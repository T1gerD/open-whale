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
// output, and by the exit status of the child that printed it.
//  * a missing summary is a failure, never a pass;
//  * a summary reporting failing tests is a failure;
//  * a summary reporting `fail 0` is only a pass when the child really exited 0.
//    A child that prints a clean summary and then exits non-zero (a late uncaught
//    exception, a rejecting `after()` hook, a bare `process.exit(1)`) is a
//    failure and the exit code is printed — this used to be reported as green
//    because the exit status was never consulted;
//  * the one exception is `status === null`: the child never exited because a
//    handle (an open socket) kept its loop alive and the timeout killed it. The
//    summary is then the only verdict available and the kill is reported
//    explicitly, so a timeout can never silently pass.
//
// `--self-test` proves both directions end to end through this same runner: one
// fixture prints a passing summary and then exits 1 (must be red), another really
// passes (must stay green). CI runs it right after the real suite; it needs no
// dependencies. `OPENWHALE_TEST_ROOT=<dir>` points the walker at a fixture tree
// and is what the self-test uses to invoke the CLI.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative as relativePathFn, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const selfTest = argv.includes('--self-test')
const only = argv.find(arg => !arg.startsWith('--')) ?? ''

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

/** What is walked. `OPENWHALE_TEST_ROOT` exists for `--self-test` fixtures. */
const suiteRoot = process.env.OPENWHALE_TEST_ROOT ? resolve(process.env.OPENWHALE_TEST_ROOT) : join(root, 'packages')

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

const logDir = join(root, '.test-logs', String(process.pid))
rmSync(logDir, { recursive: true, force: true })
mkdirSync(logDir, { recursive: true })

// `tests / pass / fail` plus the optional `cancelled` counter. Cancellation is its
// own verdict (see `judge`): a file whose event loop drains mid-suite reports
// `fail 0` and still hands back most of its tests as never-run.
const SUMMARY = /tests\s+(\d+)[\s\S]*?pass\s+(\d+)[\s\S]*?fail\s+(\d+)(?:[\s\S]*?cancelled\s+(\d+))?/
const WAIT_MS = 25_000

/** `exit 3`, or `killed (SIGTERM)` when the child never exited. */
function exitLabel(run) {
  return run.status !== null ? `exit ${run.status}` : `killed (${run.signal ?? 'timeout'})`
}

/**
 * Spawn a node process with its stdout/stderr on a real file descriptor.
 *
 * Pipes are denied in this sandbox, which is why this exists at all. `timeout` is
 * the safety net for a suite that hangs before reporting.
 * @param {string[]} args argv for the child (node is the executable).
 * @param {string} logPath file the child writes both streams to.
 * @param {Record<string,string>} [env] extra environment for the child.
 */
function runProcess(args, logPath, env = {}) {
  const fd = openSync(logPath, 'w')
  try {
    const result = spawnSync(process.execPath, args, {
      stdio: ['ignore', fd, fd],
      timeout: WAIT_MS + 10_000,
      env: { ...process.env, ...env },
    })
    return {
      status: result.status,
      signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT',
      output: readFileSync(logPath, 'utf8'),
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Decide one file. Pure, so the self-test can feed it a captured run.
 * @param {string} label path shown to the reader.
 * @param {{status: number|null, signal: string|null, output: string}} run
 * @returns {{ok: boolean, tests: number, pass: number, reason: string, note?: string}}
 */
function judge(label, run) {
  const summary = SUMMARY.exec(run.output)
  if (!summary) {
    return { ok: false, tests: 0, pass: 0, reason: `no test summary in output (${exitLabel(run)})` }
  }
  const fileTests = Number(summary[1])
  const filePass = Number(summary[2])
  const fileFail = Number(summary[3])
  if (fileFail > 0) {
    return { ok: false, tests: fileTests, pass: filePass, reason: `${fileFail} failing test(s) (${exitLabel(run)})` }
  }
  const fileCancelled = summary[4] === undefined ? 0 : Number(summary[4])
  if (fileCancelled > 0) {
    // The suite stopped halfway: node:test cancelled everything still queued
    // because the event loop drained ("Promise resolution is still pending but
    // the event loop has already resolved"). Those tests never ran, so `fail 0`
    // says nothing about them — this is red, and the reason names the count so
    // the next reader does not have to decode an exit code 1.
    return {
      ok: false,
      tests: fileTests,
      pass: filePass,
      reason: `${fileCancelled} test(s) cancelled — the event loop drained before they ran (${exitLabel(run)})`,
    }
  }
  if (run.status !== null && run.status !== 0) {
    // The summary lied (or the crash happened after it): the exit status is part
    // of the contract, so this is a failure with the code spelled out.
    return {
      ok: false,
      tests: fileTests,
      pass: filePass,
      reason: `summary reports 0 failures but the child exited with code ${run.status}`,
    }
  }
  if (run.status === null) {
    return {
      ok: true,
      tests: fileTests,
      pass: filePass,
      note: `summary accepted, child was killed after reporting (${run.signal ?? 'timeout'})`,
    }
  }
  return { ok: true, tests: fileTests, pass: filePass, reason: '' }
}

/** Run every collected suite; returns true when the whole run is green. */
function runAll() {
  if (!existsSync(suiteRoot)) {
    console.error(`test root does not exist: ${suiteRoot}`)
    return false
  }
  let files = collect(suiteRoot).sort()
  if (only) {
    // Compare on POSIX separators so a filter written as `packages/plugin` works on
    // Windows, where the collected paths use backslashes.
    files = files.filter(file => relativePathFn(root, file).replaceAll('\\', '/').includes(only))
  }
  if (files.length === 0) {
    console.error(`no *.test.mjs files found under ${relativePathFn(root, suiteRoot) || suiteRoot}`)
    return false
  }

  let tests = 0
  let passed = 0
  const failing = []
  let index = 0
  for (const file of files) {
    const relativePath = relativePathFn(root, file).split(sep).join('/')
    const base = relativePath.split('/').pop()
    const logPath = join(logDir, `${String(index++).padStart(2, '0')}-${base}.log`)
    process.stdout.write(`\n=== ${relativePath}\n`)

    const run = runProcess([file], logPath)
    process.stdout.write(run.output)

    const verdict = judge(relativePath, run)
    tests += verdict.tests
    passed += verdict.pass
    if (!verdict.ok) {
      failing.push(`${relativePath}: ${verdict.reason}`)
      process.stdout.write(`--- FAILED: ${relativePath} — ${verdict.reason}\n`)
    } else if (verdict.note) {
      process.stdout.write(`--- ${relativePath}: ${verdict.note}\n`)
    }
  }

  console.log('')
  console.log(`files=${files.length} tests=${tests} pass=${passed} failed=${failing.length}`)
  if (failing.length > 0) {
    console.error(`\n${failing.length} failing file(s):`)
    for (const line of failing) console.error(`  - ${line}`)
    console.error('\ntest run FAILED')
    return false
  }
  console.log('test run OK')
  return true
}

/**
 * Self-test: generate fixtures whose verdict is known and assert the runner's
 * behaviour on them. Guards the exact regression this file was rewritten for —
 * a summary printed by a process that then failed must not be a pass.
 */
function runSelfTest() {
  const fixtureRoot = join(logDir, 'self-test-fixtures')
  const greenDir = join(fixtureRoot, 'green')
  const redDir = join(fixtureRoot, 'red')
  mkdirSync(greenDir, { recursive: true })
  mkdirSync(redDir, { recursive: true })

  const greenFile = join(greenDir, 'really-passes.test.mjs')
  writeFileSync(greenFile, [
    "import { test } from 'node:test'",
    "test('nothing to see here, this one is meant to pass', () => {})",
    '',
  ].join('\n'))

  const redFile = join(redDir, 'summary-then-exit-1.test.mjs')
  writeFileSync(redFile, [
    '// The shape that used to be reported as green: a full node:test summary with',
    '// `fail 0`, printed by a process that then exits non-zero.',
    "console.log('\\u2139 tests 1\\n\\u2139 pass 1\\n\\u2139 fail 0\\n\\u2139 duration_ms 1.0')",
    'process.exit(1)',
    '',
  ].join('\n'))

  const checks = []
  /** @param {string} name @param {boolean} ok @param {string} [detail] */
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // 1. The verdict itself, on the captured run of the red fixture.
  const redRun = runProcess([redFile], join(logDir, 'self-test-red-fixture.log'))
  const redVerdict = judge('red/summary-then-exit-1.test.mjs', redRun)
  check(
    'verdict: "summary + exit 1" is red for the exit code',
    redVerdict.ok === false && redRun.status === 1 && redVerdict.reason.includes('exited with code 1'),
    `ok=${redVerdict.ok} status=${redRun.status} reason=${redVerdict.reason}`,
  )

  // 2. A cancelled suite is red on its own, even when the child somehow exits 0:
  //    `fail 0` only describes the tests that ran, and cancelled ones never did.
  //    This is the shape that let `dsh-bridge.test.mjs` look like "0 failures"
  //    while 42 of its 90 tests never executed on Node 22.
  const cancelledVerdict = judge('cancelled/x.test.mjs', {
    status: 0,
    signal: null,
    output: '\u2139 tests 3\n\u2139 pass 2\n\u2139 fail 0\n\u2139 cancelled 1\n',
  })
  check(
    'verdict: cancelled tests are red even on exit 0',
    cancelledVerdict.ok === false && cancelledVerdict.reason.includes('cancelled'),
    `ok=${cancelledVerdict.ok} reason=${cancelledVerdict.reason}`,
  )

  // 3. End to end through the CLI: the aggregate run must exit 1 and say why.
  const redCli = runProcess([selfPath], join(logDir, 'self-test-cli-red.log'), { OPENWHALE_TEST_ROOT: redDir })
  check(
    'runner CLI: exits 1 on the red fixture',
    redCli.status === 1 &&
      redCli.output.includes('test run FAILED') &&
      redCli.output.includes('exited with code 1') &&
      redCli.output.includes('summary-then-exit-1.test.mjs:'),
    `status=${redCli.status}`,
  )

  // 4. The same CLI on a genuinely passing fixture must stay green, so the
  //    self-test cannot pass just by always failing.
  const greenCli = runProcess([selfPath], join(logDir, 'self-test-cli-green.log'), { OPENWHALE_TEST_ROOT: greenDir })
  check(
    'runner CLI: stays green on a passing fixture',
    greenCli.status === 0 && greenCli.output.includes('test run OK') && greenCli.output.includes('files=1'),
    `status=${greenCli.status}`,
  )

  rmSync(redDir, { recursive: true, force: true })
  rmSync(greenDir, { recursive: true, force: true })

  const failed = checks.filter(entry => !entry.ok)
  console.log('')
  console.log(`self-test: ${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.error('self-test FAILED — the runner cannot be trusted until this is fixed')
    return false
  }
  console.log('self-test OK')
  return true
}

process.exit((selfTest ? runSelfTest() : runAll()) ? 0 : 1)
