/**
 * 步骤③ 中→英翻译（SPEC-001 §3.3，人工校对最重的一步）。
 * 逐句编辑英文 + 点选 AI 备选×3 + 俚语标黄 + 超支标红（全局策略 / 逐句二选一）+ 句级锚点拖拽。
 * 门禁：全部句子确认，「改这里比改后面便宜」。
 */
import { useState } from 'react'
import { Check, Settings2, TriangleAlert } from 'lucide-react'
import type { LineDto, OverflowPolicy } from '@shared/types'
import { Badge, EmptyState, KeyVal, Panel, Spinner, Toggle } from '@renderer/components/ui'
import { LineCard } from '@renderer/components/LineCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import {
  FILTER_LABELS,
  StepDoc,
  StepPane,
  StepParams,
  byIndex,
  filterLines,
  lookupOf,
  useOverview,
  usePending,
  type LineFilterKey
} from '@renderer/pages/pipeline/StepPane'
import { useAppStore } from '@renderer/stores/appStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

const POLICY_LABEL: Record<OverflowPolicy, string> = { none: '不处理', compress: '精简译文（推荐）', freeze: '允许画面停顿' }
const FILTERS: LineFilterKey[] = ['all', 'unconfirmed', 'overflow', 'slang']

export function Step3Translate(): JSX.Element {
  const data = useOverview()
  const running = usePending('run3')
  const confirmAllBusy = usePending('confirmAll')
  const run = useWorkspaceStore((s) => s.run)
  const patchLine = useWorkspaceStore((s) => s.patchLine)
  const confirmLine = useWorkspaceStore((s) => s.confirmLine)
  const confirmAllLines = useWorkspaceStore((s) => s.confirmAllLines)
  const lineAction = useWorkspaceStore((s) => s.lineAction)
  const setActiveStep = useWorkspaceStore((s) => s.setActiveStep)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [model, setModel] = useState('auto')
  const [batchSize, setBatchSize] = useState(10)
  const [force, setForce] = useState(false)
  const [filter, setFilter] = useState<LineFilterKey>('all')

  if (!data) return <StepPane preview={<Spinner label="载入译文" />} aside={<Spinner label="载入译文" />} />

  const totalMs = data.project.durationMs
  const { speakerLabel, shotIndex } = lookupOf(data)
  const lines = data.lines.slice().sort(byIndex)
  const visible = filterLines(lines, filter)
  const confirmed = lines.filter((l) => l.confirmStatus === 'confirmed')
  const overflowing = lines.filter((l) => l.overflowMs > 0)
  const pendingPolicy = overflowing.filter((l) => l.overflowPolicy === 'none')
  const globalPolicy = settings?.translate.globalOverflowPolicy ?? 'compress'
  const locked = lines.length === 0

  return (
    <StepPane
      preview={
        <>
          <Panel
            title={<span className="text-[12px]">逐句校对（人工区）</span>}
            aside={
              <>
                <Badge tone={confirmed.length === lines.length && lines.length > 0 ? 'success' : 'warn'}>
                  全部 {confirmed.length} / {lines.length} 句已确认
                </Badge>
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-[3px] text-[11px]"
                  disabled={running || confirmAllBusy || locked}
                  onClick={() => void confirmAllLines()}
                  title="把当前所有句子标记为已确认（仍需每句有英文）"
                >
                  {confirmAllBusy ? <Spinner label="提交中" /> : <><Check size={11} /> 全部确认</>}
                </button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`border px-2 py-[2px] text-[11px] ${filter === f ? 'border-accent bg-accent/15 text-accent' : 'border-hairline text-muted hover:text-body'}`}
                  >
                    {FILTER_LABELS[f]}
                  </button>
                ))}
                <span className="mono ml-auto text-[11px] text-muted">{visible.length} 句显示中</span>
              </div>

              {overflowing.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border border-error/40 bg-error/10 px-2 py-1 text-[11px]">
                  <TriangleAlert size={12} className="text-error" />
                  <span className="text-error">{overflowing.length} 句译文超支</span>
                  <span className="text-muted">
                    全局策略：<Badge tone="muted">{POLICY_LABEL[globalPolicy]}</Badge>
                  </span>
                  {pendingPolicy.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-ghost ml-auto px-2 py-[2px] text-[11px]"
                      disabled={running}
                      onClick={() => {
                        for (const l of pendingPolicy) void patchLine(l.id, { overflowPolicy: globalPolicy })
                      }}
                    >
                      把全局策略应用到 {pendingPolicy.length} 句未处理
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-[2px] text-[11px]"
                    title="在「精简译文」与「允许画面停顿」之间切换全局默认"
                    onClick={() => {
                      const t = settings?.translate
                      if (!t) return
                      void saveSettings({ translate: { ...t, globalOverflowPolicy: t.globalOverflowPolicy === 'freeze' ? 'compress' : 'freeze' } })
                    }}
                  >
                    <Settings2 size={11} /> 切换全局策略
                  </button>
                </div>
              )}

              {lines.length === 0 ? (
                <EmptyState text="没有可翻译的句子。请先在步骤② 产出转写文本并确认。" />
              ) : visible.length === 0 ? (
                <EmptyState text="当前筛选下没有句子，切回「全部」看看。" />
              ) : (
                visible.map((line) => (
                  <div key={line.id} id={`line-${line.id}`} className="scroll-mt-4">
                    <LineCard
                      line={line}
                      mode="translate"
                      totalMs={totalMs}
                      busy={running}
                      speakerLabel={speakerLabel(line.speakerId)}
                      shotIndex={shotIndex(line.shotId)}
                      onPatch={(body) => void patchLine(line.id, body)}
                      onCommitAnchors={(startMs, endMs) => void patchLine(line.id, { startMs, endMs })}
                      onConfirm={(c) => void confirmLine(line.id, c)}
                      onRegenerate={() => void lineAction(line.id, 'translate')}
                      onAltBatch={() => void lineAction(line.id, 'alts')}
                      onJumpToShot={() => setActiveStep(1)}
                    />
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel title={<span className="text-[12px]">锚点总览</span>} bodyClass="p-3">
            <AnchorOverview
              lines={lines}
              totalMs={totalMs}
              onPick={(id) => {
                setFilter('all')
                document.getElementById(`line-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }}
            />
          </Panel>
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '步骤② 的逐句中文与时间锚点' },
              { k: '处理', v: '批量翻译 + 每句 3 条备选 + 俚语/梗 存疑标记 + 时长超支估算' },
              { k: '模型', v: '③ 翻译（auto 走时段路由，夜间 4 折）' },
              { k: '产物', v: 'translation.json' },
              { k: '门禁', v: '全部句子已确认且英文非空' }
            ]}
          />

          <StepParams title="运行本步骤">
            <ModelPicker stage="stage3" value={model} onChange={setModel} disabled={running} />
            <label className="flex flex-col gap-1">
              <span className="label">每批句子数</span>
              <input
                type="number"
                min={1}
                max={40}
                value={batchSize}
                disabled={running}
                onChange={(e) => setBatchSize(Math.max(1, Math.min(40, Number(e.target.value) || 1)))}
                className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink"
              />
              <span className="text-[11px] text-muted">批次越小越稳，但请求数与费用更高（默认 10）。</span>
            </label>
            <Toggle checked={force} onChange={setForce} label="重译全部句子" hint="默认只补空缺与未确认的；开启后已有译文中英对照会被替换，且全部句子回到未确认" />
            <button
              type="button"
              className="btn btn-accent w-full"
              disabled={running || locked}
              onClick={() => void run(3, { model: model === 'auto' ? null : model, batchSize, force })}
            >
              {running ? <Spinner label="翻译中" /> : <>运行翻译</>}
            </button>
            {locked && <p className="text-[11px] text-warn">步骤② 还没有转写结果。</p>}
          </StepParams>

          <Panel title={<span className="text-[12px]">翻译风格与统计</span>} bodyClass="px-4 py-2">
            <KeyVal k="风格指令" v={<span title={settings?.translate.styleInstruction ?? ''}>{trunc(settings?.translate.styleInstruction ?? '（未设置）', 28)}</span>} />
            <KeyVal k="备选条数" v={String(settings?.translate.altsCount ?? 3)} mono />
            <KeyVal k="全局超支策略" v={POLICY_LABEL[globalPolicy]} />
            <KeyVal k="语速（影响超支估算）" v={`${(settings?.tts.speed ?? 1).toFixed(2)}×`} mono />
            <KeyVal k="超支句" v={`${overflowing.length} / ${lines.length}`} mono />
            <KeyVal k="俚语存疑" v={String(lines.filter((l) => l.slangFlag).length)} mono />
            <KeyVal k="策略分布" v={policySummary(lines.map((l) => l.overflowPolicy))} />
          </Panel>
        </>
      }
    />
  )
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
function policySummary(list: OverflowPolicy[]): string {
  const c = { none: 0, compress: 0, freeze: 0 }
  for (const p of list) c[p] += 1
  return `精简 ${c.compress} / 停顿 ${c.freeze} / 未处理 ${c.none}`
}

/** 全片时间轴上的句子密度 + 超支红点（§3.3：一眼看出哪句要改） */
function AnchorOverview({ lines, totalMs, onPick }: { lines: LineDto[]; totalMs: number; onPick: (id: string) => void }): JSX.Element {
  if (lines.length === 0) return <p className="text-[11px] text-muted">尚无句子。</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-[34px] w-full border border-hairline bg-canvas">
        {lines.map((l) => {
          const left = totalMs > 0 ? (l.startMs / totalMs) * 100 : 0
          const width = totalMs > 0 ? Math.max(0.4, ((l.endMs - l.startMs) / totalMs) * 100) : 1
          const tone = l.overflowMs > 0 ? 'bg-error/70' : l.confirmStatus === 'confirmed' ? 'bg-success/70' : 'bg-warn/70'
          return (
            <button
              key={l.id}
              type="button"
              title={`#${String(l.index).padStart(2, '0')} 超支 ${l.overflowMs}ms · ${l.confirmStatus === 'confirmed' ? '已确认' : '待确认'}`}
              onClick={() => onPick(l.id)}
              className={`absolute bottom-0 top-0 ${tone} hover:opacity-80`}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          )
        })}
      </div>
      <div className="mono flex justify-between text-[10px] text-muted">
        <span>00:00</span>
        <span>绿=已确认 黄=待确认 红=超支</span>
        <span>{Math.round(totalMs / 1000)}s</span>
      </div>
    </div>
  )
}
