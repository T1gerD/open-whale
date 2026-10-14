// 构造测试数据的小工具。
// 文件名以 `helpers.mjs` 结尾而不是 `.test.mjs`，所以不会被测试运行器当成用例文件。

import { PAIR_SECRET_TTL_MS } from '../../protocol/src/index.mjs'

/** 一份合法的二维码载荷；每个用例只改自己要破坏的那个字段。 */
export function pairingPayload(overrides = {}) {
  return {
    v: 1,
    p: 'openwhale',
    host: 'DESKTOP-7',
    id: 'cmp_abc123',
    fp: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    secret: 's3cr3t-single-use',
    expires: new Date(Date.now() + PAIR_SECRET_TTL_MS).toISOString(),
    endpoints: ['https://quiet-whale.trycloudflare.com', 'http://192.168.1.20:8787'],
    port: 8787,
    lan: 'http://192.168.1.20:8787',
    name: '书房电脑',
    version: '1.0.0',
    ...overrides,
  }
}

/** 用真实 protocol 实现驱动纯逻辑（不复制协议、不 mock，避免漂移）。 */
export async function realDeps() {
  const protocol = await import('../../protocol/src/index.mjs')
  return {
    parsePairingPayload: protocol.parsePairingPayload,
    pickEndpoint: protocol.pickEndpoint,
  }
}

/** 一个 12 字节的固定随机源，让 deviceId / nonce 在测试里可复现。 */
export function fixedRandom(length, seed = 1) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (seed * 31 + i * 7) & 0xff
  return out
}

/** base64 of N 个 0x41 字节，用于伪造文件分块。 */
export function chunkOf(bytes) {
  return Buffer.alloc(bytes, 0x41).toString('base64')
}
