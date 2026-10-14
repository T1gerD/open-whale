// Public tunnel management for the Open Whale computer plugin.
//
// Why this module manages the `cloudflared` *binary itself* instead of adding an
// npm dependency:
//
//  1. The machine this was developed on has a **dangling shim**: the npm `.bin`
//     wrapper exists (1195 bytes of shell script) while the package body and the
//     `cloudflared.exe` it should point at are both gone. Running it exits 1 with
//     "Cannot find module". A plugin that shells out to `cloudflared` found on
//     PATH therefore *must* prove it runs, not merely that a file exists.
//  2. The `cloudflared` and `untun` npm packages both download a ~53 MB binary
//     from GitHub Releases from a `postinstall` script. That fails behind
//     `--ignore-scripts`, in restricted CI, and often in mainland China.
//  3. Downloading a 53 MB executable at install time is a decision the *user*
//     should make, with a checksum in hand. So the default here is: detect, and
//     if detection fails, explain — never silently download.
//
// The supervisor below encodes three hard-won constraints from production
// implementations of Quick Tunnels:
//   · stdout AND stderr must be drained for the child's whole lifetime (a full
//     pipe blocks cloudflared, and only one of the two streams carries the URL
//     depending on version/platform);
//   · a Quick Tunnel holds a *single* edge connection, so it dies mid-run and
//     restarting must be supervised with exponential backoff — quick-tunnel
//     *creation* is rate limited per source IP (community measurement: ~20
//     tunnels in 30 minutes trips a 25+ minute limit), so a crash loop is
//     actively harmful;
//   · `--config <devnull>` is required because a named-tunnel config in
//     `~/.cloudflared/config.yml` otherwise hijacks (and breaks) a quick tunnel.
import { EventEmitter } from 'node:events'
import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where a quick tunnel is pointed by default. The origin must stay loopback-only. */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:8787'

/** How long to wait for a URL before declaring the start failed. Production value. */
export const DEFAULT_START_TIMEOUT_MS = 30_000

/** Backoff floor, ceiling, and the multiplier used while rate limited. */
export const DEFAULT_BACKOFF_START_MS = 1_000
export const DEFAULT_BACKOFF_MAX_MS = 60_000
export const RATE_LIMITED_BACKOFF_MULTIPLIER = 4

/**
 * Ready marker. Appearing means the tunnel has a registered edge connection;
 * a URL alone can be printed before the name actually resolves on the edge.
 * (Source: osmosis-sdk-python `_CONNECTION_REGISTERED_MARKER`.)
 */
export const READY_MARKER = 'Registered tunnel connection'

/**
 * Both URL regexes come from production implementations that were verified
 * against real cloudflared output:
 *  · `BOXED_URL` matches untun's log box: `|  https://x.trycloudflare.com  |`
 *  · `PLAIN_URL` matches osmosis's stderr scrape; anchoring on the host is what
 *    keeps a URL embedded in prose from matching.
 *
 * Neither regex alone is sufficient. The boxed one over-captures (it can pick up
 * `https://api.trycloudflare.com` out of a line that merely mentions the API), and
 * the plain one happily matches that same control-plane host because `api` is a
 * valid subdomain label. So BOTH results are passed through
 * {@link isPublicTunnelUrl}: the regexes find candidates, one guard decides.
 */
export const BOXED_URL = /\|\s+(https?:\/\/\S+)/
export const PLAIN_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/**
 * Log lines that mean "Cloudflare refused to allocate a tunnel", not "the tunnel
 * dropped". `error code: 1015` is Cloudflare's "you are being rate limited".
 * Retrying these on the normal schedule is what turns one refusal into a
 * 25-minute ban, so they get a longer backoff.
 */
export const RATE_LIMIT_MARKERS = /** @type {const} */ ([
  '429 Too Many Requests',
  'error code: 1015',
  'failed to unmarshal quick tunnel',
])

/** Stable, machine-readable reasons so the UI can branch without parsing prose. */
export const TUNNEL_REASON = /** @type {const} */ ({
  NOT_INSTALLED: 'cloudflared-missing',
  START_TIMEOUT: 'start-timeout',
  RATE_LIMITED: 'rate-limited',
  SPAWN_FAILED: 'spawn-failed',
  CHECKSUM_MISMATCH: 'checksum-mismatch',
  DOWNLOAD_FAILED: 'download-failed',
})

/**
 * Strip ANSI escapes and normalize CRLF before regex matching. cloudflared colors
 * its log output when it detects a TTY, and a raw escape between the pipe and the
 * URL breaks the boxed-URL match.
 * @param {string} line
 */
function clean(line) {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

/**
 * Extract the first public hostname from a chunk of cloudflared output.
 * @param {string} text
 * @returns {string | null}
 */
export function parseTunnelUrl(text) {
  const input = clean(String(text))
  const boxed = BOXED_URL.exec(input)
  if (boxed) {
    // Trim the box border/decoration the regex necessarily swallowed.
    const candidate = boxed[1].replace(/[|),\s].*$/, '')
    if (isPublicTunnelUrl(candidate)) return candidate
  }
  // Second pass for output that has the URL bare rather than inside the log box.
  const plain = PLAIN_URL.exec(input)
  if (plain && isPublicTunnelUrl(plain[0])) return plain[0]
  return null
}

/**
 * Guard against the false positives a bare `https://...` scrape would otherwise
 * allow — most importantly `https://api.trycloudflare.com`, Cloudflare's control
 * plane, which has already been mistaken for a public tunnel URL in the wild.
 * @param {string} url
 */
export function isPublicTunnelUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      // `=== 'trycloudflare.com' || endsWith('.trycloudflare.com')` is the exact
      // test: a plain `endsWith('.trycloudflare.com')` is false for
      // api.trycloudflare.com, which is why the exclusion below is stated on the
      // hostname directly rather than inferred.
      (parsed.hostname === 'trycloudflare.com' || parsed.hostname.endsWith('.trycloudflare.com')) &&
      parsed.hostname !== 'api.trycloudflare.com' &&
      !parsed.hostname.includes('..')
    )
  } catch {
    return false
  }
}

/**
 * Classify an output line or exit summary as a rate-limit signal.
 * @param {string} text
 * @returns {boolean}
 */
export function isRateLimitSignal(text) {
  const input = String(text)
  return RATE_LIMIT_MARKERS.some(marker => input.includes(marker))
}

/** Platform-specific "empty config" argument: NUL on Windows, /dev/null elsewhere. */
export function nullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

/**
 * Candidate binary names in priority order. The `.exe`-less name is still tried on
 * Windows because a `.CMD`/`.ps1` shim resolves through PATHEXT via `where`-like
 * lookup, and that is exactly the dangling-shim case we must detect and reject.
 * @param {NodeJS.Platform} platform
 */
export function binaryNames(platform = process.platform) {
  return platform === 'win32' ? ['cloudflared.exe', 'cloudflared.cmd', 'cloudflared.bat', 'cloudflared'] : ['cloudflared']
}

/**
 * Default cache directory for a self-managed binary. Deliberately *not* inside the
 * npm tree: an npm install/prune would delete it.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string|undefined>} [env]
 */
/**
 * Join path segments using the separators of a *target* platform.
 *
 * `node:path.join` uses the separator of the platform the code is running on,
 * which is wrong here: every function in this module takes an explicit `platform`
 * describing the machine being managed, and callers use it to reason about a
 * different OS than the current one (the plugin is also exercised on Linux CI while
 * targeting Windows). Mixing the two produced paths like `C:\cache/dir` on Linux —
 * still recognisable to a human, but not equal to the string a Windows target would
 * actually have, so discovery silently found nothing.
 *
 * @param {NodeJS.Platform} platform
 * @param {string[]} segments
 * @returns {string}
 */
function joinForPlatform(platform, ...segments) {
  const separator = platform === 'win32' ? '\\' : '/'
  const cleaned = []
  for (const segment of segments) {
    const text = String(segment ?? '')
    if (text === '') continue
    cleaned.push(cleaned.length === 0 ? text.replace(/[\\/]+$/, '') : text.replace(/^[\\/]+|[\\/]+$/g, ''))
  }
  const joined = cleaned.join(separator)
  // Preserve an explicit root, so '/a' + 'b' does not become 'a/b'.
  return segments.length > 0 && String(segments[0] ?? '').startsWith(separator) && !joined.startsWith(separator)
    ? separator + joined
    : joined
}

export function defaultCacheDir(platform = process.platform, env = process.env) {
  const home = homedir()
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? env.APPDATA ?? joinForPlatform(platform, home, 'AppData', 'Local')
    return joinForPlatform(platform, base, 'openwhale', 'cloudflared')
  }
  if (platform === 'darwin') return joinForPlatform(platform, home, 'Library', 'Caches', 'openwhale', 'cloudflared')
  const base = env.XDG_CACHE_HOME ?? joinForPlatform(platform, home, '.cache')
  return joinForPlatform(platform, base, 'openwhale', 'cloudflared')
}

/**
 * Parse the version out of `cloudflared --version` output, which looks like
 * `cloudflared version 2026.10.0 (built 2026-10-05-17:43 UTC)`.
 * @param {string} output
 * @returns {string | null}
 */
export function parseCloudflaredVersion(output) {
  const match = /cloudflared\s+version\s+([^\s(]+)/i.exec(String(output))
  return match ? match[1] : null
}

/**
 * Walk PATH looking for a binary. Returns candidates in PATH order; existence is
 * *not* proof of usability (see the dangling shim above), only a cheap filter.
 * @param {string[]} names
 * @param {Record<string, string|undefined>} env
 * @param {NodeJS.Platform} platform
 */
function pathCandidates(names, env, platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean)
  const extensions = platform === 'win32'
    ? [''].concat(String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase()))
    : ['']
  const out = []
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of extensions) {
        out.push(joinForPlatform(platform, dir, ext && !name.toLowerCase().endsWith(ext) ? name + ext : name))
      }
    }
  }
  return out
}

/**
 * Candidate binaries previously installed into our own cache directory.
 *
 * Versioned filenames (as written by `installCloudflared`) are preferred over the
 * unversioned one so a downloaded upgrade wins over a stale copy.
 * @param {string} cacheDir
 * @param {NodeJS.Platform} platform
 * @param {(path: string) => boolean} isFile
 * @param {(dir: string) => string[]} readdir
 */
function cacheCandidates(cacheDir, platform, isFile, readdir = readdirSync) {
  const names = binaryNames(platform)
  const out = []
  // No separate "does the directory exist" check: reading it either works or
  // throws, and a missing directory is just an empty candidate list. Each entry
  // still has to pass the same probe as every other candidate.
  let entries = []
  try {
    entries = readdir(cacheDir)
  } catch {
    entries = []
  }
  for (const entry of entries.sort().reverse()) {
    if (!names.some(n => entry.startsWith(n))) continue
    const full = joinForPlatform(platform, cacheDir, entry)
    // Go through `isFile` (never statSync directly) so the whole discovery path —
    // including cache entries — stays injectable for tests, and so "exists" and
    // "is a regular file" are decided in exactly one place.
    if (isFile(full)) out.push(full)
  }
  for (const name of names) out.push(joinForPlatform(platform, cacheDir, name))
  return out
}

/**
 * Default `--version` prober: run the candidate and capture stdout. A file that
 * exists but cannot execute (dangling shim, wrong architecture, quarantined
 * binary) throws or exits non-zero, and that is the whole point of this step.
 * @param {string} path
 * @param {{execFileSync: Function, timeoutMs?: number}} deps
 */
function defaultProbe(path, deps) {
  const output = deps.execFileSync(path, ['--version'], {
    timeout: deps.timeoutMs ?? 10_000,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return String(output ?? '')
}

/**
 * Find a *working* cloudflared binary.
 *
 * Priority: explicit config → `CLOUDFLARED_BIN` → cache directory → PATH. Every
 * candidate is executed with `--version`; the first one that answers wins. When
 * nothing answers, the return value still carries actionable guidance rather than
 * throwing, because "no tunnel" must degrade to "LAN only", not to a dead plugin.
 *
 * @param {object} [options]
 * @param {string} [options.explicitPath] User-configured absolute path (highest priority).
 * @param {string} [options.cacheDir]     Self-managed cache directory.
 * @param {Record<string, string|undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {{execFileSync: Function, timeoutMs?: number}} [options.probeDeps] Test seam.
 * @param {(path: string) => boolean} [options.isFile] Test seam for existence checks.
 * @param {(dir: string) => string[]} [options.readdir] Test seam for the cache listing.
 * @returns {{available: boolean, path: string|null, version: string|null, source: 'explicit'|'env'|'cache'|'path'|null, error: string|null, installHint: string|null, checked: Array<{path: string, source: string, ok: boolean, error: string|null}>}}
 */
export function resolveCloudflared(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cacheDir = options.cacheDir ?? defaultCacheDir(platform, env)
  const probe = options.probeDeps ?? { execFileSync: nodeExecFileSync }
  const deps = {
    execFileSync: probe.execFileSync ?? nodeExecFileSync,
    timeoutMs: probe.timeoutMs,
  }
  const isFile = options.isFile ?? existsSync

  /** @type {Array<{path: string, source: 'explicit'|'env'|'cache'|'path'}>} */
  const candidates = []
  if (options.explicitPath) candidates.push({ path: options.explicitPath, source: 'explicit' })
  if (env.CLOUDFLARED_BIN) candidates.push({ path: env.CLOUDFLARED_BIN, source: 'env' })
  for (const path of cacheCandidates(cacheDir, platform, isFile, options.readdir)) candidates.push({ path, source: 'cache' })
  for (const path of pathCandidates(binaryNames(platform), env, platform)) candidates.push({ path, source: 'path' })

  /** @type {Array<{path: string, source: string, ok: boolean, error: string|null}>} */
  const checked = []
  const seen = new Set()
  for (const candidate of candidates) {
    const key = platform === 'win32' ? candidate.path.toLowerCase() : candidate.path
    if (seen.has(key)) continue
    seen.add(key)
    if (!isFile(candidate.path)) {
      checked.push({ path: candidate.path, source: candidate.source, ok: false, error: '文件不存在' })
      continue
    }
    let output
    try {
      output = defaultProbe(candidate.path, deps)
    } catch (error) {
      // The dangling shim lands here with exit code 1 / ENOENT / EACCES. Record
      // the precise failure: it is what tells the user "your PATH is lying".
      const message = /** @type {Error} */ (error).message ?? String(error)
      checked.push({ path: candidate.path, source: candidate.source, ok: false, error: message.split('\n')[0] })
      continue
    }
    const version = parseCloudflaredVersion(output)
    if (!version) {
      checked.push({
        path: candidate.path,
        source: candidate.source,
        ok: false,
        error: `--version 输出无法识别：${String(output).trim().slice(0, 120) || '(空)'}`,
      })
      continue
    }
    checked.push({ path: candidate.path, source: candidate.source, ok: true, error: null })
    return { available: true, path: candidate.path, version, source: candidate.source, error: null, installHint: null, checked }
  }

  const dangling = checked.find(c => c.source === 'path' && c.error && c.error !== '文件不存在')
  return {
    available: false,
    path: null,
    version: null,
    source: null,
    error: dangling
      ? `找到了 cloudflared 但它无法运行（${dangling.path}：${dangling.error}）。这通常是 npm 留下的“悬空 shim”——包装脚本还在，真正的二进制已经没了。`
      : '未找到可用的 cloudflared 二进制。',
    installHint: installHint({ platform, cacheDir, checked }),
    checked,
  }
}

/**
 * Human-readable, copy-pasteable installation guidance. Kept in one place so the
 * settings UI and the docs cannot drift apart.
 * @param {{platform: NodeJS.Platform, cacheDir: string, checked?: unknown[]}} options
 * @returns {string}
 */
export function installHint(options) {
  const { platform, cacheDir } = options
  if (platform === 'win32') {
    return [
      '可选方案（三选一），插件不会自动下载二进制：',
      `1) 手动下载并校验（推荐）：下载 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe 到 ${cacheDir}，再用 Get-FileHash 校验 SHA256；`,
      '2) 已有二进制时：设置环境变量 CLOUDFLARED_BIN 指向 cloudflared.exe 的绝对路径，然后重启插件；',
      `3) winget 安装：winget install --id Cloudflare.cloudflared（装好后如果不在 PATH，仍请用方案 2 指定路径）。`,
      '注意：npm 上的 cloudflared / untun 包会下载 50MB+ 二进制，本插件刻意不依赖它们；如果 PATH 上的 cloudflared 是 npm shim，请先确认它能运行 `cloudflared --version`。',
    ].join('\n')
  }
  return [
    '可选方案（二选一），插件不会自动下载二进制：',
    `1) 手动下载对应平台的 release 到 ${cacheDir}（macOS/Linux 记得 chmod +x）；`,
    '2) 已有二进制时：设置环境变量 CLOUDFLARED_BIN 指向其绝对路径，然后重启插件。',
  ].join('\n')
}

/** Normalize a 64-char SHA256 hex string, or return null. */
function normalizeSha256(value) {
  if (typeof value !== 'string') return null
  const clean = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null
}

/** Pick the GitHub Releases asset name for a platform/arch pair. */
export function releaseAssetName(platform, arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe'
  if (platform === 'darwin') return 'cloudflared-darwin-amd64.tgz'
  return arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'
}

/**
 * Optional, opt-in binary download with mandatory integrity checking.
 *
 * This is the *only* network-touching code in the module, it is never called from
 * the default path, and it refuses to write anything that does not hash to the
 * caller-supplied SHA256. Tests must inject `fetchImpl`; production callers are
 * expected to have obtained the expected hash out of band (the GitHub Releases API
 * publishes one per asset).
 *
 * @param {object} options
 * @param {string} [options.cacheDir]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.releaseBase] Override for a mirror.
 * @param {string} [options.version] e.g. '2026.10.0'; default 'latest'.
 * @param {string} options.sha256 Expected SHA256 (required).
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(path: string, mode: number) => void} [options.chmod] Test seam.
 * @returns {Promise<{ok: true, path: string, version: string, bytes: number, sha256: string} | {ok: false, reason: string, message: string}>}
 */
export async function installCloudflared(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const cacheDir = options.cacheDir ?? defaultCacheDir(platform, process.env)
  const version = options.version ?? 'latest'
  const expected = normalizeSha256(options.sha256)
  if (!expected) {
    return {
      ok: false,
      reason: 'sha256-required',
      // Refusing without a hash is the feature, not a limitation: an unverified
      // 53 MB executable from the internet is exactly what we must not do.
      message: '必须提供 64 位十六进制 sha256 才能下载 cloudflared（拒绝写入未经校验的可执行文件）',
    }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'no-fetch', message: '当前运行环境没有 fetch 实现，无法下载；请手动放置二进制' }
  }

  const asset = releaseAssetName(platform, arch)
  const releaseBase = options.releaseBase ?? 'https://github.com/cloudflare/cloudflared/releases'
  const url = version === 'latest'
    ? `${releaseBase}/latest/download/${asset}`
    : `${releaseBase}/download/${version}/${asset}`

  let bytes
  try {
    const response = await fetchImpl(url, { redirect: 'follow' })
    if (!response?.ok) {
      return { ok: false, reason: 'download-failed', message: `下载失败：HTTP ${response?.status ?? '?'}` }
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return { ok: false, reason: 'download-failed', message: `下载失败：${/** @type {Error} */ (error).message}` }
  }

  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    return {
      ok: false,
      reason: 'checksum-mismatch',
      message: `SHA256 校验失败，已丢弃下载内容（期望 ${expected}，实际 ${actual}）。可能是版本已更新或下载被篡改。`,
    }
  }

  mkdirSync(cacheDir, { recursive: true })
  const filename = platform === 'win32' ? `cloudflared-${version}.exe` : `cloudflared-${version}`
  const target = joinForPlatform(platform, cacheDir, filename)
  const tmp = `${target}.${process.pid}.part`
  writeFileSync(tmp, bytes, { mode: 0o755 })
  renameSync(tmp, target)
  if (options.chmod) options.chmod(target, 0o755)
  else {
    try {
      chmodSync(target, 0o755)
    } catch { /* Windows ignores POSIX modes */ }
  }
  return { ok: true, path: target, version, bytes: bytes.length, sha256: actual }
}

/**
 * Supervised Quick Tunnel.
 *
 * Lifecycle states: `stopped` → `starting` → `ready`, and on a dead child
 * `restarting` → `starting`. `failed` means "we gave up this round" (start
 * timeout, or cloudflared unavailable); a later `start()` is always allowed.
 *
 * @typedef {object} TunnelOptions
 * @property {number} [port]          Local port to expose (loopback only).
 * @property {string} [origin]        Full origin URL; overrides `port`.
 * @property {string} [binaryPath]    Resolved cloudflared path; if absent, `resolveCloudflared` runs.
 * @property {NodeJS.Platform} [platform]
 * @property {Function} [spawn]       Test seam: (command, args, options) => fake child.
 * @property {Function} [killTree]    Test seam: (child, signal) => void.
 * @property {Function} [now]         Injectable clock, milliseconds.
 * @property {Function} [setTimer] / [clearTimer]  Injectable timers.
 * @property {number} [startTimeoutMs]
 * @property {number} [backoffStartMs] / [backoffMaxMs]
 * @property {number} [maxConsecutiveFailures] After this many restarts in a row, park in `failed`.
 * @property {Function} [log]
 * @property {Function} [resolveBinary] Test seam for binary discovery.
 */

export class TunnelManager extends EventEmitter {
  /** @param {TunnelOptions} [options] */
  constructor(options = {}) {
    super()
    this.port = options.port ?? 8787
    this.origin = options.origin ?? `http://127.0.0.1:${this.port}`
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.backoffStartMs = options.backoffStartMs ?? DEFAULT_BACKOFF_START_MS
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5
    this.log = options.log ?? (() => {})
    this.spawn = options.spawn ?? nodeSpawn
    this.killTree = options.killTree ?? ((child, signal) => defaultKillTree(child, signal, this.platform, this.log))
    this.resolveBinary = options.resolveBinary ?? (() => resolveCloudflared({
      explicitPath: this.binaryPath,
      cacheDir: this.cacheDir,
      platform: this.platform,
    }))

    this.binaryPath = options.binaryPath ?? null
    this.cacheDir = options.cacheDir ?? defaultCacheDir(this.platform)

    /** @type {'stopped'|'starting'|'ready'|'restarting'|'failed'} */
    this.state = 'stopped'
    /** @type {string | null} */
    this.url = null
    /**
     * The most recent hostname, kept across a drop so the next `url` event can
     * report `previousUrl` and the phone can tell "same endpoint" from "the
     * hostname changed, re-pair". A quick tunnel changes hostname on every
     * creation, so this distinction is the difference between a reconnect and a
     * silent failure.
     * @type {string | null}
     */
    this.lastUrl = null
    /** @type {any} */
    this.child = null
    /** @type {any} */
    this.startTimer = null
    /** @type {any} */
    this.restartTimer = null
    this.restartAttempt = 0
    /** Set by an explicit stop() so an exiting child does not schedule a restart. */
    this.stopping = false
    /** @type {string | null} */
    this.lastError = null
    /** @type {string|null} */ this.reason = null
    /** @type {{path: string, version: string, source: string} | null} */ this.binary = null
    /** @type {Array<{consecutive: number, delayMs: number, rateLimited: boolean}>} */ this.restartHistory = []
    /** @type {string} */ this.tail = ''
    /** True while a chunk is being scanned (re-entrancy guard). */
    this.scanning = false
    /**
     * True once cloudflared logged a registered edge connection. A quick tunnel
     * gets exactly one, so this is the strongest readiness signal available; it
     * can arrive *after* the URL, which is why both are tracked.
     */
    this.connectionRegistered = false
  }

  /** @param {'stopped'|'starting'|'ready'|'restarting'|'failed'} state @param {object} [extra] */
  #setState(state, extra = {}) {
    this.state = state
    this.emit('state', { state, url: this.url, reason: this.reason, ...extra })
  }

  /** Snapshot for the settings UI. */
  status() {
    return {
      state: this.state,
      url: this.url,
      origin: this.origin,
      binary: this.binary,
      reason: this.reason,
      error: this.lastError,
      restartAttempt: this.restartAttempt,
      connectionRegistered: this.connectionRegistered,
    }
  }

  /**
   * Argument vector for the child process. Exported-ish for tests via the
   * instance method so a fake spawn can assert on exact flags.
   * @param {string} origin
   */
  commandArgs(origin) {
    return [
      'tunnel',
      '--url', origin,
      // An existing ~/.cloudflared/config.yml (from a named-tunnel setup) makes a
      // quick tunnel fail; pinning an explicitly empty config prevents that.
      '--config', nullDevice(this.platform),
      '--no-autoupdate',
    ]
  }

  /**
   * Start the tunnel. Resolves once the child is spawned (not once the URL is
   * known) — the URL arrives asynchronously via the `url` event, because a
   * Quick Tunnel's hostname is allocated by Cloudflare at connect time.
   * @returns {{ok: boolean, reason?: string, message?: string, installHint?: string, checked?: unknown[], child?: unknown}}
   */
  start() {
    if (this.state === 'starting' || this.state === 'ready' || this.state === 'restarting') {
      return { ok: true, message: `隧道已在 ${this.state} 状态，忽略重复启动` }
    }
    this.stopping = false
    this.reason = null
    this.lastError = null
    this.restartAttempt = 0
    this.restartHistory = []

    if (!this.binaryPath) {
      const resolved = this.resolveBinary()
      if (!resolved?.available) {
        // Degrade, do not throw: the plugin stays usable on the LAN.
        this.reason = TUNNEL_REASON.NOT_INSTALLED
        this.lastError = resolved?.error ?? '未找到可用的 cloudflared 二进制'
        this.#setState('failed', { message: this.lastError, installHint: resolved?.installHint ?? null })
        return {
          ok: false,
          reason: this.reason,
          message: this.lastError,
          installHint: resolved?.installHint ?? null,
          checked: resolved?.checked ?? [],
        }
      }
      this.binaryPath = resolved.path
      this.binary = { path: resolved.path, version: resolved.version, source: resolved.source }
    }

    return this.#spawnChild()
  }

  #spawnChild() {
    this.#setState(this.restartAttempt > 0 ? 'restarting' : 'starting')
    const args = this.commandArgs(this.origin)
    this.tail = ''
    this.scanning = false
    this.connectionRegistered = false
    let child
    try {
      child = this.spawn(this.binaryPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Never let a shell reinterpret the origin URL or the binary path.
        shell: false,
      })
    } catch (error) {
      this.lastError = `启动 cloudflared 失败：${/** @type {Error} */ (error).message}`
      this.reason = TUNNEL_REASON.SPAWN_FAILED
      this.#setState('failed', { message: this.lastError })
      this.emit('error', new Error(this.lastError))
      return { ok: false, reason: this.reason, message: this.lastError }
    }
    this.child = child

    // Drain BOTH streams for the child's entire lifetime. Stopping at the URL
    // parse would fill the OS pipe buffer and freeze cloudflared mid-handshake.
    this.#attach(child.stdout, 'stdout')
    this.#attach(child.stderr, 'stderr')

    child.once('error', error => {
      this.lastError = `cloudflared 进程错误：${/** @type {Error} */ (error).message}`
      this.emit('error', error)
    })
    child.once('exit', (code, signal) => this.#onExit(code, signal))

    this.startTimer = this.setTimer(() => {
      this.startTimer = null
      if (this.state === 'ready' || this.stopping) return
      this.reason = TUNNEL_REASON.START_TIMEOUT
      this.lastError = `启动超时：${this.startTimeoutMs / 1000} 秒内没有拿到公网地址。可能原因：网络不通、Cloudflare 拒绝创建（限流）或端口 ${this.port} 上没有本地服务。`
      this.log(`tunnel: ${this.lastError}`)
      this.#killChild()
      this.#setState('failed', { message: this.lastError })
      this.emit('error', new Error(this.lastError))
      // No automatic restart after our own timeout: a hard failure loop is what
      // triggers Cloudflare's per-IP creation limit.
    }, this.startTimeoutMs)
    this.startTimer?.unref?.()

    return { ok: true, child }
  }

  /**
   * Consume a child stream. Data is matched incrementally: cloudflared may split a
   * log line across chunks, so the tail of each chunk is retained for the next.
   * @param {any} stream
   * @param {'stdout'|'stderr'} source
   */
  #attach(stream, source) {
    if (!stream) return
    stream.setEncoding?.('utf8')
    stream.on('data', (/** @type {string|Buffer} */ chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.tail = (this.tail + text).slice(-8192)
      this.emit('log', { source, text })
      // Match against the accumulated tail, never the raw chunk: cloudflared log
      // lines are routinely split across pipe reads, and a URL straddling the
      // boundary would otherwise be lost forever.
      this.#enqueue(this.tail)
    })
    // Errors on the pipe itself must not become unhandled 'error' events.
    stream.on('error', () => {})
    if (typeof stream.resume === 'function') stream.resume()
  }

  /**
   * Feed a chunk to the matcher, ignoring anything produced while we are already
   * inside it. A caller that reacts to a `url`/`state` event by writing the same
   * text back into the stream would otherwise re-enter this path unbounded.
   * @param {string} text
   */
  #enqueue(text) {
    if (this.scanning) return
    this.scanning = true
    try {
      this.#scan(text)
    } finally {
      this.scanning = false
    }
  }

  /** @param {string} text */
  #scan(text) {
    if (isRateLimitSignal(text)) {
      this.reason = TUNNEL_REASON.RATE_LIMITED
      this.log('tunnel: 检测到 Cloudflare 限流信号，将使用更长退避')
    }
    if (text.includes(READY_MARKER)) {
      // "Registration is sufficient readiness" (osmosis): the hostname exists but
      // may not resolve on the edge until this line appears, so record it even
      // when the URL arrived first.
      if (!this.connectionRegistered) {
        this.connectionRegistered = true
        this.emit('ready', { url: this.url, marker: READY_MARKER })
      }
    }
    const found = parseTunnelUrl(text)
    if (!found) return
    if (this.url === found && this.state === 'ready') return
    const previous = this.url ?? this.lastUrl
    this.url = found
    this.lastUrl = found
    if (this.startTimer) {
      this.clearTimer(this.startTimer)
      this.startTimer = null
    }
    // We reached ready, so the consecutive-failure streak is over: the next drop
    // must start its backoff from the floor, not from wherever we were.
    this.restartAttempt = 0
    // A new hostname after a restart means every paired phone must reconnect, so
    // the event fires again rather than only reporting the first URL.
    this.#setState('ready', { previousUrl: previous })
    this.emit('url', { url: found, previousUrl: previous, permanent: false })
    this.log(`tunnel: 公网地址已就绪 ${found}`)
  }

  /** @param {number|null} code @param {string|null} signal */
  #onExit(code, signal) {
    this.child = null
    if (this.startTimer) {
      this.clearTimer(this.startTimer)
      this.startTimer = null
    }
    const wasReady = this.state === 'ready'
    this.emit('exit', { code, signal, expected: this.stopping, wasReady })
    if (this.stopping) {
      this.url = null
      this.#setState('stopped')
      return
    }
    // 'failed' is terminal until an explicit start()/restart(). An exit produced by
    // our own timeout kill must not be re-read as a fresh fault, or a start that
    // never reached the edge would loop forever.
    if (this.state === 'failed') {
      this.log(`tunnel: 已处于 failed 状态，忽略退出事件（code=${code ?? 'n/a'}）`)
      return
    }
    // The exit reason decides the backoff: an explicit rate-limit signal must wait
    // far longer than an unexplained single-edge-connection drop.
    const rateLimited = this.reason === TUNNEL_REASON.RATE_LIMITED || isRateLimitSignal(this.tail)
    this.#scheduleRestart({ rateLimited, code })
  }

  /** @param {{rateLimited: boolean, code: number|null}} info */
  #scheduleRestart(info) {
    // `restartAttempt` stays 0 while ready, so this counts *consecutive* failures
    // since the last successful connection.
    this.restartAttempt += 1
    if (this.restartAttempt > this.maxConsecutiveFailures) {
      this.reason = info.rateLimited ? TUNNEL_REASON.RATE_LIMITED : TUNNEL_REASON.SPAWN_FAILED
      this.lastError = `连续 ${this.maxConsecutiveFailures} 次重启失败，已停止自动重启（避免触发 Cloudflare 的每 IP 创建限流）。最后一次退出码：${info.code ?? '未知'}${info.rateLimited ? '（被 Cloudflare 限流，请等待 25 分钟以上再试）' : ''}`
      this.url = null
      this.#setState('failed', { message: this.lastError })
      this.emit('error', new Error(this.lastError))
      return
    }
    const delayMs = this.backoffDelayMs(this.restartAttempt, info.rateLimited)
    this.restartHistory.push({ consecutive: this.restartAttempt, delayMs, rateLimited: info.rateLimited })
    this.url = null
    this.#setState('restarting', { delayMs, attempt: this.restartAttempt, rateLimited: info.rateLimited })
    this.log(`tunnel: cloudflared 退出（code=${info.code ?? 'n/a'}），${delayMs}ms 后第 ${this.restartAttempt} 次重启`)
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.#spawnChild()
    }, delayMs)
    this.restartTimer?.unref?.()
  }

  /**
   * Exponential backoff: 1s, 2s, 4s, … capped at 60s. Rate-limited rounds are
   * multiplied further because the limit is wall-clock based (community
   * measurement: ~20 creations / 30 min → 25+ min penalty), so retrying fast
   * makes the outage longer, not shorter.
   * @param {number} attempt 1-based
   * @param {boolean} rateLimited
   */
  backoffDelayMs(attempt, rateLimited = false) {
    const exponential = this.backoffStartMs * 2 ** Math.max(0, attempt - 1)
    const base = Math.min(this.backoffMaxMs, exponential)
    if (!rateLimited) return base
    // Cap the exponential first, then multiply, so a rate-limited round really
    // waits longer than an ordinary one even when the exponential already hit the
    // ceiling — otherwise the longer backoff would silently disappear.
    return Math.min(this.backoffMaxMs, base * RATE_LIMITED_BACKOFF_MULTIPLIER)
  }

  #killChild() {
    if (!this.child) return
    const child = this.child
    this.child = null
    try {
      // On Windows the tree must go: `cloudflared` may have helper processes, and
      // child.kill() only signals the direct child.
      this.killTree(child, 'SIGTERM')
    } catch (error) {
      this.log(`tunnel: 结束进程失败：${/** @type {Error} */ (error).message}`)
    }
  }

  /**
   * Manual retry after the supervisor parked in `failed`. Refuses while the
   * manager is still running, because a user tapping "retry" during a live
   * restart must not create a second cloudflared process.
   * @returns {{ok: boolean, message?: string, reason?: string}}
   */
  restart() {
    if (this.state === 'starting' || this.state === 'ready' || this.state === 'restarting') {
      return { ok: false, reason: 'already-running', message: `隧道当前为 ${this.state}，无需重启；如需彻底重来请先 stop()` }
    }
    // A failed binary lookup is re-attempted on restart: the user may have just
    // installed cloudflared or set CLOUDFLARED_BIN.
    if (this.reason === TUNNEL_REASON.NOT_INSTALLED) this.binaryPath = null
    return this.start()
  }

  /**
   * Stop for good. Idempotent, and once called the manager will not restart the
   * child — an exiting child during shutdown must not be mistaken for a failure.
   * @returns {{stopped: boolean, wasRunning: boolean}}
   */
  stop() {
    const wasRunning = Boolean(this.child) || this.state === 'starting' || this.state === 'ready' || this.state === 'restarting'
    this.stopping = true
    if (this.startTimer) {
      this.clearTimer(this.startTimer)
      this.startTimer = null
    }
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer)
      this.restartTimer = null
    }
    this.#killChild()
    this.url = null
    this.reason = null
    this.#setState('stopped')
    return { stopped: true, wasRunning }
  }
}

/**
 * Kill a process *tree*.
 *
 * On Windows `child.kill()` leaves the tree orphaned, so `taskkill /T /F` is used;
 * elsewhere a process-group kill is attempted first and a plain SIGKILL follows.
 * @param {any} child
 * @param {NodeJS.Signals} signal
 * @param {NodeJS.Platform} [platform]
 * @param {(message: string) => void} [log]
 */
export function defaultKillTree(child, signal = 'SIGTERM', platform = process.platform, log = () => {}) {
  if (!child || child.killed) return
  if (platform === 'win32' && child.pid) {
    try {
      // Use nodeSpawn, not execFile: the output is irrelevant and piping it can
      // deadlock under restricted sandboxes.
      const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', error => log(`tunnel: taskkill 失败：${error.message}`))
      return
    } catch (error) {
      log(`tunnel: taskkill 启动失败：${/** @type {Error} */ (error).message}`)
    }
  }
  try {
    // Detached children live in their own process group; negative-pid signalling
    // is not available from Node, so fall back to the direct child.
    child.kill?.(signal)
  } catch (error) {
    log(`tunnel: kill 失败：${/** @type {Error} */ (error).message}`)
  }
}
