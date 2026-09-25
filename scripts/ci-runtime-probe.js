/**
 * 在「打包后的 Electron 运行时」里执行的自检探针。
 *
 * 由 scripts/ci-smoke-test.js 以 ELECTRON_RUN_AS_NODE=1 方式调用，因此：
 *   - 跑的是 Electron 自带的 Node（与真实运行时同一套 ABI）
 *   - 能加载 app.asar 里的代码（Electron 会为 fs 打补丁以支持 asar）
 * 这样一个探针就能把三类问题区分开：
 *   A. asar 结构/路径问题          → 日志停在哪个步骤
 *   B. 打包内代码或原生模块加载失败 → require 抛错
 *   C. 服务端能起来但被端口/权限挡住 → listen 报错
 *
 * 结果同时写到 stdout 和 TARGET_FILE，供 CI 两侧取证。
 * 用法（由冒烟测试调用，一般不手动执行）：
 *   set ELECTRON_RUN_AS_NODE=1
 *   <app>.exe scripts/ci-runtime-probe.js
 */

const fs = require('fs')
const path = require('path')

const out = []

function report(line) {
  const text = String(line)
  out.push(text)
  try {
    process.stdout.write(`[probe] ${text}\n`)
  } catch {}
  try {
    if (process.env.PROBE_FILE) {
      fs.writeFileSync(process.env.PROBE_FILE, out.join('\n') + '\n', 'utf8')
    }
  } catch {}
}

function step(name, fn) {
  const started = Date.now()
  try {
    const value = fn()
    report(`OK   ${name} (${Date.now() - started}ms)${value === undefined ? '' : ' => ' + value}`)
    return value
  } catch (err) {
    report(`FAIL ${name} (${Date.now() - started}ms) => ${err && err.message ? err.message : err}`)
    return undefined
  }
}

async function main() {
  const port = Number(process.env.PORT || 3201)
  report(`electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`)
  report(`cwd=${process.cwd()} __dirname=${__dirname}`)

  // 1) 定位 app.asar。优先用 Electron 的 app.getAppPath()，它直接给出应用根路径；
  //    退化方案是按 __dirname 去掉结尾的 scripts。
  let asarPath = null
  try {
    const electron = require('electron')
    if (electron && typeof electron.app?.getAppPath === 'function') {
      asarPath = electron.app.getAppPath()
    }
  } catch {}
  if (!asarPath) {
    asarPath = __dirname.replace(/[\\/]scripts$/, '')
  }
  report(`asar=${asarPath}`)
  report(`asar exists=${step('fs.existsSync(asar)', () => fs.existsSync(asarPath))}`)

  // 2) 直接把打包内的 server/index.js 加载起来并真正监听端口。
  //    这一步覆盖：asar 内代码可读、require 链完整、better-sqlite3 等原生模块 ABI 正确。
  const serverEntry = path.join(asarPath, 'server', 'index.js')
  const loaded = step('require(server/index.js)', () => {
    require(serverEntry)
    return 'module loaded'
  })
  if (loaded === undefined) {
    report('__PROBE_DONE__')
    return
  }

  // 2b) 逐个显式 require 所有第三方依赖。
  //
  // 为什么必须做：曾经出现过这样的真实故障 —— zip-stream 在顶层、archiver-utils 被
  // npm 提升冲突挤进 archiver/node_modules/，于是 zip-stream 里的
  // require('archiver-utils') 解析不到。archiver 模块本身能加载、server/index.js 也能
  // 加载，只有真正 require('archiver') 时才炸，导致坏包流到了用户手里。
  // 这里逐个 require 一遍，把这类问题挡在 CI 阶段。
  const requiredModules = []
  for (const name of [
    'express',
    'archiver',
    'archiver-utils',
    'zip-stream',
    'compress-commons',
    'better-sqlite3',
    'fluent-ffmpeg',
    '@ffmpeg-installer/ffmpeg',
  ]) {
    const ok = step(`require('${name}')`, () => {
      require(name)
      return 'ok'
    })
    if (ok !== undefined) {
      requiredModules.push(name)
    }
  }
  report(`已成功 require ${requiredModules.length} 个第三方模块`)

  // 2c) 完整加载 archiver 的依赖链。
  //     实测：require('archiver') 会连锁加载 archiver/lib/plugins/zip -> zip-stream，
  //     真正的报错来自 zip-stream 内部的 require('archiver-utils')，所以这一条是关键校验。
  step('require(archiver) 完整加载链', () => {
    const archiverEntry = require.resolve('archiver')
    const archiver = require(archiverEntry)
    if (typeof archiver !== 'function' && typeof archiver.create !== 'function') {
      throw new Error('archiver 导出形状异常')
    }
    return 'archiver 可用'
  })

  // server/index.js 通过 app.listen 异步监听，这里轮询确认真能服务
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20000
  let listenError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`)
      const body = await res.text()
      report(`OK   /api/health (${res.status}) => ${body.slice(0, 160)}`)
      report('__PROBE_DONE__')
      return
    } catch (err) {
      listenError = err && err.message ? err.message : String(err)
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  report(`FAIL 服务端未能在 ${port} 端口提供服务 => ${listenError}`)
  report('__PROBE_DONE__')
}

main().catch((err) => {
  report(`FAIL 探针异常 => ${err && err.stack ? err.stack : err}`)
  report('__PROBE_DONE__')
})
