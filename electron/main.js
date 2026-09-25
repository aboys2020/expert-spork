const { app, BrowserWindow } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')

/**
 * 诊断心跳（默认完全关闭，不影响正常运行）。
 *
 * 背景：Windows 上 Electron 的 GUI 进程没有挂控制台，主进程里 console.log 的内容会被丢弃，
 * 所以 CI 里看 GUI 进程的 stdout/stderr 永远是空的，无法判断它卡在哪一步。
 * 设置环境变量 SMOKE_HEARTBEAT=<文件路径> 后，主进程会把启动关键节点直接写入该文件，
 * 供 scripts/ci-smoke-test.js 取证。
 */
const HEARTBEAT_FILE = process.env.SMOKE_HEARTBEAT || ''
function heartbeat(message) {
  if (!HEARTBEAT_FILE) {
    return
  }
  try {
    fs.appendFileSync(HEARTBEAT_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

heartbeat(`main.js 已进入 pid=${process.pid} electron=${process.versions.electron}`)

// 直接在主进程内拉起 Express 后端（server/index.js 会调用 app.listen 并保持进程存活）
require(path.join(__dirname, '..', 'server', 'index.js'))
heartbeat('server/index.js 已 require')

const PORT = process.env.PORT || 3001
const BASE = `http://localhost:${PORT}`
heartbeat(`PORT=${PORT}`)

let win = null

function createWindow() {
  heartbeat('createWindow 开始')
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  heartbeat('BrowserWindow 已创建')
  win.on('closed', () => {
    win = null
    heartbeat('窗口已关闭')
  })
  waitForServerThenLoad()
}

function loadIntoWindow() {
  // 防御：等待后端的过程中窗口可能已被关闭，此时 win 为 null，
  // 原来的 win.loadURL() 会抛未捕获异常。
  if (!win || win.isDestroyed()) {
    heartbeat('窗口已不存在，跳过 loadURL')
    return
  }
  win.loadURL(BASE).catch((err) => {
    heartbeat(`loadURL 失败：${err && err.message ? err.message : err}`)
  })
}

// 后端 listen 是异步的，先轮询就绪再 loadURL，避免白屏
function waitForServerThenLoad() {
  const tryLoad = (attempt) => {
    const req = http.get(BASE, (res) => {
      res.destroy()
      heartbeat(`后端就绪，loadURL（第 ${attempt + 1} 次探测）`)
      loadIntoWindow()
    })
    req.on('error', (err) => {
      if (attempt < 30) {
        heartbeat(`后端未就绪（第 ${attempt + 1} 次）：${err && err.code ? err.code : err}`)
        setTimeout(() => tryLoad(attempt + 1), 300)
      } else {
        heartbeat('后端 30 次探测均失败，仍尝试 loadURL')
        loadIntoWindow()
      }
    })
  }
  tryLoad(0)
}

app
  .whenReady()
  .then(() => {
    heartbeat('app ready')
    createWindow()
  })
  .catch((err) => {
    heartbeat(`app.whenReady 失败：${err && err.message ? err.message : err}`)
  })

app.on('window-all-closed', () => {
  heartbeat('window-all-closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

process.on('uncaughtException', (err) => {
  heartbeat(`uncaughtException: ${err && err.stack ? err.stack : err}`)
})

process.on('unhandledRejection', (reason) => {
  heartbeat(`unhandledRejection: ${reason}`)
})
