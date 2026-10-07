/**
 * REST 层的数据组装（SPEC-001 §6 设置项 ↔ Settings 表 key 的映射，§4 导入前置检查）。
 * 渲染层只看见 SettingsDto 的分组结构，不接触 key/value。
 */
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ModelRouteDto, OverflowPolicy, PrecheckItem, PrecheckResult, SettingsDto } from '../../shared/types'
import type { SidecarViewDto } from '../../shared/api'
import { MODELS, STAGE_OPTIONS, TIME_AWARE_STAGES } from '../../shared/models'
import { getBool, getNum, getSetting, isMock, setSetting } from '../db/repos/settings'
import { secretState, setApiKey } from '../safeStorage'
import { sidecar } from '../sidecar/client'
import { readBootstrapNote } from '../sidecar/manager'
import { probe } from '../media/ffmpeg'
import { appDataDir, ensureDir } from '../paths'
import { log } from '../logger'
import { resolve as resolveRoute } from '../bailian/timeRouter'

/** 视频硬性约束（评审决议 R6：≤5 分钟、≥720p） */
export const MAX_DURATION_MS = 5 * 60_000
export const MIN_SHORT_EDGE = 720

export function settingsDto(): SettingsDto {
  const secret = secretState()
  return {
    api: {
      keyMasked: secret.masked,
      hasKey: secret.hasKey,
      baseUrl: getSetting('api.compatible_base_url'),
      mockMode: isMock()
    },
    routes: {
      timeAware: getBool('route.time_aware'),
      discountWindow: getSetting('route.discount_window'),
      stage1: getSetting('route.stage1.model'),
      stage2: getSetting('route.stage2.model'),
      stage3: getSetting('route.stage3.model'),
      stage4: getSetting('route.stage4.model'),
      stage5Keyframe: getSetting('route.stage5_keyframe.model'),
      stage5Motion: getSetting('route.stage5_motion.model')
    },
    storage: {
      workspaceRoot: getSetting('storage.workspace_root'),
      exportDir: getSetting('storage.export_dir').trim() || defaultExportDir(),
      freeBytesC: freeBytesSync('C:/'),
      freeBytesD: freeBytesSync(getSetting('storage.workspace_root') || 'D:/')
    },
    style: {
      preset: presetStyle(),
      faceConsistency: getNum('style.face_consistency') || 0.82,
      renderConcurrency: getNum('render.concurrency') || 2
    },
    translate: {
      styleInstruction: getSetting('translate.style_instruction'),
      altsCount: getNum('translate.alts_count') || 2,
      globalOverflowPolicy: policy(getSetting('translate.global_overflow_policy'))
    },
    tts: {
      speed: getNum('dub.speed') || 1,
      pitch: getNum('dub.pitch'),
      emotion: getNum('dub.emotion') || 0.5
    },
    export: {
      resolution: getSetting('export.resolution') === '720p' ? '720p' : '1080p',
      fps: getNum('export.fps') || 30,
      bilingualSrt: getBool('export.bilingual_srt')
    },
    sidecar: {
      autoStart: getBool('sidecar.auto_start'),
      pythonPath: getSetting('sidecar.python_path'),
      port: getNum('sidecar.port')
    },
    ui: {
      copyrightNoticeDismissed: getBool('ui.copyright_dismissed')
    }
  }
}

/** 分块写回设置（未出现的块不动） */
export function applySettingsPatch(patch: Partial<SettingsDto>): SettingsDto {
  if (patch.api) {
    if (patch.api.baseUrl) setSetting('api.compatible_base_url', patch.api.baseUrl.trim())
    if (patch.api.mockMode !== undefined) setSetting('api.mock', patch.api.mockMode ? 'true' : 'false')
  }
  if (patch.routes) {
    const r = patch.routes
    if (r.timeAware !== undefined) setSetting('route.time_aware', r.timeAware ? 'true' : 'false')
    if (r.discountWindow) setSetting('route.discount_window', r.discountWindow.trim())
    if (r.stage1) setSetting('route.stage1.model', r.stage1)
    if (r.stage2) setSetting('route.stage2.model', r.stage2)
    if (r.stage3) setSetting('route.stage3.model', r.stage3)
    if (r.stage4) setSetting('route.stage4.model', r.stage4)
    if (r.stage5Keyframe) setSetting('route.stage5_keyframe.model', r.stage5Keyframe)
    if (r.stage5Motion) setSetting('route.stage5_motion.model', r.stage5Motion)
  }
  if (patch.storage) {
    if (patch.storage.workspaceRoot) setSetting('storage.workspace_root', patch.storage.workspaceRoot.trim())
    if (patch.storage.exportDir !== undefined) setSetting('storage.export_dir', patch.storage.exportDir.trim())
  }
  if (patch.style) {
    if (patch.style.preset) setSetting('style.preset', patch.style.preset)
    if (patch.style.faceConsistency !== undefined) setSetting('style.face_consistency', String(patch.style.faceConsistency))
    if (patch.style.renderConcurrency !== undefined) setSetting('render.concurrency', String(Math.max(1, Math.min(2, patch.style.renderConcurrency))))
  }
  if (patch.translate) {
    const t = patch.translate
    if (t.styleInstruction !== undefined) setSetting('translate.style_instruction', t.styleInstruction)
    if (t.altsCount !== undefined) setSetting('translate.alts_count', String(Math.max(0, Math.min(4, Math.round(t.altsCount)))))
    if (t.globalOverflowPolicy) setSetting('translate.global_overflow_policy', t.globalOverflowPolicy)
  }
  if (patch.tts) {
    if (patch.tts.speed !== undefined) setSetting('dub.speed', String(clamp(patch.tts.speed, 0.5, 2)))
    if (patch.tts.pitch !== undefined) setSetting('dub.pitch', String(clamp(patch.tts.pitch, -12, 12)))
    if (patch.tts.emotion !== undefined) setSetting('dub.emotion', String(clamp(patch.tts.emotion, 0, 1)))
  }
  if (patch.export) {
    if (patch.export.resolution) setSetting('export.resolution', patch.export.resolution === '720p' ? '720p' : '1080p')
    if (patch.export.fps !== undefined) setSetting('export.fps', String(Math.round(clamp(patch.export.fps, 15, 60))))
    if (patch.export.bilingualSrt !== undefined) setSetting('export.bilingual_srt', patch.export.bilingualSrt ? 'true' : 'false')
  }
  if (patch.sidecar) {
    if (patch.sidecar.autoStart !== undefined) setSetting('sidecar.auto_start', patch.sidecar.autoStart ? 'true' : 'false')
    if (patch.sidecar.pythonPath !== undefined) setSetting('sidecar.python_path', patch.sidecar.pythonPath.trim() || 'auto')
    if (patch.sidecar.port !== undefined) setSetting('sidecar.port', String(Math.max(0, Math.min(65535, Math.round(patch.sidecar.port)))))
  }
  if (patch.ui?.copyrightNoticeDismissed !== undefined) setSetting('ui.copyright_dismissed', patch.ui.copyrightNoticeDismissed ? 'true' : 'false')
  return settingsDto()
}

export function saveApiKey(plain: string): SettingsDto {
  setApiKey(plain)
  return settingsDto()
}

/** 时段路由表（①③ 两条，含夜间 4 折角标文案，SPEC-001 §5.4） */
export function modelRoutes(): ModelRouteDto[] {
  return TIME_AWARE_STAGES.map((stage) => {
    const effective = resolveRoute(stage)
    const key = stage === 'shot_analysis' ? 'stage1' : 'stage3'
    return {
      stage,
      label: stage === 'shot_analysis' ? '① 分镜解析（视觉）' : '③ 中→英翻译（文本）',
      auto: (getSetting(`route.${key}.model`) || 'auto') === 'auto',
      override: getSetting(`route.${key}.model`) || 'auto',
      candidates: STAGE_OPTIONS[key] ?? [],
      effective
    }
  })
}

export function modelName(id: string): string {
  const m = MODELS[id]
  return m ? m.label : id
}

/** 导入前置检查：时长 / 人声 / 画面 三项（§4 项目列表页） */
export async function precheckFile(filePath: string): Promise<PrecheckResult> {
  const missing: PrecheckResult = {
    filePath,
    fileName: basename(filePath),
    durationMs: 0,
    width: 0,
    height: 0,
    hasAudio: false,
    items: [{ key: 'visual', label: '文件可读', pass: false, detail: `文件不存在：${filePath}`, blocking: true }],
    ok: false
  }
  if (!existsSync(filePath)) return missing
  const meta = await probe(filePath)
  const shortEdge = Math.min(meta.width, meta.height)
  const items: PrecheckItem[] = [
    {
      key: 'duration',
      label: '时长 ≤ 5 分钟',
      pass: meta.durationMs > 0 && meta.durationMs <= MAX_DURATION_MS,
      detail: `${(meta.durationMs / 1000).toFixed(1)}s${meta.durationMs > MAX_DURATION_MS ? `（超出 ${((meta.durationMs - MAX_DURATION_MS) / 1000).toFixed(0)}s，请裁短）` : ''}`,
      blocking: true
    },
    {
      key: 'audio',
      label: '含可分离人声的音轨',
      pass: meta.hasAudio,
      detail: meta.hasAudio ? `音轨 ${meta.audioSampleRate ?? '?'}Hz（人声质量在步骤② 逐句校验）` : '没有音轨：无法转写与配音',
      blocking: true
    },
    {
      key: 'visual',
      label: '画面 ≥ 720p',
      pass: shortEdge >= MIN_SHORT_EDGE,
      detail: `${meta.width}×${meta.height}${meta.fps ? ` · ${meta.fps.toFixed(0)}fps` : ''}${shortEdge < MIN_SHORT_EDGE ? `（短边 ${shortEdge}px < ${MIN_SHORT_EDGE}px）` : ''}`,
      blocking: false
    }
  ]
  return {
    filePath,
    fileName: basename(filePath),
    durationMs: Math.round(meta.durationMs),
    width: meta.width,
    height: meta.height,
    hasAudio: meta.hasAudio,
    items,
    ok: items.filter((i) => i.blocking).every((i) => i.pass)
  }
}

export function defaultExportDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (!home) return ''
  const desk = join(home, 'Desktop')
  return existsSync(desk) ? desk : home
}

export function previewDir(): string {
  return ensureDir(join(appDataDir(), 'preview'))
}

function freeBytesSync(path: string): number | null {
  try {
    const root = /^[A-Za-z]:/.test(path) ? path.slice(0, 2) + '/' : path
    if (!existsSync(root)) return null
    // statfs 是异步的，这里用同步封装（调用频率低：仅打开设置页/导入页）
    return FREE_CACHE.get(root) ?? null
  } catch {
    return null
  }
}

const FREE_CACHE = new Map<string, number>()

/** 磁盘余量（异步刷新进缓存，UI 拿 settings 时得到最新值） */
export async function refreshFreeBytes(): Promise<void> {
  const roots = new Set<string>(['C:/', dirname(getSetting('storage.workspace_root') || 'D:/Vardub_Workspace')])
  for (const raw of roots) {
    const root = /^[A-Za-z]:/.test(raw) ? raw.slice(0, 2) + '/' : raw
    try {
      const stats = await statfs(root)
      FREE_CACHE.set(root, stats.bsize * stats.bavail)
    } catch (err) {
      log.warn('dto', `读取磁盘余量失败 ${root}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** sidecar 运行态（UI 侧栏 + 设置页共用） */
export function sidecarView(): SidecarViewDto {
  return {
    ...sidecar.status,
    port: getNum('sidecar.port'),
    pythonPath: getSetting('sidecar.python_path'),
    bootstrapNote: readBootstrapNote()
  }
}

function presetStyle(): SettingsDto['style']['preset'] {
  const v = getSetting('style.preset')
  return v === 'anime' || v === 'claymation' ? v : 'pixar'
}

function policy(v: string): OverflowPolicy {
  return v === 'freeze' || v === 'none' ? v : 'compress'
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}
