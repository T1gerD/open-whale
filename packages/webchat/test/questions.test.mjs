// 结构化提问（3.0.0）的网页端模型测试：
// 归一化、队列（重发幂等 / 排队上限）、答案拼装规则、resolved 出队。
//
// v3.0.x 追加两组（真机反馈）：
//  * 题干回退：`item.question` 为空/缺省时用 `intent.display`（本地化字典）兜底，
//    绝不渲染空行、也绝不因为缺 question 把整条丢掉；
//  * 答后留痕：`question/resolved` 之后留下只读摘要卡（题目 + 所选答案），
//    同一 questionId 只留一张，跨标签互不串台。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChatModel,
  ChatTabsModel,
  QUESTION_FALLBACK_TEXT,
  buildQuestionReply,
  normalizeQuestion,
} from '../lib/messages.mjs'

const NOW = Date.parse('2026-10-26T12:00:00.000Z')

function makeModel() {
  const model = new ChatModel()
  model.setDeviceId('dev_a')
  return model
}

const TWO_QUESTIONS = [
  { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '还要补充吗', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
]

test('a question frame normalises into renderable items', () => {
  const question = normalizeQuestion(
    { questionId: 'qst_1', items: TWO_QUESTIONS, expiresAt: NOW + 60_000, canAnswerLate: true, callId: 'call_1' },
    NOW,
  )
  assert.ok(question)
  assert.equal(question.questionId, 'qst_1')
  assert.equal(question.items.length, 2)
  assert.equal(question.items[1].multiSelect, true)
  assert.equal(question.canAnswerLate, true)
  assert.equal(question.callId, 'call_1')
  assert.equal(question.replied, false)
})

test('a question without id or without usable items is dropped', () => {
  assert.equal(normalizeQuestion({ items: TWO_QUESTIONS }, NOW), undefined)
  assert.equal(normalizeQuestion({ questionId: 'q', items: [] }, NOW), undefined)
  assert.equal(normalizeQuestion(null, NOW), undefined)
})

test('the same batch re-sent updates instead of duplicating the card', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  model.applyFrame({ t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS }, NOW + 1000)
  assert.equal(model.questions.length, 1)
})

test('resolved removes the batch and advances the model', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  const result = model.applyFrame({ t: 'question/resolved', questionId: 'qst_1', outcome: 'answered' }, NOW + 1000)
  assert.equal(result.changed, true)
  assert.equal(model.questions.length, 0)
  assert.equal(model.hasPendingQuestions, false)
})

test('submitting marks the batch replied and refuses a second submit', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  assert.equal(model.markQuestionReplied('qst_1'), true)
  assert.equal(model.markQuestionReplied('qst_1'), false)
  assert.equal(model.questionsById.get('qst_1').replied, true)
})

test('answers name every question and follow DSH single/multi rules', () => {
  const question = normalizeQuestion({ questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  const reply = buildQuestionReply(question, {
    q1: { selected: ['A'], custom: '都不是，我要选 D' },
    q2: { selected: ['X', 'Y'], custom: '再补充一句' },
  })
  assert.equal(reply.questionId, 'qst_1')
  assert.deepEqual(reply.answers, [
    // 单选：custom 覆盖 selected
    { id: 'q1', selected: [], custom: '都不是，我要选 D' },
    // 多选：custom 与 selected 并列
    { id: 'q2', selected: ['X', 'Y'], custom: '再补充一句' },
  ])
})

test('unanswered questions are submitted as explicit skips', () => {
  const question = normalizeQuestion({ questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  assert.deepEqual(buildQuestionReply(question, {}).answers, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [] },
  ])
  assert.equal(buildQuestionReply(null, {}), undefined)
})

test('options the computer never offered are dropped', () => {
  const question = normalizeQuestion({ questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  const reply = buildQuestionReply(question, { q1: { selected: ['A', 'NOPE'] } })
  assert.deepEqual(reply.answers[0], { id: 'q1', selected: ['A'] })
})

test('the queue is bounded so a broken peer cannot grow it forever', () => {
  const model = makeModel()
  for (let index = 0; index < 10; index++) {
    model.applyFrame({ t: 'question/ask', questionId: `qst_${index}`, items: TWO_QUESTIONS }, NOW + index)
  }
  assert.ok(model.questions.length <= 4)
  assert.equal(model.questions.at(-1).questionId, 'qst_9')
})

// ---------------------------------------------------------------------------
// v3.0.x：真机反馈「手机上能看到『需要你的回答』和选项、能作答，但题目文字不显示；
// 答完之后聊天流里不留任何记录」。这两件事各锁一组测试：
//   1) 题干回退——DSH 新版把文字放在 `intent.display`（本地化字典），`question`
//      可能是空串甚至缺省，旧实现要么渲染空行、要么整条丢掉；
//   2) 答后留痕——`question/resolved` 一到，旧实现把卡片删掉就什么都不剩了。
// ---------------------------------------------------------------------------

/** DSH 新版 shape：question 是空串，人话全在 intent.display（本地化字典）里。 */
const DISPLAY_ONLY_ITEM = {
  id: 'q1',
  question: '',
  options: [{ label: '同意并开始' }, { label: '先别动' }],
  intent: {
    kind: 'plan-review',
    display: {
      question: { en: 'Start the plan?', zh: '按这个计划开始吗？' },
      detail: { en: 'Touches 3 files.', zh: '会改 3 个文件。' },
      approve: { en: 'Go ahead', zh: '同意并开始' },
    },
  },
}

test('an empty question falls back to intent.display (zh first, en as backup)', () => {
  const question = normalizeQuestion({ questionId: 'qst_d', items: [DISPLAY_ONLY_ITEM] }, NOW)
  assert.ok(question, 'display-only items must never be dropped')
  const item = question.items[0]
  assert.equal(item.question, '按这个计划开始吗？')
  assert.equal(item.detail, '会改 3 个文件。')
  assert.equal(item.intent.kind, 'plan-review')
  assert.equal(item.intent.approve, '同意并开始')

  const english = normalizeQuestion(
    { questionId: 'qst_e', items: [{ id: 'q1', intent: { display: { question: { en: 'Start?' } } } }] },
    NOW,
  )
  assert.equal(english.items[0].question, 'Start?', '只有 en 时兜底到英文')
})

test('a missing question field no longer drops the item', () => {
  const question = normalizeQuestion(
    { questionId: 'qst_m', items: [{ id: 'q7', header: '计划审阅', options: [{ label: '同意' }, { label: '不同意' }] }] },
    NOW,
  )
  assert.ok(question)
  assert.equal(question.items.length, 1)
  assert.equal(question.items[0].question, '计划审阅', '退到 header 也比空行好')
  assert.equal(question.items[0].options.length, 2)
})

test('a batch with no text at all still renders an honest placeholder', () => {
  const question = normalizeQuestion({ questionId: 'qst_n', items: [{ id: 'q1', options: [{ label: 'OK' }] }] }, NOW)
  assert.equal(question.items[0].question, QUESTION_FALLBACK_TEXT)
})

test('answering leaves one read-only summary that survives question/resolved', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_1', items: TWO_QUESTIONS }, NOW)
  assert.equal(
    model.recordQuestionAnswer('qst_1', [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [], custom: '还有一句' },
    ]),
    true,
  )
  assert.equal(model.questions.length, 1, '本地提交后卡片还在（等电脑确认）')
  assert.equal(model.questions[0].replied, true)
  assert.equal(model.questionLog.length, 1)
  const summary = model.questionLog[0]
  assert.equal(summary.answered, true)
  assert.equal(summary.source, 'phone')
  assert.deepEqual(summary.items.map(item => item.question), ['选哪个？', '还要补充吗'])
  assert.deepEqual(summary.items[0].selected, ['A'])
  assert.equal(summary.items[1].custom, '还有一句')

  const result = model.applyFrame({ t: 'question/resolved', questionId: 'qst_1', outcome: 'answered', source: 'phone' }, NOW + 1000)
  assert.equal(result.changed, true)
  assert.equal(model.questions.length, 0)
  assert.equal(model.questionsById.get('qst_1'), undefined, 'resolved 之后不能再点')
  assert.equal(model.recordQuestionAnswer('qst_1', []), false)
  assert.equal(model.questionLog.length, 1, '同一批只留一张')
  assert.equal(model.questionLog[0].outcome, 'answered')
  assert.deepEqual(model.questionLog[0].items[0].selected, ['A'], '更新结果不能把答案清空')

  // 迟到的重复 resolved 幂等
  model.applyFrame({ t: 'question/resolved', questionId: 'qst_1', outcome: 'answered', source: 'phone' }, NOW + 2000)
  assert.equal(model.questionLog.length, 1)
})

test('a question answered on the computer also leaves a read-only record', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_2', items: TWO_QUESTIONS }, NOW)
  model.applyFrame({ t: 'question/resolved', questionId: 'qst_2', outcome: 'answered', source: 'desktop' }, NOW + 1000)
  assert.equal(model.questions.length, 0)
  assert.equal(model.questionLog.length, 1)
  const summary = model.questionLog[0]
  assert.equal(summary.source, 'desktop')
  assert.equal(summary.answered, true)
  assert.equal(summary.items[0].question, '选哪个？', '电脑上答的也要能看到题目')
  assert.deepEqual(summary.items[0].selected, [], '答案在电脑上，手机不知道具体选项')
})

test('a timed-out question is recorded honestly, not as answered', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_t', items: TWO_QUESTIONS }, NOW)
  model.applyFrame({ t: 'question/resolved', questionId: 'qst_t', outcome: 'timeout', source: 'timeout' }, NOW + 1000)
  assert.equal(model.questionLog.length, 1)
  assert.equal(model.questionLog[0].outcome, 'timeout')
  assert.equal(model.questionLog[0].answered, false)
})

test('a re-sent batch replaces its old summary instead of stacking a second card', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_r', items: TWO_QUESTIONS }, NOW)
  model.applyFrame({ t: 'question/resolved', questionId: 'qst_r', outcome: 'timeout', source: 'timeout' }, NOW + 1000)
  assert.equal(model.questionLog.length, 1)
  // 电脑端重推同一批（它又活了）：摘要撤掉、可点卡片回来，始终只有一张。
  model.applyFrame({ t: 'question/ask', questionId: 'qst_r', items: TWO_QUESTIONS }, NOW + 2000)
  assert.equal(model.questionLog.length, 0)
  assert.equal(model.questions.length, 1)
})

test('questions and their summaries stay in their own tab', () => {
  const store = new ChatTabsModel({ myDeviceId: 'dev_a' })
  store.applyFrame({ t: 'session/state', sessionId: 'sess_a', sessionEpoch: 1, head: 1, snapshot: { messages: [] } }, { now: NOW })
  store.applyFrame(
    { t: 'session/state', sessionId: 'sess_b', sessionEpoch: 1, head: 1, snapshot: { messages: [] }, active: false },
    { now: NOW },
  )
  store.applyFrame({ t: 'question/ask', sessionId: 'sess_a', questionId: 'qa', items: TWO_QUESTIONS }, { now: NOW })
  store.applyFrame({ t: 'question/ask', sessionId: 'sess_b', questionId: 'qb', items: TWO_QUESTIONS }, { now: NOW })
  assert.equal(store.chatFor('sess_a').questions.length, 1)
  assert.equal(store.chatFor('sess_b').questions.length, 1)

  assert.equal(store.chatFor('sess_a').recordQuestionAnswer('qa', [{ id: 'q1', selected: ['A'] }]), true)
  store.applyFrame(
    { t: 'question/resolved', sessionId: 'sess_a', questionId: 'qa', outcome: 'answered', source: 'phone' },
    { now: NOW + 1000 },
  )
  assert.equal(store.chatFor('sess_a').questionLog.length, 1)
  assert.equal(store.chatFor('sess_b').questionLog.length, 0, '别的标签不该冒出一张摘要卡')
  assert.equal(store.chatFor('sess_b').questions.length, 1, '另一个标签的提问还在等作答')
})

test('answered summaries survive a page reload (storage round-trip)', () => {
  const model = makeModel()
  model.applyFrame({ t: 'question/ask', questionId: 'qst_s', items: TWO_QUESTIONS }, NOW)
  model.recordQuestionAnswer('qst_s', [{ id: 'q1', selected: ['B'] }])
  model.applyFrame({ t: 'question/resolved', questionId: 'qst_s', outcome: 'answered', source: 'phone' }, NOW + 1000)
  const saved = model.snapshotForStorage({ limit: 50 })
  assert.equal(saved.questionLog.length, 1)
  const restored = makeModel()
  assert.equal(restored.restoreFromStorage(saved), true)
  assert.equal(restored.questions.length, 0, '待答卡片是有时效的请求，不落盘')
  assert.equal(restored.questionLog.length, 1)
  assert.equal(restored.questionLog[0].items[0].selected[0], 'B')
})
