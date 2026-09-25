/**
 * 诊断接口（只读，不写出任何文件）：
 *   POST /api/diagnose/track-quality
 *   body: { sessionid, track_id, aid?, qualities? }
 *
 * 用途：同一首歌在不同音质下的容器/加密参数对照。
 * 真实场景：lossless 下载失败、其余音质正常，四者走同一代码路径，
 * 差异只可能来自上游文件本身，需要并排比较才能定位。
 *
 * 返回内容只含长度与结构参数，不含任何密钥或 IV 内容。
 */

const { diagnoseTrackMedia } = require('../utils/track-download')
const { getTrackV2Payload } = require('../utils/track-download')

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

    try {
      const result = await diagnoseTrackMedia({
        aid: payload.aid,
        sessionid: payload.sessionid,
        track_id: payload.track_id,
        qualities: Array.isArray(req.body?.qualities) ? req.body.qualities : null,
      })

      res.json({ message: 'success', data: result })
    } catch (error) {
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
      })
    }
  },
}
