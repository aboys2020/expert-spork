/**
 * 诊断脚本：把 server/ 与 electron/ 里所有 require 的第三方模块，和 package-lock 的
 * 依赖树做交叉比对，提前发现「打包后会 Cannot find module」的风险。
 *
 * 为什么需要：archiver-utils 这类传递依赖如果没被打进 asar，
 * 编译期和阶段 1 探针都不会报错，只有用户点某个功能时才崩。
 *
 * 用法：node scripts/diagnose-deps.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// 收集 lock 里所有包路径
const lockPackages = Object.keys(lock.packages || {})

/** 判断某个模块名是否存在于 lock 的树里 */
function isInLock(name) {
  return lockPackages.some((p) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`))
}

/** 解析 require 的模块名（'a/b' -> 'a'，'@scope/x/y' -> '@scope/x'） */
function bareName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) {
    return null
  }
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const NODE_BUILTINS = new Set([
  'fs', 'path', 'http', 'https', 'os', 'crypto', 'zlib', 'stream', 'url', 'util', 'events',
  'child_process', 'assert', 'buffer', 'net', 'tls', 'dns', 'querystring', 'readline',
  'worker_threads', 'perf_hooks', 'timers', 'string_decoder', 'tty', 'vm', 'v8', 'process',
])

/** 递归扫描目录里的 require 调用 */
function scanDir(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(full, acc)
      continue
    }
    if (!entry.name.endsWith('.js')) {
      continue
    }
    const text = fs.readFileSync(full, 'utf8')
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g
    let m
    while ((m = re.exec(text)) !== null) {
      const name = bareName(m[1])
      if (!name || NODE_BUILTINS.has(name)) {
        continue
      }
      if (!acc.has(name)) {
        acc.set(name, [])
      }
      acc.get(name).push(path.relative(ROOT, full).replace(/\\/g, '/'))
    }
  }
}

const found = new Map()
scanDir(path.join(ROOT, 'server'), found)
scanDir(path.join(ROOT, 'electron'), found)

console.log('扫描到 ' + found.size + ' 个第三方 require：\n')

const missing = []
for (const [name, files] of [...found.entries()].sort()) {
  const inLock = isInLock(name)
  const isDirectDep = Boolean((pkg.dependencies || {})[name])
  const flag = inLock ? '✓' : '✗ 不在依赖树中'
  console.log(`${flag.padEnd(16)} ${name.padEnd(28)} ${isDirectDep ? '(直接依赖)' : '(传递依赖)'}`)
  if (!inLock) {
    missing.push({ name, files: [...new Set(files)] })
  }
}

console.log('')
if (missing.length === 0) {
  console.log('结果：所有 require 的模块都能在 package-lock 里找到。')
  console.log('注意：这只能证明“依赖树里有”，不能证明“被打进了 asar”。')
} else {
  console.log('结果：以下模块在依赖树中找不到（打包后必然 runtime 报错）：')
  for (const m of missing) {
    console.log(`  - ${m.name}   ← ${m.files.join(', ')}`)
  }
  process.exit(1)
}
