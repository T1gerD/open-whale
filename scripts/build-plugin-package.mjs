// Build the distributable plugin tarball.
//
// A DSH plugin is installed straight from a tarball, and the install is a *copy*,
// so the package must be complete and self-contained: the entrypoint, every module
// it imports (including the generated `src/protocol.mjs`), the bundle patch and the
// README. This script pins the exact file list instead of trusting `npm pack`, so
// the artifact is reproducible and auditable.
//
// The archive is staged in a temporary directory so its layout is the standard npm
// one — everything under a single top-level `package/` entry — which is what plugin
// installers expect.
//
//   node scripts/build-plugin-package.mjs          → release/dsh-openwhale-<v>.tgz
//   node scripts/build-plugin-package.mjs --check  → verify the file list only
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const outDir = join(repo, 'release')
const checkOnly = process.argv.includes('--check')

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

/** Everything a working install needs, in a stable order. */
const FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'src/index.mjs',
  'src/dsh-bridge.mjs',
  'src/gateway.mjs',
  'src/ws.mjs',
  'src/qr.mjs',
  'src/state.mjs',
  'src/pairer.mjs',
  'src/voice.mjs',
  'src/power.mjs',
  'src/tunnel.mjs',
  'src/wol-proxy.mjs',
  // Generated from packages/protocol by scripts/sync-protocol.mjs. It must be in
  // the tarball: without it the plugin cannot resolve its protocol import once it
  // has been copied into a profile.
  'src/protocol.mjs',
  'scripts/sync-protocol.mjs',
]

// Fail loudly rather than shipping a tarball with a hole in it.
const missing = FILES.filter(file => {
  try {
    return !statSync(join(pluginDir, file)).isFile()
  } catch {
    return true
  }
})
if (missing.length > 0) {
  console.error(`missing files for the package:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

console.log(`package ${pkg.name}@${pkg.version}`)
console.log(`files: ${FILES.length}`)
for (const file of FILES) {
  console.log(`  ${String(statSync(join(pluginDir, file)).size).padStart(7)}  ${file}`)
}

if (checkOnly) {
  console.log('\n--check: file list verified, nothing written')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const tarball = join(outDir, `${pkg.name}-${pkg.version}.tgz`)
rmSync(tarball, { force: true })

const stageParent = join(tmpdir(), `openwhale-pack-${process.pid}`)
const stage = join(stageParent, 'package')
mkdirSync(stage, { recursive: true })
try {
  for (const file of FILES) {
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(pluginDir, file), target)
  }
  // Run from the staging parent so the archive contains `package/<file>`.
  execFileSync('tar', ['-czf', tarball, 'package'], {
    cwd: stageParent,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
} finally {
  rmSync(stageParent, { recursive: true, force: true })
}

const bytes = statSync(tarball).size
console.log(`\nwrote ${tarball} (${(bytes / 1024).toFixed(1)} KB)`)
