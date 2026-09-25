const { Mp4Box } = require('./mp4-box')
const {
  aesCtrDecrypt,
  decryptSpadeA,
  hexToBuffer,
  inspectFlacBlockChain,
  parseSenc,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
} = require('./decrypt-utils')

class TrackDecryptor {
  resolveKey(spadeA) {
    if (!spadeA) {
      throw new Error('spade_a is required for decryption.')
    }

    const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
    const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)

    if (!keyHex) {
      throw new Error('Failed to resolve decryption key from spade_a.')
    }

    return hexToBuffer(keyHex)
  }

  decryptSampleList({ fileBuffer, key, sampleSizes, ivs, mdatOffset }) {
    const totalSampleBytes = sampleSizes.reduce((sum, size) => sum + size, 0)
    const availableBytes = fileBuffer.length - (mdatOffset + 8)

    // 关键校验：先算出所有样本需要的总字节数，和 mdat 里实际可用的字节数对比。
    // 若不校验，subarray 越界会静默截断，解密出来的文件看似正常实则损坏
    // （比抛错更难排查），同时后面 Buffer.copy 也可能越界。
    if (totalSampleBytes > availableBytes) {
      throw new Error(
        `音频数据不完整：样本表声明共 ${totalSampleBytes} 字节，` +
          `但媒体数据区只有 ${availableBytes} 字节（差了 ${totalSampleBytes - availableBytes} 字节）。` +
          '可能是下载被截断，或该曲目的容器结构与预期不符（例如分片 MP4 需要不同的解析方式）。',
      )
    }

    const decryptedSamples = []
    let sampleOffset = mdatOffset + 8

    for (let index = 0; index < sampleSizes.length; index += 1) {
      const size = sampleSizes[index]
      const iv = ivs[index]

      if (!iv) {
        throw new Error(`Missing IV for sample ${index}.`)
      }

      const encrypted = fileBuffer.subarray(sampleOffset, sampleOffset + size)
      decryptedSamples.push(aesCtrDecrypt(key, iv, encrypted))
      sampleOffset += size
    }

    return decryptedSamples
  }

  /**
   * 拼装标准 FLAC 文件：'fLaC' 签名 + metadata 块链 + 音频帧。
   *
   * 为什么必须补一个 PADDING 块：
   *   flac-tagger 的 header.js 里 isLast 判定写错了 ——
   *     isLast: (lastAndType & 0b10000000) === 1
   *   & 128 的结果不可能是 1，所以它永远认不出「最后一块」，
   *   只能靠读到 type=127(Invalid) 才停止遍历。
   *   当 metadata 只有 STREAMINFO 一个块时（本曲目的 dfLa 就是如此），
   *   它会顺着音频帧继续当元数据解析，最终越界抛出
   *     "Attempt to access memory outside buffer bounds"  ← 用户实际遇到的报错
   *
   * 补一个 PADDING 块既是 FLAC 编码器的常规做法，也能让上述库正确终止遍历。
   * 注意若原块已带 isLast 标记，必须先清掉，否则会出现两个「最后一块」。
   */
  buildFlacFile(flacMetadata, decryptedSamples) {
    const flacSignature = Buffer.from('fLaC')

    const blocks = Buffer.from(flacMetadata)
    if (blocks.length >= 4) {
      // 清除第一个块头里的 isLast 位（bit7）
      blocks[0] = blocks[0] & 0x7f
    }

    // PADDING 块：1 字节头（isLast=1, type=1）+ 3 字节长度 + 数据
    const paddingBody = Buffer.alloc(4096)
    const paddingHeader = Buffer.from([
      0x81, // isLast = 1, type = 1 (PADDING)
      (paddingBody.length >> 16) & 0xff,
      (paddingBody.length >> 8) & 0xff,
      paddingBody.length & 0xff,
    ])

    return Buffer.concat([
      flacSignature,
      blocks,
      paddingHeader,
      paddingBody,
      ...decryptedSamples,
    ])
  }

  buildM4aFile(fileBuffer, decryptedSamples, mdat, stsd) {
    const output = Buffer.from(fileBuffer)
    let writePointer = mdat.offset + 8

    for (const sample of decryptedSamples) {
      sample.copy(output, writePointer)
      writePointer += sample.length
    }

    replaceEncaWithMp4a(output, stsd.offset, stsd.offset + stsd.size)
    return output
  }

  createFileName({ title, artist, extension }) {
    const safeTitle = sanitizeFilenamePart(title, 'track')
    const safeArtist = sanitizeFilenamePart(artist, 'unknown')
    return `${safeTitle} - ${safeArtist}${extension}`
  }

  decrypt({ encryptedBuffer, spadeA, media = {} }) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
      throw new Error('encryptedBuffer must be a non-empty Buffer.')
    }

    const key = this.resolveKey(spadeA)

    const moov = Mp4Box.findBox(encryptedBuffer, 'moov')
    if (moov.isEmpty()) {
      throw new Error("Decrypt failed: 'moov' atom not found.")
    }

    const trak = Mp4Box.findBox(encryptedBuffer, 'trak', moov.offset + 8, moov.offset + moov.size)
    const mdia = Mp4Box.findBox(encryptedBuffer, 'mdia', trak.offset + 8, trak.offset + trak.size)
    const minf = Mp4Box.findBox(encryptedBuffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size)
    const stbl = Mp4Box.findBox(encryptedBuffer, 'stbl', minf.offset + 8, minf.offset + minf.size)
    const stsd = Mp4Box.findBox(encryptedBuffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size)
    const stsz = Mp4Box.findBox(encryptedBuffer, 'stsz', stbl.offset + 8, stbl.offset + stbl.size)
    const stsc = Mp4Box.findBox(encryptedBuffer, 'stsc', stbl.offset + 8, stbl.offset + stbl.size)
    const stco = Mp4Box.findBox(encryptedBuffer, 'stco', stbl.offset + 8, stbl.offset + stbl.size)

    let senc = Mp4Box.findBox(encryptedBuffer, 'senc', moov.offset + 8, moov.offset + moov.size)
    if (senc.isEmpty()) {
      senc = Mp4Box.findBox(encryptedBuffer, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
    }

    if (senc.isEmpty()) {
      throw new Error("Decrypt failed: 'senc' atom not found.")
    }

    const mdat = Mp4Box.findBox(encryptedBuffer, 'mdat')
    if (mdat.isEmpty()) {
      throw new Error("Decrypt failed: 'mdat' atom not found.")
    }

    const flacMetadata = scanForFlacMetadata(stsd.data)
    const isFlac = flacMetadata.length > 0

    // FLAC 路径的前置校验：metadata 块链必须自洽，否则下游 flac-tagger 会
    // 按错误的长度跳到音频数据里解析，抛出难以定位的
    // "Attempt to access memory outside buffer bounds"。
    if (isFlac) {
      const chain = inspectFlacBlockChain(flacMetadata)
      if (!chain.ok) {
        throw new Error(
          `FLAC metadata 块链不完整：${chain.reason}。` +
            '（这将导致写标签阶段越界崩溃，故提前拦截）',
        )
      }
    }

    // stco 为空会导致后续 readUInt32BE 直接抛 "Attempt to access memory outside buffer bounds"，
    // 这里提前给出可定位的报错。
    if (stco.isEmpty() || stco.data.length < 8) {
      throw new Error(
        "Decrypt failed: 'stco' atom 缺失或过短（无法确定 chunk 偏移表）。" +
          '通常说明该曲目的容器结构与预期不符。',
      )
    }

    const sampleSizes = parseStsz(stsz.data)
    const stscEntries = parseStsc(stsc.data)
    const chunkCount = stco.data.readUInt32BE(4)
    const ivs = parseSenc(senc.data)

    // 诊断上下文：只记录长度与结构参数，绝不记录密钥或 IV 的内容。
    // 用于把「无从定位的原生越界报错」变成可直接对照的参数快照
    // （真实场景：某曲目 lossless 下载失败，而同曲目其他音质正常，
    //   需要对比两者的容器参数才能定位差异）。
    const sencFlags = senc.data.length >= 4 ? senc.data.readUInt32BE(0) & 0xffffff : -1
    const context = {
      文件总字节: encryptedBuffer.length,
      mdat数据字节: encryptedBuffer.length - (mdat.offset + 8),
      样本条数: sampleSizes.length,
      样本表声明总字节: sampleSizes.reduce((sum, n) => sum + n, 0),
      IV个数: ivs.length,
      senc版本: sencFlags >= 0 ? (senc.data.readUInt32BE(0) >>> 24) & 0xff : '未知',
      senc_flags: sencFlags >= 0 ? `0x${sencFlags.toString(16)}` : '未知',
      senc声明IV大小: sencFlags >= 0 ? (sencFlags >> 8) & 0x3f : '未知',
      senc声明有子样本: sencFlags >= 0 ? (sencFlags & 0x02) !== 0 : '未知',
      senc_box字节: senc.data.length,
      stsz_box字节: stsz.data.length,
      stsc_box字节: stsc.data.length,
      stco_box字节: stco.data.length,
      判定为FLAC: isFlac,
      密钥字节: Buffer.isBuffer(key) ? key.length : 0,
    }

    const withContext = (message) => `${message}\n【诊断参数】${JSON.stringify(context, null, 1)}`

    // 显式校验 key/IV 长度，避免 crypto 层抛出难以定位的原生报错
    if (!Buffer.isBuffer(key) || key.length !== 16) {
      throw new Error(withContext(`解密密钥长度异常：期望 16 字节，实际 ${key ? key.length : 0} 字节。`))
    }

    if (ivs.some((iv) => !Buffer.isBuffer(iv) || iv.length !== 16)) {
      throw new Error(withContext('解密 IV 长度异常：期望每个 IV 为 16 字节。'))
    }

    if (sampleSizes.length !== ivs.length) {
      throw new Error(
        withContext(`Decrypt failed: sample count ${sampleSizes.length} does not match iv count ${ivs.length}.`),
      )
    }

    let decryptedSamples
    try {
      decryptedSamples = this.decryptSampleList({
        fileBuffer: encryptedBuffer,
        key,
        sampleSizes,
        ivs,
        mdatOffset: mdat.offset,
        stscEntries,
        chunkCount,
      })
    } catch (error) {
      // 把诊断参数附到任何解密阶段错误上，避免只看到一句原生报错
      error.message = withContext(error.message)
      throw error
    }

    const outputBuffer = isFlac
      ? this.buildFlacFile(flacMetadata, decryptedSamples)
      : this.buildM4aFile(encryptedBuffer, decryptedSamples, mdat, stsd)

    const extension = isFlac ? '.flac' : '.m4a'

    return {
      buffer: outputBuffer,
      extension,
      fileName: this.createFileName({
        title: media.title,
        artist: media.artist,
        extension,
      }),
      meta: {
        isFlac,
        sampleCount: sampleSizes.length,
        chunkCount,
      },
    }
  }
}

module.exports = {
  TrackDecryptor,
}
