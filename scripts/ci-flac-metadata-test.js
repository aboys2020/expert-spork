/**
 * 离线回归测试：FLAC 标签写入。
 *
 * 锁定的历史 bug：flac-tagger@2.0.0 的 header.js 把 isLast 判定写成
 *   (lastAndType & 0b10000000) === 1
 * —— & 128 不可能是 1，所以它永远认不出「最后一块」，只能靠读到 type=127 才停。
 * 当 FLAC 只有 STREAMINFO 一个元数据块时（本站 lossless 的 dfLa 就是这种），
 * 它会顺着音频帧继续解析并抛出
 *   "Attempt to access memory outside buffer bounds"
 * 该报错在构建期与启动期都不出现，只有用户下载 lossless 时才炸。
 *
 * 本测试不联网、不需要密钥，构造最小 FLAC 后校验：
 *   1. 只有 STREAMINFO 的文件能成功写入标签
 *   2. 块链以 isLast 正确结束，且音频数据原样保留
 *   3. 标签内容与封面可被正确解析回来
 *
 * 用法：node scripts/ci-flac-metadata-test.js
 */

const { FlacMetadataWriter, parseMetadataBlocks } = require('../server/utils/flac-metadata')

let failed = 0

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`✓ ${label}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    failed += 1
    console.log(`✗ ${label}`)
    console.log(`    ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(message)
  }
}

/** 构造一个只含 STREAMINFO 的最小 FLAC（模拟本站 lossless 的 dfLa 内容） */
function buildMinimalFlacWithStreamInfoOnly() {
  const streamInfo = Buffer.alloc(34)
  // min/max block size, frame size 等字段对结构测试无关紧要，填可辨识的值
  streamInfo.writeUInt16BE(4096, 0)
  streamInfo.writeUInt16BE(4096, 2)
  streamInfo.writeUInt32BE(0, 4)
  streamInfo.writeUInt32BE(0, 8)
  // 总样本数 + 采样率等（20 bit 采样率 + 3 bit 声道 + 5 bit 位深 + 36 bit 样本数）
  streamInfo.writeUInt32BE(44100 << 12, 10)
  streamInfo[14] = 0x70 // 位深/声道占位
  streamInfo.writeUInt32BE(123456, 15)

  const header = Buffer.from([0x80, 0x00, 0x00, 0x22]) // isLast=1, type=0, len=34
  // 音频帧：以 FLAC 同步码开头，确保能被当作音频而不影响解析
  const audio = Buffer.alloc(2000)
  audio[0] = 0xff
  audio[1] = 0xf8
  for (let i = 2; i < audio.length; i += 1) {
    audio[i] = (i * 7) & 0xff
  }

  return Buffer.concat([Buffer.from('fLaC'), header, streamInfo, audio])
}

const writer = new FlacMetadataWriter()
const original = buildMinimalFlacWithStreamInfoOnly()

check('只有 STREAMINFO 的 FLAC 能写入标签（历史崩溃场景）', () => {
  const out = writer.writeTagsToBuffer({
    flacBuffer: original,
    metadata: { title: '不想上班（李哈哈 Remix）', artist: ['李哈哈'], album: '不想上班' },
  })
  assert(Buffer.isBuffer(out), '返回值不是 Buffer')
  assert(out.subarray(0, 4).toString('latin1') === 'fLaC', '缺少 fLaC 签名')
  const { blocks } = parseMetadataBlocks(out)
  const types = blocks.map((b) => b.type)
  assert(types[0] === 0, '第一个块必须是 STREAMINFO')
  assert(types.includes(4), '缺少 VORBIS_COMMENT 块')
  return `块类型 ${types.join(',')}`
})

check('块链以 isLast 正确结束', () => {
  const out = writer.writeTagsToBuffer({ flacBuffer: original, metadata: { title: 't' } })
  const { blocks } = parseMetadataBlocks(out)
  const lastFlags = blocks.filter((b) => b.isLast)
  assert(lastFlags.length === 1, `isLast 标记数量应为 1，实际 ${lastFlags.length}`)
  assert(blocks[blocks.length - 1].isLast, '最后一块必须带 isLast')
  return `共 ${blocks.length} 块，末块 isLast`
})

check('音频数据原样保留（长度与首字节）', () => {
  const out = writer.writeTagsToBuffer({ flacBuffer: original, metadata: { title: 't' } })
  const { audioStart } = parseMetadataBlocks(out)
  const originalAudio = original.subarray(4 + 4 + 34)
  const outputAudio = out.subarray(audioStart)
  assert(outputAudio.length === originalAudio.length, `音频长度变化：${originalAudio.length} -> ${outputAudio.length}`)
  assert(outputAudio[0] === 0xff && outputAudio[1] === 0xf8, '音频首字节不是 FLAC 同步码')
  assert(outputAudio.equals(originalAudio), '音频内容被改动')
  return `${outputAudio.length} 字节一致`
})

check('标签内容可被正确解析回来', () => {
  const out = writer.writeTagsToBuffer({
    flacBuffer: original,
    metadata: { title: '不想上班（李哈哈 Remix）', artist: ['李哈哈'], album: '不想上班' },
  })
  const { blocks } = parseMetadataBlocks(out)
  const vc = blocks.find((b) => b.type === 4)
  assert(vc, '没有 VORBIS_COMMENT 块')

  const d = vc.data
  const vlen = d.readUInt32LE(0)
  let p = 4 + vlen
  const count = d.readUInt32LE(p)
  p += 4
  const entries = []
  for (let i = 0; i < count; i += 1) {
    const l = d.readUInt32LE(p)
    p += 4
    entries.push(d.subarray(p, p + l).toString('utf8'))
    p += l
  }
  assert(entries.includes('TITLE=不想上班（李哈哈 Remix）'), '缺少 TITLE')
  assert(entries.includes('ARTIST=李哈哈'), '缺少 ARTIST')
  assert(entries.includes('ALBUM=不想上班'), '缺少 ALBUM')
  return `${count} 项`
})

check('封面写入为 PICTURE 块且可读回 mime', () => {
  const cover = Buffer.alloc(64, 0xab)
  const out = writer.writeTagsToBuffer({
    flacBuffer: original,
    metadata: { title: 't' },
    coverBuffer: cover,
    coverMime: 'image/jpeg',
  })
  const { blocks } = parseMetadataBlocks(out)
  const pic = blocks.find((b) => b.type === 6)
  assert(pic, '没有 PICTURE 块')
  const mimeLen = pic.data.readUInt32BE(4)
  const mime = pic.data.subarray(8, 8 + mimeLen).toString('latin1')
  assert(mime === 'image/jpeg', `mime 不正确：${mime}`)
  return `mime=${mime}`
})

check('重复写入不会累积重复的标签块', () => {
  const once = writer.writeTagsToBuffer({ flacBuffer: original, metadata: { title: 'a' } })
  const twice = writer.writeTagsToBuffer({ flacBuffer: once, metadata: { title: 'b' } })
  const { blocks } = parseMetadataBlocks(twice)
  const vcCount = blocks.filter((b) => b.type === 4).length
  assert(vcCount === 1, `VORBIS_COMMENT 块应只有 1 个，实际 ${vcCount}`)
  return `VORBIS_COMMENT 数量 ${vcCount}`
})

check('非法输入被拒绝（缺少 fLaC 签名）', () => {
  let threw = false
  try {
    writer.writeTagsToBuffer({ flacBuffer: Buffer.from('NOTFLAC....'), metadata: { title: 't' } })
  } catch {
    threw = true
  }
  assert(threw, '应当抛错但没抛')
  return '已抛错'
})

console.log('')
if (failed === 0) {
  console.log('结论：FLAC 标签写入全部通过（含历史崩溃场景）。')
  process.exit(0)
}
console.log(`结论：${failed} 项失败。`)
process.exit(1)
