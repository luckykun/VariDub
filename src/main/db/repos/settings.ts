/** Settings 表读写（SPEC-001 §6）：key/value 文本，值按声明类型解析，缺失取默认值 */
import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { settingsTable } from '../schema'
import { nowIso } from '../../util/id'

export const SETTINGS_DEFAULTS = {
  'api.base_url': 'https://dashscope.aliyuncs.com/api/v1',
  'api.compatible_base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'api.tts_endpoint': 'dashscope_tts',
  'api.mock': 'false',
  'route.time_aware': 'true',
  'route.discount_window': '22:00-08:00',
  'route.stage1.model': 'auto',
  'route.stage2.model': 'qwen-audio-3.0-asr-flash',
  'route.stage3.model': 'auto',
  'route.stage4.model': 'qwen-audio-3.0-tts-plus',
  'route.stage5_keyframe.model': 'wan2.7-image-pro',
  'route.stage5_motion.model': 'happyhorse-1.1-i2v',
  'storage.workspace_root': 'D:/Vardub_Workspace',
  'storage.export_dir': '',
  'style.preset': 'pixar',
  'style.face_consistency': '0.82',
  'render.concurrency': '2',
  'translate.style_instruction': '',
  'translate.alts_count': '2',
  'translate.global_overflow_policy': 'compress',
  'dub.speed': '1.0',
  'dub.pitch': '0',
  'dub.emotion': '0.5',
  'export.resolution': '1080p',
  'export.fps': '30',
  'export.bilingual_srt': 'true',
  'sidecar.auto_start': 'true',
  'sidecar.python_path': 'auto',
  'sidecar.port': '0',
  'ui.copyright_dismissed': 'false'
} as const

export type SettingKey = keyof typeof SETTINGS_DEFAULTS

export function getSetting(key: SettingKey | string): string {
  const rows = getDb().select().from(settingsTable).where(eq(settingsTable.key, key)).all()
  if (rows.length > 0) return rows[0].value
  const fallback = (SETTINGS_DEFAULTS as Record<string, string>)[key]
  return fallback ?? ''
}

export function setSetting(key: SettingKey | string, value: string): void {
  const db = getDb()
  const exists = db.select({ k: settingsTable.key }).from(settingsTable).where(eq(settingsTable.key, key)).all().length > 0
  if (exists) {
    db.update(settingsTable).set({ value }).where(eq(settingsTable.key, key)).run()
  } else {
    db.insert(settingsTable).values({ key, value }).run()
  }
}

export function getBool(key: SettingKey | string): boolean {
  return getSetting(key) === 'true'
}

/**
 * Mock 判定的唯一入口：env VARIDUB_MOCK=1（`--mock` / 启动脚本选 Mock）或设置表 api.mock（设置页开关）。
 * 别再直接用 getBool('api.mock')：那样 `--mock` 启的进程会被漏判成真实调用，当场报“未配 API-KEY”。
 */
export function isMock(): boolean {
  return process.env.VARIDUB_MOCK === '1' || getBool('api.mock')
}

export function getNum(key: SettingKey | string): number {
  const n = Number(getSetting(key))
  return Number.isFinite(n) ? n : 0
}

/** 时间戳工具统一入口 */
export function timestamp(): string {
  return nowIso()
}
