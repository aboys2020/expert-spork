/**
 * 诊断脚本：在 app.asar 里做「运行时依赖闭合性」审计。
 *
 * 目的：找出那种只在用户实际点功能时才崩的依赖问题。真实案例 ——
 *   require('archiver') 会连锁加载 archiver/lib/plugins/zip -> zip-stream，
 *   而 zip-stream 里的 require('archiver-utils') 解析不到
 *   （archiver-utils 被 npm 的提升冲突挤进了 archiver/node_modules/），
 *   结果 zip 打包功能一用就报 Cannot find module，但构建与启动阶段都不报错。
 *
 * 算法：从 server/ 与 electron/ 的入口出发，按 package.json 的 dependencies 递归，
 * 对每个包检查它的每个运行时依赖能否按 Node 规则解析到（就近向上查找 node_modules）。
 * 只跟进运行时依赖；跳过 optionalDependencies 与 peerDependencies，
 * 并跳过纯类型包（@types/*），避免噪音。
 *
 * 用法：node scripts/audit-asardeps.js ["<app.asar 路径>"]
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'popDownloader', 'resources', 'app.asar'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PopDownloader', 'resources', 'app.asar'),
  path.join(path.resolve(__dirname, '..'), 'release', 'win-unpacked', 'resources', 'app.asar'),
]

// 只关心服务端真正会用到的第三方包，避免把前端构建期依赖也算进来
const ENTRY_PACKAGES = [
  'express',
  'archiver',
  'better-sqlite3',
  'fluent-ffmpeg',
  '@ffmpeg-installer/ffmpeg',
]

function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headSize = head.readUInt32LE(4)
  const buf = Buffer.alloc(headSize)
  fs.readSync(fd, buf, 0, headSize, 16)
  const raw = buf.toString('utf8')
  const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1))
  // 数据区起点 = 8 + headSize（已用真实字节交叉验证）
  return { fd, header, dataOffset: 8 + headSize }
}

/**
 * 取 node_modules 下的目录节点。
 * 入参 pkgPath 是「相对 node_modules 的路径」，例如：
 *   'express'                          -> node_modules/express
 *   'archiver/node_modules/async'      -> node_modules/archiver/node_modules/async
 * 注意：若路径已以 node_modules 开头，则不再重复添加前缀。
 */
function getPkgNode(header, pkgPath) {
  const rel = String(pkgPath).startsWith('node_modules/') ? String(pkgPath) : `node_modules/${pkgPath}`
  let n = header
  for (const s of rel.split('/').filter(Boolean)) {
    if (!n || !n.files || !n.files[s]) {
      return null
    }
    n = n.files[s]
  }
  return n
}

function readJson(fd, dataOffset, node) {
  if (!node || node.offset === undefined) {
    return null
  }
  try {
    const b = Buffer.alloc(node.size)
    fs.readSync(fd, b, 0, node.size, dataOffset + Number(node.offset))
    return JSON.parse(b.toString('utf8'))
  } catch (err) {
    if (process.env.AUDIT_TRACE) {
      console.log(`  [readJson 失败] node.offset=${node.offset} size=${node.size} err=${err.message}`)
    }
    return null
  }
}

/**
 * 模拟 Node 的解析规则：从 fromDir 向上逐级查找 node_modules/name。
 * fromDir / 返回值都是 asar 内的相对路径（用 / 分隔）。
 */
function resolveFrom(header, fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`
    if (getPkgNode(header, candidate)) {
      return candidate
    }
    if (!dir) {
      return null
    }
    const idx = dir.lastIndexOf('/node_modules')
    if (idx < 0) {
      dir = ''
    } else {
      dir = dir.slice(0, idx)
    }
  }
}

function main() {
  const explicit = process.argv[2]
  const asarPath = explicit && fs.existsSync(explicit) ? explicit : CANDIDATES.find((c) => fs.existsSync(c))
  if (!asarPath) {
    console.error('找不到 app.asar')
    process.exit(1)
  }

  const { fd, header, dataOffset } = readAsar(asarPath)
  try {
    console.log('asar：' + asarPath + '\n')

    // 自检：解析器若是坏的，后面的结论都不可信，必须先确认能取到已知存在的包
    const selfCheck = getPkgNode(header, 'express')
    if (!selfCheck) {
      console.error('自检失败：连 node_modules/express 都取不到，说明本脚本解析有误，请勿据此下结论。')
      console.error('header 顶层键：' + JSON.stringify(Object.keys(header)))
      const nm = header.files && header.files.node_modules
      console.error('node_modules 下的键数量：' + (nm && nm.files ? Object.keys(nm.files).length : '无法读取'))
      process.exit(2)
    }
    console.log('自检通过：能定位 node_modules/express\n')

    const problems = []
    const visited = new Set()
    const queue = []

    for (const name of ENTRY_PACKAGES) {
      const dir = resolveFrom(header, '', name)
      if (!dir) {
        problems.push({ from: '(应用根)', dep: name, missing: true })
        continue
      }
      queue.push(dir)
    }

    while (queue.length > 0) {
      const pkgDir = queue.shift()
      if (visited.has(pkgDir)) {
        continue
      }
      visited.add(pkgDir)

      const meta = readJson(fd, dataOffset, getPkgNode(header, `${pkgDir}/package.json`))
      if (!meta) {
        continue
      }
      if (String(meta.name || '').startsWith('@types/')) {
        continue
      }

      const deps = Object.keys(meta.dependencies || {})
      for (const dep of deps) {
        const resolved = resolveFrom(header, pkgDir, dep)
        if (process.env.AUDIT_TRACE) {
          console.log(`  [trace] ${meta.name || pkgDir} 需要 ${dep} -> ${resolved || '解析失败'}`)
        }
        if (!resolved) {
          problems.push({ from: pkgDir, dep, meta })
        } else {
          queue.push(resolved)
        }
      }
    }

    console.log(`已遍历运行时包：${visited.size} 个\n`)
    console.log('=== 运行时依赖闭合性 ===')
    if (problems.length === 0) {
      console.log('  ✓ 通过：入口包的全部运行时依赖都能按 Node 规则解析到')
    } else {
      for (const p of problems) {
        console.log(`  ✗ ${p.dep}`)
        console.log(`      被谁需要：${p.from}`)
      }
      console.log(`\n结论：${problems.length} 处解析失败，相关功能一用就会报 Cannot find module。`)
      process.exit(1)
    }
  } finally {
    fs.closeSync(fd)
  }
}

main()
