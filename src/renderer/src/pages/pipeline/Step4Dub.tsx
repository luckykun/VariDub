/**
 * 步骤④ 音色克隆配音（SPEC-001 §3.4）。
 * 音色来源逐说话人三选一：本步自动克隆 / 音色库挑选 / 克隆后存库；逐句试听 + 相似度 <80% 标红重配。
 * 全局语速·音调·情绪 + 批量重生成；门禁「全部句子无红标（或底部手动放行）」。
 */
import { useEffect, useState } from 'react'
import { Download, Mic, TriangleAlert } from 'lucide-react'
import type { SpeakerDto } from '@shared/types'
import { LineCard } from '@renderer/components/LineCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { QualityChip } from '@renderer/components/StatusChip'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { Badge, EmptyState, KeyVal, Panel, Spinner, Toggle } from '@renderer/components/ui'
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
import { useVoicesStore } from '@renderer/stores/voicesStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { msShort } from '@renderer/util/format'

const FILTERS: LineFilterKey[] = ['all', 'red', 'nodub', 'unconfirmed']

export function Step4Dub(): JSX.Element {
  const data = useOverview()
  const running = usePending('run4')
  const run = useWorkspaceStore((s) => s.run)
  const patchLine = useWorkspaceStore((s) => s.patchLine)
  const confirmLine = useWorkspaceStore((s) => s.confirmLine)
  const lineAction = useWorkspaceStore((s) => s.lineAction)
  const patchSpeaker = useWorkspaceStore((s) => s.patchSpeaker)
  const setActiveStep = useWorkspaceStore((s) => s.setActiveStep)

  const voices = useVoicesStore((s) => s.items)
  const refreshVoices = useVoicesStore((s) => s.refresh)
  const createVoice = useVoicesStore((s) => s.create)
  const previewVoice = useVoicesStore((s) => s.preview)
  const voiceBusy = useVoicesStore((s) => s.busy)

  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [model, setModel] = useState('auto')
  const [includeUnconfirmed, setIncludeUnconfirmed] = useState(false)
  const [force, setForce] = useState(false)
  const [filter, setFilter] = useState<LineFilterKey>('all')
  const [pickFor, setPickFor] = useState<string | null>(null)

  useEffect(() => {
    void refreshVoices()
  }, [refreshVoices])

  if (!data) return <StepPane preview={<Spinner label="载入配音" />} aside={<Spinner label="载入配音" />} />

  const totalMs = data.project.durationMs
  const { speakerLabel, shotIndex } = lookupOf(data)
  const lines = data.lines.slice().sort(byIndex)
  const usable = lines.filter((l) => l.enText.trim())
  const red = lines.filter((l) => l.similarity !== null && l.similarity < 80)
  const missing = lines.filter((l) => !l.dubWavPath && l.enText.trim())
  const visible = filterLines(lines, filter)

  return (
    <StepPane
      preview={
        <>
          <Panel
            title={<span className="text-[12px]">说话人音色来源</span>}
            aside={
              <Badge tone={red.length > 0 ? 'error' : 'success'}>
                {red.length > 0 ? (
                  <>
                    <TriangleAlert size={10} /> {red.length} 句红标
                  </>
                ) : (
                  '无红标'
                )}
              </Badge>
            }
          >
            {data.speakers.length === 0 ? (
              <EmptyState text="没有说话人。请先完成步骤②（ASR + 说话人分离）。" />
            ) : (
              <div className="flex flex-col gap-3">
                {data.speakers.map((speaker) => (
                  <VoiceSourceRow
                    key={speaker.id}
                    speaker={speaker}
                    voices={voices}
                    busy={running || voiceBusy}
                    picking={pickFor === speaker.id}
                    lineCount={lines.filter((l) => l.speakerId === speaker.id).length}
                    onPickMode={() => setPickFor(pickFor === speaker.id ? null : speaker.id)}
                    onMap={(voiceId) => {
                      void patchSpeaker(speaker.id, { mappedVoiceId: voiceId })
                      setPickFor(null)
                    }}
                    onSaveToLibrary={async () => {
                      if (!speaker.sampleWavPath) return
                      const created = await createVoice({
                        name: `${data.project.name} · ${speaker.label}`,
                        samplePath: speaker.sampleWavPath,
                        tags: ['克隆自综艺片段', speaker.label],
                        sourceType: 'cloned'
                      })
                      if (created) void patchSpeaker(speaker.id, { mappedVoiceId: created.id })
                    }}
                  />
                ))}
              </div>
            )}
          </Panel>

          {pickFor && (
            <Panel
              title={<span className="text-[12px]">从音色库挑选</span>}
              aside={
                <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" onClick={() => setPickFor(null)}>
                  收起
                </button>
              }
            >
              {voices.length === 0 ? (
                <EmptyState text="音色库为空。可先到「音色库」页克隆，或直接使用本步自动克隆。" />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                  {voices.map((voice) => (
                    <VoiceCard
                      key={voice.id}
                      voice={voice}
                      busy={voiceBusy}
                      selectable
                      selected={data.speakers.find((s) => s.id === pickFor)?.mappedVoiceId === voice.id}
                      onSelect={() => void patchSpeaker(pickFor, { mappedVoiceId: voice.id })}
                      onPreview={() => void previewVoice(voice.id)}
                    />
                  ))}
                </div>
              )}
            </Panel>
          )}

          <Panel
            title={<span className="text-[12px]">逐句试听（{lines.length} 句）</span>}
            aside={
              <div className="flex items-center gap-1">
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
              </div>
            }
          >
            {usable.length === 0 ? (
              <EmptyState text="还没有可用译文。请先到步骤③ 确认英文。" action={<button type="button" className="btn btn-ghost" onClick={() => setActiveStep(3)}>去步骤③</button>} />
            ) : (
              <div className="flex flex-col gap-3">
                {(red.length > 0 || missing.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2 border border-error/40 bg-error/10 px-2 py-1 text-[11px]">
                    <TriangleAlert size={12} className="text-error" />
                    <span className="text-error">{red.length} 句相似度 &lt;80%，{missing.length} 句还没有配音</span>
                    <button
                      type="button"
                      className="btn btn-ghost ml-auto px-2 py-[2px] text-[11px]"
                      disabled={running}
                      onClick={() => void run(4, { model: model === 'auto' ? null : model, includeUnconfirmed, force: false })}
                      title="只补缺失与过期的句子；红标句可逐句「重配此句」"
                    >
                      批量补齐
                    </button>
                  </div>
                )}
                {visible.length === 0 ? (
                  <EmptyState text="当前筛选下没有句子。" />
                ) : (
                  visible.map((line) => (
                    <div key={line.id} id={`line-${line.id}`} className="scroll-mt-4">
                      <LineCard
                        line={line}
                        mode="dub"
                        totalMs={totalMs}
                        busy={running}
                        speakerLabel={speakerLabel(line.speakerId)}
                        shotIndex={shotIndex(line.shotId)}
                        onPatch={(body) => void patchLine(line.id, body)}
                        onCommitAnchors={(startMs, endMs) => void patchLine(line.id, { startMs, endMs })}
                        onConfirm={(c) => void confirmLine(line.id, c)}
                        onRegenerate={() => void lineAction(line.id, 'dub')}
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </Panel>
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '已确认英文 + 说话人音色样本' },
              { k: '处理', v: '音色复刻 TTS 逐句配音 → 与样本比对相似度' },
              { k: '模型', v: 'qwen-audio-3.0-tts-plus（云端）' },
              { k: '产物', v: 'dub/*.wav + dub_manifest.json' },
              { k: '门禁', v: '全部句子有配音且相似度 ≥80%（否则手动放行）' }
            ]}
          />

          <StepParams title="运行本步骤">
            <ModelPicker stage="stage4" value={model} onChange={setModel} disabled={running} />
            <Toggle checked={includeUnconfirmed} onChange={setIncludeUnconfirmed} label="连未确认的句子一起配" hint="默认只配步骤③ 已确认的句子" />
            <Toggle checked={force} onChange={setForce} label="重配全部句子" hint="默认跳过已有且未过期的配音，省额度" />
            <button
              type="button"
              className="btn btn-accent w-full"
              disabled={running || usable.length === 0}
              onClick={() => void run(4, { model: model === 'auto' ? null : model, includeUnconfirmed, force })}
            >
              {running ? <Spinner label="配音中" /> : <><Mic size={13} /> 批量配音</>}
            </button>
          </StepParams>

          {settings && (
            <StepParams title="全局表演参数">
              <Slider label="语速" value={settings.tts.speed} min={0.6} max={1.6} step={0.02} format={(v) => `${v.toFixed(2)}×`} onCommit={(v) => void saveSettings({ tts: { ...settings.tts, speed: v } })} />
              <Slider label="音调" value={settings.tts.pitch} min={-6} max={6} step={1} format={(v) => (v === 0 ? '原调' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`)} onCommit={(v) => void saveSettings({ tts: { ...settings.tts, pitch: v } })} />
              <Slider label="情绪强度" value={settings.tts.emotion} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => void saveSettings({ tts: { ...settings.tts, emotion: v } })} />
              <p className="text-[11px] text-muted">语速会影响超支估算：超支句选「精简译文」时会自动提速到刚好塞进窗口（上限 1.6×）。</p>
            </StepParams>
          )}

          <Panel title={<span className="text-[12px]">配音概况</span>} bodyClass="px-4 py-2">
            <KeyVal k="已配音" v={`${lines.filter((l) => l.dubWavPath).length} / ${lines.length}`} mono />
            <KeyVal k="红标（<80%）" v={String(red.length)} mono />
            <KeyVal k="平均相似度" v={avgSimilarity(lines.map((l) => l.similarity))} mono />
            <KeyVal k="实际时长偏差" v={avgDeviation(lines)} mono />
            <KeyVal k="音色库" v={`${voices.length} 个音色`} />
          </Panel>
        </>
      }
    />
  )
}

/** 说话人 → 音色来源三选一（§3.4） */
function VoiceSourceRow({
  speaker,
  voices,
  busy,
  picking,
  lineCount,
  onPickMode,
  onMap,
  onSaveToLibrary
}: {
  speaker: SpeakerDto
  voices: { id: string; name: string; sourceType: 'preset' | 'cloned' }[]
  busy: boolean
  picking: boolean
  lineCount: number
  onPickMode: () => void
  onMap: (voiceId: string | null) => void
  onSaveToLibrary: () => Promise<void>
}): JSX.Element {
  const mapped = speaker.mappedVoiceId ? voices.find((v) => v.id === speaker.mappedVoiceId) ?? null : null
  const mode = mapped ? (mapped.sourceType === 'preset' ? '预置音色库' : '音色库（已克隆）') : '本步自动克隆'

  return (
    <div className="flex flex-col gap-2 border border-hairline bg-canvas p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-[24px] items-center justify-center border border-hairline bg-canvas text-accent">
          <Mic size={13} />
        </span>
        <span className="text-[13px] text-ink">{speaker.label}</span>
        <Badge tone="muted">{lineCount} 句</Badge>
        <QualityChip level={speaker.sampleQuality} note={speaker.sampleQualityNote} />
        <span className="mono ml-auto text-[11px] text-body">来源：{mode}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onMap(null)}
          className={`border px-2 py-[2px] text-[11px] ${!mapped ? 'border-accent bg-accent/15 text-accent' : 'border-hairline text-muted hover:text-body'}`}
          title="用该说话人的音色样本到云端复刻（每次运行本步骤自动注册）"
        >
          本步自动克隆
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onPickMode}
          className={`border px-2 py-[2px] text-[11px] ${mapped ? 'border-accent bg-accent/15 text-accent' : 'border-hairline text-muted hover:text-body'}`}
          title="从音色库挑选（含预置音色与既往克隆结果）"
        >
          {mapped ? `音色库：${mapped.name}` : '从音色库挑选'}
        </button>
        <button
          type="button"
          disabled={busy || !speaker.sampleWavPath}
          onClick={() => void onSaveToLibrary()}
          className="btn btn-ghost px-2 py-[2px] text-[11px]"
          title={speaker.sampleWavPath ? '把当前音色样本存为新的音色并选中' : '该说话人还没有样本文件'}
        >
          <Download size={11} /> 存库并选用
        </button>
        {mapped && (
          <button type="button" disabled={busy} className="text-[11px] text-muted hover:text-ink" onClick={() => onMap(null)}>
            取消映射
          </button>
        )}
        <span className="mono ml-auto text-[10px] text-muted">{speaker.sampleWavPath ? speaker.sampleWavPath.split(/[\\/]/).pop() : '无样本'}</span>
      </div>

      {picking && (
        <p className="text-[11px] text-muted">在下方音色网格里点选即可套用；预置音色不需要云端注册，直接按名字合成。</p>
      )}
    </div>
  )
}

function avgSimilarity(list: (number | null)[]): string {
  const nums = list.filter((v): v is number => v !== null)
  return nums.length === 0 ? '—' : `${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)}%`
}

function avgDeviation(lines: { dubDurationMs: number | null; startMs: number; endMs: number }[]): string {
  const diffs = lines.filter((l) => l.dubDurationMs !== null).map((l) => (l.dubDurationMs as number) - (l.endMs - l.startMs))
  if (diffs.length === 0) return '—'
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length
  return `${avg > 0 ? '+' : avg < 0 ? '−' : '±'}${msShort(Math.abs(avg))}`
}

/** 滑杆：拖动过程中只改本地值，松手才写设置（避免每像素一次 PATCH） */
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onCommit: (v: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <label className="flex flex-col gap-1">
      <span className="label flex items-center justify-between">
        {label}
        <span className="mono text-[11px] text-ink">{format(draft)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          if (draft !== value) onCommit(draft)
        }}
        onKeyUp={() => {
          if (draft !== value) onCommit(draft)
        }}
      />
    </label>
  )
}
