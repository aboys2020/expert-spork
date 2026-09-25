/**
 * 诊断接口：把「同一首歌各音质的容器/加密参数」写入一个文本文件，便于直接发送排查。
 *
 *   POST /api/diagnose/track-quality
 *   body: { sessionid, track_id, aid?, confirm: true, qualities?: [...] }
 *
 * 设计要点：
 *  1. 必须显式传 confirm: true 才会下载。默认不下载 —— 一次诊断要拉取全部音质的
 *     媒体文件（合计可能十几 MB），不应在用户无感的情况下消耗流量。未传时返回使用说明。
 *  2. 结果同时写文件：Windows 上 Electron 的 GUI 进程没有控制台，
 *     F12 也未必能打开 DevTools，所以让报告落到磁盘最省事。
 *  3. 每完成一个音质就写一次文件，中途失败也能拿到已采集的部分。
 *  4. 报告只含长度与结构参数，不含密钥或 IV 内容，可安全分享。
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { diagnoseTrackMedia, getTrackV2Payload } = require('../utils/track-download')

function resolveReportPath() {
  let baseDir = ''
  try {
    baseDir = app.getPath('userData')
  } catch {
    baseDir = process.cwd()
  }
  return path.join(baseDir, 'diagnose-track-quality.txt')
}

function toText(report, meta) {
  const lines = []
  lines.push('PopDownloader 音质诊断报告')
  lines.push(`生成时间: ${new Date().toISOString()}`)
  lines.push(`track_id: ${meta.track_id}`)
  lines.push(`build: ${meta.build}`)
  lines.push('')
  lines.push('说明：以下只包含长度与结构参数，不含密钥或 IV 内容。')
  lines.push('='.repeat(72))

  for (const entry of report) {
    lines.push('')
    lines.push(`【${entry.quality}】${entry.结论 || ''}`)
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'quality' || key === '结论') {
        continue
      }
      const printed = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
      lines.push(`  ${key}: ${printed}`)
    }
  }

  lines.push('')
  lines.push('='.repeat(72))
  lines.push('对比提示：重点看 senc版本 / senc_flags / senc声明IV大小 / senc声明样本数 /')
  lines.push('mdat数据字节 / 样本表声明总字节 这几项在成功音质与失败音质之间的差异。')
  return lines.join('\r\n')
}

module.exports = {
  name: 'diagnose-track-quality',
  method: 'post',
  path: '/api/diagnose/track-quality',
  handler: async (req, res) => {
    const payload = getTrackV2Payload(req.body)

    if (!payload.sessionid) {
      res.status(400).json({ message: 'sessionid is required' })
      return
    }

    if (!payload.track_id) {
      res.status(400).json({ message: 'track_id is required' })
      return
    }

    // 必须显式确认，避免无意中大量下载
    if (req.body?.confirm !== true) {
      res.status(400).json({
        message: '需要确认',
        hint:
          '本诊断会依次下载该曲目的全部音质（合计可能十几 MB）用于分析，不会写出音频文件。' +
          '确认后请在请求体里加上 "confirm": true。',
      })
      return
    }

    const reportPath = resolveReportPath()
    const partial = []
    const writeReport = () => {
      try {
        const build = require('./health').response?.build || 'unknown'
        fs.writeFileSync(reportPath, toText(partial, { track_id: payload.track_id, build }), 'utf8')
      } catch {}
    }

    try {
      const result = await diagnoseTrackMedia({
        aid: payload.aid,
        sessionid: payload.sessionid,
        track_id: payload.track_id,
        qualities: Array.isArray(req.body?.qualities) ? req.body.qualities : null,
        onProgress: (entry) => {
          partial.push(entry)
          writeReport()
        },
      })

      writeReport()

      res.json({
        message: 'success',
        reportPath,
        data: result,
      })
    } catch (error) {
      writeReport()
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
        reportPath: partial.length > 0 ? reportPath : null,
      })
    }
  },
}
