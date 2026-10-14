// Cross-platform contract for the cloudflared path logic.
//
// These exist because the module takes an explicit `platform` describing the
// machine being *managed*, which is not always the machine the code runs on — the
// plugin targets Windows while CI exercises the suite on Linux and macOS. An
// earlier implementation used `node:path.join`, which follows the *running*
// platform, so on Linux CI it built `C:\cache/cloudflared.exe` and discovery found
// nothing. The tests below fail on any host if that regresses, which is the point:
// they are the only local check that does not require the second OS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultCacheDir, resolveCloudflared } from '../src/tunnel.mjs'

test('windows-shaped candidates keep backslashes even when built on another OS', () => {
  const seen = []
  resolveCloudflared({
    env: { CLOUDFLARED_BIN: 'C:\\broken\\cloudflared.exe', PATH: 'C:\\nope' },
    cacheDir: 'C:\\cache',
    platform: 'win32',
    isFile: path => {
      seen.push(path)
      return false
    },
    readdir: () => ['cloudflared-2026.10.0.exe'],
  })
  assert.ok(seen.length > 0, 'candidates must be probed')
  for (const path of seen) {
    assert.equal(path.includes('/'), false, `windows candidate must not contain a forward slash: ${path}`)
  }
  assert.ok(seen.includes('C:\\cache\\cloudflared-2026.10.0.exe'), `cache entry not built as expected: ${seen.join(', ')}`)
  assert.ok(seen.includes('C:\\nope\\cloudflared.exe'), `PATH entry not built as expected: ${seen.join(', ')}`)
})

test('posix-shaped candidates keep forward slashes even when built on Windows', () => {
  const seen = []
  resolveCloudflared({
    env: { PATH: '/usr/local/bin:/usr/bin' },
    cacheDir: '/home/u/.cache/openwhale/cloudflared',
    platform: 'linux',
    isFile: path => {
      seen.push(path)
      return false
    },
    readdir: () => ['cloudflared-2026.10.0'],
  })
  assert.ok(seen.length > 0, 'candidates must be probed')
  for (const path of seen) {
    assert.equal(path.includes('\\'), false, `posix candidate must not contain a backslash: ${path}`)
  }
  assert.ok(seen.includes('/home/u/.cache/openwhale/cloudflared/cloudflared-2026.10.0'))
  assert.ok(seen.includes('/usr/bin/cloudflared'))
})

test('the win32 cache directory is built with win32 separators', () => {
  const dir = defaultCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
  assert.equal(dir, 'C:\\Users\\u\\AppData\\Local\\openwhale\\cloudflared')
})

test('the linux cache directory is built with posix separators', () => {
  const dir = defaultCacheDir('linux', { XDG_CACHE_HOME: '/home/u/.cache' })
  assert.equal(dir, '/home/u/.cache/openwhale/cloudflared')
})

test('a broken env override falls through to a working cache copy, on any host', () => {
  // Same intent as the original test, but with a cache directory shaped for the
  // target platform so it asserts the fallback rather than the separator style.
  const result = resolveCloudflared({
    env: { CLOUDFLARED_BIN: 'C:\\broken\\cloudflared.exe', PATH: 'C:\\nope' },
    cacheDir: 'C:\\cache',
    platform: 'win32',
    isFile: path => path === 'C:\\broken\\cloudflared.exe' || path === 'C:\\cache\\cloudflared-2026.10.0.exe',
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
  assert.equal(result.error, null)
})

test('discovery still succeeds when the cache directory cannot be listed', () => {
  const result = resolveCloudflared({
    env: { PATH: '/usr/local/bin' },
    cacheDir: '/nonexistent/cache',
    platform: 'linux',
    isFile: path => path === '/usr/local/bin/cloudflared',
    readdir: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
    probeDeps: { execFileSync: () => 'cloudflared version 2026.10.0' },
  })
  assert.equal(result.available, true)
  assert.equal(result.path, '/usr/local/bin/cloudflared')
  assert.equal(result.source, 'path')
})

test('a real file on this host is discovered through the real filesystem', () => {
  // End-to-end sanity with no seams except the version probe: a genuine file in a
  // genuine directory must be found, on whatever platform runs the suite.
  const dir = mkdtempSync(join(tmpdir(), 'openwhale-tunnel-'))
  try {
    mkdirSync(dir, { recursive: true })
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    writeFileSync(join(dir, name), '#!/bin/sh\necho "cloudflared version 2026.10.0"\n')
    const result = resolveCloudflared({
      env: { PATH: dir },
      cacheDir: join(dir, 'cache'),
      platform: process.platform,
      probeDeps: { execFileSync: () => 'cloudflared version 2026.10.0' },
    })
    assert.equal(result.available, true)
    assert.ok(result.path.endsWith(name), `expected to find ${name}, got ${result.path}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
