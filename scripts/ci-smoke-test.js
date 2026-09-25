/**
 * CI 冒烟测试：确保 electron-builder 打出的产物真的能“跑起来”。
 *
 * 分两个阶段，目的是把不同性质的问题区分开：
 *
 *   阶段 1｜运行时探针（scripts/ci-runtime-probe.js，以 ELECTRON_RUN_AS_NODE=1 执行）
 *     在打包后的 Electron 运行时里加载 app.asar 内的 server/index.js 并真正监听端口。
 *     覆盖：asar 结构、require 链、better-sqlite3 等原生模块的 ABI 是否正确。
 *     这一阶段不需要 GUI，因此结果只反映「打包内容是否可用」。
 *
 *   阶段 2｜真实启动 GUI 产物
 *     启动 release/win-unpacked/PopDownloader.exe（带 --no-sandbox --disable-gpu，
 *     因为 Runner 是无头会话），轮询 /api/health 并校验前端入口。
 *
 * 之所以这样拆：此前只跑阶段 2 时，产物「进程活着但端口始终不响应、且 stdout/stderr
 * 全为空」，无法判断是打包内容坏了还是 GUI 起不来。拆开后一眼可辨。
 *
 * 用法：node scripts/ci-smoke-test.js
 * 退出码 0 = 通过，非 0 = 产物有问题（会让 CI 失败，避免发出坏包）。
 */

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXE_PATH = path.join(ROOT, 'release', 'win-unpacked', 'PopDownloader.exe')
const PROBE_SCRIPT = path.join(ROOT, 'scripts', 'ci-runtime-probe.js')

const GUI_PORT = Number(process.env.SMOKE_PORT || 3199)
// 探针与 GUI 必须用不同端口，否则探针残留的监听会干扰阶段 2
const PROBE_PORT = Number(process.env.SMOKE_PROBE_PORT || 3201)
const GUI_BASE = `http://127.0.0.1:${GUI_PORT}`

const PROBE_TIMEOUT_MS = 60 * 1000
const GUI_TIMEOUT_MS = 90 * 1000

const LOG_DIR = path.join(os.tmpdir(), 'popdownloader-smoke')
const PROBE_LOG = path.join(LOG_DIR, 'probe.log')
const PROBE_RESULT = path.join(LOG_DIR, 'probe-result.txt')
const GUI_LOG = path.join(LOG_DIR, 'gui.log')

function fail(message, extra) {
  console.error(`\n[smoke] ✗ ${message}`)
  if (extra) {
    console.error(extra)
  }
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function probeUrl(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function printSection(title, content) {
  console.error(`[smoke] --- ${title} ---`)
  console.error(content && content.trim() ? content : '(空)')
}

/** 阶段 1：在打包后的 Electron 运行时里验证 asar 内容 */
async function runRuntimeProbe() {
  console.log('[smoke] ===== 阶段 1/2：运行时探针（ELECTRON_RUN_AS_NODE，无 GUI）=====')
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.rmSync(PROBE_LOG, { force: true })
  fs.rmSync(PROBE_RESULT, { force: true })

  const logFd = fs.openSync(PROBE_LOG, 'w')
  const child = spawn(EXE_PATH, [PROBE_SCRIPT], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PROBE_FILE: PROBE_RESULT,
      PORT: String(PROBE_PORT),
    },
    stdio: ['ignore', logFd, logFd],
  })

  let exited = false
  let exitInfo = ''
  child.on('exit', (code, signal) => {
    exited = true
    exitInfo = `code=${code} signal=${signal}`
  })

  const deadline = Date.now() + PROBE_TIMEOUT_MS
  let output = ''
  while (Date.now() < deadline) {
    output = readFileSafe(PROBE_LOG) + readFileSafe(PROBE_RESULT)
    if (output.includes('__PROBE_DONE__')) {
      break
    }
    if (exited) {
      await sleep(300)
      output = readFileSafe(PROBE_LOG) + readFileSafe(PROBE_RESULT)
      break
    }
    await sleep(500)
  }

  try {
    if (!exited) {
      child.kill()
    }
  } catch {}
  try {
    fs.closeSync(logFd)
  } catch {}

  console.log(output.trim() ? output.trim() : '(探针无输出)')

  if (!output.includes('__PROBE_DONE__')) {
    console.error(`[smoke] 探针未完成（${exitInfo || '超时'}）`)
    printSection('探针输出', output)
    fail('运行时探针未能完成：打包后的 electron 以 Node 模式运行脚本时卡住或崩溃。')
  }

  const lines = output.split(/\r?\n/).filter((l) => l.startsWith('FAIL'))
  if (lines.length > 0) {
    console.error(`[smoke] 探针报告了 ${lines.length} 处失败`)
    printSection('探针输出', output)
    fail(
      '打包内容在 Electron 运行时里不可用（详见上方 FAIL 行）。\n' +
        '  提示：若是 require 失败，多半是原生模块 ABI、asar 打包遗漏或依赖缺失；\n' +
        '        若 asar exists=false，说明 app.asar 没有生成或路径不对。',
    )
  }

  console.log('[smoke] ✓ 阶段 1 通过：app.asar 内容在 Electron 运行时里可加载并正常监听')
}

/** 阶段 2：真实启动 GUI 产物并校验接口与前端入口 */
async function runGuiCheck() {
  console.log('[smoke] ===== 阶段 2/2：启动 GUI 产物 =====')
  const logFd = fs.openSync(GUI_LOG, 'w')

  const child = spawn(EXE_PATH, ['--no-sandbox', '--disable-gpu'], {
    env: {
      ...process.env,
      PORT: String(GUI_PORT),
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', logFd, logFd],
  })

  let childExited = false
  let exitInfo = ''
  child.on('exit', (code, signal) => {
    childExited = true
    exitInfo = `code=${code} signal=${signal}`
  })

  const cleanup = () => {
    try {
      if (!childExited) {
        child.kill()
      }
    } catch {}
  }
  process.on('exit', cleanup)

  const deadline = Date.now() + GUI_TIMEOUT_MS
  let lastStatus = '未收到任何响应'

  while (Date.now() < deadline) {
    const health = await probeUrl(`${GUI_BASE}/api/health`)
    if (health && health.ok) {
      let payload = null
      try {
        payload = JSON.parse(health.body)
      } catch {
        fail(`/api/health 返回的不是 JSON：${health.body.slice(0, 200)}`)
      }
      // 不能只看 200：同端口若跑着别的服务会误判通过
      if (payload.message !== 'PopDownloader local API is running') {
        fail(`同端口上的服务不是本应用（message=${JSON.stringify(payload.message)}）。`)
      }
      if (String(payload.port) !== String(GUI_PORT)) {
        fail(`health 回显端口 ${payload.port} 与期望的 ${GUI_PORT} 不一致，疑似连到了别的实例。`)
      }
      console.log(`[smoke] /api/health 通过：${JSON.stringify(payload)}`)

      const index = await probeUrl(`${GUI_BASE}/`)
      if (!index || !index.ok) {
        fail(`后端存活但根路径不可访问（${index ? index.status : '无响应'}），dist 静态资源可能没打进包。`)
      }
      if (!/<!doctype html|<div id="app"/i.test(index.body)) {
        fail('根路径返回的内容不像前端入口页，请检查 server/index.js 的 distPath 与打包 files 配置。')
      }

      console.log('[smoke] ✓ 阶段 2 通过：GUI 产物启动正常，后端可用 + 前端资源完整')
      cleanup()
      process.exit(0)
    }

    if (health) {
      lastStatus = `HTTP ${health.status}`
    } else if (childExited) {
      lastStatus = `进程已退出（${exitInfo}）`
    }

    await sleep(1500)
  }

  printSection('GUI 进程输出', readFileSafe(GUI_LOG))
  fail(
    `等待 ${GUI_TIMEOUT_MS / 1000}s 后 GUI 产物仍未就绪（最后状态：${lastStatus}）。\n` +
      '  注意：阶段 1 已证明打包内容本身可用，因此问题出在「GUI 启动」这一环\n' +
      '        （无头会话、Electron 窗口创建失败、或主进程在窗口阶段阻塞）。',
  )
}

async function main() {
  if (!fs.existsSync(EXE_PATH)) {
    fail(`找不到打包产物：${EXE_PATH}（electron-builder 是否成功生成 win-unpacked？）`)
  }
  console.log(`[smoke] 待测产物：${EXE_PATH}`)

  await runRuntimeProbe()
  await runGuiCheck()
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)))
