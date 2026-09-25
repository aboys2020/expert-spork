/**
 * CI 冒烟测试：验证 electron-builder 打出的免安装产物真的能“跑起来”。
 *
 * 为什么需要它：
 *   better-sqlite3 是原生模块。npm ci 装出来的是「系统 Node」的二进制，
 *   而打包进 exe 的应用跑在「Electron 自己的 Node」上。如果 ABI 没对齐，
 *   vite build / electron-builder 都不会报错，但用户双击 exe 会直接崩。
 *   这个脚本会在 CI 里启动 release/win-unpacked 下的 PopDownloader.exe，
 *   轮询 /api/health，确认前端静态资源 + Express 后端 + 原生模块都可加载。
 *
 * 用法：node scripts/ci-smoke-test.js
 * 退出码 0 = 通过，非 0 = 产物有问题（会让 CI 失败，避免发出坏包）。
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXE_PATH = path.join(ROOT, 'release', 'win-unpacked', 'PopDownloader.exe')
const PORT = Number(process.env.SMOKE_PORT || 3199)
const BASE = `http://127.0.0.1:${PORT}`
const WAIT_TIMEOUT_MS = 90 * 1000

function fail(message) {
  console.error(`\n[smoke] ✗ ${message}`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probe(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (!fs.existsSync(EXE_PATH)) {
    fail(`找不到打包产物：${EXE_PATH}（electron-builder 是否成功生成 win-unpacked？）`)
  }
  console.log(`[smoke] 待测产物：${EXE_PATH}`)

  const child = spawn(EXE_PATH, [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let childExited = false
  let exitInfo = ''
  child.on('exit', (code, signal) => {
    childExited = true
    exitInfo = `code=${code} signal=${signal}`
  })

  const stdout = []
  const stderr = []
  child.stdout.on('data', (d) => stdout.push(String(d)))
  child.stderr.on('data', (d) => stderr.push(String(d)))

  const cleanup = () => {
    try {
      if (!childExited) child.kill()
    } catch {}
  }
  process.on('exit', cleanup)

  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let lastStatus = '未收到任何响应'

  while (Date.now() < deadline) {
    if (childExited) {
      console.error('[smoke] --- 应用 stdout ---')
      console.error(stdout.join(''))
      console.error('[smoke] --- 应用 stderr ---')
      console.error(stderr.join(''))
      fail(`应用在就绪前退出（${exitInfo}）。常见原因：原生模块 ABI 不匹配、缺少依赖、主进程报错。`)
    }

    const health = await probe(`${BASE}/api/health`)
    if (health) {
      if (health.ok) {
        // 不能只看 200：万一同端口上跑着别的服务会误判通过。
        // health 会回显 message / author / port，逐项对一下，确认是本应用的实例。
        let payload = null
        try {
          payload = JSON.parse(health.body)
        } catch {
          fail(`/api/health 返回的不是 JSON：${health.body.slice(0, 200)}`)
        }
        if (payload.message !== 'PopDownloader local API is running') {
          fail(`同端口上的服务不是本应用（message=${JSON.stringify(payload.message)}），请检查 SMOKE_PORT 是否被占用。`)
        }
        if (String(payload.port) !== String(PORT)) {
          fail(`health 回显端口 ${payload.port} 与本次期望的 ${PORT} 不一致，疑似连到了别的实例。`)
        }
        console.log(`[smoke] /api/health 通过：${JSON.stringify(payload)}`)

        // 再确认前端入口能被后端吐出（index.html 由 dist 提供）
        const index = await probe(`${BASE}/`)
        if (!index || !index.ok) {
          fail(`后端存活但根路径不可访问（${index ? index.status : '无响应'}），dist 静态资源可能没打进包。`)
        }
        if (!/<!doctype html|<div id="app"/i.test(index.body)) {
          fail('根路径返回的内容不像前端入口页，请检查 server/index.js 的 distPath 与打包 files 配置。')
        }

        console.log('[smoke] ✓ 打包产物启动正常：后端可用 + 前端资源完整')
        cleanup()
        process.exit(0)
      }
      lastStatus = `HTTP ${health.status}`
    }

    await sleep(1500)
  }

  console.error('[smoke] --- 应用 stdout ---')
  console.error(stdout.join(''))
  console.error('[smoke] --- 应用 stderr ---')
  console.error(stderr.join(''))
  fail(`等待 ${WAIT_TIMEOUT_MS / 1000}s 后应用仍未就绪（最后状态：${lastStatus}）。`)
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)))
