// Synchronise the plugin's self-contained copy of the Open Whale protocol.
//
// Why a copy exists at all: `dsh plugin add <path>` installs a plugin by copying
// it into the profile, so any import that escapes the package (a relative
// `../../protocol/...`) resolves outside the installed tree and fails at load.
// The plugin must therefore carry the protocol inside its own `src/`.
//
// Why the copy is checked rather than hand-maintained: `packages/protocol` stays
// the single authority (the mobile app and the protocol test suite import it
// directly). This script writes the copy with a source hash, and
// `test/protocol-copy.test.mjs` fails when the copy is stale — so drift is caught
// by the test suite instead of by a phone that cannot pair.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', '..', 'protocol', 'src', 'index.mjs')
const target = join(here, '..', 'src', 'protocol.mjs')

/** Marker line the consistency test looks for. */
export const MARKER_PREFIX = '// OPENWHALE-PROTOCOL-SOURCE-SHA256: '

/**
 * @param {string} text
 * @returns {string}
 */
export function hashOf(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Render the generated copy for the current protocol source.
 *
 * Line endings are normalised to LF before hashing. The copy's sha256 is asserted
 * against the authority, and Git's checkout behaviour on Windows rewrites LF to CRLF
 * unless a `.gitattributes` rule stops it — a divergence that showed up as a failing
 * test on Windows CI while passing on the developer's machine. Normalising here means
 * the hash describes the content rather than the checkout, so the check holds
 * regardless of anyone's `core.autocrlf` setting.
 * @returns {{content: string, hash: string}}
 */
export function renderCopy() {
  const original = readFileSync(source, 'utf8').replaceAll('\r\n', '\n')
  const hash = hashOf(original)
  const header = [
    '// GENERATED FILE — do not edit by hand.',
    '//',
    '// This is the plugin\'s self-contained copy of `packages/protocol/src/index.mjs`.',
    '// A DSH plugin is installed by copying the package into the profile, so any',
    '// import reaching outside the package breaks at load time; the protocol therefore',
    '// has to live inside `src/`. The authoritative source stays in `packages/protocol`,',
    '// and `npm run sync:protocol` regenerates this file.',
    `${MARKER_PREFIX}${hash}`,
    '',
  ].join('\n')
  return { content: header + original, hash }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { content, hash } = renderCopy()
  const checkOnly = process.argv.includes('--check')
  if (checkOnly) {
    // CI mode: fail loudly instead of rewriting, so a drift is caught in review
    // rather than silently fixed by the pipeline.
    let current = ''
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      console.error('src/protocol.mjs is missing — run `node scripts/sync-protocol.mjs`')
      process.exit(1)
    }
    if (current !== content) {
      console.error('src/protocol.mjs is out of sync with packages/protocol/src/index.mjs')
      console.error('run `node packages/plugin/scripts/sync-protocol.mjs` and commit the result')
      process.exit(1)
    }
    console.log(`src/protocol.mjs is in sync (sha256 ${hash.slice(0, 16)}…)`)
    process.exit(0)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  console.log(`synced src/protocol.mjs (sha256 ${hash.slice(0, 16)}…)`)
}
