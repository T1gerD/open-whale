// 相册扫码的纯逻辑：缩放档位、二维码内容校验、错误文案。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QR_JPEG_QUALITY,
  QR_RESIZE_STEPS,
  hasMoreResizeSteps,
  qrDecodeFailure,
  qrPickFailure,
  qrResizePlan,
  validateQrText,
} from '../src/core/qr-image.mts'

test('large images are downscaled in two steps before jsQR sees them', () => {
  assert.deepEqual([...QR_RESIZE_STEPS], [1024, 2048])
  assert.deepEqual(qrResizePlan(), [
    { width: 1024, label: '1024px' },
    { width: 2048, label: '2048px' },
  ])
  assert.equal(hasMoreResizeSteps(0), true)
  assert.equal(hasMoreResizeSteps(1), false)
  // 质量不能是 1.0（体积大、解码慢），也不能太低（糊掉二维码模块）
  assert.ok(QR_JPEG_QUALITY >= 0.8 && QR_JPEG_QUALITY < 1)
})

test('a binding QR payload is recognised and handed to bind()', () => {
  const payload = {
    v: 1,
    p: 'openwhale',
    host: 'DESKTOP-7',
    id: 'cmp_1',
    fp: 'ab'.repeat(32),
    secret: 's',
    expires: new Date(Date.now() + 60_000).toISOString(),
    endpoints: ['http://192.168.1.5:8787'],
  }
  const result = validateQrText(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.fromJson, true)
  assert.deepEqual(result.payload, payload)
  // 前后有噪声（比如手动粘贴时带了提示文字）也能抠出 JSON
  const noisy = validateQrText(`二维码内容：${JSON.stringify(payload)} 以上`)
  assert.equal(noisy.ok, true)
  assert.equal(noisy.fromJson, true)
})

test('non-JSON QR content is passed through so bind() can explain the problem', () => {
  const result = validateQrText('https://openwhale.example/app')
  assert.equal(result.ok, true)
  assert.equal(result.fromJson, false)
})

test('empty or unreadable images give an actionable message', () => {
  for (const value of ['', '   ', null, undefined, 42]) {
    const result = validateQrText(value)
    assert.equal(result.ok, false)
    assert.match(result.message, /没有找到二维码/)
    assert.match(result.hint, /手动输入电脑地址/)
  }
})

test('decode failures explain MLKit-less devices and retry hints', () => {
  const mlkit = qrDecodeFailure(new Error('MLKitUnavailableException'), true)
  assert.match(mlkit.message, /不支持系统扫码组件/)
  assert.ok(mlkit.hint.length > 0)

  const noNative = qrDecodeFailure(undefined, true)
  assert.match(noNative.message, /没有找到二维码/)

  const imageError = qrDecodeFailure(new Error('unsupported image'), false)
  assert.match(imageError.message, /图片读取失败/)
})

test('album picker failure copy covers cancel and permission denial', () => {
  assert.match(qrPickFailure('cancelled').message, /取消/)
  const denied = qrPickFailure('denied')
  assert.match(denied.message, /相册访问权限/)
  assert.match(denied.hint, /系统设置/)
  assert.match(qrPickFailure('unknown', 'boom').message, /boom/)
})
