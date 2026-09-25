/**
 * 诊断脚本：检查已安装/已打包的 PopDownloader 的 app.asar 内容，
 * 用于定位「Cannot find module 'xxx'」类问题。
 *
 * 用法：
 *   node scripts/inspect-asar.js                                  # 自动找已安装目录 / 本地产物
 *   node scripts/inspect-asar.js "<路径>\app.asar"                # 指定 asar
 *   node scripts/inspect-asar.js "<路径>\app.asar" <包名>          # 并提取该包的关键文件内容
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'popDownloader', 'resources', 'app.asar'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PopDownloader', 'resources', 'app.asar'),
  path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar'),
]

/**
 * 解析 asar：返回 { header, dataOffset }。
 * asar 头是 V8 pickle 字符串：
 *   offset 0..3  pickle 载荷长度(4) | 4..7 字符串长度 | 8..11 长度副本 | 12..15 对齐填充
 *   offset 16.. 头部 JSON（其后可能有 \0 填充）
 * 文件数据区从 16 + headSize 开始。
 */
function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headSize = head.readUInt32LE(4)
    const buf = Buffer.alloc(headSize)
    fs.readSync(fd, buf, 0, headSize, 16)
    const raw = buf.toString('utf8')
    const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1))
    return { fd, header, dataOffset: 16 + headSize, headSize }
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
}

/** 按路径取节点，路径形如 'node_modules/express/index.js' */
function getNode(header, relPath) {
  const segs = relPath.split('/').filter(Boolean)
  let node = header
  for (const s of segs) {
    if (!node || !node.files || !node.files[s]) {
      return null
    }
    node = node.files[s]
  }
  return node
}

/** 读取 asar 内某个文件的真实内容 */
function readFileFromAsar(fd, dataOffset, node) {
  if (!node || typeof node.offset !== 'string') {
    return null
  }
  const offset = dataOffset + Number(node.offset)
  const size = node.size || 0
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, offset)
  return buf
}

/** 收集 node_modules 下的包：顶层与嵌套分别记录 */
function collectPackages(node, prefix, top, nested) {
  const files = (node && node.files) || {}
  for (const [name, child] of Object.entries(files)) {
    const next = prefix ? `${prefix}/${name}` : name
    const isDir = Boolean(child && typeof child === 'object' && child.files)
    if (!isDir) {
      continue
    }
    if (next.startsWith('node_modules/') && !next.startsWith('node_modules/.')) {
      const rest = next.slice('node_modules/'.length)
      const segs = rest.split('/')
      const pkg = segs[0].startsWith('@') ? `${segs[0]}/${segs[1] || ''}` : segs[0]
      if (segs.length === 1 || (segs[0].startsWith('@') && segs.length === 2)) {
        if (next.includes('/node_modules/')) {
          nested.add(pkg)
        } else {
          top.add(pkg)
        }
      }
    }
    collectPackages(child, next, top, nested)
  }
}

function findAsar() {
  const explicit = process.argv[2]
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      console.error(`指定的 asar 不存在：${explicit}`)
      process.exit(1)
    }
    return explicit
  }
  for (const c of CANDIDATES) {
    if (fs.existsSync(c)) {
      return c
    }
  }
  console.error('没找到 app.asar，检查过：')
  CANDIDATES.forEach((c) => console.error('  ' + c))
  process.exit(1)
}

function main() {
  const asarPath = findAsar()
  const { fd, header, dataOffset, headSize } = readAsar(asarPath)

  try {
    const stat = fs.statSync(asarPath)
    console.log('asar：' + asarPath)
    console.log(`大小 ${(stat.size / 1024 / 1024).toFixed(2)} MB | 头 ${headSize} 字节 | 数据区起于 ${dataOffset}\n`)

    const top = new Set()
    const nested = new Set()
    collectPackages(header, '', top, nested)

    const topList = [...top].sort()
    console.log(`node_modules 顶层包：${topList.length} 个`)
    console.log(`仅嵌套出现的包：${[...nested].filter((n) => !top.has(n)).sort().join(', ') || '(无)'}\n`)

    // 校验 asar 结构正确性的锚点
    for (const anchor of ['package.json', 'server/index.js', 'electron/main.js', 'dist/index.html']) {
      const n = getNode(header, anchor)
      console.log(`  ${n ? '✓' : '✗'} ${anchor}${n && n.size ? ` (${n.size} 字节)` : ''}`)
    }

    const watch = process.argv[3]
      ? [process.argv[3]]
      : ['express', 'archiver', 'archiver-utils', 'zip-stream', 'better-sqlite3', 'fluent-ffmpeg']

    console.log('\n=== 关注包的位置 ===')
    for (const w of watch) {
      const atTop = top.has(w)
      const atNested = nested.has(w)
      // 找它的真实路径
      const hits = []
      const walk = (node, prefix) => {
        const files = (node && node.files) || {}
        for (const [name, child] of Object.entries(files)) {
          const next = prefix ? `${prefix}/${name}` : name
          if (next.endsWith('/node_modules/' + w) || next === 'node_modules/' + w) {
            hits.push(next)
          }
          if (child && child.files) {
            walk(child, next)
          }
        }
      }
      walk(header, '')
      console.log(
        `  ${atTop || atNested ? '✓' : '✗ 完全没有'} ${w.padEnd(18)} 顶层=${atTop ? '是' : '否'} 嵌套=${atNested ? '是' : '否'}`,
      )
      hits.forEach((h) => console.log(`       路径: ${h}`))

      // 看看能否真的读出内容（这才能证明文件存在且可读）
      for (const h of hits.slice(0, 1)) {
        const pj = getNode(header, h + '/package.json')
        if (pj) {
          const content = readFileFromAsar(fd, dataOffset, pj)
          let version = '无法解析'
          try {
            version = JSON.parse(content.toString('utf8')).version
          } catch {}
          console.log(`       可读取 package.json，version=${version}，size=${pj.size}`)
        } else {
          console.log('       ✗ 该路径下没有 package.json')
        }
      }
    }

    console.log('\n=== 服务端直接依赖的所有包 ===')
    const serverDeps = ['express', 'archiver', 'better-sqlite3', 'fluent-ffmpeg', '@ffmpeg-installer/ffmpeg']
    for (const d of serverDeps) {
      console.log(`  ${top.has(d) || nested.has(d) ? '✓' : '✗'} ${d}`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

main()
