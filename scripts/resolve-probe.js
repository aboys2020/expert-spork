/**
 * 诊断脚本：在「打包后的 Electron 运行时」里验证各个第三方模块能否真正被 require。
 * 用于定位「Cannot find module 'xxx'」这类只在实际运行时才暴露的问题。
 *
 * 为什么必须在 Electron 里跑：app.asar 是虚拟归档，普通 Node 读不进去
 * （普通 node 访问 app.asar\xxx 会直接 ENOENT），只有 Electron 的 fs 补丁能解析它。
 * 所以这个探针要用打包后的 exe 以 ELECTRON_RUN_AS_NODE=1 方式启动。
 *
 * 用法（Windows，PowerShell）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "C:\Users\<你>\AppData\Local\Programs\popDownloader\PopDownloader.exe" `
 *       "C:\path\to\scripts\resolve-probe.js"
 *
 * 注意：脚本请放在 asar 之外的普通目录运行，它自己会去定位已安装的 app.asar。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const lines = []
function log(s) {
  const t = String(s)
  lines.push(t)
  process.stdout.write(t + '\n')
}

/** 定位已安装应用的 app.asar */
function locateAsar() {
  const cands = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'popDownloader', 'resources', 'app.asar'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PopDownloader', 'resources', 'app.asar'),
  ]
  for (const c of cands) {
    if (fs.existsSync(c)) {
      return c
    }
  }
  return null
}

function main() {
  log(`electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`)

  const asar = locateAsar()
  log('asar=' + (asar || '(未找到)'))
  if (!asar) {
    return
  }

  const appRoot = asar // 形如 ...\resources\app.asar，直接当目录用
  log('appRoot 可访问=' + fs.existsSync(appRoot))

  // 逐个尝试 require，并打印解析到的实际路径
  const modules = [
    'express',
    'archiver',
    'archiver-utils',
    'zip-stream',
    'compress-commons',
    'better-sqlite3',
    'fluent-ffmpeg',
    '@ffmpeg-installer/ffmpeg',
  ]

  log('')
  log('=== require 实测（在 app.asar 上下文里）===')
  for (const name of modules) {
    // 关键：把 paths 指向 asar 内的 node_modules，模拟打包内代码的解析行为
    const opts = { paths: [path.join(appRoot, 'node_modules')] }
    let resolved = null
    let resErr = null
    try {
      resolved = require.resolve(name, opts)
    } catch (e) {
      resErr = e
    }
    if (resolved) {
      log(`  ✓ resolve 成功  ${name.padEnd(22)} -> ${resolved}`)
    } else {
      log(`  ✗ resolve 失败  ${name.padEnd(22)} -> ${resErr ? resErr.code || resErr.message : '未知'}`)
    }
  }

  log('')
  log('=== 从 archiver 的位置解析 archiver-utils（模拟真实调用链）===')
  try {
    const archiverDir = path.dirname(require.resolve('archiver', { paths: [path.join(appRoot, 'node_modules')] }))
    log('archiver 入口目录=' + archiverDir)
    const au = require.resolve('archiver-utils', { paths: [archiverDir] })
    log('✓ archiver-utils 解析成功 -> ' + au)
  } catch (e) {
    log('✗ 解析失败: ' + (e.code || '') + ' ' + e.message)
  }

  log('')
  log('=== 直接 require archiver（会触发其内部依赖）===')
  try {
    const archiver = require(path.join(appRoot, 'node_modules', 'archiver'))
    log('✓ require archiver 成功, typeof=' + typeof archiver)
  } catch (e) {
    log('✗ require archiver 失败: ' + (e.code || '') + ' ' + e.message)
    log('  堆栈:')
    String(e.stack || '').split('\n').slice(0, 8).forEach((l) => log('    ' + l))
  }

  log('')
  log('=== 直接 require 服务端 API 入口（复现启动时的完整加载链）===')
  try {
    const apis = require(path.join(appRoot, 'server', 'apis', 'index.js'))
    log('✓ server/apis 加载成功，接口数=' + (Array.isArray(apis) ? apis.length : '?'))
  } catch (e) {
    log('✗ 加载失败: ' + (e.code || '') + ' ' + e.message)
    log('  堆栈:')
    String(e.stack || '').split('\n').slice(0, 10).forEach((l) => log('    ' + l))
  }
}

main()
