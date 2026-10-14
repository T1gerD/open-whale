// 语法与“可擦除性”检查（零依赖，本机就能跑）。
//
// 本机没有 node_modules，因此跑不了 tsc。Node 24 自带 TypeScript 类型剥离，可以用
// `module.stripTypeScriptTypes` 做两件事：
//  1. `.ts` / `.mts` 能不能被解析（括号、引号、import 语法是否成立）；
//  2. `src/core/**` 是否只用了可擦除语法 —— 否则 `node test/run.mjs` 会在运行时炸掉。
//
// ⚠️ 局限（诚实声明）：Node 的剥离器不支持 JSX，所以 `.tsx` 只做**分隔符配对**检查
//（{} () [] 是否平衡），不做完整的 JSX 语法树校验。真正的类型与 JSX 检查需要 tsc。
//
// 用法：node scripts/check-syntax.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = fileURLToPath(new URL('..', import.meta.url))
const roots = ['app', 'src', 'test']
const extensions = ['.ts', '.tsx', '.mts']

function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (extensions.some(ext => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/**
 * 把注释与字符串/模板字面量抹掉（保留换行，行号才不会漂），
 * 剩下的分隔符才参与配对检查。
 *
 * 注意：这里**不识别正则字面量**，所以只对 `.tsx` 使用；`.ts`/`.mts` 交给
 * `stripTypeScriptTypes` 做真正的解析（它是完整 parser，不需要这种近似）。
 */
function blankLiterals(code) {
  let out = ''
  let i = 0
  const keepNewlines = text => text.replace(/[^\n]/g, '')
  while (i < code.length) {
    const char = code[i]
    const next = code[i + 1]
    if (char === '/' && next === '/') {
      let end = i
      while (end < code.length && code[end] !== '\n') end += 1
      i = end
      continue
    }
    if (char === '/' && next === '*') {
      const start = i
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i = Math.min(code.length, i + 2)
      out += keepNewlines(code.slice(start, i))
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      const start = i
      i += 1
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2
          continue
        }
        if (code[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      out += keepNewlines(code.slice(start, i))
      continue
    }
    out += char
    i += 1
  }
  return out
}

/** 分隔符配对（对 .tsx 也适用）。 */
function checkDelimiters(code, label) {
  const clean = blankLiterals(code)
  const pairs = { '}': '{', ')': '(', ']': '[' }
  const stack = []
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i]
    if (char === '{' || char === '(' || char === '[') stack.push({ char, at: i })
    else if (char === '}' || char === ')' || char === ']') {
      const open = stack.pop()
      if (!open || open.char !== pairs[char]) {
        const line = clean.slice(0, i).split('\n').length
        throw new Error(`${label}:${line} 处 ${char} 没有对应的 ${pairs[char]}`)
      }
    }
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1]
    const line = clean.slice(0, open.at).split('\n').length
    throw new Error(`${label}:${line} 处的 ${open.char} 没有闭合`)
  }
}

const files = roots.flatMap(dir => {
  try {
    return collect(join(root, dir))
  } catch {
    return []
  }
})

let failed = 0
let tsxSkipped = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const label = relative(root, file).replaceAll('\\', '/')
  const isTsx = label.endsWith('.tsx')

  try {
    if (isTsx) {
      tsxSkipped += 1
      // Node 的剥离器不认 JSX，只能做分隔符配对（近似但能抓住未闭合的组件/表达式）。
      checkDelimiters(source, label)
    } else {
      // 完整解析：连括号、字符串、正则都由真正的 parser 校验。
      stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
      if (label.startsWith('src/core/') && /^\s*(export\s+)?enum\s/m.test(source)) {
        throw new Error('src/core 里不允许使用 enum（Node 的类型剥离处理不了）')
      }
    }
  } catch (error) {
    failed += 1
    console.error(`✖ ${label}`)
    console.error(`  ${String(error.message).split('\n')[0]}`)
  }
}

if (failed > 0) {
  console.error(`\n语法检查失败：${failed} 个文件`)
  process.exit(1)
}
console.log(
  `语法检查通过：${files.length} 个文件（${files.length - tsxSkipped} 个做了类型剥离解析，${tsxSkipped} 个 .tsx 只做了分隔符配对）`,
)
