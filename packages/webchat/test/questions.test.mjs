// 结构化提问（3.0.0）的网页端模型测试：
// 归一化、队列（重发幂等 / 排队上限）、答案拼装规则、resolved 出队。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChatModel, buildQuestionReply, normalizeQuestion } from '../lib/messages.mjs'

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
