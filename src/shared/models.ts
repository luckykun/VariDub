/**
 * 模型路由总表（SPEC-001 §5.1 / §5.2 / §5.4）——前端下拉与后端 timeRouter 的单一真源。
 * id 为调用百炼时使用的模型名；nightDiscount 对应「限时夜间 4 折」标注。
 */

export type ModelKind = 'vision' | 'text' | 'asr' | 'tts' | 'image' | 'video'

export interface ModelInfo {
  id: string
  label: string
  kind: ModelKind
  /** 是否标注夜间折扣（可用于时段路由） */
  nightDiscount: boolean
  /** 同代视觉/文本档，时段路由可自动切换 */
  timeAwareEligible: boolean
  /** 本地兜底能力说明或计费说明 */
  note: string
  /** 已订阅清单内但不适用（置灰不可选，SPEC-001 §5.2 注） */
  unavailable?: boolean
  /** 无本地兜底（显存不足，SPEC-001 §3.5） */
  noLocalFallback?: boolean
}

export const MODELS: Record<string, ModelInfo> = {
  'qwen3.8-max': {
    id: 'qwen3.8-max',
    label: 'qwen3.8-max',
    kind: 'vision',
    nightDiscount: true,
    timeAwareEligible: true,
    note: '最新代视觉/文本 · 夜间 4 折'
  },
  'qwen3.8-flash': {
    id: 'qwen3.8-flash',
    label: 'qwen3.8-flash',
    kind: 'vision',
    nightDiscount: true,
    timeAwareEligible: true,
    note: '同代视觉 · 省额度'
  },
  'qwen3.6-flash': {
    id: 'qwen3.6-flash',
    label: 'qwen3.6-flash',
    kind: 'text',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '更省额度（翻译手动可切）'
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    kind: 'text',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '翻译可选模型'
  },
  'glm-5': {
    id: 'glm-5',
    label: 'glm-5',
    kind: 'text',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '翻译可选模型'
  },
  'qwen-audio-3.0-asr-flash': {
    id: 'qwen-audio-3.0-asr-flash',
    label: 'qwen-audio-3.0-asr-flash',
    kind: 'asr',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '语音识别 + 说话人分离 · 无折扣不做时段路由'
  },
  'qwen-audio-3.0-tts-plus': {
    id: 'qwen-audio-3.0-tts-plus',
    label: 'qwen-audio-3.0-tts-plus',
    kind: 'tts',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '音色复刻 TTS · 无折扣不做时段路由'
  },
  'wan2.7-image-pro': {
    id: 'wan2.7-image-pro',
    label: 'wan2.7-image-pro',
    kind: 'image',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '3D 关键帧重绘（异步任务）· 无本地兜底',
    noLocalFallback: true
  },
  'happyhorse-1.1-i2v': {
    id: 'happyhorse-1.1-i2v',
    label: 'happyhorse-1.1-i2v',
    kind: 'video',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '图生视频动态化（异步任务）· 无本地兜底',
    noLocalFallback: true
  },
  'happyhorse-1.1-r2v': {
    id: 'happyhorse-1.1-r2v',
    label: 'happyhorse-1.1-r2v',
    kind: 'video',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '同风格参考视频备选（异步任务）',
    noLocalFallback: true
  },
  'qwen-audio-3.0-realtime-plus': {
    id: 'qwen-audio-3.0-realtime-plus',
    label: 'qwen-audio-3.0-realtime-plus',
    kind: 'asr',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '实时对话 · 本产品暂不使用',
    unavailable: true
  },
  'qwen-image-3.0-pro': {
    id: 'qwen-image-3.0-pro',
    label: 'qwen-image-3.0-pro',
    kind: 'image',
    nightDiscount: false,
    timeAwareEligible: false,
    note: '本产品暂不使用',
    unavailable: true
  }
}

/** 本地模型（SPEC-001 §2.1） */
export const LOCAL_MODELS = {
  demucs: { label: 'Demucs (htdemucs)', usage: '步骤② 人声/背景分离', cost: '¥0 · 电费' },
  musetalk: { label: 'MuseTalk v1 (192px)', usage: '步骤⑥ 口型对齐', cost: '¥0 · 电费' },
  pyscenedetect: { label: 'PySceneDetect', usage: '步骤① 分镜兜底', cost: '¥0 · CPU' },
  ffmpeg: { label: 'ffmpeg', usage: '抽帧/切片/混音/合成', cost: '¥0' }
} as const

export const ROUTE_STAGE_LABELS = {
  shot_analysis: '① 分镜解析',
  translate: '③ 中→英翻译'
} as const

export type RouteStageKey = 'shot_analysis' | 'translate'

/** 各环节候选模型（下拉框始终可选清单内任意模型，SPEC-001 §5.4 手动覆盖） */
export const STAGE_OPTIONS: Record<string, string[]> = {
  stage1: ['auto', 'qwen3.8-max', 'qwen3.8-flash'],
  stage2: ['qwen-audio-3.0-asr-flash'],
  stage3: ['auto', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.6-flash', 'deepseek-v4-pro', 'glm-5'],
  stage4: ['qwen-audio-3.0-tts-plus'],
  stage5_keyframe: ['wan2.7-image-pro'],
  stage5_motion: ['happyhorse-1.1-i2v', 'happyhorse-1.1-r2v']
}

/** 时段路由仅作用于同时具备 max/flash 同代且 max 有夜间折扣的环节（SPEC-001 §5.1） */
export const TIME_AWARE_STAGES: RouteStageKey[] = ['shot_analysis', 'translate']

export const NIGHT_HEAVY_MODEL = 'qwen3.8-max'
export const DAY_LIGHT_MODEL = 'qwen3.8-flash'

export const STYLE_PRESETS = [
  { id: 'pixar', label: '皮克斯质感', desc: '默认 · 柔和次表面散射皮肤，电影打光' },
  { id: 'anime', label: '日系动漫', desc: '赛璐璐描边 + 3D 体积光' },
  { id: 'claymation', label: '黏土定格', desc: '黏土材质指纹质感，定格动画光照' }
] as const

export const PRESET_VOICES = [
  { name: 'Sofia', tags: ['女声', '温暖'], desc: '预置音色库' },
  { name: 'Marcus', tags: ['男声', '低沉'], desc: '预置音色库' },
  { name: '播音员', tags: ['中性', '字正腔圆'], desc: '预置音色库' },
  { name: 'Vivi', tags: ['女声', '活泼'], desc: '预置音色库' }
] as const
