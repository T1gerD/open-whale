// 文件出站：电脑 → 手机的分片推送与一次性下载链接。
//
// 从 gateway.mjs 拆出来的原因：这一段是纯 I/O（stat / createReadStream / HTTP
// 响应），与帧分发、会话绑定没有关系；放在 2700 行的网关里既难 review，也无法
// 独立测试背压与中断。行为保持不变：
//  · `file/fetch` → `file/meta` + 若干 `file/chunk` + `file/end`；
//  · 慢链路必须等 socket drain（否则整块文件堆在 Node 内部，传输会卡死）；
//  · 同时提供一次性 HTTP 下载链接，给不能/不愿重组 base64 的客户端。
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import {
  DOWNLOAD_PATH,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  SERVER_FRAME,
} from './protocol.mjs'

/** 下载链接有效期：够手机点开，又不会长期留在浏览器历史里。 */
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000

/** 同时保留的下载链接上限，防止手机循环 file/fetch 把内存撑大。 */
const MAX_DOWNLOAD_TOKENS = 64

/**
 * @typedef {object} FileServiceOptions
 * @property {{fileFor?: (fileId: string) => Promise<{name: string, mime?: string, path: string} | undefined>}} [bridge]
 *           Assistant-produced files. The gateway's bridge filters which paths a
 *           phone may ever ask for, so this is the authority for those.
 * @property {Map<string, {name: string, path: string, mime?: string, size?: number}>} [offeredFiles]
 *           Files the user explicitly sent from the computer.
 * @property {(message: string) => void} [log]
 */

/**
 * 手机侧文件读取的 I/O 半层。
 */
export class FileService {
  /**
   * @param {FileServiceOptions} [options]
   */
  constructor(options = {}) {
    this.bridge = options.bridge ?? {}
    this.offeredFiles = options.offeredFiles ?? new Map()
    this.log = options.log ?? (() => {})
    /** token → {path, name, mime, expiresAt} */
    this.downloadTokens = new Map()
  }

  /**
   * `file/fetch`：把文件按块推给一台手机。
   * @param {{send: (frame: any) => any, sendError?: (code: string, message: string) => any, connection: any}} session
   * @param {any} frame
   */
  async fetch(session, frame) {
    const fileId = String(frame.fileId ?? '')
    if (!fileId) {
      if (typeof session.sendError === 'function') return session.sendError('bad-frame', 'file/fetch 缺少 fileId')
      return undefined
    }
    // Files the assistant produced are registered by the bridge; files the user
    // explicitly sent from the computer are registered here.
    const file = (await this.bridge.fileFor?.(fileId)) ?? this.offeredFiles.get(fileId)
    if (!file) {
      return session.send({ t: SERVER_FRAME.FILE_ERROR, fileId, code: 'not-found', message: '找不到该文件' })
    }
    let size = 0
    try {
      size = (await stat(file.path)).size
    } catch (error) {
      return session.send({
        t: SERVER_FRAME.FILE_ERROR,
        fileId,
        code: 'unreadable',
        message: `无法读取文件：${/** @type {Error} */ (error).message}`,
      })
    }
    if (size > MAX_FILE_BYTES) {
      return session.send({
        t: SERVER_FRAME.FILE_ERROR,
        fileId,
        code: 'too-large',
        message: `文件过大（${Math.round(size / 1024 / 1024)} MB），上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`,
      })
    }

    session.send({
      t: SERVER_FRAME.FILE_META,
      fileId,
      name: file.name,
      mime: file.mime,
      size,
      // A plain HTTP fallback for clients that cannot or prefer not to reassemble
      // base64 chunks. The token is single-use and short-lived.
      downloadPath: `${DOWNLOAD_PATH}?token=${this.issueDownloadToken(file.path, file.name, file.mime)}`,
    })

    await this.streamToSession(session, fileId, file.path, size)
    return undefined
  }

  /**
   * Push a file as base64 chunks, aborting if the session drops.
   * @param {any} session
   * @param {string} fileId
   * @param {string} path
   * @param {number} size
   */
  async streamToSession(session, fileId, path, size) {
    const stream = createReadStream(path, { highWaterMark: FILE_CHUNK_BYTES })
    let seq = 0
    let sent = 0
    let aborted = false
    const onClose = () => {
      aborted = true
      stream.destroy()
    }
    session.connection.once('close', onClose)
    try {
      for await (const chunk of stream) {
        if (aborted || session.connection.closed) {
          aborted = true
          break
        }

        // Respect the socket's write buffer. Pushing a whole large file at a
        // socket that cannot drain it (a slow phone link, or a host with a smaller
        // send buffer) queues the remainder in Node's internals, and the transfer
        // then stalls instead of finishing — observed as a timeout on macOS CI for a
        // 700 KiB file. Waiting for `drain` bounds memory to one chunk.
        const frame = JSON.stringify({
          t: SERVER_FRAME.FILE_CHUNK,
          fileId,
          seq,
          dataBase64: /** @type {Buffer} */ (chunk).toString('base64'),
        })
        const accepted = typeof session.connection.sendWithBackpressure === 'function'
          ? session.connection.sendWithBackpressure(frame)
          : session.send({
            t: SERVER_FRAME.FILE_CHUNK,
            fileId,
            seq,
            dataBase64: /** @type {Buffer} */ (chunk).toString('base64'),
          })
        if (!accepted) {
          // Either the connection is gone or the frame buffered. Distinguish them:
          // a buffered write must be waited for, a dead connection must abort.
          if (session.connection.closed) {
            aborted = true
            break
          }
          await session.connection.waitForDrain()
          if (session.connection.closed || aborted) {
            aborted = true
            break
          }
        }

        seq += 1
        sent += /** @type {Buffer} */ (chunk).length
        // Yield so incoming frames (including the phone's cancel) are never starved.
        if (seq % 4 === 0) await new Promise(resolve => setImmediate(resolve))
      }
    } finally {
      session.connection.off('close', onClose)
    }
    if (aborted) {
      this.log(`file: transfer of ${fileId} aborted after ${sent}/${size} bytes`)
      return
    }
    session.send({ t: SERVER_FRAME.FILE_END, fileId, seq })
  }

  /**
   * `GET /openwhale/download?token=…`：一次性 HTTP 下载。
   * @param {URL} url
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>}
   */
  async handleDownload(url, res) {
    const token = url.searchParams.get('token') ?? ''
    const entry = this.downloadTokens.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.downloadTokens.delete(token)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('下载链接已失效')
      return true
    }
    this.downloadTokens.delete(token)
    let size
    try {
      size = (await stat(entry.path)).size
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('文件不存在')
      return true
    }
    res.writeHead(200, {
      'content-type': entry.mime ?? 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${encodeURIComponent(entry.name)}"`,
      'cache-control': 'no-store',
    })
    createReadStream(entry.path).pipe(res)
    return true
  }

  /**
   * 签发一次性下载 token（同一文件在 5 分钟内可以重复签发，旧 token 不受影响）。
   * @param {string} path
   * @param {string} name
   * @param {string} [mime]
   * @returns {string}
   */
  issueDownloadToken(path, name, mime) {
    const token = randomBytes(24).toString('base64url')
    this.downloadTokens.set(token, { path, name, mime, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS })
    // Bound the map so a phone looping file/fetch cannot grow memory forever.
    if (this.downloadTokens.size > MAX_DOWNLOAD_TOKENS) {
      const oldest = [...this.downloadTokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) this.downloadTokens.delete(oldest[0])
    }
    return token
  }
}
