/**
 * 步骤② 人声分离·识别（SPEC-001 §3.2）：Demucs 双音轨试听 + ASR 逐句校对 + 说话人确认 + 音色样本质量校验。
 * 样本 <15s 或信噪比差会标黄/标红，可手动补选区间（重切 vocals 片段）。
 */
import { useEffect, useState } from 'react'
import { Cpu, Plus, TriangleAlert } from 'lucide-react'
import type { SpeakerDto } from '@shared/types'
import { WaveCard } from '@renderer/components/WaveCard'
import { AnchorSlider } from '@renderer/components/AnchorSlider'
import { LineCard } from '@renderer/components/LineCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { QualityChip } from '@renderer/components/StatusChip'
import { Badge, EmptyState, KeyVal, Panel, Spinner, Toggle } from '@renderer/components/ui'
import { StepDoc, StepPane, StepParams, artifactPath, byIndex, lookupOf, useOverview, usePending } from '@renderer/pages/pipeline/StepPane'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { msClock } from '@renderer/util/format'

type LineFilter = 'all' | 'empty' | 'unassigned'

export function Step2Separate(): JSX.Element {
  const data = useOverview()
  const running = usePending('run2')
  const run = useWorkspaceStore((s) => s.run)
  const patchLine = useWorkspaceStore((s) => s.patchLine)
  const confirmLine = useWorkspaceStore((s) => s.confirmLine)
  const patchSpeaker = useWorkspaceStore((s) => s.patchSpeaker)
  const resample = useWorkspaceStore((s) => s.resample)

  const [model, setModel] = useState('auto')
  const [reuseSeparation, setReuseSeparation] = useState(false)
  const [filter, setFilter] = useState<LineFilter>('all')

  useEffect(() => {
    const s = useWorkspaceStore.getState()
    if (s.data?.project.stepStates[2] === 'confirmed') setReuseSeparation(true)
  }, [data?.project.stepStates[2]])

  if (!data) return <StepPane preview={<Spinner label="载入音轨" />} aside={<Spinner label="载入音轨" />} />

  const project = data.project
  const totalMs = project.durationMs
  const vocals = artifactPath(data, 'vocals_wav')
  const bgm = artifactPath(data, 'bgm_wav')
  const { speakerLabel, shotIndex } = lookupOf(data)
  const lines = data.lines.slice().sort(byIndex)
  const visible = lines.filter((l) => {
    if (filter === 'empty') return !l.zhText.trim()
    if (filter === 'unassigned') return l.speakerId === null
    return true
  })
  const weak = data.speakers.filter((s) => s.sampleQuality !== 'ok')
  const sidecarWarn = !data.sidecar.online || !data.sidecar.models.demucs

  return (
    <StepPane
      preview={
        <>
          <Panel title={<span className="text-[12px]">双音轨试听</span>} aside={<Badge tone="muted">Demucs · 本地 GPU</Badge>}>
            <div className="flex flex-col gap-2">
              <WaveCard path={vocals} label="人声轨 vocals.wav" note="用于 ASR、音色克隆与配音" />
              <WaveCard path={bgm} label="伴奏轨 bgm.wav" note="原音量直接混入成片（R4）" />
              {!vocals && <p className="text-[11px] text-muted">尚未分离。运行本步骤后会得到两条独立音轨。</p>}
              {bgm && (
                <p className="text-[11px] text-muted">
                  背景音（音乐/音效）单独成轨，配音与人声替换后与伴奏轨原音量混合，不做自动压低，因此译文时长最好与原句接近（步骤③的超支标记）。
                </p>
              )}
            </div>
          </Panel>

          <Panel
            title={<span className="text-[12px]">说话人（{data.speakers.length} 位）</span>}
            aside={weak.length > 0 ? <Badge tone="warn"><TriangleAlert size={10} /> {weak.length} 位样本偏弱</Badge> : null}
          >
            {data.speakers.length === 0 ? (
              <EmptyState text="没有识别到说话人。运行本步骤会做 diarization 并自动登记；若一位都没有，请确认视频里确实有清晰中文对白。" />
            ) : (
              <div className="flex flex-col gap-3">
                {data.speakers.map((speaker) => (
                  <SpeakerRow
                    key={speaker.id}
                    speaker={speaker}
                    totalMs={totalMs}
                    lineCount={lines.filter((l) => l.speakerId === speaker.id).length}
                    busy={running}
                    onLabel={(label) => void patchSpeaker(speaker.id, { label })}
                    onResample={(startMs, endMs) => void resample(speaker.id, startMs, endMs)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title={<span className="text-[12px]">逐句校对（{lines.length} 句）</span>}
            aside={
              <div className="flex items-center gap-1">
                {(['all', 'empty', 'unassigned'] as LineFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`border px-2 py-[2px] text-[11px] ${filter === f ? 'border-accent bg-accent/15 text-accent' : 'border-hairline text-muted hover:text-body'}`}
                  >
                    {f === 'all' ? '全部' : f === 'empty' ? '缺文本' : '未归属'}
                  </button>
                ))}
              </div>
            }
          >
            {lines.length === 0 ? (
              <EmptyState text="还没有转写结果。运行本步骤会先分离人声，再做中文识别 + 说话人分离，产出逐句时间锚点。" />
            ) : visible.length === 0 ? (
              <EmptyState text="当前筛选条件下没有句子。" />
            ) : (
              <div className="flex flex-col gap-3">
                {visible.map((line) => (
                  <LineCard
                    key={line.id}
                    line={line}
                    mode="asr"
                    totalMs={totalMs}
                    busy={running}
                    speakerLabel={speakerLabel(line.speakerId)}
                    shotIndex={shotIndex(line.shotId)}
                    headerExtra={
                      <select
                        value={line.speakerId ?? ''}
                        disabled={running}
                        title="归属说话人（影响步骤④用哪个音色配音）"
                        onChange={(e) => void patchLine(line.id, { speakerId: e.target.value || null })}
                        className="ml-auto rounded-input bg-canvas px-1 py-[2px] text-[11px] text-body"
                      >
                        <option value="">未归属</option>
                        {data.speakers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    }
                    onPatch={(body) => void patchLine(line.id, body)}
                    onCommitAnchors={(startMs, endMs) => void patchLine(line.id, { startMs, endMs })}
                    onConfirm={(confirmed) => void confirmLine(line.id, confirmed)}
                    onJumpToShot={() => setFilter('all')}
                  />
                ))}
              </div>
            )}
          </Panel>
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '源视频音轨' },
              { k: '处理', v: 'Demucs 分离人声/伴奏 → ASR 逐句识别 + 说话人分离' },
              { k: '模型', v: '本地 Demucs（¥0）+ 云端 ASR' },
              { k: '产物', v: 'vocals.wav / bgm.wav / asr.json / 音色样本 wav' },
              { k: '门禁', v: '至少 1 句转写且登记了说话人' }
            ]}
          />

          <StepParams title="运行本步骤">
            <ModelPicker stage="stage2" value={model} onChange={setModel} disabled={running} label="ASR 模型" />
            <Toggle checked={reuseSeparation} onChange={setReuseSeparation} label="复用已有 vocals.wav（跳过 Demucs）" hint="只改识别结果时用，省一轮本地 GPU 时间" />
            {sidecarWarn && (
              <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                <Cpu size={12} className="mt-[2px] shrink-0" />
                <span>
                  {data.sidecar.online ? 'Demucs 模型未就绪：' : '本地算力未启动：'}
                  {data.sidecar.reason ?? '请到设置页「本地算力」启动或准备环境'}
                </span>
              </p>
            )}
            <button type="button" className="btn btn-accent w-full" disabled={running} onClick={() => void run(2, { model: model === 'auto' ? null : model, reuseSeparation })}>
              {running ? <Spinner label="分离与识别中" /> : <><Plus size={13} /> 运行分离·识别</>}
            </button>
            <p className="text-[11px] text-muted">重跑会把步骤③④⑥ 的产物标记为待重跑（改上游比改下游便宜）。</p>
          </StepParams>

          <Panel title={<span className="text-[12px]">识别概况</span>} bodyClass="px-4 py-2">
            <KeyVal k="句子数" v={String(lines.length)} mono />
            <KeyVal k="缺文本" v={String(lines.filter((l) => !l.zhText.trim()).length)} mono />
            <KeyVal k="未归属说话人" v={String(lines.filter((l) => l.speakerId === null).length)} mono />
            <KeyVal k="已确认" v={`${lines.filter((l) => l.confirmStatus === 'confirmed').length} / ${lines.length}`} mono />
            <KeyVal k="锚点总时长" v={`${(lines.reduce((a, l) => a + (l.endMs - l.startMs), 0) / 1000).toFixed(1)}s`} mono />
          </Panel>
        </>
      }
    />
  )
}

function SpeakerRow({
  speaker,
  totalMs,
  lineCount,
  busy,
  onLabel,
  onResample
}: {
  speaker: SpeakerDto
  totalMs: number
  lineCount: number
  busy: boolean
  onLabel: (label: string) => void
  onResample: (startMs: number, endMs: number) => void
}): JSX.Element {
  const [label, setLabel] = useState(speaker.label)
  useEffect(() => setLabel(speaker.label), [speaker.label])

  const start = speaker.sampleStartMs ?? 0
  const end = speaker.sampleEndMs ?? Math.min(totalMs, start + 5000)

  return (
    <div className="flex flex-col gap-2 border border-hairline bg-canvas p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            const v = label.trim()
            if (v && v !== speaker.label) onLabel(v)
          }}
          className="w-[150px] rounded-input bg-canvas px-2 py-[3px] text-[12px] text-ink"
          title="说话人名称"
        />
        <QualityChip level={speaker.sampleQuality} note={speaker.sampleQualityNote} />
        <Badge tone="muted">{lineCount} 句</Badge>
        <span className="mono ml-auto text-[10px] text-muted">
          {speaker.sampleStartMs === null ? '未取样本' : `样本 ${msClock(start, false)} → ${msClock(end, false)}`}
        </span>
      </div>

      <WaveCard path={speaker.sampleWavPath} compact label="音色样本" note={speaker.sampleQuality === 'ok' ? '可直接克隆' : '建议补选更干净的区间'} />

      <AnchorSlider
        startMs={start}
        endMs={end}
        totalMs={totalMs}
        minMs={1000}
        stepMs={100}
        disabled={busy}
        onCommit={(s, e) => onResample(s, e)}
      />
      <p className="text-[11px] text-muted">
        拖动两端从 vocals.wav 里补选 ≥15s、无背景乐的区间（SPEC §3.2）。样本太短会让步骤④ 的音色相似度掉到 80% 以下。
      </p>
    </div>
  )
}
