// 手机端子包自己的测试运行器。
//
// 为什么不用 `node --test test/`：`node --test` 会为每个测试文件起子进程并通过管道
// 收集输出，在受限沙箱里会被拒（EPERM）。在同一进程里 import 每个测试文件，用的是
// 同一套 node:test 断言与报告，行为一致且不需要任何依赖。
//
// 用法（在 packages/mobile 下）：node test/run.mjs
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('没有找到 *.test.mjs')
  process.exit(1)
}

for (const file of files) {
  process.stdout.write(`\n=== ${file}\n`)
  await import(pathToFileURL(join(testDir, file)).href)
}

if (process.exitCode) {
  console.error('\nmobile test run FAILED')
  process.exit(1)
}
console.log(`\nmobile test run OK (${files.length} 个测试文件)`)
