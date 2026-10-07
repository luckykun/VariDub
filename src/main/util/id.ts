import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function base36(n: number, len: number): string {
  let s = ''
  let x = Math.abs(Math.floor(n))
  while (s.length < len) {
    s = ALPHABET[x % 36] + s
    x = Math.floor(x / 36)
  }
  return s
}

/** 时间戳前缀 + 随机后缀，可排序、可读 */
export function newId(prefix: string): string {
  return `${prefix}_${base36(Date.now(), 8)}${randomSuffix(5)}`
}

function randomSuffix(len: number): string {
  const bytes = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i += 1) s += ALPHABET[bytes[i] % 36]
  return s
}

export function nowIso(): string {
  return new Date().toISOString()
}
