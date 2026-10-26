// localStorage 持久化：绑定身份 / 设置 / 最近会话 / 待发队列。
//
// 安全说明（也写进 README）：浏览器本地存储里的设备私钥只能防网络窃听，
// 防不了同源脚本（XSS）。这是网页版相对原生 App 的固有弱点，因此：
//  * 插件只在 /openwhale/app 下提供静态文件，不注入任何第三方脚本；
//  * 不要在公开电脑的浏览器里绑定（和「不要勾选记住密码」同理）。

import { CONNECTION_MODE, CONNECTION_MODES } from './protocol.mjs'

/** 存储键前缀；v2 是网页版自己的数据版本，与产品版本无关。 */
export const STORAGE_PREFIX = 'openwhale.web.v2'

/** 设置默认值。 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 外观：auto / light / dark。 */
  theme: 'auto',
  /** 自动 / 局域网 / Tailscale / 公网隧道。 */
  mode: CONNECTION_MODE.AUTO,
  /** 上次成功的地址，重连时排第一。 */
  preferredEndpoint: '',
  /** 用户手动添加的地址（最多 8 个）。 */
  manualEndpoints: [],
  /** 设备昵称（协作模式里显示）；空 = 用 UA 推断的默认名。 */
  deviceName: '',
  /** 上次刷新时页面是不是独立窗口（用于提示安装到主屏幕）。 */
  standaloneHintDismissed: false,
  /** 是否接受「用 Tailscale 提示」等一次性提示。 */
  seenInstallHint: false,
})

/**
 * 安全解析 JSON，坏数据当作没有（不能让一条脏记录把网页版卡死）。
 * @param {string | null} text
 * @returns {any}
 */
export function parseStored(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 清理/校验连接方式。
 * @param {unknown} mode
 * @returns {string}
 */
export function normalizeMode(mode) {
  return CONNECTION_MODES.includes(/** @type {any} */ (mode)) ? /** @type {string} */ (mode) : CONNECTION_MODE.AUTO
}

/**
 * 设置对象规整（读旧版本 / 手改 localStorage 都不至于崩）。
 * @param {any} value
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {}
  const manual = Array.isArray(input.manualEndpoints)
    ? input.manualEndpoints.filter(item => typeof item === 'string' && /^https?:\/\//.test(item)).slice(0, 8)
    : []
  return {
    mode: normalizeMode(input.mode),
    preferredEndpoint: typeof input.preferredEndpoint === 'string' ? input.preferredEndpoint : '',
    manualEndpoints: manual,
    deviceName: typeof input.deviceName === 'string' ? input.deviceName.slice(0, 24) : '',
    theme: ['auto', 'light', 'dark'].includes(input.theme) ? input.theme : 'auto',
    standaloneHintDismissed: input.standaloneHintDismissed === true,
    seenInstallHint: input.seenInstallHint === true,
  }
}

/**
 * 绑定记录校验：缺关键字段就当没绑定（宁可让用户重扫，也不要半绑定状态）。
 * @param {any} value
 * @returns {any | undefined}
 */
export function normalizeBinding(value) {
  if (!value || typeof value !== 'object') return undefined
  const requiredStrings = ['computerId', 'computerName', 'fingerprint', 'deviceId', 'secretKeyB64', 'publicKeySpkiB64']
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || value[key] === '') return undefined
  }
  const endpoints = Array.isArray(value.endpoints)
    ? value.endpoints
        .filter(item => item && typeof item.url === 'string')
        .map(item => ({ url: item.url, kind: typeof item.kind === 'string' ? item.kind : 'unknown' }))
    : []
  return {
    version: 1,
    computerId: value.computerId,
    computerName: value.computerName,
    computerPublicKey: typeof value.computerPublicKey === 'string' ? value.computerPublicKey : '',
    fingerprint: value.fingerprint,
    fingerprintDisplay: typeof value.fingerprintDisplay === 'string' ? value.fingerprintDisplay : '',
    endpoints,
    webUrl: typeof value.webUrl === 'string' ? value.webUrl : '',
    mode: normalizeMode(value.mode),
    payloadVersion: typeof value.payloadVersion === 'string' ? value.payloadVersion : '',
    protocolVersion: typeof value.protocolVersion === 'string' ? value.protocolVersion : '',
    pairedAt: typeof value.pairedAt === 'string' ? value.pairedAt : new Date().toISOString(),
    deviceId: value.deviceId,
    deviceName: typeof value.deviceName === 'string' ? value.deviceName : '网页版 · 浏览器',
    secretKeyB64: value.secretKeyB64,
    publicKeySpkiB64: value.publicKeySpkiB64,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    verified: value.verified === true,
  }
}

/**
 * 待发消息（离线队列）。只持久化文本消息：附件体积大，宁可让用户重发。
 * @param {any} value
 * @returns {Array<{msgId: string, text: string, at: string}>}
 */
export function normalizeOutbox(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item.msgId === 'string' && typeof item.text === 'string')
    .slice(0, 20)
    .map(item => ({ msgId: item.msgId, text: item.text, at: typeof item.at === 'string' ? item.at : new Date().toISOString() }))
}

/**
 * 给 localStorage 套一层「永不抛异常」的包装。隐私模式 / 配额满 / 被禁用都降级成内存。
 * @param {Storage | undefined} storage
 * @param {string} [prefix]
 */
export function createStorage(storage, prefix = STORAGE_PREFIX) {
  /** @type {Map<string, string>} 存储不可用时的兜底，保证本页内仍能工作。 */
  const fallback = new Map()
  const available = Boolean(storage)

  /** @param {string} key */
  const fullKey = key => `${prefix}.${key}`

  /**
   * @param {string} key
   * @returns {string | null}
   */
  function getRaw(key) {
    if (available) {
      try {
        return storage.getItem(fullKey(key))
      } catch {
        return fallback.get(fullKey(key)) ?? null
      }
    }
    return fallback.get(fullKey(key)) ?? null
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {boolean}
   */
  function setRaw(key, value) {
    fallback.set(fullKey(key), value)
    if (!available) return false
    try {
      storage.setItem(fullKey(key), value)
      return true
    } catch {
      return false
    }
  }

  /** @param {string} key */
  function removeRaw(key) {
    fallback.delete(fullKey(key))
    if (!available) return
    try {
      storage.removeItem(fullKey(key))
    } catch {
      /* 忽略：删不掉不是致命错误 */
    }
  }

  return {
    getRaw,
    setRaw,
    removeRaw,
    /** 存储是否真的可用（隐私模式下可能不可用）。 */
    get available() {
      return available
    },
    /** @returns {any | undefined} */
    loadBinding() {
      return normalizeBinding(parseStored(getRaw('binding')))
    },
    /** @param {any} binding */
    saveBinding(binding) {
      return setRaw('binding', JSON.stringify(binding))
    },
    clearBinding() {
      removeRaw('binding')
    },
    /** @returns {typeof DEFAULT_SETTINGS} */
    loadSettings() {
      return normalizeSettings(parseStored(getRaw('settings')))
    },
    /** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
    saveSettings(patch) {
      const next = normalizeSettings({ ...this.loadSettings(), ...patch })
      setRaw('settings', JSON.stringify(next))
      return next
    },
    /** @param {string} deviceId @returns {any | undefined} */
    loadConversation(deviceId) {
      const value = parseStored(getRaw(`conversation.${deviceId}`))
      return value && typeof value === 'object' ? value : undefined
    },
    /** @param {string} deviceId @param {any} snapshot */
    saveConversation(deviceId, snapshot) {
      return setRaw(`conversation.${deviceId}`, JSON.stringify(snapshot))
    },
    /** @param {string} deviceId */
    clearConversation(deviceId) {
      removeRaw(`conversation.${deviceId}`)
    },
    /** @param {string} deviceId @returns {Array<{msgId: string, text: string, at: string}>} */
    loadOutbox(deviceId) {
      return normalizeOutbox(parseStored(getRaw(`outbox.${deviceId}`)))
    },
    /** @param {string} deviceId @param {any} outbox */
    saveOutbox(deviceId, outbox) {
      return setRaw(`outbox.${deviceId}`, JSON.stringify(normalizeOutbox(outbox)))
    },
    /** @param {string} deviceId */
    clearOutbox(deviceId) {
      removeRaw(`outbox.${deviceId}`)
    },
  }
}
