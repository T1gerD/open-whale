// Build the distributable plugin package.
//
// A DSH plugin is installed straight from a tarball (or from npm), and the install
// is a *copy*, so the package must be complete and self-contained: the entrypoint,
// every module it imports (including the generated `src/protocol.mjs`), the bundle
// patch, the README, and — since 2.2.0 — the web/PWA client served at
// `/openwhale/app` (that is what makes the same plugin usable from HarmonyOS and
// iOS browsers without an app store).
//
// File discovery is dynamic on purpose. A pinned list is auditable but silently
// ships a broken package the moment someone adds a module and forgets the list;
// discovering `src/**` and `scripts/**` keeps the artifact complete, and the
// `--check` mode still prints the exact contents so a review can diff them.
//
//   node scripts/build-plugin-package.mjs              → release/dsh-openwhale-<v>.tgz
//                                                      + release/dsh-openwhale.tgz (stable
//                                                        alias used by the plugin-market
//                                                        `tarball:` link)
//   node scripts/build-plugin-package.mjs --check      → verify the file list only
//   node scripts/build-plugin-package.mjs --npm-dir    → additionally stage
//                                                        release/npm-package/ for
//                                                        `npm publish release/npm-package`
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const webchatDir = join(repo, 'packages', 'webchat')
const outDir = join(repo, 'release')
const checkOnly = process.argv.includes('--check')
const npmDirMode = process.argv.includes('--npm-dir')

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

/** Fixed files every install needs, in a stable order. */
const FIXED_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/** Recursively list files under `dir`, as plugin-package-relative POSIX paths. */
function walk(dir, prefix = '') {
  const found = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // Never ship tests or dependency trees inside the plugin package.
      if (['node_modules', 'test', 'tests', '.git'].includes(entry.name)) continue
      found.push(...walk(dir, rel))
    } else {
      found.push(rel)
    }
  }
  return found
}

/** The plugin's own source and helper scripts. */
function pluginFiles() {
  const files = new Set()
  for (const file of FIXED_FILES) {
    if (existsSync(join(pluginDir, file))) files.add(file)
  }
  for (const sub of ['src', 'scripts']) {
    if (!existsSync(join(pluginDir, sub))) continue
    for (const rel of walk(pluginDir, sub)) files.add(rel)
  }
  return [...files].sort()
}

/**
 * Files of the web/PWA client. The client is a plain static bundle (no build
 * step), so what is on disk is what ships. `test/` is included by `walk` skip
 * rules — the package carries no tests.
 */
function webchatFiles() {
  if (!existsSync(webchatDir)) return []
  return walk(webchatDir).sort()
}

const files = pluginFiles()
const webchat = webchatFiles()

// Fail loudly rather than shipping a package with a hole in it.
const missing = files.filter(file => {
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
if (webchat.length === 0) {
  console.error('packages/webchat is missing or empty: the web/PWA client must ship with the plugin')
  process.exit(1)
}
for (const required of ['index.html', 'app.js']) {
  if (!webchat.includes(required)) {
    console.error(`packages/webchat/${required} is required (the plugin serves /openwhale/app from it)`)
    process.exit(1)
  }
}

const totalBytes = (list, root) =>
  list.reduce((sum, file) => sum + statSync(join(root, file)).size, 0)

console.log(`package ${pkg.name}@${pkg.version}`)
console.log(`plugin files: ${files.length} (${(totalBytes(files, pluginDir) / 1024).toFixed(1)} KB)`)
for (const file of files) console.log(`  ${String(statSync(join(pluginDir, file)).size).padStart(7)}  ${file}`)
console.log(`webchat files: ${webchat.length} (${(totalBytes(webchat, webchatDir) / 1024).toFixed(1)} KB)`)
for (const file of webchat) console.log(`  ${String(statSync(join(webchatDir, file)).size).padStart(7)}  webchat/${file}`)

if (checkOnly) {
  console.log('\n--check: file list verified, nothing written')
  process.exit(0)
}

/** Stage one complete package tree at `stage` (a `package/`-shaped directory). */
function stagePackage(stage, { forNpm }) {
  for (const file of files) {
    const target = join(stage, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(pluginDir, file), target)
  }
  cpSync(webchatDir, join(stage, 'webchat'), {
    recursive: true,
    filter: source => {
      const name = basename(source)
      return name !== 'node_modules' && name !== 'test' && name !== 'tests'
    },
  })
  if (forNpm) {
    // `npm publish <dir>` still honours the `files` allow-list in package.json, so
    // the staged manifest has to mention webchat or the published tarball would
    // install fine and then 404 every asset.
    const stagedPkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
    stagedPkg.files = ['src', 'scripts', 'webchat', 'cordis.patch.yml', 'README.md', 'LICENSE']
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`)
  }
}

/**
 * Build a deterministic `.tar.gz` in pure Node.
 *
 * Why not shell out to `tar`: the archive path on Windows starts with `C:` and GNU
 * tar interprets `host:path` as a remote archive, so `tar -czf C:\... out/package`
 * fails with a confusing status 2 — the exact thing that broke the first 2.2.0
 * packaging run. macOS ships bsdtar where `--force-local` does not exist, so a
 * flag would trade one platform bug for another. A ~60-line ustar writer has no
 * such failure modes and needs no dependency.
 *
 * @param {Array<{path: string, data: Buffer}>} entries Archive-relative POSIX paths.
 * @returns {Buffer}
 */
function createTarGz(entries) {
  const BLOCK = 512
  const chunks = []
  const pad = (length) => {
    const remainder = length % BLOCK
    return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
  }
  /** @param {string} name @param {Buffer} head */
  const writeOctal = (buffer, offset, length, value) => {
    const text = value.toString(8).padStart(length - 1, '0')
    buffer.write(text, offset, 'ascii')
    buffer.write('\0', offset + length - 1, 'latin1')
  }
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK, 0)
    // ustar splits long names into prefix(155)/name(100); our longest path is well
    // under that, but split anyway so an unexpected deep webchat file cannot break
    // the archive silently.
    let name = entry.path
    let prefix = ''
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/')
      if (cut < 0) throw new Error(`tar: path too long: ${name}`)
      prefix = name.slice(0, cut)
      name = name.slice(cut + 1)
      if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
        throw new Error(`tar: path too long: ${entry.path}`)
      }
    }
    header.write(name, 0, 100, 'utf8')
    writeOctal(header, 100, 8, 0o644) // mode
    writeOctal(header, 108, 8, 0) // uid
    writeOctal(header, 116, 8, 0) // gid
    writeOctal(header, 124, 12, entry.data.length)
    writeOctal(header, 136, 12, 0) // mtime: fixed, so the archive is reproducible
    header.write('        ', 148, 8, 'ascii') // checksum placeholder
    header.write('0', 156, 1, 'ascii') // regular file
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    header.write(prefix, 345, 155, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    writeOctal(header, 148, 7, sum)
    header.write(' ', 155, 1, 'ascii')
    chunks.push(header, entry.data, pad(entry.data.length))
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

mkdirSync(outDir, { recursive: true })
const tarball = join(outDir, `${pkg.name}-${pkg.version}.tgz`)
const stableTarball = join(outDir, `${pkg.name}.tgz`)
rmSync(tarball, { force: true })
rmSync(stableTarball, { force: true })

const stageParent = join(tmpdir(), `openwhale-pack-${process.pid}`)
const stage = join(stageParent, 'package')
mkdirSync(stage, { recursive: true })
try {
  stagePackage(stage, { forNpm: false })
  /** @type {Array<{path: string, data: Buffer}>} */
  const entries = []
  const walkStage = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkStage(full, rel)
      else entries.push({ path: rel, data: readFileSync(full) })
    }
  }
  walkStage(stage, 'package')
  writeFileSync(tarball, createTarGz(entries))
} finally {
  rmSync(stageParent, { recursive: true, force: true })
}

// Stable name: the plugin-market entry links to
// `.../releases/latest/download/dsh-openwhale.tgz`, which needs an asset name that
// does not change with the version.
cpSync(tarball, stableTarball)

const bytes = statSync(tarball).size
console.log(`\nwrote ${relative(repo, tarball)} (${(bytes / 1024).toFixed(1)} KB)`)
console.log(`wrote ${relative(repo, stableTarball)} (stable alias for the plugin market)`)

if (npmDirMode) {
  const npmStage = join(outDir, 'npm-package')
  rmSync(npmStage, { recursive: true, force: true })
  mkdirSync(npmStage, { recursive: true })
  stagePackage(npmStage, { forNpm: true })
  const publishBytes = (() => {
    let sum = 0
    const stack = [npmStage]
    while (stack.length > 0) {
      const dir = stack.pop()
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else sum += statSync(full).size
      }
    }
    return sum
  })()
  console.log(`\nstaged ${relative(repo, npmStage)} (${(publishBytes / 1024).toFixed(1)} KB) — publish with:`)
  console.log(`  npm publish ${relative(repo, npmStage)} --access public`)
}
