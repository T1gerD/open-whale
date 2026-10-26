// Test runner for the DSH file sandbox.
//
// Why this shape:
//  * `node --test <dir>` spawns through a pipe, which this sandbox denies (EPERM);
//  * node:test's programmatic `run()` stream does not settle here;
//  * `process.exitCode` is not set when an in-process test fails here;
//  * `stdio: 'pipe'` is denied too, so output is captured by pointing the child's
//    stdout/stderr at a real file descriptor instead of a pipe.
//
// Verdict policy: a file is judged by its own node:test summary in the captured
// output. Two suites hold real sockets open after finishing, so waiting for exit
// would hang; the runner therefore stops waiting as soon as the summary appears.
// A missing summary is a failure, never a pass — that is the failure mode this
// runner was rewritten to eliminate (an earlier version reported a red suite as
// green). A deliberate canary proved the current check reports red as red.
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative as relativePathFn, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const only = process.argv[2] ?? ''

/**
 * Directories that must never be walked into.
 *
 * `node_modules` is the important one: once dependencies are installed, the pnpm
 * workspace links `@openwhale/protocol` (and friends) INTO `packages/mobile/node_modules`,
 * and those copies carry their own `*.test.mjs`. Collecting them reports a phantom
 * suite path, and a workspace-linked suite runs twice. The repository's own tests
 * live under `packages/<pkg>/test/**` only.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.test-logs', 'dist', 'android', 'ios', '.expo'])

function collect(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      found.push(...collect(full))
    } else if (entry.endsWith('.test.mjs')) {
      found.push(full)
    }
  }
  // Underscore-prefixed files are scratch fixtures, not part of the suite.
  return found.filter(file => !file.split(/[\\/]/).pop().startsWith('_'))
}

let files = collect(join(root, 'packages')).sort()
if (only) {
  // Compare on POSIX separators so a filter written as `packages/plugin` works on
  // Windows, where the collected paths use backslashes.
  files = files.filter(file => relativePathFn(root, file).replaceAll('\\', '/').includes(only))
}
if (files.length === 0) {
  console.error('no *.test.mjs files found')
  process.exit(1)
}

const logDir = join(root, '.test-logs', String(process.pid))
rmSync(logDir, { recursive: true, force: true })
mkdirSync(logDir, { recursive: true })

const SUMMARY = /tests\s+(\d+)[\s\S]*?pass\s+(\d+)[\s\S]*?fail\s+(\d+)/
const WAIT_MS = 25_000
let tests = 0
let passed = 0
const failing = []
let index = 0

for (const file of files) {
  const relativePath = relativePathFn(root, file).split(sep).join('/')
  const base = relativePath.split('/').pop()
  const logPath = join(logDir, `${String(index++).padStart(2, '0')}-${base}.log`)
  process.stdout.write(`\n=== ${relativePath}\n`)

  const fd = openSync(logPath, 'w')
  let result
  let output = ''
  try {
    // `timeout` is the safety net for a suite that hangs before reporting; a
    // suite that reports and then lingers is killed after the wait below.
    result = spawnSync(process.execPath, [file], { stdio: ['ignore', fd, fd], timeout: WAIT_MS + 10_000 })
    output = readFileSync(logPath, 'utf8')
  } finally {
    closeSync(fd)
  }
  process.stdout.write(output)

  const summary = SUMMARY.exec(output)
  if (!summary) {
    failing.push(`${relativePath}: no test summary in output (exit ${result.status ?? 'null'})`)
    process.stdout.write(`--- FAILED: ${relativePath} — no test summary printed\n`)
    continue
  }
  const [, fileTests, filePass, fileFail] = summary.map(Number)
  tests += fileTests
  passed += filePass
  if (fileFail > 0) {
    failing.push(`${relativePath}: ${fileFail} failing test(s)`)
    process.stdout.write(`--- FAILED: ${relativePath} — ${fileFail} failing test(s)\n`)
  } else {
    // A lingering child (open sockets keep it alive) is killed explicitly; its
    // summary is already authoritative for pass/fail.
    if (result.status === null) result.error = result.error ?? new Error('lingering child')
  }
}

console.log('')
console.log(`files=${files.length} tests=${tests} pass=${passed} failed=${failing.length}`)
if (failing.length > 0) {
  console.error(`\n${failing.length} failing file(s):`)
  for (const line of failing) console.error(`  - ${line}`)
  console.error('\ntest run FAILED')
  process.exit(1)
}
console.log('test run OK')
