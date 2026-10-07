/** API-KEY 加密存储：Electron safeStorage（Windows DPAPI），不落明文（SPEC-001 §7.9） */
import { safeStorage } from 'electron'
import { getSetting, isMock, setSetting } from './db/repos/settings'

const KEY = 'api.key.enc'

export interface SecretState {
  available: boolean
  hasKey: boolean
  masked: string | null
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setApiKey(plain: string): void {
  const trimmed = plain.trim()
  if (trimmed === '') {
    setSetting(KEY, '')
    return
  }
  if (!isEncryptionAvailable()) {
    // 系统级加密不可用时拒绝存明文，避免密钥躺在 SQLite 里
    throw new Error('系统凭据加密不可用（safeStorage），无法安全保存 API-KEY')
  }
  setSetting(KEY, safeStorage.encryptString(trimmed).toString('base64'))
}

export function getApiKey(): string | null {
  // 冒烟测试可用环境变量注入假 key，避免依赖真实凭据
  const env = process.env.VARIDUB_API_KEY
  if (env) return env
  const stored = getSetting(KEY)
  if (!stored) return null
  // mock 模式下允许遗留明文（历史写入）
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return isMock() ? stored : null
  }
}

export function secretState(): SecretState {
  const stored = getSetting(KEY)
  return {
    available: isEncryptionAvailable(),
    hasKey: stored.length > 0 || !!process.env.VARIDUB_API_KEY,
    masked: maskApiKey(stored ? getApiKey() : null)
  }
}

export function maskApiKey(key: string | null): string | null {
  if (!key) return null
  const head = key.slice(0, 4)
  const tail = key.slice(-4)
  return `${head}••••••${tail}`
}
