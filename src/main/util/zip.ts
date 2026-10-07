/**
 * 零依赖 ZIP 解包（仅 stored / deflate 两种常见方法），供 sidecar 引导使用。
 * zip 结构：Local File Header = PK\x03\x04，Central Directory = PK\x01\x02，End = PK\x05\x06
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off)
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off)
}

interface Entry {
  method: number
  compSize: number
  uncompSize: number
  localHeaderOffset: number
  name: string
}

function readEntries(buf: Buffer): Entry[] {
  // 从尾部找 EOCD
  let end = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (u32(buf, i) === SIG_END) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('不是有效的 zip 文件（未找到中央目录结束记录）')
  const cdCount = u16(buf, end + 10)
  let off = u32(buf, end + 16)
  const entries: Entry[] = []
  for (let i = 0; i < cdCount; i += 1) {
    if (u32(buf, off) !== SIG_CENTRAL) break
    const method = u16(buf, off + 10)
    let compSize = u32(buf, off + 20)
    let uncompSize = u32(buf, off + 24)
    const nameLen = u16(buf, off + 28)
    const extraLen = u16(buf, off + 30)
    const commentLen = u16(buf, off + 32)
    const localHeaderOffset = u32(buf, off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    // zip64 兜底：0xffffffff 时从 local header 读
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      compSize = u32(buf, localHeaderOffset + 18)
      uncompSize = u32(buf, localHeaderOffset + 22)
    }
    entries.push({ method, compSize, uncompSize, localHeaderOffset, name })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function dataOffset(buf: Buffer, localHeaderOffset: number): number {
  const nameLen = u16(buf, localHeaderOffset + 26)
  const extraLen = u16(buf, localHeaderOffset + 28)
  return localHeaderOffset + 30 + nameLen + extraLen
}

/** 解到 destDir（覆盖写），返回解出的文件数 */
export function unzip(zipPath: string, destDir: string): number {
  const buf = readFileSync(zipPath)
  if (u32(buf, 0) !== SIG_LOCAL && entriesProbeFail(buf)) throw new Error('zip 头不可读')
  let count = 0
  for (const e of readEntries(buf)) {
    if (e.name.endsWith('/') || e.name.startsWith('__MACOSX')) continue
    const outPath = join(destDir, ...e.name.split('/').filter(Boolean))
    if (!outPath.startsWith(destDir)) continue
    const start = dataOffset(buf, e.localHeaderOffset)
    const raw = buf.subarray(start, start + e.compSize)
    const data = e.method === 0 ? raw : inflateRawSync(raw)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, data)
    count += 1
  }
  return count
}

function entriesProbeFail(buf: Buffer): boolean {
  return buf.length < 22
}

export function fileExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}
