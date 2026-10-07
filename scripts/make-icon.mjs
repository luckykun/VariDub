#!/usr/bin/env node
/**
 * 生成应用图标：resources/icon.png（256×256，窗口与托盘运行时用）+ build/icon.ico（打包用）。
 * 纯 Node 标准库手写编码，不引第三方绘图依赖——图标只有这一处需要位图。
 * 改设计就改下面的绘图参数，然后 `node scripts/make-icon.mjs` 重新生成。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const SS = 4 // 超采样倍数（边缘抗锯齿）
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PNG = join(HERE, '..', 'resources', 'icon.png')
const OUT_ICO = join(HERE, '..', 'build', 'icon.ico')

const BG_TOP = [38, 38, 38]
const BG_BOTTOM = [23, 23, 23]
const TEAL = [45, 212, 191]
const VIOLET = [167, 139, 250]
const MAGENTA = [192, 38, 211]

/** 圆角矩形遮罩覆盖率（0-1）：圆心距判断 + 超采样 */
function roundedAlpha(x, y, box, radius) {
  const [x0, y0, x1, y1] = box
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius)
  const dx = x - cx
  const dy = y - cy
  return Math.hypot(dx, dy) <= radius ? 1 : 0
}

/** 线段到点的距离（用来画粗描边式的折线/圆弧） */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

const BARS = [
  { x: 58, h: 62 },
  { x: 84, h: 108 },
  { x: 110, h: 78 },
  { x: 136, h: 124 }
]
const BAR_W = 16
const BAR_R = 8
const CY = 128

/** 右侧字幕尖括号「>」，用两条粗线段拼 */
const CHEVRON = { ax: 176, ay: 92, bx: 208, by: 128, cx: 176, cy: 164, stroke: 9 }

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 单像素取色：SS×SS 超采样后求平均，返回 [r,g,b,a] */
function pixel(x, y) {
  const out = [0, 0, 0, 0]
  let hitR = 0
  let hitG = 0
  let hitB = 0
  let hit = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS
      const py = y + (sy + 0.5) / SS
      const cover = roundedAlpha(px, py, [12, 12, 244, 244], 58)
      if (!cover) continue
      // 背景：垂直渐变
      const bg = mix(BG_TOP, BG_BOTTOM, (py - 12) / 232)
      let r = bg[0]
      let g = bg[1]
      let b = bg[2]
      let a = 1
      // 波形柱：左半，四根等高线居中的圆角条
      for (let i = 0; i < BARS.length; i++) {
        const bar = BARS[i]
        const box = [bar.x, CY - bar.h / 2, bar.x + BAR_W, CY + bar.h / 2]
        if (roundedAlpha(px, py, box, BAR_R)) {
          const tint = 0.82 + 0.18 * (i / (BARS.length - 1))
          r = TEAL[0] * tint
          g = TEAL[1] * tint
          b = TEAL[2] * tint
          a = 1
        }
      }
      // 字幕尖括号：右半，颜色自上而下由品红过渡到紫
      const d = Math.min(distToSegment(px, py, CHEVRON.ax, CHEVRON.ay, CHEVRON.bx, CHEVRON.by), distToSegment(px, py, CHEVRON.bx, CHEVRON.by, CHEVRON.cx, CHEVRON.cy))
      if (d <= CHEVRON.stroke) {
        const c = mix(MAGENTA, VIOLET, (py - 92) / 72)
        r = c[0]
        g = c[1]
        b = c[2]
        a = 1
      }
      hitR += r
      hitG += g
      hitB += b
      hit += a * cover
    }
  }
  const n = SS * SS
  if (hit <= 0) return out
  const alpha = hit / n
  return [Math.round(hitR / n), Math.round(hitG / n), Math.round(hitB / n), Math.round(alpha * 255)]
}

/* ------------------------------------------------------------ PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0 // 不交错
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** 块平均降采样：从 srcSize 缩到 dstSize（dstSize 必须整除 srcSize） */
function downscale(src, srcSize, dstSize) {
  if (dstSize === srcSize) return src
  const block = srcSize / dstSize
  const out = Buffer.alloc(dstSize * dstSize * 4)
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let pr = 0
      let pg = 0
      let pb = 0
      let pa = 0
      for (let sy = 0; sy < block; sy++) {
        for (let sx = 0; sx < block; sx++) {
          const off = ((y * block + sy) * srcSize + x * block + sx) * 4
          const a = src[off + 3]
          // 预乘再平均，否则透明像素会把颜色拉灰
          pr += src[off] * a
          pg += src[off + 1] * a
          pb += src[off + 2] * a
          pa += a
        }
      }
      const n = block * block
      const off = (y * dstSize + x) * 4
      out[off] = pa > 0 ? Math.round(pr / pa) : 0
      out[off + 1] = pa > 0 ? Math.round(pg / pa) : 0
      out[off + 2] = pa > 0 ? Math.round(pb / pa) : 0
      out[off + 3] = Math.round(pa / n)
    }
  }
  return out
}

/** ICO 里的位图项用未压 BMP（全兼容），不是所有工具都读 PNG 内嵌项 */
function encodeBmpEntry(data, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR 图像 + AND 遮罩
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  const rowMask = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(rowMask * size) // 全 0：透明度交给 alpha 通道
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4 // DIB 习惯自下而上
    for (let x = 0; x < size; x++) {
      const from = srcRow + x * 4
      const to = (y * size + x) * 4
      pixels[to] = data[from + 2] // BGRA
      pixels[to + 1] = data[from + 1]
      pixels[to + 2] = data[from]
      pixels[to + 3] = data[from + 3]
    }
  }
  return Buffer.concat([header, pixels, mask])
}

/** images: [{ size, data }]，大的在前（Windows 会按需要选尺寸） */
function encodeIco(images) {
  const headerSize = 6 + images.length * 16
  const bodies = images.map((im) => encodeBmpEntry(im.data, im.size))
  let offset = headerSize
  const entries = images.map((im, i) => {
    const e = Buffer.alloc(16)
    e[0] = im.size >= 256 ? 0 : im.size // 256 用 0 表示
    e[1] = im.size >= 256 ? 0 : im.size
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(bodies[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += bodies[i].length
    return e
  })
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(images.length, 4)
  return Buffer.concat([dir, ...entries, ...bodies])
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const p = pixel(x, y)
    const off = (y * SIZE + x) * 4
    rgba[off] = p[0]
    rgba[off + 1] = p[1]
    rgba[off + 2] = p[2]
    rgba[off + 3] = p[3]
  }
}

const png = encodePng(SIZE, SIZE, rgba)
writeFileSync(OUT_PNG, png)
const levels = [SIZE, 48, 32, 16].map((size) => ({ size, data: downscale(rgba, SIZE, size) }))
mkdirSync(dirname(OUT_ICO), { recursive: true })
writeFileSync(OUT_ICO, encodeIco(levels))
console.log(`已生成 ${OUT_PNG}（${SIZE}×${SIZE}）`)
console.log(`已生成 ${OUT_ICO}（${levels.map((l) => l.size).join('/')} 四档，${(statSync(OUT_ICO).size / 1024).toFixed(0)} KB）`)
