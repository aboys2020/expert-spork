const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

/**
 * FLAC 元数据写入（自实现，不再依赖 flac-tagger）。
 *
 * 为什么换掉 flac-tagger@2.0.0：
 *   1. 它的 header.js 里 isLast 判定写错了 —— `(lastAndType & 0b10000000) === 1`，
 *      & 128 的结果不可能是 1，因此它永远认不出「最后一块」，只能靠读到 type=127 才停。
 *   2. 当 FLAC 只有 STREAMINFO 一个元数据块时（本站 lossless 的 dfLa 就是这种），
 *      它会顺着音频帧继续当元数据解析，最终抛
 *      "Attempt to access memory outside buffer bounds" —— 正是用户遇到的报错。
 *   3. 该库还要求先落盘再用文件 API 操作，多一次磁盘往返。
 *
 * 自实现只需处理两种块：VORBIS_COMMENT(4) 与 PICTURE(6)，格式简单且稳定。
 * 已验证：重建后的 FLAC 能被 ffmpeg 正常解码（44100Hz / stereo / s16 / ~397kbps）。
 */

const BLOCK_STREAMINFO = 0
const BLOCK_PADDING = 1
const BLOCK_VORBIS_COMMENT = 4
const BLOCK_PICTURE = 6

/** 解析 FLAC 元数据块链，返回 { blocks, audioStart } */
function parseMetadataBlocks(buffer) {
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('latin1') !== 'fLaC') {
    throw new Error('不是合法的 FLAC 文件（缺少 fLaC 签名）')
  }

  const blocks = []
  let position = 4

  while (position + 4 <= buffer.length) {
    const header = buffer[position]
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = (buffer[position + 1] << 16) | (buffer[position + 2] << 8) | buffer[position + 3]
    const dataStart = position + 4
    const dataEnd = dataStart + length

    if (dataEnd > buffer.length) {
      throw new Error(
        `FLAC 元数据块不完整：type=${type} 声明长度 ${length}，需要到偏移 ${dataEnd}，但文件只有 ${buffer.length} 字节`,
      )
    }

    blocks.push({ type, isLast, data: buffer.subarray(dataStart, dataEnd) })
    position = dataEnd

    if (isLast) {
      return { blocks, audioStart: position }
    }
  }

  throw new Error('FLAC 元数据块链没有以 isLast 标记结束')
}

/** 构造一个 VORBIS_COMMENT 块的载荷（不含 4 字节块头） */
function buildVorbisCommentPayload(tagMap) {
  const vendor = 'PopDownloader'
  const parts = []

  const vendorBuf = Buffer.from(vendor, 'utf8')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(vendorBuf.length, 0)
  parts.push(lenBuf, vendorBuf)

  const comments = []
  for (const [key, value] of Object.entries(tagMap || {})) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      const text = String(v ?? '').trim()
      if (!text) {
        continue
      }
      comments.push(Buffer.from(`${key.toUpperCase()}=${text}`, 'utf8'))
    }
  }

  const countBuf = Buffer.alloc(4)
  countBuf.writeUInt32LE(comments.length, 0)
  parts.push(countBuf)
  for (const c of comments) {
    const l = Buffer.alloc(4)
    l.writeUInt32LE(c.length, 0)
    parts.push(l, c)
  }

  return Buffer.concat(parts)
}

/** 构造 PICTURE 块的载荷（不含 4 字节块头） */
function buildPicturePayload({ buffer, mime }) {
  const mimeText = String(mime || 'image/jpeg').split(';')[0].trim() || 'image/jpeg'
  const mimeBuf = Buffer.from(mimeText, 'latin1')
  const descBuf = Buffer.alloc(0)

  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
  }

  return Buffer.concat([
    u32(3), // picture type: front cover
    u32(mimeBuf.length),
    mimeBuf,
    u32(descBuf.length),
    descBuf,
    u32(0), // width  (0 = 未知)
    u32(0), // height
    u32(0), // color depth
    u32(0), // colors used
    u32(buffer.length),
    buffer,
  ])
}

/** 把块头（1 字节 isLast+type，3 字节长度）写到载荷前面 */
function withBlockHeader(type, payload, isLast) {
  const header = Buffer.alloc(4)
  header[0] = (isLast ? 0x80 : 0) | (type & 0x7f)
  header[1] = (payload.length >> 16) & 0xff
  header[2] = (payload.length >> 8) & 0xff
  header[3] = payload.length & 0xff
  return Buffer.concat([header, payload])
}

class FlacMetadataWriter {
  createTempFilePath() {
    const fileName = `pop-downloader-${crypto.randomUUID()}.flac`
    return path.join(os.tmpdir(), fileName)
  }

  toTagValue(value) {
    if (Array.isArray(value)) {
      const list = value.map((item) => String(item || '').trim()).filter(Boolean)
      return list.length > 0 ? list : null
    }

    const normalized = String(value || '').trim()
    return normalized ? normalized : null
  }

  buildTagMap(metadata = {}) {
    const tagMap = {}

    const entries = {
      TITLE: metadata.title,
      ARTIST: metadata.artist,
      ALBUM: metadata.album,
      ALBUMARTIST: metadata.albumArtist,
      DATE: metadata.date,
      YEAR: metadata.year,
      GENRE: metadata.genre,
      COMPOSER: metadata.composer,
      LYRICIST: metadata.lyricist,
      COMMENT: metadata.comment,
      TRACKNUMBER: metadata.trackNumber,
      DISCNUMBER: metadata.discNumber,
    }

    for (const [key, value] of Object.entries(entries)) {
      const normalizedValue = this.toTagValue(value)

      if (normalizedValue) {
        tagMap[key] = normalizedValue
      }
    }

    return tagMap
  }

  /**
   * 在 FLAC buffer 上写入标签（含可选封面），返回新的 FLAC buffer。
   * 不落盘、不依赖第三方库。
   */
  writeTagsToBuffer({ flacBuffer, metadata = {}, coverBuffer = null, coverMime = null }) {
    if (!Buffer.isBuffer(flacBuffer) || flacBuffer.length === 0) {
      throw new Error('flacBuffer must be a non-empty Buffer.')
    }

    const { blocks, audioStart } = parseMetadataBlocks(flacBuffer)

    // 保留 STREAMINFO 等非标签块；丢掉旧的 VORBIS_COMMENT / PICTURE，避免重复
    const kept = blocks.filter(
      (b) => b.type !== BLOCK_VORBIS_COMMENT && b.type !== BLOCK_PICTURE && b.type !== BLOCK_PADDING,
    )
    if (kept.length === 0 || kept[0].type !== BLOCK_STREAMINFO) {
      throw new Error('FLAC 缺少 STREAMINFO 块，无法安全写入标签')
    }

    const newBlocks = []

    for (const block of kept) {
      newBlocks.push(
        withBlockHeader(block.type, block.data, false), // isLast 稍后统一处理
      )
    }

    const tagMap = this.buildTagMap(metadata)
    if (Object.keys(tagMap).length > 0) {
      newBlocks.push(
        withBlockHeader(BLOCK_VORBIS_COMMENT, buildVorbisCommentPayload(tagMap), false),
      )
    }

    if (Buffer.isBuffer(coverBuffer) && coverBuffer.length > 0) {
      newBlocks.push(withBlockHeader(BLOCK_PICTURE, buildPicturePayload({ buffer: coverBuffer, mime: coverMime }), false))
    }

    // 补一个 PADDING 块作为最后一块：这是 FLAC 编码器的常规做法，
    // 也让「最后一块」标记明确落在块链里（不依赖音频帧的字节是什么）。
    const paddingBody = Buffer.alloc(1024)
    newBlocks.push(withBlockHeader(BLOCK_PADDING, paddingBody, true))

    return Buffer.concat([Buffer.from('fLaC'), ...newBlocks, flacBuffer.subarray(audioStart)])
  }

  /**
   * 兼容旧接口：原实现是「写临时文件 → 调库 → 读回」。
   * 现在改为纯内存操作，保留该方法以兼容既有调用方。
   */
  async writeBufferTags({ flacBuffer, metadata = {}, coverBuffer = null, coverMime = null }) {
    return this.writeTagsToBuffer({ flacBuffer, metadata, coverBuffer, coverMime })
  }

  async fetchCoverBuffer(imageUrl) {
    if (!imageUrl) {
      return null
    }

    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch FLAC cover: ${response.status}`)
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type') || undefined,
    }
  }
}

module.exports = {
  FlacMetadataWriter,
  parseMetadataBlocks,
}
