const { endpoints, fixed, getPcQuery, lunaUserAgent } = require('../config/qishui-auth')
const { buildUrl, probeSessionValidity, signedFetch } = require('./http')
const { TrackDecryptor } = require('./track-decryptor')
const { FlacMetadataWriter } = require('./flac-metadata')

function getArtistName(trackPayload) {
  const artists = Array.isArray(trackPayload?.track?.artists) ? trackPayload.track.artists : []
  const firstArtist = artists[0]

  return (
    firstArtist?.simple_display_name ||
    firstArtist?.user_info?.nickname ||
    firstArtist?.name ||
    ''
  )
}

function getArtistNames(trackPayload) {
  const artists = Array.isArray(trackPayload?.track?.artists) ? trackPayload.track.artists : []

  return artists
    .map((artist) => (
      artist?.simple_display_name ||
      artist?.user_info?.nickname ||
      artist?.name ||
      ''
    ))
    .filter(Boolean)
}

function getNames(list) {
  if (!Array.isArray(list)) {
    return []
  }

  return list
    .map((item) => item?.name || '')
    .filter(Boolean)
}

function getReleaseDate(trackPayload) {
  const releaseTimestamp = trackPayload?.track?.album?.release_date

  if (typeof releaseTimestamp !== 'number' || Number.isNaN(releaseTimestamp) || releaseTimestamp <= 0) {
    return ''
  }

  return new Date(releaseTimestamp * 1000).toISOString().slice(0, 10)
}

function getGenreNames(trackPayload) {
  const tags = Array.isArray(trackPayload?.track?.tags) ? trackPayload.track.tags : []
  const genreNames = []

  for (const tag of tags) {
    const secondLevel = tag?.second_level_tag?.tag_name
    const firstLevel = tag?.first_level_tag?.tag_name

    if (secondLevel) {
      genreNames.push(secondLevel)
      continue
    }

    if (firstLevel) {
      genreNames.push(firstLevel)
    }
  }

  return [...new Set(genreNames)]
}

function getFirstImageUrl(imageLike) {
  if (!imageLike || !Array.isArray(imageLike.urls) || imageLike.urls.length === 0) {
    return ''
  }

  return imageLike.urls[0]
}

function resolveImageUrl(imageLike) {
  if (!imageLike) {
    return ''
  }

  const firstUrl = getFirstImageUrl(imageLike)
  const uri = imageLike.uri || ''
  const templatePrefix = imageLike.template_prefix || ''

  if (!firstUrl || !uri) {
    return firstUrl
  }

  const templateSuffix = templatePrefix
    ? `~${templatePrefix}-crop-center:800:800.jpg`
    : ''

  if (!firstUrl.includes(uri)) {
    return `${firstUrl}${uri}${templateSuffix}`
  }

  return `${firstUrl}${templateSuffix}`
}

function buildFlacMetadata(trackPayload) {
  const artists = getArtistNames(trackPayload)
  const composers = getNames(trackPayload?.track?.song_maker_team?.composers)
  const lyricists = getNames(trackPayload?.track?.song_maker_team?.lyricists)
  const genres = getGenreNames(trackPayload)
  const releaseDate = getReleaseDate(trackPayload)

  return {
    title: trackPayload?.track?.name || '',
    artist: artists,
    album: trackPayload?.track?.album?.name || '',
    albumArtist: artists,
    date: releaseDate,
    year: releaseDate ? releaseDate.slice(0, 4) : '',
    genre: genres,
    composer: composers,
    lyricist: lyricists,
  }
}

function getTrackV2Payload(reqBody) {
  const {
    aid = fixed.aid,
    sessionid,
    track_id,
  } = reqBody || {}

  return {
    aid,
    sessionid,
    track_id,
    media_type: 'track',
    queue_type: 'search_one_track',
    scene_name: 'search',
  }
}

async function fetchTrackPayload({ aid = fixed.aid, sessionid, track_id }) {
  const trackV2Url = buildUrl(endpoints.trackV2, getPcQuery({ aid }))
  const trackV2Response = await signedFetch(trackV2Url, {
    method: 'POST',
    headers: {
      Cookie: `sessionid=${sessionid};`,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': lunaUserAgent,
    },
    body: JSON.stringify({
      track_id,
      media_type: 'track',
      queue_type: 'search_one_track',
      scene_name: 'search',
    }),
  })

  const rawText = await trackV2Response.text()

  if (!rawText) {
    const sessionValid = await probeSessionValidity({ aid, sessionid })
    const error = new Error(
      sessionValid
        ? '获取音频信息失败：上游返回空响应（登录状态正常，可能是 track_v2 接口被风控拦截）'
        : '获取音频信息失败：登录状态已失效，请退出后重新扫码登录',
    )
    error.status = 502
    throw error
  }

  let trackPayload
  try {
    trackPayload = JSON.parse(rawText)
  } catch {
    const error = new Error('获取音频信息失败：上游返回的数据不是有效 JSON')
    error.status = 502
    throw error
  }

  if (!trackV2Response.ok) {
    const error = new Error(trackPayload?.error || trackPayload?.message || '获取音频信息失败')
    error.status = trackV2Response.status
    error.payload = trackPayload
    throw error
  }

  return trackPayload
}

async function downloadTrackMedia({ sessionid, track_id, quality, aid = fixed.aid }) {
  const flacMetadataWriter = new FlacMetadataWriter()
  const trackPayload = await fetchTrackPayload({ aid, sessionid, track_id })
  const videoModelRaw = trackPayload?.track_player?.video_model

  if (!videoModelRaw) {
    const error = new Error('track video_model not found')
    error.status = 404
    throw error
  }

  let videoModel = null

  try {
    videoModel = JSON.parse(videoModelRaw)
  } catch {
    const error = new Error('track video_model parse failed')
    error.status = 500
    throw error
  }

  const videoList = Array.isArray(videoModel?.video_list) ? videoModel.video_list : []
  const matchedItem = videoList.find((item) => item?.video_meta?.quality === quality)

  if (!matchedItem?.main_url) {
    const error = new Error(`quality ${quality} download url not found`)
    error.status = 404
    throw error
  }

  const mediaResponse = await fetch(matchedItem.main_url, {
    headers: {
      'User-Agent': 'libcurl-agent/1.0',
    },
    redirect: 'follow',
  })

  if (!mediaResponse.ok) {
    const errorText = await mediaResponse.text().catch(() => '')
    const error = new Error(errorText || `upstream status ${mediaResponse.status}`)
    error.status = mediaResponse.status
    throw error
  }

  const encryptedBuffer = Buffer.from(await mediaResponse.arrayBuffer())
  const decryptor = new TrackDecryptor()
  const result = decryptor.decrypt({
    encryptedBuffer,
    spadeA: matchedItem?.encrypt_info?.spade_a || '',
    media: {
      title: trackPayload?.track?.name || '',
      artist: getArtistName(trackPayload),
    },
  })

  let outputBuffer = result.buffer

  if (result.extension === '.flac') {
    const metadata = buildFlacMetadata(trackPayload)
    const coverUrl = resolveImageUrl(trackPayload?.track?.album?.url_cover)
    let coverData = null

    if (coverUrl) {
      try {
        coverData = await flacMetadataWriter.fetchCoverBuffer(coverUrl)
      } catch {
        coverData = null
      }
    }

    outputBuffer = await flacMetadataWriter.writeBufferTags({
      flacBuffer: result.buffer,
      metadata,
      coverBuffer: coverData?.buffer || null,
      coverMime: coverData?.mime || null,
    })
  }

  return {
    buffer: outputBuffer,
    fileName: result.fileName,
    contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
    trackPayload,
  }
}

/**
 * 诊断用：对同一首歌的所有音质做「浅层结构分析」，不写出任何文件。
 *
 * 为什么要它：真实场景里同一首歌 lossless 下载失败、而 medium/higher/highest 正常，
 * 四者走的是完全相同的代码路径，唯一变量是上游返回的媒体文件本身。
 * 逐个手点无法对比，这个函数一次把所有音质的容器参数并列出来，
 * 差异一眼可见（例如 senc 声明 0 字节 IV、样本表与 mdat 不匹配等）。
 *
 * 注意：只返回长度与结构参数，绝不返回密钥或 IV 的内容。
 */
async function diagnoseTrackMedia({ sessionid, track_id, aid = fixed.aid, qualities, onProgress }) {
  const trackPayload = await fetchTrackPayload({ aid, sessionid, track_id })
  const videoModelRaw = trackPayload?.track_player?.video_model

  if (!videoModelRaw) {
    throw new Error('track video_model not found')
  }

  const videoModel = JSON.parse(videoModelRaw)
  const videoList = Array.isArray(videoModel?.video_list) ? videoModel.video_list : []
  const targets = (qualities && qualities.length > 0
    ? qualities
    : videoList.map((item) => item?.video_meta?.quality).filter(Boolean))

  const report = []
  // 每采集完一个音质就回调一次，便于调用方即时落盘（中途失败也能留下已完成部分）
  const push = (entry) => {
    report.push(entry)
    if (typeof onProgress === 'function') {
      try {
        onProgress(entry)
      } catch {}
    }
  }

  for (const quality of targets) {
    const item = videoList.find((entry) => entry?.video_meta?.quality === quality)
    const entry = {
      quality,
      有下载地址: Boolean(item?.main_url),
      声明比特率: item?.video_meta?.bitrate ?? null,
      声明大小: item?.video_meta?.size ?? null,
      有加密信息: Boolean(item?.encrypt_info?.spade_a),
    }

    if (!item?.main_url) {
      entry.结论 = '无下载地址，跳过'
      push(entry)
      continue
    }

    try {
      const response = await fetch(item.main_url, {
        headers: { 'User-Agent': 'libcurl-agent/1.0' },
        redirect: 'follow',
      })
      entry.HTTP状态 = response.status
      if (!response.ok) {
        entry.结论 = `下载失败：HTTP ${response.status}`
        push(entry)
        continue
      }

      const encryptedBuffer = Buffer.from(await response.arrayBuffer())
      entry.实际下载字节 = encryptedBuffer.length

      // 浅层探测：与 TrackDecryptor 使用相同的 box 定位方式，但不做解密
      const { Mp4Box } = require('./mp4-box')
      const text = (s, o, e) => Mp4Box.findBox(encryptedBuffer, s, o, e)

      const moov = text('moov', 0, encryptedBuffer.length)
      const mdat = text('mdat', 0, encryptedBuffer.length)
      entry.有moov = !moov.isEmpty()
      entry.有mdat = !mdat.isEmpty()

      if (moov.isEmpty()) {
        entry.结论 = '容器里没有 moov，不是预期格式'
        push(entry)
        continue
      }

      const trak = text('trak', moov.offset + 8, moov.offset + moov.size)
      const mdia = text('mdia', trak.offset + 8, trak.offset + trak.size)
      const minf = text('minf', mdia.offset + 8, mdia.offset + mdia.size)
      const stbl = text('stbl', minf.offset + 8, minf.offset + minf.size)
      const stsd = text('stsd', stbl.offset + 8, stbl.offset + stbl.size)
      const stsz = text('stsz', stbl.offset + 8, stbl.offset + stbl.size)
      const stsc = text('stsc', stbl.offset + 8, stbl.offset + stbl.size)
      const stco = text('stco', stbl.offset + 8, stbl.offset + stbl.size)

      let senc = text('senc', moov.offset + 8, moov.offset + moov.size)
      if (senc.isEmpty()) {
        senc = text('senc', stbl.offset + 8, stbl.offset + stbl.size)
      }

      entry.box = {
        stsd: stsd.data.length,
        stsz: stsz.data.length,
        stsc: stsc.data.length,
        stco: stco.data.length,
        senc: senc.isEmpty() ? 0 : senc.data.length,
      }

      if (!senc.isEmpty() && senc.data.length >= 4) {
        const vf = senc.data.readUInt32BE(0)
        entry.senc版本 = (vf >>> 24) & 0xff
        entry.senc_flags = `0x${(vf & 0xffffff).toString(16)}`
        entry.senc声明IV大小 = ((vf & 0xffffff) >> 8) & 0x3f
        entry.senc声明样本数 = senc.data.length >= 8 ? senc.data.readUInt32BE(4) : '未知'
      } else {
        entry.结论 = '没有 senc box（未按预期加密）'
        push(entry)
        continue
      }

      entry.mdat数据字节 = mdat.isEmpty() ? 0 : encryptedBuffer.length - (mdat.offset + 8)

      // 尝试完整解密以复现结论（不写文件、不下标签）
      try {
        const decryptor = new TrackDecryptor()
        const result = decryptor.decrypt({
          encryptedBuffer,
          spadeA: item?.encrypt_info?.spade_a || '',
          media: { title: 'diagnose', artist: 'diagnose' },
        })
        entry.解密结果 = '成功'
        entry.输出扩展名 = result.extension
        entry.输出字节 = result.buffer.length
        entry.结论 = '正常'
      } catch (error) {
        entry.解密结果 = '失败'
        entry.错误 = error.message
        entry.结论 = '解密阶段失败'
      }
    } catch (error) {
      entry.结论 = '请求异常'
      entry.错误 = error.message
    }

    push(entry)
  }

  return { track_id, qualities: targets, report }
}

module.exports = {
  getTrackV2Payload,
  downloadTrackMedia,
  diagnoseTrackMedia,
}
