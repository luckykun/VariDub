/**
 * 屏 04 设置（SPEC-001 §4）：顶部 Tab 切换，一屏只呈现一张卡，避免多卡堆叠出两层滚动条。
 * 云端接入 · 模型路由 · 3D 风格 · 翻译风格 · 配音参数 · 导出与存储 · 本地算力。
 * 每个 Tab 独立草稿 + 「保存本块」，避免一次误改整张表；所有卡常驻 DOM（非当前 Tab 只隐藏），
 * 因此来回切 Tab 不会丢未保存的草稿。卡内不滚动（Panel bodyScroll={false}），内容超高时只在内容区滚动一次。
 * 保存按钮一律放在卡内容最下方独占一行（SaveRow），不夹在字段中间；右侧配一段「本组是否有改动」状态字。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Clock, Cloud, Cpu, Download, FolderOpen, Languages, Mic, Palette, Play, Route, Save, Server, Square, TriangleAlert } from 'lucide-react'
import type { ModelRouteDto, SettingsDto } from '@shared/types'
import { MODELS } from '@shared/models'
import { api } from '@renderer/api/client'
import { Badge, Field, Panel, Spinner, Toggle, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { useAppStore } from '@renderer/stores/appStore'
import { bytes, clamp } from '@renderer/util/format'

type RouteModelKey = 'stage1' | 'stage2' | 'stage3' | 'stage4' | 'stage5Keyframe' | 'stage5Motion'

const STAGE_ROWS: Array<{ key: RouteModelKey; label: string; options: string; fallback: string }> = [
  { key: 'stage1', label: '① 分镜解析（视觉）', options: 'stage1', fallback: 'PySceneDetect（本地兜底）' },
  { key: 'stage2', label: '② 中文识别（ASR）', options: 'stage2', fallback: 'Whisper（本地，暂不实现）' },
  { key: 'stage3', label: '③ 中→英翻译', options: 'stage3', fallback: '手动可切 qwen3.6-flash 更省' },
  { key: 'stage4', label: '④ 音色克隆配音（TTS）', options: 'stage4', fallback: '本地 F5-TTS（预留位）' },
  { key: 'stage5Keyframe', label: '⑤ 3D 关键帧', options: 'stage5_keyframe', fallback: '无本地兜底（显存不足）' },
  { key: 'stage5Motion', label: '⑤ 3D 动态化', options: 'stage5_motion', fallback: 'happyhorse-1.1-r2v 备选' }
]

type TabId = 'cloud' | 'route' | 'style' | 'translate' | 'dub' | 'storage' | 'compute'

const TABS: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  { id: 'cloud', label: '云端接入', icon: <Cloud size={13} /> },
  { id: 'route', label: '模型路由', icon: <Route size={13} /> },
  { id: 'style', label: '3D 风格', icon: <Palette size={13} /> },
  { id: 'translate', label: '翻译风格', icon: <Languages size={13} /> },
  { id: 'dub', label: '配音参数', icon: <Mic size={13} /> },
  { id: 'storage', label: '导出与存储', icon: <FolderOpen size={13} /> },
  { id: 'compute', label: '本地算力', icon: <Cpu size={13} /> }
]

const TAB_MEMORY = 'varidub.settings.tab'

export function Settings(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const catalog = useAppStore((s) => s.catalog)
  const system = useAppStore((s) => s.system)
  const secret = useAppStore((s) => s.secret)
  const routes = useAppStore((s) => s.routes)
  const [tab, setTab] = useState<TabId>(readSavedTab)

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Spinner label="读取设置" />
      </div>
    )
  }

  function selectTab(id: TabId): void {
    setTab(id)
    try {
      localStorage.setItem(TAB_MEMORY, id)
    } catch {
      /* 本地存储不可用时就在本次会话里记住 */
    }
  }

  // 所有卡常驻（只隐藏非当前项），草稿态因此不随 Tab 切换丢失
  const blocks: Array<{ id: TabId; node: JSX.Element }> = [
    { id: 'cloud', node: <ApiKeyBlock secret={secret} api={settings.api} mock={system?.mockMode ?? settings.api.mockMode} /> },
    { id: 'route', node: <RouteBlock draft={settings.routes} routes={routes} catalog={catalog} /> },
    { id: 'style', node: <StyleBlock style={settings.style} styles={catalog?.styles ?? []} /> },
    { id: 'translate', node: <TranslateBlock translate={settings.translate} /> },
    { id: 'dub', node: <DubBlock tts={settings.tts} /> },
    { id: 'storage', node: <StorageBlock storage={settings.storage} exportCfg={settings.export} system={system} /> },
    { id: 'compute', node: <LocalComputeBlock sidecarCfg={settings.sidecar} localModels={catalog?.localModels ?? []} /> }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 px-6 pt-5">
        <h1 className="font-display text-[18px] text-ink">设置</h1>
        <p className="text-[12px] text-muted">API-KEY 用系统级加密（Windows DPAPI）保存，界面只显示脱敏串；各组设置独立保存。</p>
      </header>

      <div role="tablist" aria-label="设置分组" className="flex shrink-0 flex-wrap items-end gap-1 border-b border-hairline px-6 pt-3">
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(t.id)}
              className={`-mb-px flex h-[var(--control-h)] items-center gap-2 border px-4 text-[12px] transition-colors ${
                // 当前 Tab 灰底 + 红下划线（与左侧菜单选中态同一套语言），非当前项保持黑
                active ? 'border-hairline border-b-2 border-b-accent bg-elevated text-ink' : 'border-transparent text-muted hover:bg-elevated/50 hover:text-body'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-4">
        {blocks.map((b) => (
          <div key={b.id} className={b.id === tab ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            {b.node}
          </div>
        ))}
      </div>
    </div>
  )
}

function readSavedTab(): TabId {
  try {
    const saved = localStorage.getItem(TAB_MEMORY)
    return TABS.some((t) => t.id === saved) ? (saved as TabId) : 'cloud'
  } catch {
    return 'cloud'
  }
}

/* ------------------------------------------------------------------ API-KEY */

function ApiKeyBlock({
  secret,
  api: cfg,
  mock
}: {
  secret: ReturnType<typeof useAppStore.getState>['secret']
  api: SettingsDto['api']
  mock: boolean
}): JSX.Element {
  const saveApiKey = useAppStore((s) => s.saveApiKey)
  const clearApiKey = useAppStore((s) => s.clearApiKey)
  const testConnection = useAppStore((s) => s.testConnection)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl)
  const [busy, setBusy] = useState(false)

  useEffect(() => setBaseUrl(cfg.baseUrl), [cfg.baseUrl])

  return (
    <Panel title={<span className="text-[13px]">云端接入（阿里云百炼 · TokenPlan 订阅）</span>} bodyScroll={false} bodyClass="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="label mb-0">当前 API-KEY</span>
          <span className="mono text-[12px] text-ink">{cfg.hasKey ? (cfg.keyMasked ?? '已保存') : '未配置'}</span>
          <Badge tone={cfg.hasKey ? 'success' : 'error'}>
            {cfg.hasKey ? <Check size={10} /> : <TriangleAlert size={10} />}
            {cfg.hasKey ? '已加密保存' : '尚未配置'}
          </Badge>
          {secret && !secret.available && (
            <Badge tone="warn">
              <TriangleAlert size={10} /> 系统加密不可用，将以明文存库（仅本机自用）
            </Badge>
          )}
        </div>

        <Field label="填入新的 API-KEY" className="w-[420px]" hint="留空则不修改；保存后立即生效，无需重启">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="flex flex-wrap items-end gap-3 border-t border-hairline pt-3">
          <Field label="OpenAI 兼容端点" className="min-w-[320px] flex-1" hint="chat/completions 与 TTS/ASR 走这里">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </Field>
          <Toggle checked={mock} onChange={(v) => void saveSettings({ api: { ...cfg, mockMode: v } })} label={<span className="text-[12px]">Mock 模式（联调用，不发真实云端请求）</span>} />
        </div>

        <p className="text-[11px] leading-[1.6] text-muted">
          说明：wan / happyhorse 为异步任务，走 DashScope 提交 + 轮询；失败自动重试 2 次，仍失败则标红并提示手动重跑（§7.7-1）。
        </p>
      </div>

      <SaveRow>
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true)
            const ok = await saveApiKey(key.trim())
            setBusy(false)
            if (ok) setKey('')
          }}
        >
          <Save size={13} />
          保存 API-KEY
        </button>
        <button type="button" className="btn" disabled={busy || !cfg.hasKey} onClick={() => void clearApiKey()}>
          清除
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void testConnection()}>
          <Play size={13} />
          连接测试
        </button>
        <span className="mx-1 h-5 w-px bg-hairline" />
        <button
          type="button"
          className="btn"
          disabled={baseUrl.trim() === cfg.baseUrl}
          onClick={() => void saveSettings({ api: { ...cfg, baseUrl: baseUrl.trim() } })}
        >
          <Save size={13} />
          保存端点
        </button>
        {key.trim() ? <DraftState dirty /> : <span className="text-[11px] text-muted">留空则不改当前 KEY；端点与 Mock 改动即时生效</span>}
      </SaveRow>
    </Panel>
  )
}

/* ---------------------------------------------------------------- 模型路由 */

function RouteBlock({
  draft,
  routes,
  catalog
}: {
  draft: SettingsDto['routes']
  routes: ModelRouteDto[]
  catalog: ReturnType<typeof useAppStore.getState>['catalog']
}): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [local, setLocal] = useState(draft)
  const [discountWindow, setDiscountWindow] = useState(draft.discountWindow)

  useEffect(() => {
    setLocal(draft)
    setDiscountWindow(draft.discountWindow)
  }, [draft])

  const dirty = JSON.stringify(local) !== JSON.stringify(draft) || discountWindow !== draft.discountWindow

  function setModel(key: RouteModelKey, value: string): void {
    setLocal((cur) => {
      const next: SettingsDto['routes'] = { ...cur }
      next[key] = value
      return next
    })
  }

  return (
    <Panel
      title={<span className="text-[13px]">模型路由总表</span>}
      aside={<span className="text-[11px] text-muted">下拉框始终可选清单内任意模型（手动覆盖），「auto」才受时段路由影响</span>}
      bodyScroll={false}
      bodyClass="p-0"
    >
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-hairline text-left text-[11px] text-muted">
            <th className="px-4 py-2 font-normal">环节</th>
            <th className="px-4 py-2 font-normal">首选</th>
            <th className="px-4 py-2 font-normal">降级 / 兜底</th>
            <th className="px-4 py-2 font-normal">当前生效</th>
          </tr>
        </thead>
        <tbody>
          {STAGE_ROWS.map((row) => {
            const options = (catalog?.stageOptions[row.options] ?? []).map((id) => id)
            const value = local[row.key]
            const route = routeFor(routes, row.key)
            return (
              <tr key={row.key} className="border-b border-hairline/60">
                <td className="px-4 py-2 text-ink">{row.label}</td>
                <td className="px-4 py-2">
                  <select
                    value={value}
                    onChange={(e) => setModel(row.key, e.target.value)}
                    className="min-w-[210px]"
                  >
                    {(options.length > 0 ? options : [value]).map((id) => (
                      <option key={id} value={id}>
                        {id === 'auto' ? 'auto（时段路由自动）' : MODELS[id]?.label ?? id}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-muted">{row.fallback}</td>
                <td className="px-4 py-2">
                  {route ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="mono text-ink">{route.effective.model}</span>
                      <Badge tone={route.effective.discountActive ? 'success' : 'muted'}>
                        <Clock size={10} />
                        {route.effective.badge}
                      </Badge>
                    </span>
                  ) : (
                    <span className="mono text-muted">{value}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-end gap-4 border-t border-hairline px-4 py-3">
        <Toggle
          checked={local.timeAware}
          onChange={(v) => setLocal({ ...local, timeAware: v })}
          label={<span className="text-[12px]">时段感知路由（仅作用 ①③，判定发生在任务提交时刻）</span>}
        />
        <Field label="夜间折扣窗口" className="w-[180px]" hint="格式 HH:MM-HH:MM，跨零点合法">
          <input value={discountWindow} onChange={(e) => setDiscountWindow(e.target.value)} spellCheck={false} />
        </Field>
        {local.timeAware && (
          <p className="min-w-[260px] flex-1 text-[11px] leading-[1.6] text-muted">
            规则：<span className="mono text-body">当前时间 ∈ 窗口 → qwen3.8-max</span>（夜间 4 折，质量高一档）；
            <span className="mono text-body"> 否则 → qwen3.8-flash</span>（同代省额度）。audio 系列与视频类无折扣标注，不参与时段路由。
          </p>
        )}
      </div>

      <SaveRow flush={false}>
        <button
          type="button"
          className="btn btn-accent"
          disabled={!dirty}
          onClick={() => void saveSettings({ routes: { ...local, discountWindow: discountWindow.trim() } })}
        >
          <Save size={13} />
          保存路由
        </button>
        <DraftState dirty={dirty} />
      </SaveRow>
    </Panel>
  )
}

function routeFor(routes: ModelRouteDto[], key: RouteModelKey): ModelRouteDto | null {
  if (key === 'stage1') return routes.find((r) => r.stage === 'shot_analysis') ?? null
  if (key === 'stage3') return routes.find((r) => r.stage === 'translate') ?? null
  return null
}

/* ------------------------------------------------------------ 3D 风格 */

function StyleBlock({
  style,
  styles
}: {
  style: SettingsDto['style']
  styles: Array<{ id: string; label: string; desc: string }>
}): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [draft, setDraft] = useState(style)
  useEffect(() => setDraft(style), [style])

  return (
    <Panel title={<span className="text-[13px]">步骤⑤ 3D 画面重绘</span>} bodyScroll={false} bodyClass="p-4">
      <div className="flex flex-wrap items-end gap-5">
        <Field label="风格预设" className="w-[280px]" hint={(styles.find((x) => x.id === draft.preset)?.desc ?? '默认皮克斯质感')}>
          <select value={draft.preset} onChange={(e) => setDraft({ ...draft, preset: e.target.value as SettingsDto['style']['preset'] })}>
            {styles.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="w-[240px]">
          <Slider label="人脸一致性强度" value={draft.faceConsistency} min={0} max={1} step={0.01} display={draft.faceConsistency.toFixed(2)} onChange={(v) => setDraft({ ...draft, faceConsistency: v })} />
        </div>
        <div className="w-[240px]">
          <Slider label="云端渲染并发" value={draft.renderConcurrency} min={1} max={2} step={1} display={`${draft.renderConcurrency}（上限 2，防限流）`} onChange={(v) => setDraft({ ...draft, renderConcurrency: v })} />
        </div>
      </div>

      <SaveRow>
        <button
          type="button"
          className="btn btn-accent"
          disabled={JSON.stringify(draft) === JSON.stringify(style)}
          onClick={() => void saveSettings({ style: draft })}
        >
          <Save size={13} />
          保存风格
        </button>
        <DraftState dirty={JSON.stringify(draft) !== JSON.stringify(style)} />
      </SaveRow>
    </Panel>
  )
}

/* ------------------------------------------------------------ 翻译风格 */

function TranslateBlock({ translate }: { translate: SettingsDto['translate'] }): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [draft, setDraft] = useState(translate)
  useEffect(() => setDraft(translate), [translate])

  return (
    <Panel title={<span className="text-[13px]">步骤③ 中→英翻译</span>} bodyScroll={false} bodyClass="p-4">
      <div className="flex flex-wrap items-start gap-5">
        <Field label="全局风格指令（注入系统提示词）" className="w-[460px]">
          <textarea
            value={draft.styleInstruction}
            rows={5}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, styleInstruction: e.target.value })}
            placeholder="例：综艺口播风格，短句、口语化、保留梗和笑点，必要处意译"
          />
        </Field>
        <div className="flex w-[300px] flex-col gap-3">
          <Slider label="每句备选译文条数" value={draft.altsCount} min={0} max={4} step={1} display={`${draft.altsCount} 条`} onChange={(v) => setDraft({ ...draft, altsCount: v })} />
          <Field label="超支句全局默认策略" hint="超支句仍需逐句人工确认二选一（§3.3）">
            <select value={draft.globalOverflowPolicy} onChange={(e) => setDraft({ ...draft, globalOverflowPolicy: e.target.value as SettingsDto['translate']['globalOverflowPolicy'] })}>
              <option value="compress">精简译文（推荐）</option>
              <option value="freeze">允许画面停顿</option>
              <option value="none">不处理（逐句自己选）</option>
            </select>
          </Field>
        </div>
      </div>

      <SaveRow>
        <button
          type="button"
          className="btn btn-accent"
          disabled={JSON.stringify(draft) === JSON.stringify(translate)}
          onClick={() => void saveSettings({ translate: draft })}
        >
          <Save size={13} />
          保存翻译参数
        </button>
        <DraftState dirty={JSON.stringify(draft) !== JSON.stringify(translate)} />
      </SaveRow>
    </Panel>
  )
}

/* ------------------------------------------------------------ 配音参数 */

function DubBlock({ tts }: { tts: SettingsDto['tts'] }): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [draft, setDraft] = useState(tts)
  useEffect(() => setDraft(tts), [tts])

  return (
    <Panel title={<span className="text-[13px]">步骤④ 配音全局参数</span>} bodyScroll={false} bodyClass="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-5">
          <div className="w-[220px]">
            <Slider label="语速" value={draft.speed} min={0.5} max={2} step={0.05} display={`${draft.speed.toFixed(2)}×`} onChange={(v) => setDraft({ ...draft, speed: v })} />
          </div>
          <div className="w-[220px]">
            <Slider label="音调偏移" value={draft.pitch} min={-12} max={12} step={1} display={`${draft.pitch > 0 ? '+' : ''}${draft.pitch} 半音`} onChange={(v) => setDraft({ ...draft, pitch: v })} />
          </div>
          <div className="w-[220px]">
            <Slider label="情绪强度" value={draft.emotion} min={0} max={1} step={0.05} display={draft.emotion.toFixed(2)} onChange={(v) => setDraft({ ...draft, emotion: v })} />
          </div>
        </div>
        <p className="text-[11px] leading-[1.6] text-muted">音色来源逐说话人三选一：本步克隆产物 / 音色库现成音色 / 克隆后勾选存库（跨项目复用）。</p>
      </div>

      <SaveRow>
        <button
          type="button"
          className="btn btn-accent"
          disabled={JSON.stringify(draft) === JSON.stringify(tts)}
          onClick={() => void saveSettings({ tts: draft })}
        >
          <Save size={13} />
          保存配音参数
        </button>
        <DraftState dirty={JSON.stringify(draft) !== JSON.stringify(tts)} />
      </SaveRow>
    </Panel>
  )
}

/* ------------------------------------------------------------- 导出与存储 */

function StorageBlock({
  storage,
  exportCfg,
  system
}: {
  storage: SettingsDto['storage']
  exportCfg: SettingsDto['export']
  system: ReturnType<typeof useAppStore.getState>['system']
}): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [draft, setDraft] = useState(exportCfg)
  useEffect(() => setDraft(exportCfg), [exportCfg])

  return (
    <Panel title={<span className="text-[13px]">导出与存储</span>} bodyScroll={false} bodyClass="p-4">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-4">
          <PathRow
            label="检查点工作区根目录"
            hint="所有中间产物（分镜/音轨/逐句 WAV/3D 片段/日志）按项目分子目录存放，勿放 C 盘"
            value={storage.workspaceRoot}
            onChange={(v) => void saveSettings({ storage: { ...storage, workspaceRoot: v } })}
          />
          <PathRow
            label="导出文件夹（默认桌面）"
            hint="步骤⑥「导出成片」把 MP4 + 双语 SRT 写到此处"
            value={storage.exportDir}
            onChange={(v) => void saveSettings({ storage: { ...storage, exportDir: v } })}
          />
        </div>

        <div className="flex flex-wrap gap-4 border-t border-hairline pt-3">
          <KeyValTone k="C 盘剩余" v={storage.freeBytesC} />
          <KeyValTone k="D 盘剩余" v={storage.freeBytesD} />
          {system && (
            <>
              <span className="mono text-[11px] text-muted">ffmpeg {system.ffmpeg ? system.ffmpeg.split(/[\\/]/).pop() : '未找到'}</span>
              <span className="mono truncate text-[11px] text-muted" title={system.modelsDir}>
                本地模型目录 {system.modelsDir.split(/[\\/]/).pop()}
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4 border-t border-hairline pt-3">
          <Field label="导出分辨率" className="w-[150px]">
            <select value={draft.resolution} onChange={(e) => setDraft({ ...draft, resolution: e.target.value as SettingsDto['export']['resolution'] })}>
              <option value="1080p">1080p（默认）</option>
              <option value="720p">720p（更快）</option>
            </select>
          </Field>
          <Field label="帧率" className="w-[120px]">
            <input
              type="number"
              min={15}
              max={60}
              value={draft.fps}
              onChange={(e) => setDraft({ ...draft, fps: Number(e.target.value) || 30 })}
            />
          </Field>
          <Toggle checked={draft.bilingualSrt} onChange={(v) => setDraft({ ...draft, bilingualSrt: v })} label={<span className="text-[12px]">双语 SRT（中文行 + 英文行）</span>} />
          <span className="min-w-[260px] flex-1 text-[11px] leading-[1.6] text-muted">v1 默认外挂字幕、不烧录（R7）；背景音按原音量直接混入，不做 ducking、不提供开关（R4）。</span>
        </div>
      </div>

      <SaveRow>
        <button
          type="button"
          className="btn btn-accent"
          disabled={JSON.stringify(draft) === JSON.stringify(exportCfg)}
          onClick={() => void saveSettings({ export: draft })}
        >
          <Save size={13} />
          保存导出设置
        </button>
        <DraftState dirty={JSON.stringify(draft) !== JSON.stringify(exportCfg)} />
        <span className="text-[11px] text-muted">两个目录的改动即时生效，不经此按钮保存</span>
      </SaveRow>
    </Panel>
  )
}

/** 目录选择后立刻写回（PathRow 内部自己管草稿） */

function PathRow({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="mono min-w-0 flex-1 text-[11px]" />
        <button
          type="button"
          className="btn px-3"
          onClick={async () => {
            const res = await api.system.pick('directory', { title: label })
            if (res.path) {
              setDraft(res.path)
              onChange(res.path)
            }
          }}
        >
          <FolderOpen size={12} />
          浏览
        </button>
        <button type="button" className="btn btn-ghost px-2" disabled={draft.trim() === value || !draft.trim()} onClick={() => onChange(draft.trim())}>
          <Save size={12} />
        </button>
      </div>
      <span className="text-[11px] text-muted">{hint}</span>
    </div>
  )
}

function KeyValTone({ k, v }: { k: string; v: number | null }): JSX.Element {
  const tone: Tone = v === null ? 'muted' : v < 10 * 2 ** 30 ? 'error' : v < 30 * 2 ** 30 ? 'warn' : 'success'
  return (
    <span className={`mono flex items-center gap-1 text-[11px] ${TONE_TEXT[tone]}`}>
      {k} {bytes(v)}
    </span>
  )
}

/* --------------------------------------------------------------- 本地算力 */

function LocalComputeBlock({ sidecarCfg, localModels }: { sidecarCfg: SettingsDto['sidecar']; localModels: Array<{ key: string; label: string; usage: string; cost: string }> }): JSX.Element {
  const saveSettings = useAppStore((s) => s.saveSettings)
  const refreshSidecar = useAppStore((s) => s.refreshSidecar)
  const sidecar = useAppStore((s) => s.sidecar)
  const toast = useAppStore((s) => s.toast)
  const [busy, setBusy] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Array<{ id: string; which: string; status: string; message: string; error: string | null; logs: string[] }>>([])

  const refreshJobs = async (): Promise<void> => {
    try {
      setJobs((await api.sidecar.modelJobs()).jobs)
    } catch {
      setJobs([])
    }
  }

  useEffect(() => {
    void refreshJobs()
  }, [])

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    try {
      await fn()
      await refreshSidecar()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      void refreshJobs()
    }
  }

  const tone: Tone = sidecar === null ? 'muted' : sidecar.online ? (sidecar.gpu ? 'success' : 'warn') : 'error'

  return (
    <Panel
      title={
        <span className="flex items-center gap-2 text-[13px]">
          <Cpu size={14} /> 本地算力（Python sidecar）
          <Badge tone={tone}>{sidecar?.online ? (sidecar.gpu ? '在线 · GPU' : '在线 · 仅 CPU') : '未启动'}</Badge>
        </span>
      }
      aside={
        <span className="mono text-[10px] text-muted">{sidecar ? `${sidecar.pythonPath} · :${sidecar.port}` : ''}</span>
      }
      bodyScroll={false}
      bodyClass="p-4"
    >
      {/* 左右两栏而不是上下堆叠：把高度压进一屏，卡内不再需要滚动 */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] items-start gap-5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-muted">
            <span>torch {sidecar?.torch ?? '—'}</span>
            <span>设备 {sidecar?.device ?? '—'}</span>
            <span className={sidecar?.models.demucs ? 'text-success' : 'text-warn'}>Demucs {sidecar?.models.demucs ? '已就绪' : '缺失'}</span>
            <span className={sidecar?.models.musetalk ? 'text-success' : 'text-warn'}>MuseTalk {sidecar?.models.musetalk ? '已就绪' : '缺失'}</span>
          </div>

          {sidecar?.mismatch && (
            <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
              <TriangleAlert size={12} className="mt-[2px] shrink-0" /> {sidecar.mismatch}
            </p>
          )}
          {sidecar?.reason && !sidecar.online && <p className="text-[11px] text-error">启动失败原因：{sidecar.reason}</p>}
          {sidecar?.bootstrapNote && <p className="mono whitespace-pre-wrap text-[10px] text-muted">{sidecar.bootstrapNote}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => act('start', () => api.sidecar.start())}>
              <Play size={12} />
              {busy === 'start' ? <Spinner /> : null}
              启动
            </button>
            <button type="button" className="btn" disabled={busy !== null || !sidecar?.online} onClick={() => act('stop', () => api.sidecar.stop())}>
              <Square size={12} />
              停止
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => act('bootstrap', () => api.sidecar.bootstrap())}>
              <Server size={12} />
              {busy === 'bootstrap' ? '环境安装中…' : '一键准备环境（venv + 依赖）'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => act('demucs', () => api.sidecar.downloadModels('demucs'))}>
              <Download size={12} />
              下载 Demucs
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => act('musetalk', () => api.sidecar.downloadModels('musetalk'))}>
              <Download size={12} />
              下载 MuseTalk
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t border-hairline pt-3">
            <Field label="python.exe 路径（留 auto 自动探测）" className="min-w-[240px] flex-1">
              <input
                defaultValue={sidecarCfg.pythonPath}
                spellCheck={false}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v !== sidecarCfg.pythonPath) void saveSettings({ sidecar: { ...sidecarCfg, pythonPath: v || 'auto' } })
                }}
              />
            </Field>
            <Field label="sidecar 端口" className="w-[110px]">
              <input
                type="number"
                defaultValue={sidecarCfg.port}
                onBlur={(e) => {
                  const v = clamp(Math.round(Number(e.target.value) || 0), 0, 65535)
                  if (v !== sidecarCfg.port) void saveSettings({ sidecar: { ...sidecarCfg, port: v } })
                }}
              />
            </Field>
            <Toggle checked={sidecarCfg.autoStart} onChange={(v) => void saveSettings({ sidecar: { ...sidecarCfg, autoStart: v } })} label={<span className="text-[12px]">随应用自动启动</span>} />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <span className="label">本地模型清单</span>
          <ul className="flex flex-col gap-1">
            {localModels.map((m) => (
              <li key={m.key} className="flex items-baseline gap-2 border border-hairline bg-canvas px-2 py-[6px]">
                <span className="shrink-0 text-[12px] text-ink">{m.label}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{m.usage}</span>
                <span className="mono shrink-0 text-[10px] text-success">{m.cost}</span>
              </li>
            ))}
          </ul>

          {jobs.length > 0 && (
            <ul className="flex flex-col gap-1 border-t border-hairline pt-2">
              {jobs.map((j) => (
                <li key={j.id} className="mono flex items-center gap-2 text-[10px] text-muted">
                  <span className="text-body">{j.which}</span>
                  <span>{j.status}</span>
                  <span className="min-w-0 flex-1 truncate">{j.error ?? j.message}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] leading-[1.6] text-muted">
            本地任务串行：同一时刻仅允许 1 个 GPU 任务（§7.7-4）；崩溃后自动重启一次，仍失败则提示手动重启。MuseTalk 固定 192px 档（6GB 显存唯一可行档）。
          </p>
        </div>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ 小组件 */

/**
 * 卡内容最下方独占一行的保存栏：保存按钮不夹在字段中间。
 * flush=true（卡体 p-4）：用负外边距贴齐卡片左右与底部边框；
 * flush=false（卡体 p-0，如路由表）：正常占位即可。
 */
function SaveRow({ children, flush = true }: { children: ReactNode; flush?: boolean }): JSX.Element {
  return (
    <div
      data-save-row
      className={`flex flex-wrap items-center gap-3 border-t border-hairline bg-canvas px-4 py-[10px] ${
        flush ? 'mt-4 -mx-4 -mb-4' : ''
      }`}
    >
      {children}
    </div>
  )
}

/** 保存按钮离字段远了，用一行状态文字提示本组有没有改。 */
function DraftState({ dirty }: { dirty: boolean }): JSX.Element {
  return <span className={`text-[11px] ${dirty ? 'text-warn' : 'text-muted'}`}>{dirty ? '本组有未保存的修改' : '没有改动'}</span>
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="label flex items-center justify-between">
        {label}
        <span className="mono text-[11px] text-ink">{display}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
