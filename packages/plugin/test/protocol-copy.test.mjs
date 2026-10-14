// Keep the plugin's in-package protocol copy honest.
//
// The plugin ships `src/protocol.mjs` because DSH installs plugins by copying the
// package (see scripts/sync-protocol.mjs). `packages/protocol` remains the single
// authority, so this suite fails the moment the two drift apart — which is the
// failure mode that would otherwise ship as "the phone cannot pair".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARKER_PREFIX, hashOf, renderCopy } from '../scripts/sync-protocol.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const authorityPath = join(here, '..', '..', 'protocol', 'src', 'index.mjs')
const copyPath = join(here, '..', 'src', 'protocol.mjs')

/**
 * Read a source file with line endings normalised.
 *
 * The comparison is about *content*: Git rewrites LF to CRLF on checkout unless
 * `.gitattributes` stops it, and even with `-text` pinned the flag can be bypassed
 * by a different checkout, a tool that rewrites files, or `core.autocrlf` on a
 * fresh clone. Normalising here means a CRLF checkout cannot masquerade as a stale
 * copy — which is exactly how this test failed on Windows CI while passing on the
 * machine the file was generated on.
 * @param {string} path
 */
function readNormalised(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
}

test('the plugin copy matches the authoritative protocol byte for byte', () => {
  const authority = readNormalised(authorityPath)
  const copy = readNormalised(copyPath)
  const expectedHash = hashOf(authority)
  const marker = copy.split('\n').find(line => line.startsWith(MARKER_PREFIX))
  assert.ok(marker, 'the generated copy must carry its source hash marker')
  assert.equal(
    marker.slice(MARKER_PREFIX.length).trim(),
    expectedHash,
    'src/protocol.mjs is stale — run `node scripts/sync-protocol.mjs` in packages/plugin',
  )
  assert.equal(copy.endsWith(authority), true, 'the copy body must be the authority, unmodified')
})

test('the generated copy is LF-only, so the hash cannot depend on the checkout', () => {
  // Git rewrites LF to CRLF on Windows unless `.gitattributes` stops it, and that
  // used to make the copy's hash disagree with the authority on Windows CI while
  // passing locally. Normalising in the generator removes the coupling entirely.
  const { content } = renderCopy()
  assert.equal(content.includes('\r\n'), false, 'generated copy must not contain CRLF')
})

test('a CRLF source hashes the same as its LF form', () => {
  const authority = readFileSync(authorityPath, 'utf8').replaceAll('\r\n', '\n')
  const crlf = authority.replaceAll('\n', '\r\n')
  assert.equal(hashOf(crlf.replaceAll('\r\n', '\n')), hashOf(authority))
})

test('regenerating the copy is deterministic', () => {
  const first = renderCopy()
  const second = renderCopy()
  assert.equal(first.content, second.content)
  assert.equal(first.hash, second.hash)
})

test('the generated copy never escapes the package', () => {
  const copy = readNormalised(copyPath)
  // A relative import that leaves src/ would resolve differently once the plugin
  // is copied into a profile.
  const escaping = [...copy.matchAll(/from '(\.[^']+)'/g)]
    .map(match => match[1])
    .filter(spec => spec.split('/').filter(part => part === '..').length > 1)
  assert.deepEqual(escaping, [], `protocol.mjs must not import outside packages/plugin: ${escaping.join(', ')}`)
})

test('the plugin sources only import the protocol from inside the package', () => {
  const sources = ['index.mjs', 'gateway.mjs', 'pairer.mjs', 'power.mjs', 'state.mjs', 'dsh-bridge.mjs']
  for (const file of sources) {
    const text = readNormalised(join(here, '..', 'src', file))
    const imports = [...text.matchAll(/from '([^']*protocol[^']*)'/g)].map(match => match[1])
    for (const spec of imports) {
      assert.equal(
        spec,
        './protocol.mjs',
        `${file} must import the in-package protocol (found "${spec}"); a path outside the package breaks once DSH copies it`,
      )
    }
  }
})
