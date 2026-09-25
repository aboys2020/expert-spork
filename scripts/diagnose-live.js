/**
 * 诊断脚本：对一首歌的所有音质做结构分析，并把结果打印 + 写入文件。
 *
 * 为什么要独立成脚本：Windows 上 Electron 的 GUI 进程没有控制台，
 * 打包版里 F12 也未必可用，导致「拿不到失败参数」。
 * 这个脚本用打包后的 exe 以 ELECTRON_RUN_AS_NODE=1 运行，
 * 直接调用应用自身的诊断逻辑，无需打开界面、无需 DevTools。
 *
 * sessionid 可以不传：不传时会走与应用「一键登录」完全相同的逻辑，
 * 读取本机汽水音乐客户端的 Cookies 库来获取（需要本机已登录汽水音乐）。
 *
 * 用法（PowerShell）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   # 自动读取本机登录态（推荐）
 *   & "$env:LOCALAPPDATA\Programs\popDownloader\PopDownloader.exe" `
 *       ".\scripts\diagnose-live.js" "" "7665560323298887720"
 *   # 或显式传入 sessionid
 *   & "..." ".\scripts\diagnose-live.js" "<sessionid>" "7665560323298887720"
 *
 * 报告会写到 %APPDATA%\popDownloader\diagnose-track-quality.txt
 */

const fs = require('fs')
const path = require('path')

/**
 * 定位「应用自身的根路径」，用它来 require 应用包内的模块。
 *
 * 为什么必须这样：本脚本放在仓库里（普通目录），而脚本里的相对 require
 * 是相对「脚本文件」解析的，会指到仓库的 server/ 去 ——
 * 那里通常没有装 node_modules，于是报 Cannot find module 'better-sqlite3'。
 * 正确做法是显式指向打包后的应用（app.asar），即真实运行时用的那份代码。
 */
function resolveAppRoot() {
  // 方式 1：Electron 的 app.getAppPath()
  try {
    const electron = require('electron')
    const p = electron && electron.app && typeof electron.app.getAppPath === 'function'
      ? electron.app.getAppPath()
      : ''
    if (p) {
      return { root: p, source: 'app.getAppPath()' }
    }
  } catch {}

  // 方式 2：从可执行文件路径推导，形如 <root>\resources\app.asar 或 <root>\resources\app
  try {
    const exeDir = path.dirname(process.execPath)
    const asar = path.join(exeDir, 'resources', 'app.asar')
    if (fs.existsSync(asar)) {
      return { root: asar, source: 'process.execPath → resources/app.asar' }
    }
    const appDir = path.join(exeDir, 'resources', 'app')
    if (fs.existsSync(appDir)) {
      return { root: appDir, source: 'process.execPath → resources/app' }
    }
  } catch {}

  return { root: '', source: '' }
}

const appRootInfo = resolveAppRoot()
const APP_ROOT = appRootInfo.root

/**
 * 选择要加载的 server/utils 目录。
 *
 * 默认用应用包内的（app.asar），保证诊断的就是真实发布产物。
 * 但另提供 DIAG_USE_LOCAL_SERVER=true 走「脚本所在仓库的 server 目录」，
 * 这样改完代码不必重新打包装机就能验证 —— 排查阶段能省掉大量来回。
 * 注意：该模式下 server 的依赖仍需可解析，所以仓库需要装好 node_modules，
 * 或把它们的 node_modules 一并放在可解析的位置。
 */
const USE_LOCAL_SERVER = process.env.DIAG_USE_LOCAL_SERVER === 'true'
const SERVER_ROOT = USE_LOCAL_SERVER ? path.join(__dirname, '..') : APP_ROOT

/**
 * 本地模式下的依赖解析：代码取自仓库，依赖取自应用包内。
 * 必须在加载任何 server 模块「之前」执行，否则第一个 require 就会失败。
 * 仓库通常没有 node_modules，而 app.asar 里有完整的生产依赖，
 * 把后者加入模块搜索路径即可两全其美：能立刻验证新代码，又不必重新打包。
 */
if (USE_LOCAL_SERVER && APP_ROOT) {
  const extra = [
    path.join(APP_ROOT, 'node_modules', 'electron', 'node_modules'),
    path.join(APP_ROOT, 'node_modules'),
  ]
  for (const p of extra) {
    if (!module.paths.includes(p)) {
      module.paths.unshift(p)
    }
  }
}

/**
 * 参数解析：兼容两种写法，避免因空字符串被当成「未提供」而误判。
 *   diagnose-live.js <track_id>
 *   diagnose-live.js <sessionid> <track_id>
 *   diagnose-live.js "" <track_id>          （sessionid 留空时自动读取本机登录态）
 *
 * 注意：必须用 `typeof x === 'string'` 判断而不是 `x || default`，
 * 因为用户常把 sessionid 写成空字符串 ""，用 || 会把它当成未提供。
 */
function parseArgs(argv) {
  const positional = argv.slice(2)
  const first = typeof positional[0] === 'string' ? positional[0].trim() : ''
  const second = typeof positional[1] === 'string' ? positional[1].trim() : ''

  if (first && second) {
    return { explicitSession: first, track: second }
  }
  if (first && !second) {
    // 只给了一个参数：按 track_id 解释，sessionid 走自动读取
    return { explicitSession: '', track: first }
  }
  if (!first && second) {
    // 第一个是空串（sessionid 留空）
    return { explicitSession: '', track: second }
  }
  return { explicitSession: '', track: '' }
}

const parsed = parseArgs(process.argv)
let sessionId = parsed.explicitSession
const trackId = parsed.track
// 可选的音质过滤：只测指定音质（逗号分隔），不传则测全部
const qualityFilter = (() => {
  const raw = typeof process.argv[4] === 'string' ? process.argv[4].trim() : ''
  if (!raw) {
    return null
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
})()

/** 不传 sessionid 时，复用应用自身的「一键登录」读取逻辑 */
function resolveSessionId() {
  if (sessionId) {
    return { value: sessionId, source: '命令行参数' }
  }
  try {
    // 关键：从选定的 server 根目录加载，而不是依赖相对脚本的解析
    const cookieModulePath = SERVER_ROOT
      ? path.join(SERVER_ROOT, 'server', 'utils', 'sodamusic-cookie.js')
      : ''
    const { getSessionIdFromSodaMusicCookies } = cookieModulePath
      ? require(cookieModulePath)
      : require('../server/utils/sodamusic-cookie')
    const result = getSessionIdFromSodaMusicCookies()
    if (result && result.supported && result.sessionid) {
      return { value: result.sessionid, source: '本机汽水音乐 Cookies（同「一键登录」）' }
    }
    return { value: '', source: '', reason: result && result.reason ? result.reason : '未取到 sessionid' }
  } catch (error) {
    return { value: '', source: '', reason: error.message }
  }
}

function reportPath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'diagnose-track-quality.txt')
  } catch {
    return path.join(process.cwd(), 'diagnose-track-quality.txt')
  }
}

function toText(result) {
  const lines = []
  lines.push('PopDownloader 音质诊断报告')
  lines.push(`生成时间: ${new Date().toISOString()}`)
  lines.push(`track_id: ${result.track_id}`)
  lines.push('说明：只含长度与结构参数，不含密钥或 IV 内容。')
  lines.push('='.repeat(72))
  for (const entry of result.report) {
    lines.push('')
    lines.push(`【${entry.quality}】${entry.结论 || ''}`)
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'quality' || key === '结论') {
        continue
      }
      lines.push(`  ${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(72))
  lines.push('对比提示：重点看 senc版本 / senc_flags / senc声明IV大小 / senc声明样本数 /')
  lines.push('mdat数据字节 / 样本表声明总字节 在成功音质与失败音质之间的差异。')
  return lines.join('\r\n')
}

async function viaHttp() {
  const body = { sessionid: sessionId, track_id: trackId, confirm: true }
  if (qualityFilter) {
    body.qualities = qualityFilter
  }
  const res = await fetch('http://localhost:3001/api/diagnose/track-quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

async function viaModule() {
  const trackModulePath = SERVER_ROOT ? path.join(SERVER_ROOT, 'server', 'utils', 'track-download.js') : ''
  const { diagnoseTrackMedia } = trackModulePath
    ? require(trackModulePath)
    : require('../server/utils/track-download')
  const result = await diagnoseTrackMedia({
    sessionid: sessionId,
    track_id: trackId,
    qualities: qualityFilter,
  })
  return { status: 200, json: { message: 'success', data: result }, text: '' }
}

async function main() {
  if (!trackId) {
    console.log('用法: diagnose-live.js [sessionid] <track_id>')
    console.log('  sessionid 可省略：省略时会读取本机汽水音乐登录态（需要本机已登录）。')
    console.log('  示例（sessionid 留空）:')
    console.log('    diagnose-live.js "" 7665560323298887720')
    console.log('  示例（只给 track_id）:')
    console.log('    diagnose-live.js 7665560323298887720')
    console.log('  可选第 3 个参数指定音质，例如只测 lossless:')
    console.log('    diagnose-live.js "" 7665560323298887720 lossless')
    return
  }

  const resolved = resolveSessionId()
  if (!resolved.value) {
    console.log('未能取得 sessionid，原因：' + (resolved.reason || '未知'))
    console.log('')
    console.log('可选做法：')
    console.log('  1. 确认本机汽水音乐 PC 端已登录（本脚本用的是与「一键登录」相同的读取方式）')
    console.log('  2. 或显式传入：diagnose-live.js <sessionid> <track_id>')
    console.log('     sessionid 可在应用里按 F12，执行：')
    console.log("     JSON.parse(localStorage['popDownloader.auth.session']).sessionid")
    return
  }
  sessionId = resolved.value

  console.log(`track_id=${trackId}`)
  console.log(`应用根路径: ${APP_ROOT || '(未定位到，将回退到脚本所在目录)'}${appRootInfo.source ? `  [${appRootInfo.source}]` : ''}`)
  console.log(`代码来源: ${USE_LOCAL_SERVER ? '仓库 server 目录（DIAG_USE_LOCAL_SERVER=true）' : '应用包内 app.asar'}`)
  console.log(`sessionid 来源：${resolved.source}`)
  console.log('开始诊断（会依次下载该曲目全部音质用于分析，不写出音频文件）...')

  let outcome
  try {
    outcome = await viaHttp()
    if (outcome.status !== 200) {
      console.log(`HTTP 模式失败（状态 ${outcome.status}），改用应用内模块模式...`)
      outcome = await viaModule()
    }
  } catch (err) {
    console.log(`HTTP 模式不可用（${err.message}），改用应用内模块模式...`)
    outcome = await viaModule()
  }

  const data = outcome.json && outcome.json.data
  if (!data) {
    console.log('诊断失败：')
    console.log(outcome.text || JSON.stringify(outcome.json))
    return
  }

  const out = reportPath()
  try {
    fs.writeFileSync(out, toText(data), 'utf8')
    console.log(`报告已写入: ${out}`)
  } catch (err) {
    console.log(`写入报告失败: ${err.message}`)
  }

  console.log('')
  console.log(toText(data))
}

main().catch((err) => {
  console.log('诊断异常: ' + (err && err.stack ? err.stack : err))
})
