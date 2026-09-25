const crypto = require('crypto')

function bitCount(value) {
  let current = value
  current = current - ((current >> 1) & 0x55555555)
  current = (current & 0x33333333) + ((current >> 2) & 0x33333333)
  return (((current + (current >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24
}

function decodeBase36(charCode) {
  if (charCode >= 48 && charCode <= 57) {
    return charCode - 48
  }

  if (charCode >= 97 && charCode <= 122) {
    return charCode - 97 + 10
  }

  return 0xff
}

function decryptSpadeInner(spadeKey) {
  const result = Buffer.from(spadeKey)
  const working = Buffer.alloc(spadeKey.length + 2)
  working[0] = 0xfa
  working[1] = 0x55
  spadeKey.copy(working, 2)

  for (let index = 0; index < result.length; index += 1) {
    let value = (spadeKey[index] ^ working[index]) - bitCount(index) - 21

    while (value < 0) {
      value += 0xff
    }

    result[index] = value & 0xff
  }

  return result
}

function decryptSpade(spadeKeyBytes) {
  if (!Buffer.isBuffer(spadeKeyBytes) || spadeKeyBytes.length < 3) {
    return ''
  }

  const paddingLength = (spadeKeyBytes[0] ^ spadeKeyBytes[1] ^ spadeKeyBytes[2]) - 48
  if (spadeKeyBytes.length < paddingLength + 2) {
    return ''
  }

  const innerInput = spadeKeyBytes.subarray(1, spadeKeyBytes.length - paddingLength)
  const tempBuffer = decryptSpadeInner(innerInput)

  if (tempBuffer.length === 0) {
    return ''
  }

  const skipBytes = decodeBase36(tempBuffer[0])
  const decodedMessageLength = spadeKeyBytes.length - paddingLength - 2
  const endIndex = 1 + decodedMessageLength - skipBytes

  if (endIndex > tempBuffer.length) {
    return ''
  }

  return tempBuffer.subarray(1, endIndex).toString('utf8')
}

function decryptSpadeA(spadeA) {
  try {
    return decryptSpade(Buffer.from(spadeA, 'base64'))
  } catch {
    return ''
  }
}

function hexToBuffer(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('Hex string length must be even.')
  }

  return Buffer.from(hex, 'hex')
}

function aesCtrDecrypt(key, iv, encrypted) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/**
 * 读取 box 内的 UInt32，越界时抛出可定位的错误。
 *
 * 为什么需要：Buffer.readUInt32BE 越界时只会抛
 * "Attempt to access memory outside buffer bounds"，既不知道是哪个 box，
 * 也不知道要读多少字节，排查成本极高（真实案例：某 lossless 曲目下载失败，
 * 只给出这一句，无法定位到 stsz/senc）。
 */
function readUInt32Checked(data, offset, boxName) {
  if (!Buffer.isBuffer(data) || offset + 4 > data.length) {
    throw new Error(
      `${boxName} 解析失败：需要读取偏移 ${offset} 处的 4 字节，但该 box 只有 ${data ? data.length : 0} 字节` +
        '（box 可能被截断，或该曲目的容器格式与预期不符）',
    )
  }
  return data.readUInt32BE(offset)
}

function parseStsz(data) {
  const sampleSize = readUInt32Checked(data, 4, 'stsz')
  const count = readUInt32Checked(data, 8, 'stsz')

  if (sampleSize !== 0) {
    return Array.from({ length: count }, () => sampleSize)
  }

  // 逐条样本表：共 count 条，每条 4 字节，起始于偏移 12
  const tableEnd = 12 + count * 4
  if (tableEnd > data.length) {
    throw new Error(
      `stsz 解析失败：声明 ${count} 条样本需要 ${tableEnd} 字节，但该 box 只有 ${data.length} 字节`,
    )
  }

  const sizes = []
  for (let index = 0; index < count; index += 1) {
    sizes.push(data.readUInt32BE(12 + index * 4))
  }

  return sizes
}

function parseStsc(data) {
  const entryCount = readUInt32Checked(data, 4, 'stsc')

  // 每项 12 字节，起始于偏移 8
  const tableEnd = 8 + entryCount * 12
  if (tableEnd > data.length) {
    throw new Error(
      `stsc 解析失败：声明 ${entryCount} 项需要 ${tableEnd} 字节，但该 box 只有 ${data.length} 字节`,
    )
  }

  const entries = []

  for (let index = 0; index < entryCount; index += 1) {
    const base = 8 + index * 12
    entries.push({
      firstChunk: data.readUInt32BE(base),
      samplesPerChunk: data.readUInt32BE(base + 4),
      id: data.readUInt32BE(base + 8),
    })
  }

  return entries
}

/**
 * 解析 senc（Sample Encryption）box，取出每个样本的 IV。
 *
 * 关键：IV 大小不是固定的 8 字节，而是写在 senc 的 flags 里（CENC 规范）：
 *   bit 0        : override_track_encryption_box_parameters
 *   bit 1        : use_subsample_encryption
 *   bit 2        : pattern（仅 cbcs）
 *   bits 4..7    : pattern 相关
 *   bits 8..13   : per_sample_iv_size（低 6 位，取值 0 / 8 / 16）
 * 注意 per_sample_iv_size 占 6 位而非 4 位，用 0x0f 遮罩会把 16(0x10) 之外的位算错、
 * 也会把 subsample 位混进来（踩过这个坑）。
 * 原先实现硬编码按 8 字节步进，遇到 16 字节 IV 的流时，读到后面 position 会越过
 * box 末尾，Buffer.copy 抛出的正是 "Attempt to access memory outside buffer bounds"
 * （真实案例：某曲目 lossless 下载失败，只给出这一句，无法定位）。
 */
function parseSenc(data) {
  const versionFlags = readUInt32Checked(data, 0, 'senc')
  const version = (versionFlags >>> 24) & 0xff
  const flags = versionFlags & 0xffffff
  const count = readUInt32Checked(data, 4, 'senc')

  const hasSubsamples = (flags & 0x02) !== 0
  const declaredIvSize = (flags >> 8) & 0x3f

  // per_sample_iv_size 是 version 1 才有的字段。version 0 的 box 里该位不可信
  // （常见情况是 flags=0，但每个条目后面仍跟着 8 字节 IV）。
  // 若直接采信 0，就会把 IV 解析成全零 —— 那会把原本能正常下载的曲目解成噪音，
  // 属于比原 bug 更严重的回归，所以这里必须区分版本处理。
  let ivSize = declaredIvSize
  if (![0, 8, 16].includes(declaredIvSize)) {
    throw new Error(
      `senc 解析失败：flags 声明了异常的 IV 大小 ${declaredIvSize} 字节` +
        `（version=${version} flags=0x${flags.toString(16)}）。本工具只支持规范定义的 0 / 8 / 16。`,
    )
  }

  if (version === 0) {
    // per_sample_iv_size 是 version 1 才有的字段。version 0 的 box 里该位不可信
    // （常见情况是 flags=0，但每个条目后面仍跟着 8 字节 IV）。
    // 若直接采信 0，就会把 IV 解析成全零 —— 那会把原本能正常下载的曲目解成噪音，
    // 属于比原 bug 更严重的回归，所以这里按条目布局反推。
    const ivPerSample = 8 + (hasSubsamples ? 2 : 0)
    const remaining = data.length - 8
    if (remaining === count * ivPerSample) {
      ivSize = 8
    }
  }

  const entryBytes = ivSize + (hasSubsamples ? 2 : 0)
  const minEnd = 8 + count * entryBytes

  if (minEnd > data.length) {
    throw new Error(
      `senc 解析失败：version=${version} flags=0x${flags.toString(16)}` +
        `（IV 大小=${ivSize} 字节，subsample=${hasSubsamples ? '有' : '无'}），` +
        `声明 ${count} 个样本至少需要 ${minEnd} 字节，但该 box 只有 ${data.length} 字节。` +
        '这通常意味着该曲目的加密方式（IV 长度/子样本）与当前解析假设不符。',
    )
  }

  const ivs = []
  let position = 8

  for (let index = 0; index < count; index += 1) {
    const iv = Buffer.alloc(16)
    if (ivSize > 0) {
      data.copy(iv, 0, position, position + ivSize)
      position += ivSize
    }

    if (hasSubsamples) {
      // 子样本计数占用 2 字节，这里只需跳过；本工具按整样本解密，不使用子样本划分。
      position += 2
    }

    ivs.push(iv)
  }

  return ivs
}

function scanForFlacMetadata(stsdData) {
  const marker = Buffer.from([0x64, 0x66, 0x4c, 0x61])
  const index = stsdData.indexOf(marker)

  if (index === -1 || index < 4) {
    return Buffer.alloc(0)
  }

  // index >= 4 已保证这里不会越界，但仍然显式校验一次，避免后续改动破坏该前提
  if (index - 4 + 4 > stsdData.length) {
    return Buffer.alloc(0)
  }

  const boxSize = stsdData.readUInt32BE(index - 4)
  const contentStart = index + 4
  const contentEnd = Math.min(index - 4 + boxSize, stsdData.length)

  if (contentEnd <= contentStart) {
    return Buffer.alloc(0)
  }

  return stsdData.subarray(contentStart, contentEnd)
}

function replaceEncaWithMp4a(buffer, searchStart, searchEnd) {
  const target = Buffer.from('enca')
  const replacement = Buffer.from('mp4a')

  for (let index = searchStart; index + 4 <= searchEnd; index += 1) {
    if (buffer.subarray(index, index + 4).equals(target)) {
      replacement.copy(buffer, index)
      break
    }
  }
}

function sanitizeFilenamePart(value, fallback) {
  const normalized = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()

  return normalized || fallback
}

module.exports = {
  aesCtrDecrypt,
  decryptSpadeA,
  hexToBuffer,
  parseSenc,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
}
