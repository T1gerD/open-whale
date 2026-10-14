// Tests for packages/plugin/src/tunnel.mjs
//
// Two rules govern this file:
//  1. Nothing here may touch the network, and nothing may launch a real
//     cloudflared. The binary probe, the process spawn, the process-tree kill and
//     the download are all injected fakes, which is precisely why those seams
//     exist in the module.
//  2. The dangling-shim scenario must be covered explicitly: a file that exists
//     but cannot run is the real state of the development machine, and "file
//     exists therefore cloudflared is available" is the bug being prevented.
//
// Run with:  node packages/plugin/test/tunnel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOXED_URL,
  DEFAULT_START_TIMEOUT_MS,
  PLAIN_URL,
  RATE_LIMITED_BACKOFF_MULTIPLIER,
  TUNNEL_REASON,
  TunnelManager,
  defaultCacheDir,
  installCloudflared,
  installHint,
  isPublicTunnelUrl,
  isRateLimitSignal,
  nullDevice,
  parseCloudflaredVersion,
  parseTunnelUrl,
  releaseAssetName,
  resolveCloudflared,
} from '../src/tunnel.mjs'

/** A temp dir that is always cleaned up, so runs cannot accumulate garbage. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-tunnel-'))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* best effort */ }
  })
  return dir
}

/** Minimal ObjectRef-based event recorder. */
function record(emitter, names) {
  /** @type {Record<string, any[]>} */
  const events = {}
  for (const name of names) {
    events[name] = []
    emitter.on(name, payload => events[name].push(payload))
  }
  return events
}

/**
 * A child stream stub that delivers chunks *synchronously*, like a real pipe that
 * already has bytes waiting. A PassThrough defers delivery to the next macrotask,
 * which would make every parsing assertion in this file timing-dependent.
 */
class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.encoding = null
    this.resumed = 0
  }

  setEncoding(encoding) {
    this.encoding = encoding
  }

  resume() {
    this.resumed += 1
  }

  write(text) {
    this.emit('data', text)
    return true
  }
}

/**
 * A fake child process: EventEmitter with synchronous chunk streams. Feeding text
 * through them also proves the module consumes both streams incrementally.
 */
function fakeChild(pid = 4242) {
  const child = /** @type {any} */ (new EventEmitter())
  child.pid = pid
  child.stdout = new FakeStream()
  child.stderr = new FakeStream()
  child.killed = false
  child.killCalls = 0
  child.kill = () => {
    child.killed = true
    child.killCalls += 1
    return true
  }
  child.exit = (code = 0, signal = null) => child.emit('exit', code, signal)
  return child
}

/**
 * A TunnelManager wired to a fake spawn + fake kill, with millisecond backoff so
 * tests finish fast without a fake clock.
 */
function makeManager(t, options = {}) {
  /** @type {Array<{command: string, args: string[], options: any, child: any}>} */
  const spawned = []
  /** @type {Array<{child: any, signal: string}>} */
  const kills = []
  const manager = new TunnelManager({
    binaryPath: 'C:\\fake\\cloudflared.exe',
    platform: 'win32',
    startTimeoutMs: 400,
    backoffStartMs: 5,
    backoffMaxMs: 20,
    killTree: (child, signal) => {
      kills.push({ child, signal })
      child.kill?.()
    },
    spawn: (command, args, spawnOptions) => {
      const child = fakeChild(1000 + spawned.length)
      spawned.push({ command, args, options: spawnOptions, child })
      return child
    },
    ...options,
  })
  t?.after(() => manager.stop())
  return { manager, spawned, kills }
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
async function waitFor(predicate, timeoutMs = 1000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

test('parseTunnelUrl reads the boxed log line produced by cloudflared', () => {
  const output = [
    '2026-10-13T10:00:00Z INF +----------------------------------------------------------------------------+',
    '2026-10-13T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time)  |',
    '2026-10-13T10:00:00Z INF |  https://mailto-davis-wilderness-facts.trycloudflare.com                    |',
    '2026-10-13T10:00:00Z INF +----------------------------------------------------------------------------+',
  ].join('\n')
  assert.equal(parseTunnelUrl(output), 'https://mailto-davis-wilderness-facts.trycloudflare.com')
})

test('parseTunnelUrl also matches the bare hostname form (second regex)', () => {
  assert.equal(
    parseTunnelUrl('INF Registered tunnel connection ... https://unjs-is-awesome.trycloudflare.com'),
    'https://unjs-is-awesome.trycloudflare.com',
  )
})

test('parseTunnelUrl survives ANSI colouring and CRLF between the pipe and the URL', () => {
  // cloudflared colours its logs on a TTY; an escape sequence sitting between the
  // box border and the URL would defeat a naive match.
  const line = 'INF |\u001B[0m  https://colour-test.trycloudflare.com  |\r\n'
  assert.equal(parseTunnelUrl(line), 'https://colour-test.trycloudflare.com')
})

test('parseTunnelUrl never mistakes the control-plane host for the tunnel URL', () => {
  // Someone has already shipped this bug: https://api.trycloudflare.com is
  // Cloudflare's API, not a public hostname a client should dial. The boxed regex
  // can pick it up from a log that merely mentions it, so the host check on the
  // result is what saves us.
  assert.equal(parseTunnelUrl('GET |  https://api.trycloudflare.com  |'), null)
  assert.equal(isPublicTunnelUrl('https://api.trycloudflare.com'), false)
  assert.equal(isPublicTunnelUrl('https://api.trycloudflare.com/v1/tunnels'), false)
  assert.equal(isPublicTunnelUrl('https://x.trycloudflare.com'), true)
  assert.equal(isPublicTunnelUrl('http://x.trycloudflare.com'), false)
  assert.equal(isPublicTunnelUrl('https://evil.example.com'), false)
  assert.equal(isPublicTunnelUrl('not a url'), false)
})

test('a boxed non-cloudflare URL is rejected rather than reported as the tunnel', () => {
  assert.equal(parseTunnelUrl('|  https://developers.cloudflare.com/tunnel/  |'), null)
})

test('parseTunnelUrl returns null when there is no URL at all', () => {
  assert.equal(parseTunnelUrl('INF Starting tunnel\nINF Version 2026.10.0'), null)
  assert.equal(parseTunnelUrl(''), null)
})

test('the two exported regexes are the production-verified pair', () => {
  assert.equal(BOXED_URL.source, String(/\|\s+(https?:\/\/\S+)/.source))
  assert.equal(PLAIN_URL.source, String(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.source))
})

test('rate-limit markers are recognised verbatim', () => {
  assert.equal(isRateLimitSignal('ERR Failed to create tunnel: 429 Too Many Requests'), true)
  assert.equal(isRateLimitSignal('ERR error code: 1015'), true)
  assert.equal(isRateLimitSignal('ERR failed to unmarshal quick tunnel'), true)
  assert.equal(isRateLimitSignal('INF Registered tunnel connection'), false)
})

test('small helpers: null device, version parsing, cache dir, asset names', () => {
  assert.equal(nullDevice('win32'), 'NUL')
  assert.equal(nullDevice('linux'), '/dev/null')
  assert.equal(parseCloudflaredVersion('cloudflared version 2026.10.0 (built 2026-11-05-17:43 UTC)'), '2026.10.0')
  assert.equal(parseCloudflaredVersion('garbage'), null)
  assert.equal(releaseAssetName('win32', 'x64'), 'cloudflared-windows-amd64.exe')
  assert.equal(releaseAssetName('win32', 'arm64'), 'cloudflared-windows-arm64.exe')
  assert.equal(releaseAssetName('linux', 'arm64'), 'cloudflared-linux-arm64')
  assert.match(defaultCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), /openwhale/)
})

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

test('resolveCloudflared accepts the first candidate that actually runs --version', () => {
  const probed = []
  const result = resolveCloudflared({
    explicitPath: 'C:\\tools\\cloudflared.exe',
    isFile: () => true,
    probeDeps: {
      execFileSync: path => {
        probed.push(path)
        if (path.includes('.bin')) throw new Error('Cannot find module cloudflared.js')
        return 'cloudflared version 2026.10.0 (built 2026-11-05)'
      },
    },
    env: { PATH: 'C:\\node_modules\\.bin;C:\\tools' },
    platform: 'win32',
  })
  assert.equal(result.available, true)
  assert.equal(result.path, 'C:\\tools\\cloudflared.exe')
  assert.equal(result.version, '2026.10.0')
  assert.equal(result.source, 'explicit')
  assert.equal(result.installHint, null)
  assert.deepEqual(probed, ['C:\\tools\\cloudflared.exe'])
  assert.equal(result.checked[0].ok, true)
})

test('the dangling npm shim is detected: the file exists but --version fails', () => {
  // This is the measured state of the development machine. A plugin that only
  // checks existence reports "cloudflared is available" and then crashes when the
  // shim exits 1 with "Cannot find module .../cloudflared/lib/cloudflared.js".
  const binDir = 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\.bin'
  const result = resolveCloudflared({
    isFile: () => true,
    env: { PATH: binDir },
    platform: 'win32',
    cacheDir: 'C:\\nonexistent-cache',
    probeDeps: {
      execFileSync: path => {
        throw Object.assign(new Error(`Command failed: ${path} --version`), {
          stderr: "Error: Cannot find module '...\\cloudflared\\lib\\cloudflared.js'",
          status: 1,
        })
      },
    },
  })
  assert.equal(result.available, false)
  assert.equal(result.path, null)
  assert.equal(result.version, null)
  assert.match(String(result.error), /无法运行/)
  assert.match(String(result.error), /悬空 shim/)
  assert.ok(result.checked.length >= 1)
  assert.equal(result.checked[0].ok, false)
  assert.ok(result.installHint.includes('CLOUDFLARED_BIN'))
})

test('resolveCloudflared falls back from a broken env override to a working cache copy', () => {
  const result = resolveCloudflared({
    env: { CLOUDFLARED_BIN: 'C:\\broken\\cloudflared.exe', PATH: 'C:\\nope' },
    cacheDir: 'C:\\cache',
    platform: 'win32',
    isFile: path => path === 'C:\\broken\\cloudflared.exe' || path === 'C:\\cache\\cloudflared-2026.10.0.exe',
    // The cache listing is injected too: a versioned filename must win over the
    // unversioned one so a downloaded upgrade is picked up.
    readdir: () => ['cloudflared-2026.9.0.exe', 'cloudflared-2026.10.0.exe'],
    probeDeps: {
      execFileSync: path => {
        if (path.startsWith('C:\\broken')) throw new Error('ENOENT')
        return 'cloudflared version 2026.10.0'
      },
    },
  })
  assert.equal(result.available, true)
  assert.equal(result.path, 'C:\\cache\\cloudflared-2026.10.0.exe')
  assert.equal(result.source, 'cache')
  assert.equal(result.checked[0].source, 'env')
  assert.equal(result.error, null)
})

test('resolveCloudflared still works when the cache directory cannot be listed', () => {
  const result = resolveCloudflared({
    env: { PATH: '' },
    cacheDir: 'C:\\locked',
    platform: 'win32',
    isFile: path => path === 'C:\\locked\\cloudflared.exe',
    readdir: () => {
      throw new Error('EACCES')
    },
    probeDeps: { execFileSync: () => 'cloudflared version 2026.10.0' },
  })
  assert.equal(result.available, true)
  assert.equal(result.source, 'cache')
})

test('resolveCloudflared reports every candidate it inspected and a hint when nothing works', () => {
  const result = resolveCloudflared({
    env: { PATH: 'C:\\a;C:\\b' },
    cacheDir: 'C:\\empty-cache',
    platform: 'win32',
    isFile: () => false,
    probeDeps: { execFileSync: () => '' },
  })
  assert.equal(result.available, false)
  assert.equal(result.source, null)
  assert.ok(result.checked.length >= 2)
  assert.ok(result.checked.every(entry => entry.error === '文件不存在'))
  assert.equal(typeof result.installHint, 'string')
  assert.match(result.installHint, /不会自动下载/)
})

test('installHint mentions the manual download and the env override on both platforms', () => {
  for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'linux'])) {
    const hint = installHint({ platform, cacheDir: '/some/cache' })
    assert.match(hint, /CLOUDFLARED_BIN/)
    assert.match(hint, /不会自动下载/)
  }
})

// ---------------------------------------------------------------------------
// Optional download (never touches the network in tests)
// ---------------------------------------------------------------------------

test('installCloudflared refuses to write a binary without a sha256', async () => {
  const result = await installCloudflared({ fetchImpl: () => assert.fail('must not fetch without a hash') })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'sha256-required')
})

test('installCloudflared discards a download whose sha256 does not match', async t => {
  const dir = tempDir(t)
  const payload = Buffer.from('definitely-not-cloudflared')
  const result = await installCloudflared({
    cacheDir: dir,
    platform: 'win32',
    arch: 'x64',
    version: '2026.10.0',
    sha256: 'a'.repeat(64),
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => payload }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'checksum-mismatch')
  assert.match(result.message, /SHA256/)
  assert.equal(existsSync(join(dir, 'cloudflared-2026.10.0.exe')), false, 'nothing may be written on mismatch')
})

test('installCloudflared writes the binary atomically when the hash matches', async t => {
  const dir = tempDir(t)
  const payload = Buffer.from('pretend-cloudflared-binary')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const chmods = []
  const result = await installCloudflared({
    cacheDir: dir,
    platform: 'linux',
    arch: 'x64',
    version: '2026.10.0',
    sha256: sha256.toUpperCase(), // accepted: hashes are case-insensitive
    chmod: (path, mode) => chmods.push({ path, mode }),
    fetchImpl: async url => {
      assert.match(url, /releases\/download\/2026\.10\.0\/cloudflared-linux-amd64$/)
      return { ok: true, status: 200, arrayBuffer: async () => payload }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(existsSync(result.path), true)
  assert.equal(result.bytes, payload.length)
  assert.deepEqual(chmods, [{ path: result.path, mode: 0o755 }])
})

test('installCloudflared reports an HTTP failure instead of throwing', async () => {
  const result = await installCloudflared({
    sha256: 'b'.repeat(64),
    fetchImpl: async () => ({ ok: false, status: 502 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'download-failed')
  assert.match(result.message, /502/)
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('start builds the documented argv: --config NUL plus --no-autoupdate', () => {
  const { manager, spawned } = makeManager(null, { port: 8787 })
  const started = manager.start()
  assert.equal(started.ok, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, 'C:\\fake\\cloudflared.exe')
  assert.deepEqual(spawned[0].args, [
    'tunnel',
    '--url', 'http://127.0.0.1:8787',
    '--config', 'NUL',
    '--no-autoupdate',
  ])
  assert.equal(spawned[0].options.shell, false, 'a shell must never see the origin URL')
  assert.equal(spawned[0].options.windowsHide, true)
  manager.stop()
})

test('non-Windows uses /dev/null for the pinned empty config', () => {
  const { manager, spawned } = makeManager(null, { platform: 'linux', binaryPath: '/usr/local/bin/cloudflared' })
  manager.start()
  assert.deepEqual(manager.commandArgs(manager.origin).slice(3, 5), ['--config', '/dev/null'])
  assert.equal(spawned.length, 1)
  manager.stop()
})

test('a URL from stderr moves the manager to ready and emits url + state', () => {
  const { manager, spawned } = makeManager(null)
  const events = record(manager, ['url', 'state'])
  manager.start()
  assert.equal(manager.state, 'starting')
  spawned[0].child.stderr.write('INF |  https://quick-example.trycloudflare.com  |\n')
  assert.equal(manager.state, 'ready')
  assert.equal(manager.url, 'https://quick-example.trycloudflare.com')
  assert.deepEqual(events.url.map(e => e.url), ['https://quick-example.trycloudflare.com'])
  assert.equal(events.url[0].permanent, false, 'a quick tunnel hostname is never permanent')
  assert.ok(events.state.some(e => e.state === 'starting'))
  assert.ok(events.state.some(e => e.state === 'ready'))
  manager.stop()
})

test('a URL split across two chunks is still parsed (streams are read incrementally)', () => {
  const { manager, spawned } = makeManager(null)
  manager.start()
  // A full pipe would have blocked cloudflared, and a line-boundary parser would
  // have missed this URL entirely.
  spawned[0].child.stdout.write('INF |  https://split-ch')
  spawned[0].child.stdout.write('unk-name.trycloudflare.com  |\n')
  assert.equal(manager.url, 'https://split-chunk-name.trycloudflare.com')
  manager.stop()
})

test('stdout is drained as well as stderr', () => {
  const { manager, spawned } = makeManager(null)
  const logs = record(manager, ['log'])
  manager.start()
  spawned[0].child.stdout.write('INF version 2026.10.0\n')
  spawned[0].child.stderr.write('INF some diagnostic\n')
  assert.equal(logs.log.filter(e => e.source === 'stdout').length, 1)
  assert.equal(logs.log.filter(e => e.source === 'stderr').length, 1)
  manager.stop()
})

test('the connection-registered marker is recorded as a readiness signal', () => {
  const { manager, spawned } = makeManager(null)
  const events = record(manager, ['ready'])
  manager.start()
  assert.equal(manager.connectionRegistered, false)
  spawned[0].child.stderr.write('INF |  https://marker-test.trycloudflare.com  |\n')
  assert.equal(manager.state, 'ready')
  // The URL alone marks the tunnel usable; the marker can arrive later.
  assert.equal(events.ready.length, 0)
  spawned[0].child.stderr.write('INF Registered tunnel connection connIndex=0 ip=198.41.200.193 location=tpe01\n')
  assert.equal(manager.connectionRegistered, true)
  assert.equal(events.ready.length, 1)
  assert.equal(events.ready[0].url, 'https://marker-test.trycloudflare.com')
  // Repeating the line must not emit twice.
  spawned[0].child.stderr.write('INF Registered tunnel connection connIndex=0\n')
  assert.equal(events.ready.length, 1)
  manager.stop()
})

test('the marker alone is not enough to publish a URL', () => {
  const { manager, spawned } = makeManager(null)
  manager.start()
  spawned[0].child.stderr.write('INF Registered tunnel connection connIndex=0\n')
  assert.equal(manager.connectionRegistered, true)
  assert.equal(manager.url, null, 'without a hostname there is nothing for a phone to dial')
  manager.stop()
})

test('a second URL after a restart is emitted again with previousUrl set', () => {
  const { manager, spawned } = makeManager(null)
  const events = record(manager, ['url'])
  manager.start()
  spawned[0].child.stderr.write('INF |  https://first-name.trycloudflare.com  |\n')
  spawned[0].child.exit(1)
  assert.equal(manager.state, 'restarting')
  return waitFor(() => spawned.length === 2, 1000, 'second spawn').then(async () => {
    spawned[1].child.stderr.write('INF |  https://second-name.trycloudflare.com  |\n')
    assert.deepEqual(events.url.map(e => e.url), [
      'https://first-name.trycloudflare.com',
      'https://second-name.trycloudflare.com',
    ])
    assert.equal(events.url[1].previousUrl, 'https://first-name.trycloudflare.com')
    assert.equal(manager.url, 'https://second-name.trycloudflare.com')
  }).finally(() => manager.stop())
})

test('exit after a drop schedules an exponential-backoff restart', async () => {
  const { manager, spawned } = makeManager(null, { maxConsecutiveFailures: 6 })
  manager.start()
  assert.equal(manager.backoffDelayMs(1), 5)
  assert.equal(manager.backoffDelayMs(2), 10)
  assert.equal(manager.backoffDelayMs(3), 20)
  assert.equal(manager.backoffDelayMs(4), 20, 'capped at backoffMaxMs')
  spawned[0].child.exit(1)
  assert.equal(manager.state, 'restarting') // never a bare 'starting' after a drop
  await waitFor(() => spawned.length === 2, 1000, 'restart spawn')
  assert.deepEqual(manager.restartHistory[0], { consecutive: 1, delayMs: 5, rateLimited: false })
  manager.stop()
})

test('the documented production backoff is 1s, 2s, 4s … capped at 60s', () => {
  const { manager } = makeManager(null, { backoffStartMs: 1000, backoffMaxMs: 60_000 })
  assert.deepEqual([1, 2, 3, 4, 7].map(n => manager.backoffDelayMs(n)), [1000, 2000, 4000, 8000, 60_000])
  manager.stop()
})

test('rate-limit signals are classified and punished with a longer backoff', () => {
  const { manager, spawned } = makeManager(null, { backoffStartMs: 5, backoffMaxMs: 60_000, maxConsecutiveFailures: 6 })
  manager.start()
  spawned[0].child.stderr.write('ERR Failed to create tunnel: 429 Too Many Requests\n')
  assert.equal(manager.reason, TUNNEL_REASON.RATE_LIMITED)
  assert.equal(manager.backoffDelayMs(1, true), 5 * RATE_LIMITED_BACKOFF_MULTIPLIER)
  assert.equal(manager.backoffDelayMs(2, true), 10 * RATE_LIMITED_BACKOFF_MULTIPLIER)
  assert.equal(manager.backoffDelayMs(30, true), 60_000, 'still capped by backoffMaxMs')
  // And the cap must never make a rate-limited round *shorter* than an ordinary one.
  assert.ok(manager.backoffDelayMs(10, true) >= manager.backoffDelayMs(10, false))
  spawned[0].child.exit(1)
  assert.deepEqual(manager.restartHistory[0], { consecutive: 1, delayMs: 20, rateLimited: true })
  manager.stop()
})

test('the supervisor parks in failed after too many consecutive failures', async () => {
  // maxConsecutiveFailures=2 means three death-and-respawn cycles, then stop:
  // a crash loop is what trips Cloudflare's per-IP creation limit (~20 tunnels
  // per 30 minutes, community measurement).
  const { manager, spawned } = makeManager(null, { maxConsecutiveFailures: 2 })
  const errors = record(manager, ['error'])
  manager.start()
  spawned[0].child.exit(1)
  await waitFor(() => spawned.length === 2, 1000, 'restart 1')
  spawned[1].child.exit(1)
  await waitFor(() => spawned.length === 3, 1000, 'restart 2')
  spawned[2].child.exit(1)
  await waitFor(() => manager.state === 'failed', 1000, 'park in failed')
  assert.match(String(manager.lastError), /停止自动重启/)
  assert.equal(errors.error.length >= 1, true)
  // No further spawn may happen after parking.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(spawned.length, 3)
  manager.stop()
})

test('a start timeout fails with an actionable message and does not loop', async () => {
  const { manager, spawned } = makeManager(null, { startTimeoutMs: 30 })
  const events = record(manager, ['error', 'state'])
  manager.start()
  await waitFor(() => manager.state === 'failed', 1000, 'start timeout')
  assert.equal(manager.reason, TUNNEL_REASON.START_TIMEOUT)
  assert.match(String(manager.lastError), /启动超时/)
  assert.match(String(manager.lastError), /30 秒内没有拿到公网地址|0.03 秒/)
  assert.equal(events.error.length, 1)
  // The kill produced an exit event; it must not be re-read as a fresh fault.
  spawned[0].child.exit(null, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(spawned.length, 1, 'a timeout must not auto-restart')
  assert.equal(DEFAULT_START_TIMEOUT_MS, 30_000, 'the documented default is 30s')
  manager.stop()
})

test('a missing binary degrades to a structured failure, never a throw', () => {
  const manager = new TunnelManager({
    platform: 'win32',
    resolveBinary: () => ({
      available: false,
      path: null,
      version: null,
      source: null,
      error: '未找到可用的 cloudflared 二进制。',
      installHint: '请下载 cloudflared',
      checked: [{ path: 'x', source: 'path', ok: false, error: '文件不存在' }],
    }),
    spawn: () => assert.fail('must not spawn without a binary'),
  })
  const result = manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.reason, TUNNEL_REASON.NOT_INSTALLED)
  assert.equal(result.installHint, '请下载 cloudflared')
  assert.equal(manager.state, 'failed')
  assert.equal(manager.status().state, 'failed')
  const status = manager.status()
  assert.equal(status.reason, 'cloudflared-missing')
  assert.equal(status.url, null)
})

test('stop is idempotent, kills the tree, and permanently suppresses restarts', async () => {
  const { manager, spawned, kills } = makeManager(null, { maxConsecutiveFailures: 6 })
  manager.start()
  spawned[0].child.stderr.write('INF |  https://stop-test.trycloudflare.com  |\n')
  const first = manager.stop()
  assert.equal(first.stopped, true)
  assert.equal(first.wasRunning, true)
  assert.equal(manager.state, 'stopped')
  assert.equal(manager.url, null)
  assert.equal(kills.length, 1)
  assert.equal(kills[0].signal, 'SIGTERM')
  assert.equal(kills[0].child.killCalls, 1)

  // The child's own exit event arrives after stop(); it must not resurrect anything.
  spawned[0].child.exit(null, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(spawned.length, 1, 'no restart after stop()')
  assert.equal(manager.state, 'stopped')

  const second = manager.stop()
  assert.equal(second.stopped, true)
  assert.equal(second.wasRunning, false, 'a second stop reports nothing was running')
})

test('stop cancels a pending restart timer', async () => {
  const { manager, spawned } = makeManager(null, { backoffStartMs: 40, backoffMaxMs: 40, maxConsecutiveFailures: 6 })
  manager.start()
  spawned[0].child.exit(1)
  assert.equal(manager.state, 'restarting')
  manager.stop()
  assert.equal(manager.state, 'stopped')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(spawned.length, 1, 'the scheduled restart must be cancelled')
})

test('restart() retries after a failure but refuses while running', () => {
  const resolved = []
  const manager = new TunnelManager({
    platform: 'win32',
    startTimeoutMs: 5000,
    killTree: child => child.kill?.(),
    resolveBinary: () => {
      resolved.push(Date.now())
      if (resolved.length === 1) return { available: false, error: '没找到', installHint: 'hint', checked: [] }
      return { available: true, path: 'C:\\later\\cloudflared.exe', version: '2026.10.0', source: 'path' }
    },
    spawn: () => fakeChild(),
  })
  assert.equal(manager.start().ok, false)
  assert.equal(manager.state, 'failed')
  const retry = manager.restart()
  assert.equal(retry.ok, true, 'restart must re-probe the binary')
  assert.equal(manager.state, 'starting')
  assert.equal(resolved.length, 2)
  const refused = manager.restart()
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'already-running')
  manager.stop()
  manager.stop()
})

test('start() during a live tunnel is a no-op rather than a second process', () => {
  const { manager, spawned } = makeManager(null)
  manager.start()
  const again = manager.start()
  assert.equal(again.ok, true)
  assert.match(String(again.message), /忽略重复启动/)
  assert.equal(spawned.length, 1)
  manager.stop()
})

test('a spawn failure is reported, not thrown', () => {
  const manager = new TunnelManager({
    platform: 'win32',
    binaryPath: 'C:\\fake\\cloudflared.exe',
    spawn: () => {
      throw new Error('EACCES')
    },
    killTree: () => {},
  })
  const events = record(manager, ['error'])
  const result = manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.reason, TUNNEL_REASON.SPAWN_FAILED)
  assert.equal(manager.state, 'failed')
  assert.equal(events.error.length, 1)
})

test('killTree receives SIGTERM on a normal stop and SIGTERM only once', () => {
  const { manager, spawned, kills } = makeManager(null)
  manager.start()
  spawned[0].child.stderr.write('INF |  https://kill-tree.trycloudflare.com  |\n')
  manager.stop()
  assert.equal(kills.length, 1)
  assert.equal(kills[0].signal, 'SIGTERM')
  assert.equal(kills[0].child.pid, 1000)
  // stop() is idempotent: no second kill for an already-reaped child.
  manager.stop()
  assert.equal(kills.length, 1)
})

test('a custom killTree seam is always used instead of touching the child directly', () => {
  const seen = []
  const { manager, spawned } = makeManager(null, { killTree: (child, signal) => seen.push({ pid: child.pid, signal }) })
  manager.start()
  manager.stop()
  assert.deepEqual(seen, [{ pid: spawned[0].child.pid, signal: 'SIGTERM' }])
  assert.equal(spawned[0].child.killed, false, 'the injected killer decides how to die')
})
