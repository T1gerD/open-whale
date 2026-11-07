// Version / documentation gate.
//
// The 3.0.0 release review found the docs drifting away from the code: README
// and PUBLISHING quoted different test counts, a tarball name carried an older
// version, and the release instructions could point at an asset that no release
// ever produced. None of that breaks the build, so nothing caught it — these
// checks are cheap enough to run on every CI job.
//
// Checks (all read-only):
//   1. versions: the five package.json manifests and `app.json`'s `expo.version`
//      are identical (the release job only knows how to assert plugin vs mobile);
//   2. artifact names: every `dsh-openwhale-<v>.tgz` / `open-whale-<v>.apk` in
//      README.md and docs/PUBLISHING.md carries the current version, and both
//      versioned names are still present (a silently dropped row is drift too);
//   3. tag instructions: `git tag v…` / `git push … origin v…` lines point at the
//      current version, so a copy-pasted release command cannot tag the wrong sha;
//   4. test counts: the counts README and PUBLISHING quote agree with each other
//      (they are derived from an actual `node scripts/run-tests.mjs` run and only
//      drift when someone bumps one file and forgets the other).
//
// Usage: node scripts/check-docs.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** @param {string} path @returns {any} */
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const readText = path => readFileSync(join(root, path), 'utf8')

/** Where the version lives in each manifest (app.json nests it under `expo`). */
const VERSION_SOURCES = [
  { path: 'package.json', pick: json => json.version },
  { path: 'packages/plugin/package.json', pick: json => json.version },
  { path: 'packages/mobile/package.json', pick: json => json.version },
  { path: 'packages/protocol/package.json', pick: json => json.version },
  { path: 'packages/webchat/package.json', pick: json => json.version },
  { path: 'packages/mobile/app.json', pick: json => json.expo?.version },
]

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

// ---------------------------------------------------------------------------
// 1. one version everywhere
// ---------------------------------------------------------------------------
const versions = new Map()
for (const { path, pick } of VERSION_SOURCES) {
  let version
  try {
    version = String(pick(readJson(path)) ?? '')
  } catch (error) {
    check(`version readable from ${path}`, false, String(error.message))
    continue
  }
  check(`version readable from ${path}`, /^\d+\.\d+\.\d+/.test(version), version || '(missing)')
  versions.set(path, version)
}
const distinct = [...new Set([...versions.values()].filter(Boolean))]
const version = versions.get('package.json')
check(
  'all manifests share one version',
  distinct.length === 1,
  distinct.length === 1 ? version : `found ${distinct.join(', ')}`,
)

// ---------------------------------------------------------------------------
// 2. artifact names in the docs match the version
// ---------------------------------------------------------------------------
const DOCS = ['README.md', 'docs/PUBLISHING.md']
const ARTIFACT = /\b(dsh-openwhale|open-whale)-(\d+\.\d+\.\d+)\.(tgz|apk)\b/g

for (const doc of DOCS) {
  const text = readText(doc)
  const stale = []
  for (const match of text.matchAll(ARTIFACT)) {
    const [, base, found, extension] = match
    if (found !== version) stale.push(`${base}-${found}.${extension}`)
  }
  check(
    `${doc}: no stale artifact names`,
    stale.length === 0,
    stale.length === 0 ? '' : `expected ${version}, found ${[...new Set(stale)].join(', ')}`,
  )
  // The release instructions need both versioned names: dropping a row is drift
  // too, and a missing name is easy to miss in review.
  for (const required of [`dsh-openwhale-${version}.tgz`, `open-whale-${version}.apk`]) {
    check(`${doc}: mentions ${required}`, text.includes(required))
  }
}

// ---------------------------------------------------------------------------
// 3. tag commands in the release instructions point at this version
// ---------------------------------------------------------------------------
const TAG_COMMAND = /git\s+tag(?:\s+-f)?\s+(v\d+\.\d+\.\d+)|git\s+push(?:\s+-f)?\s+origin\s+(v\d+\.\d+\.\d+)/g
const publishing = readText('docs/PUBLISHING.md')
const tagged = [...publishing.matchAll(TAG_COMMAND)].map(match => match[1] ?? match[2])
check(
  'docs/PUBLISHING.md: tag commands use the current version',
  tagged.length > 0 && tagged.every(tag => tag === `v${version}`),
  tagged.length === 0 ? 'no `git tag v…` command found' : `found ${[...new Set(tagged)].join(', ')}, expected v${version}`,
)

// ---------------------------------------------------------------------------
// 4. the two docs quote the same test counts
// ---------------------------------------------------------------------------
/** @param {string} text @param {RegExp} pattern */
function quote(text, pattern, label) {
  const match = pattern.exec(text)
  if (!match) {
    check(`${label}: quotes a test count`, false, 'no "<files> / <tests>" line found')
    return null
  }
  return { files: Number(match[1]), tests: Number(match[2]) }
}

const readmeCounts = quote(
  readText('README.md'),
  /(\d+)\s*个测试文件\s*\/\s*(\d+)\s*项测试/,
  'README.md',
)
const publishingCounts = quote(
  publishing,
  /(\d+)\s*文件\s*\/\s*(\d+)\s*项/,
  'docs/PUBLISHING.md',
)
if (readmeCounts && publishingCounts) {
  const same =
    readmeCounts.files === publishingCounts.files && readmeCounts.tests === publishingCounts.tests
  check(
    'README.md and docs/PUBLISHING.md quote the same test counts',
    same,
    same
      ? `${readmeCounts.files} files / ${readmeCounts.tests} tests`
      : `README ${readmeCounts.files}/${readmeCounts.tests} vs PUBLISHING ${publishingCounts.files}/${publishingCounts.tests}`,
  )
}

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} doc/version check(s) failed:`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('\ndocs check FAILED')
  process.exit(1)
}
console.log(`docs check OK (${checks} checks, version ${version})`)
