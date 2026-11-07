// Assert what `npm pack` would actually publish for the plugin.
//
// The plugin is installed by copying a tarball into a DSH profile, so a file this
// list forgets is not a build warning — it is a user whose plugin 404s every web
// asset, or fails to load because `lib/` did not ship. `scripts/build-plugin-package.mjs`
// stages `release/npm-package/` with a patched `files` allow-list; `npm publish` then
// honours that list, which is exactly why the list itself has to be checked against
// the real packer instead of being trusted.
//
// Required in the tarball: `package.json`, `cordis.patch.yml`, the `main` entry,
// something under `src/`, something under `lib/`, and `webchat/index.html` +
// `webchat/app.js` (served at `/openwhale/app`).
// Forbidden: anything named `test` (a directory or file), `*.test.mjs`, `node_modules`.
//
// Usage:
//   node scripts/check-npm-package.mjs [dir]        # default: release/npm-package
//   node scripts/check-npm-package.mjs --pack-json <file>   # offline: validate a saved pack list
//
// The `--pack-json` escape hatch exists because this repository has to be reviewable
// without a registry or a local npm; CI always takes the real `npm pack` path.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const argv = process.argv.slice(2)
let dirArg = ''
let packJsonArg = ''
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--pack-json') packJsonArg = argv[++i] ?? ''
  else if (!argv[i].startsWith('--')) dirArg = argv[i]
}
const packageDir = resolve(root, dirArg || 'release/npm-package')

const failures = []
let checks = 0
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  checks += 1
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** @param {string} path */
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** @returns {Array<{files: Array<{path: string}>, filename?: string, version?: string}>} */
function readPackList() {
  if (packJsonArg) {
    const raw = readFileSync(resolve(root, packJsonArg), 'utf8')
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw)
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 120_000,
    shell: process.platform === 'win32',
  })
  if (result.error) {
    console.error(`cannot run \`npm pack --dry-run\`: ${result.error.message}`)
    console.error('If npm is unavailable here, run with --pack-json <file> instead.')
    process.exit(2)
  }
  const stdout = result.stdout ?? ''
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (result.status !== 0 || start < 0 || end < start) {
    console.error('`npm pack --dry-run --json` did not produce a pack list')
    console.error(stdout)
    console.error(result.stderr ?? '')
    process.exit(1)
  }
  return JSON.parse(stdout.slice(start, end + 1))
}

let stagedPkg
try {
  stagedPkg = readJson(join(packageDir, 'package.json'))
} catch (error) {
  console.error(`cannot read ${join(packageDir, 'package.json')}: ${error.message}`)
  console.error('Run `node scripts/build-plugin-package.mjs --npm-dir` first.')
  process.exit(1)
}

const repoVersion = readJson(join(root, 'package.json')).version
check(
  `staged package version matches the repository (${repoVersion})`,
  stagedPkg.version === repoVersion,
  `staged=${stagedPkg.version}`,
)

let packs
try {
  packs = readPackList()
} catch (error) {
  console.error(`cannot read the pack list: ${error.message}`)
  process.exit(1)
}

const pack = Array.isArray(packs) ? packs[0] : packs
if (!pack) {
  console.error('npm pack returned an empty list')
  process.exit(1)
}
const files = (pack.files ?? []).map(entry => String(entry.path).replaceAll('\\', '/'))
check('npm pack lists files', files.length > 0, `${files.length} files`)
check(
  'packed filename carries name and version',
  !pack.filename || pack.filename === `${stagedPkg.name}-${stagedPkg.version}.tgz`,
  pack.filename,
)

const segments = path => path.split('/')
const main = String(stagedPkg.main ?? 'src/index.mjs').replaceAll('\\', '/')
const required = [
  'package.json',
  'cordis.patch.yml',
  main,
  'webchat/index.html',
  'webchat/app.js',
]
for (const path of required) {
  check(`tarball contains ${path}`, files.includes(path))
}
check(
  'tarball contains src/ modules',
  files.some(path => path.startsWith('src/') && path.endsWith('.mjs')),
  files.filter(path => path.startsWith('src/')).length + ' src files',
)
check(
  'tarball contains lib/ files',
  files.some(path => path.startsWith('lib/')),
  files.filter(path => path.startsWith('lib/')).length + ' lib files',
)

// Everything the manifest exports has to be in the tarball: `./client` points at
// `lib/client.js` (the browser client), and a copy-installed plugin resolves the
// export, not a repository path.
const exported = Object.values(stagedPkg.exports ?? {})
  .flatMap(target => (typeof target === 'string' ? [target] : Object.values(target ?? {})))
  .filter(target => typeof target === 'string' && target.startsWith('./'))
  .map(target => target.slice(2))
for (const target of exported) {
  check(`tarball contains exported ${target}`, files.includes(target))
}

const leaked = files.filter(
  path => segments(path).includes('test') || path.endsWith('.test.mjs') || segments(path).includes('node_modules'),
)
check('tarball contains no test files', leaked.length === 0, leaked.join(', '))

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} npm package check(s) failed:`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('\nnpm package check FAILED')
  process.exit(1)
}
console.log(`npm package check OK (${checks} checks, ${files.length} files)`)
