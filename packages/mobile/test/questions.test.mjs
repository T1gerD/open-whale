// 结构化提问（question，3.0.0）的纯逻辑 + reducer 队列行为。
//
// 每一条都对应一个真实会发生的场景：
//  * 一批里有多道题、选项、多选和「其他」文本；
//  * 电脑端重连后重发同一批（不能变成两张卡）；
//  * 前台超时后交回桌面（canAnswerLate=false 的卡必须自己消失，true 的还能补答）；
//  * 用户只答了一部分问题时，未答的要按「跳过」提交而不是报错。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CAPABILITIES, CLIENT_FRAME } from '../src/core/frames.mts'
import {
  MAX_PENDING_QUESTIONS,
  buildQuestionReply,
  draftHasAnswer,
  enqueueQuestion,
  formatQuestionCountdown,
  isQuestionExpired,
  normalizeQuestionAsk,
  normalizeQuestionItems,
  pruneExpiredQuestions,
  questionAnswerable,
  questionAvailability,
  questionRemainingMs,
  resolveQuestion,
  setQuestionCustom,
  toggleQuestionOption,
} from '../src/core/questions.mts'
import { emptyChatState, reduceChat } from '../src/core/reducer.mts'
import { sessionOfQuestion } from '../src/core/tabs.mts'

const ASSISTANT = 'cmp_abc123'

function run(events, state = emptyChatState(ASSISTANT), start = 1000) {
  let current = state
  let clock = start
  for (const event of events) {
    const result = reduceChat(current, event, clock)
    current = result.state
    clock += 1
  }
  return current
}

const TWO_QUESTIONS = [
  { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '还要补充吗', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
]

// ---------------------------------------------------------------------------
// 帧归一化
// ---------------------------------------------------------------------------

test('a valid question/ask normalizes with its items and deadline', () => {
  const prompt = normalizeQuestionAsk(
    { questionId: 'qst_1', items: TWO_QUESTIONS, callId: 'call_1', expiresAt: 5000, canAnswerLate: true },
    1000,
  )
  assert.ok(prompt)
  assert.equal(prompt.questionId, 'qst_1')
  assert.equal(prompt.items.length, 2)
  assert.equal(prompt.callId, 'call_1')
  assert.equal(prompt.expiresAt, 5000)
  assert.equal(prompt.canAnswerLate, true)
})

test('a question without id or without usable items is dropped', () => {
  assert.equal(normalizeQuestionAsk({ items: TWO_QUESTIONS }, 1000), undefined)
  assert.equal(normalizeQuestionAsk({ questionId: 'q', items: [] }, 1000), undefined)
  assert.equal(normalizeQuestionAsk({ questionId: 'q', items: [{ question: '没有 id' }] }, 1000), undefined)
  assert.equal(normalizeQuestionAsk(null, 1000), undefined)
})

test('question items are sanitised and capped', () => {
  const items = normalizeQuestionItems([
    { id: 'ok', question: '问', options: [{ label: 'A' }, { label: '' }, { nope: 1 }] },
    { id: '', question: '没有 id' },
    null,
  ])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].options, [{ label: 'A' }])

  const many = Array.from({ length: 40 }, (_, index) => ({ id: `q${index}`, question: 'x' }))
  assert.ok(normalizeQuestionItems(many).length <= 10)
})

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

test('re-sending the same batch updates it instead of duplicating cards', () => {
  const first = normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 1000)
  const again = normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 2000)
  const list = enqueueQuestion(enqueueQuestion([], first), again)
  assert.equal(list.length, 1)
  assert.equal(list[0].receivedAt, 2000)
})

test('the queue is bounded and drops the oldest batch', () => {
  let list = []
  for (let index = 0; index < MAX_PENDING_QUESTIONS + 2; index++) {
    list = enqueueQuestion(list, normalizeQuestionAsk({ questionId: `q${index}`, items: TWO_QUESTIONS }, 1000 + index))
  }
  assert.equal(list.length, MAX_PENDING_QUESTIONS)
  assert.equal(list.at(-1).questionId, `q${MAX_PENDING_QUESTIONS + 1}`)
})

test('resolved removes the batch, and unknown ids change nothing', () => {
  const list = [normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 1000)]
  assert.equal(resolveQuestion(list, 'nope'), list)
  assert.deepEqual(resolveQuestion(list, 'qst_1'), [])
})

test('only expired questions that cannot be answered late are pruned', () => {
  const now = 10_000
  const expired = { questionId: 'a', items: TWO_QUESTIONS, expiresAt: 9_000, canAnswerLate: false, receivedAt: 0 }
  const late = { questionId: 'b', items: TWO_QUESTIONS, expiresAt: 9_000, canAnswerLate: true, receivedAt: 0 }
  const live = { questionId: 'c', items: TWO_QUESTIONS, expiresAt: 20_000, canAnswerLate: false, receivedAt: 0 }
  assert.deepEqual(pruneExpiredQuestions([expired, late, live], now).map(item => item.questionId), ['b', 'c'])
  assert.equal(isQuestionExpired(expired, now), true)
  assert.equal(questionAnswerable(expired, now), false)
  assert.equal(questionAnswerable(late, now), true)
  assert.equal(questionRemainingMs(live, now), 10_000)
  assert.equal(formatQuestionCountdown(90_000), '1:30')
})

// ---------------------------------------------------------------------------
// 草稿与回包
// ---------------------------------------------------------------------------

test('single select replaces, multi select toggles', () => {
  const single = { id: 's', question: '单选', options: [{ label: 'A' }, { label: 'B' }] }
  const multi = { id: 'm', question: '多选', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }
  let draft = toggleQuestionOption({}, single, 'A')
  assert.deepEqual(draft.s.selected, ['A'])
  draft = toggleQuestionOption(draft, single, 'B')
  assert.deepEqual(draft.s.selected, ['B'])
  draft = toggleQuestionOption(draft, multi, 'X')
  draft = toggleQuestionOption(draft, multi, 'Y')
  assert.deepEqual(draft.m.selected, ['X', 'Y'])
  draft = toggleQuestionOption(draft, multi, 'X')
  assert.deepEqual(draft.m.selected, ['Y'])
})

test('an answer batch names every question, and single-select custom overrides selection', () => {
  const prompt = normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 1000)
  let draft = toggleQuestionOption({}, prompt.items[0], 'A')
  draft = setQuestionCustom(draft, prompt.items[0], '都不是，我要选 D')
  draft = toggleQuestionOption(draft, prompt.items[1], 'X')
  draft = setQuestionCustom(draft, prompt.items[1], '再加一句')

  const frame = buildQuestionReply(prompt, draft)
  assert.equal(frame.t, CLIENT_FRAME.QUESTION_REPLY)
  assert.equal(frame.questionId, 'qst_1')
  assert.deepEqual(frame.answers, [
    // 单选：custom 覆盖 selected
    { id: 'q1', selected: [], custom: '都不是，我要选 D' },
    // 多选：custom 与 selected 并列
    { id: 'q2', selected: ['X'], custom: '再加一句' },
  ])
})

test('skipped questions are submitted explicitly as empty answers', () => {
  const prompt = normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 1000)
  const frame = buildQuestionReply(prompt, {})
  assert.deepEqual(frame.answers, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [] },
  ])
  assert.equal(draftHasAnswer({}), false)
  assert.equal(draftHasAnswer({ q1: { selected: ['A'] } }), true)
})

test('options the computer never offered are dropped from the answer', () => {
  const prompt = normalizeQuestionAsk({ questionId: 'qst_1', items: TWO_QUESTIONS }, 1000)
  const frame = buildQuestionReply(prompt, { q1: { selected: ['A', 'NOPE'] } })
  assert.deepEqual(frame.answers[0], { id: 'q1', selected: ['A'] })
})

test('the phone only answers when the computer advertises questions-v1', () => {
  assert.equal(questionAvailability(true, [CAPABILITIES.QUESTIONS]).ok, true)
  assert.equal(questionAvailability(true, [CAPABILITIES.APPROVAL]).ok, false)
  assert.equal(questionAvailability(false, [CAPABILITIES.QUESTIONS]).ok, false)
})

// ---------------------------------------------------------------------------
// reducer / 标签归属
// ---------------------------------------------------------------------------

test('question frames land in the chat queue and resolved clears them', () => {
  const state = run([
    { t: 'question/ask', sessionId: 'ow-a', questionId: 'qst_1', items: TWO_QUESTIONS, expiresAt: 5000, canAnswerLate: false },
    { t: 'question/ask', sessionId: 'ow-a', questionId: 'qst_2', items: TWO_QUESTIONS, expiresAt: 1000, canAnswerLate: true },
  ])
  assert.equal(state.questions.length, 2)

  const cleared = run([{ t: 'question/resolved', sessionId: 'ow-a', questionId: 'qst_1', outcome: 'answered' }], state, 2000)
  assert.deepEqual(cleared.questions.map(item => item.questionId), ['qst_2'])
})

test('a tick drops an expired blocking question but keeps a late-answerable one', () => {
  const state = run([
    { t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS, expiresAt: 1500, canAnswerLate: false },
    { t: 'question/ask', questionId: 'qst_2', items: TWO_QUESTIONS, expiresAt: 1500, canAnswerLate: true },
  ], undefined, 1000)
  const ticked = run([{ t: 'question/tick' }], state, 3000)
  assert.deepEqual(ticked.questions.map(item => item.questionId), ['qst_2'])
})

test('a question can be routed back to the tab it belongs to', () => {
  const tabsState = {
    assistantId: ASSISTANT,
    tabs: ['ow-a', 'ow-b'],
    activeSessionId: 'ow-a',
    chats: {
      'ow-a': { ...emptyChatState(ASSISTANT), questions: [] },
      'ow-b': { ...emptyChatState(ASSISTANT), questions: [normalizeQuestionAsk({ questionId: 'qst_9', items: TWO_QUESTIONS }, 0)] },
    },
    activity: {},
  }
  assert.equal(sessionOfQuestion(tabsState, 'qst_9'), 'ow-b')
  assert.equal(sessionOfQuestion(tabsState, 'nope'), undefined)
})
