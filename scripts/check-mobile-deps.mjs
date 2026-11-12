// 手机端依赖树 ↔ Expo SDK 的自洽性检查。
//
// 为什么不用 `npx expo install --check`：
//   1. 它拿 **线上**（api.expo.dev）的 SDK 清单做基准。Expo 每发一个 patch，
//      已经打好的 tag 就会被判红 —— v3.0.10 的 release job 正是这么挂的：
//      `expo@57.0.31 - expected version: ~57.0.32`，而仓库那一刻什么都没改。
//      结论是「是否发布得出去」不该由联网查询的当下结果决定。
//   2. 它同时会改写 package.json（`--fix`），产物因此对不上任何一次提交。
//
// 这里改读**仓库锁定的 expo 包自带**的 `bundledNativeModules.json`：它是 SDK 57.0.x
// 这一版随包发布的权威版本表，跟 lockfile 一起被钉死，离线、可复现。它回答的问题
// 也刚好是我们关心的那一个 —— 「这棵依赖树与这个 expo 版本是否自洽」。
//
// 用法（需要先 pnpm install）：
//   node scripts/check-mobile-deps.mjs
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const mobileDir = join(root, 'packages/mobile')
const mobilePkgPath = join(mobileDir, 'package.json')

const mobileRequire = createRequire(mobilePkgPath)

/**
 * 找到 expo 包目录。
 * `expo/package.json` 不一定在 `exports` 里，所以先试解析，再从入口向上找。
 * @returns {string}
 */
function resolveExpoDir() {
  const candidates = []
  try {
    candidates.push(dirname(mobileRequire.resolve('expo/package.json')))
  } catch {}
  try {
    let dir = dirname(mobileRequire.resolve('expo'))
    while (dir !== dirname(dir)) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name === 'expo') return dir
      }
      dir = dirname(dir)
    }
  } catch {}
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bundledNativeModules.json'))) return dir
  }
  throw new Error('找不到已安装的 expo 包 —— 先在仓库根跑 `pnpm install`')
}

/** @param {string} version @param {string} range */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** @returns {boolean} */
function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  const spec = String(range).trim()
  if (spec === '*' || spec === '' || spec === 'latest') return true

  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const atLeast = (target) => compare(v, target) >= 0

  if (spec.startsWith('~')) {
    const base = parseVersion(spec.slice(1))
    if (!base) return false
    // ~1.2.3 → >=1.2.3 <1.3.0
    return atLeast(base) && v[0] === base[0] && v[1] === base[1]
  }
  if (spec.startsWith('^')) {
    const base = parseVersion(spec.slice(1))
    if (!base) return false
    // ^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0
    if (!atLeast(base)) return false
    return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0]
  }
  if (spec.startsWith('>=')) {
    const base = parseVersion(spec.slice(2))
    return base ? atLeast(base) : false
  }
  const exact = parseVersion(spec)
  return exact ? compare(v, exact) === 0 : false
}

/**
 * 解析某个包在 packages/mobile 视角下的已安装版本。
 * @param {string} name
 * @returns {string|null}
 */
function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(mobileRequire.resolve(`${name}/package.json`), 'utf8')).version
  } catch {
    return null
  }
}

const expoDir = resolveExpoDir()
const expoPkg = JSON.parse(readFileSync(join(expoDir, 'package.json'), 'utf8'))
const bundledPath = join(expoDir, 'bundledNativeModules.json')
if (!existsSync(bundledPath)) {
  console.error(`expo@${expoPkg.version} 没有 bundledNativeModules.json —— 这个 SDK 版本无法离线校验`)
  process.exit(1)
}
const bundled = JSON.parse(readFileSync(bundledPath, 'utf8'))
const mobilePkg = JSON.parse(readFileSync(mobilePkgPath, 'utf8'))
const declared = { ...mobilePkg.dependencies, ...mobilePkg.devDependencies }

const problems = []
let checked = 0
for (const [name, expectedRange] of Object.entries(bundled)) {
  if (!(name in declared)) continue
  const version = installedVersion(name)
  if (!version) {
    problems.push(`${name}: package.json 里声明了，但没装上`)
    continue
  }
  checked += 1
  if (!satisfies(version, expectedRange)) {
    problems.push(
      `${name}: 装的 ${version}，expo@${expoPkg.version} 期望 ${expectedRange}`,
    )
  }
}

console.log(`expo@${expoPkg.version} 的 SDK 版本表：${Object.keys(bundled).length} 项`)
console.log(`本仓库声明并在 SDK 表里的依赖：${checked} 项`)

if (problems.length > 0) {
  console.error('\n以下依赖与当前 Expo SDK 不自洽：')
  for (const line of problems) console.error(`  - ${line}`)
  console.error(
    '\n修法：把 packages/mobile/package.json 里的版本范围对齐到 SDK 表的写法' +
      '（通常是 `~x.y.z`），再 `pnpm install` 更新 lockfile。' +
      '\n不要用 `expo install --fix` 改树 —— 那会在发布途中改写 package.json。',
  )
  process.exit(1)
}
console.log('mobile deps OK')
