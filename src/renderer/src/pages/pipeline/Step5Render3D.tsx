/**
 * 步骤⑤ 3D 画面重绘（SPEC-001 §3.5，两段式门禁 P2）。
 * 阶段①：选 1 个代表性分镜试跑关键帧（几分钱）→ 原帧 vs 3D 帧对比 → 人工锁定风格。
 * 阶段②：全量重绘（关键帧 + 图生视频），云端并发 ≤2，分镜级接受/拒绝/重跑。
 */
import { useMemo, useState } from 'react'
import { Check, Cloud, Images, Layers, TriangleAlert, Wand2 } from 'lucide-react'
import { STYLE_PRESETS } from '@shared/models'
import { fileUrl } from '@renderer/api/client'
import { ShotCard } from '@renderer/components/ShotCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { Badge, EmptyState, KeyVal, Meter, Panel, Spinner, Toggle, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { StepDoc, StepPane, StepParams, byIndex, useOverview, usePending } from '@renderer/pages/pipeline/StepPane'
import { useAppStore } from '@renderer/stores/appStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { msClock, pct } from '@renderer/util/format'

export function Step5Render3D(): JSX.Element {
  const data = useOverview()
  const running = usePending('run5')
  const pilotBusy = usePending('pilot')
  const acceptBusy = usePending('accept')
  const run = useWorkspaceStore((s) => s.run)
  const pilot = useWorkspaceStore((s) => s.pilot)
  const acceptShots = useWorkspaceStore((s) => s.acceptShots)
  const rerunShots = useWorkspaceStore((s) => s.rerunShots)
  const rerunLow = useWorkspaceStore((s) => s.rerunLow)
  const patchShot = useWorkspaceStore((s) => s.patchShot)

  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [styleId, setStyleId] = useState<string | null>(null)
  const [consistency, setConsistency] = useState<number | null>(null)
  const [keyframeModel, setKeyframeModel] = useState<string | null>(null)
  const [motionModel, setMotionModel] = useState<string | null>(null)
  const [concurrency, setConcurrency] = useState<number | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [resetClips, setResetClips] = useState(false)
  const [pilotShotId, setPilotShotId] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  const shots = useMemo(() => (data?.shots ?? []).slice().sort(byIndex), [data])

  if (!data) return <StepPane preview={<Spinner label="载入分镜" />} aside={<Spinner label="载入分镜" />} />

  const effStyle = styleId ?? settings?.style.preset ?? 'pixar'
  const effConsistency = consistency ?? settings?.style.faceConsistency ?? 0.82
  const effKeyframe = keyframeModel ?? 'wan2.7-image-pro'
  const effMotion = motionModel ?? 'happyhorse-1.1-i2v'
  const effConcurrency = concurrency ?? settings?.style.renderConcurrency ?? 2

  const longest = shots.slice().sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))[0]
  const pilotTarget = shots.find((s) => s.id === pilotShotId) ?? shots.find((s) => s.isPilot) ?? longest ?? null
  const accepted = shots.filter((s) => s.acceptStatus === 'accepted')
  const rendering = shots.filter((s) => s.acceptStatus === 'rendering')
  const queued = shots.filter((s) => s.acceptStatus === 'queued')
  const failed = shots.filter((s) => s.acceptStatus === 'failed')
  const lowConsistency = shots.filter((s) => s.consistencyScore !== null && s.consistencyScore < 0.75)
  const withKeyframe = shots.filter((s) => s.frame3dPath)
  const styleLocked = withKeyframe.length > 0

  return (
    <StepPane
      preview={
        <>
          <Panel
            title={<span className="text-[12px]">阶段① 关键帧试跑（先花几分钱确认风格）</span>}
            aside={<Badge tone={styleLocked ? 'success' : 'warn'}>{styleLocked ? '已有试跑结果' : '待试跑'}</Badge>}
          >
            {shots.length === 0 ? (
              <EmptyState text="没有分镜，无法试跑。请先完成步骤①。" />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="label">代表性分镜</span>
                  <select
                    value={pilotTarget?.id ?? ''}
                    disabled={pilotBusy || running}
                    onChange={(e) => setPilotShotId(e.target.value)}
                    className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink"
                  >
                    {shots.map((s) => (
                      <option key={s.id} value={s.id}>
                        #{String(s.index).padStart(2, '0')} · {msClock(s.startMs, false)}→{msClock(s.endMs, false)} · {s.sceneDesc.slice(0, 18) || '（无描述）'}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-accent px-3 py-[5px] text-[12px]"
                    disabled={pilotBusy || running || !pilotTarget}
                    onClick={() => {
                      if (!pilotTarget) return
                      void pilot({ shotId: pilotTarget.id, styleId: effStyle, consistency: effConsistency, keyframeModel: effKeyframe })
                    }}
                  >
                    {pilotBusy ? <Spinner label="重绘关键帧" /> : <><Wand2 size={13} /> 试跑 1 张关键帧</>}
                  </button>
                </div>

                {pilotTarget && (
                  <div className="grid grid-cols-2 gap-3">
                    <FrameBox label="原帧" path={pilotTarget.thumbPath} note={`#${String(pilotTarget.index).padStart(2, '0')} · ${msClock(pilotTarget.startMs, false)}`} />
                    <FrameBox
                      label="3D 关键帧"
                      path={pilotTarget.frame3dPath}
                      note={pilotTarget.consistencyScore === null ? '待评分' : `人脸一致性 ${pct(pilotTarget.consistencyScore, 1)}`}
                      tone={consistencyTone(pilotTarget.consistencyScore)}
                    />
                  </div>
                )}

                {pilotTarget?.sceneDesc && (
                  <p className="text-[11px] text-muted">
                    重绘提示词由「场景描述 + 人物 + 风格」拼成；不满意可直接改描述再试跑：
                    <span className="ml-1 text-body">{pilotTarget.sceneDesc}</span>
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel
            title={<span className="text-[12px]">阶段② 全量重绘（关键帧 + 图生视频）</span>}
            aside={
              <>
                <Badge tone="muted">
                  已接受 {accepted.length} / {shots.length}
                </Badge>
                {rendering.length > 0 && <Badge tone="accent">渲染中 {rendering.length}</Badge>}
                {queued.length > 0 && <Badge tone="muted">排队 {queued.length}</Badge>}
                {failed.length > 0 && <Badge tone="error">失败 {failed.length}</Badge>}
              </>
            }
          >
            <div className="flex flex-col gap-3">
              {!styleLocked && (
                <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                  <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                  <span>还没有关键帧。建议先做阶段① 试跑并确认风格，再全量重绘，避免整片按错的风格重复计费。</span>
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-accent px-3 py-[5px] text-[12px]"
                  disabled={running || pilotBusy || shots.length === 0}
                  onClick={() => {
                    void run(5, {
                      styleId: effStyle,
                      consistency: effConsistency,
                      keyframeModel: effKeyframe,
                      motionModel: effMotion,
                      concurrency: effConcurrency,
                      onlyMissing,
                      resetClips
                    })
                    void saveSettings({
                      style: { preset: effStyle as 'pixar' | 'anime' | 'claymation', faceConsistency: effConsistency, renderConcurrency: effConcurrency }
                    })
                  }}
                >
                  {running ? <Spinner label="重绘中" /> : <><Layers size={13} /> 锁定风格并全量重绘</>}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost px-3 py-[5px] text-[12px]"
                  disabled={running || acceptBusy}
                  onClick={() => void acceptShots()}
                  title="把所有已有 3D 片段的分镜一次性接受"
                >
                  {acceptBusy ? <Spinner label="提交中" /> : <><Check size={13} /> 接受全部可接受的分镜</>}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost px-3 py-[5px] text-[12px]"
                  disabled={running || lowConsistency.length === 0}
                  onClick={() => void rerunLow(0.75)}
                >
                  重跑低一致性分镜（{lowConsistency.length}）
                </button>
                <button
                  type="button"
                  className="btn btn-ghost px-3 py-[5px] text-[12px]"
                  disabled={running || picked.length === 0}
                  onClick={() => {
                    void rerunShots(picked)
                    setPicked([])
                  }}
                >
                  重跑选中（{picked.length}）
                </button>
              </div>

              {shots.length === 0 ? (
                <EmptyState text="没有分镜。" />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3">
                  {shots.map((shot) => {
                    const selected = picked.includes(shot.id)
                    return (
                      <ShotCard
                        key={shot.id}
                        shot={shot}
                        variant="step5"
                        busy={running}
                        selected={selected}
                        onSelect={() => setPicked(selected ? picked.filter((id) => id !== shot.id) : [...picked, shot.id])}
                        onAccept={() => void acceptShots([shot.id])}
                        onReject={() => void patchShot(shot.id, { acceptStatus: 'rejected' })}
                        onRegenerate={() => void rerunShots([shot.id])}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </Panel>
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '分镜关键帧 + 场景/人物描述 + 风格' },
              { k: '阶段①', v: '1 镜 → wan2.7-image-pro（几分钱）人工确认' },
              { k: '阶段②', v: '逐镜关键帧 + happyhorse-1.1-i2v 图生视频' },
              { k: '产物', v: 'keyframe/*.png + clips3d/*.mp4 + render_manifest.json' },
              { k: '门禁', v: '全部分镜「已接受」' }
            ]}
          />

          <StepParams title="风格与模型">
            <label className="flex flex-col gap-1">
              <span className="label">3D 风格</span>
              <select value={effStyle} disabled={running} onChange={(e) => setStyleId(e.target.value)} className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink">
                {STYLE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted">{STYLE_PRESETS.find((p) => p.id === effStyle)?.desc}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="label flex items-center justify-between">
                人脸一致性强度
                <span className="mono text-[11px] text-ink">{effConsistency.toFixed(2)}</span>
              </span>
              <input type="range" min={0.5} max={1} step={0.01} value={effConsistency} disabled={running} onChange={(e) => setConsistency(Number(e.target.value))} />
              <span className="text-[11px] text-muted">默认 0.82。越高越像原人，但风格化越弱；低于 0.75 会被标为低一致性。</span>
            </label>

            <ModelPicker stage="stage5_keyframe" value={effKeyframe} onChange={setKeyframeModel} label="关键帧模型" disabled={running} />
            <ModelPicker stage="stage5_motion" value={effMotion} onChange={setMotionModel} label="动态化模型" disabled={running} />

            <label className="flex flex-col gap-1">
              <span className="label flex items-center justify-between">
                并发
                <span className="mono text-[11px] text-ink">{effConcurrency}</span>
              </span>
              <input type="range" min={1} max={2} step={1} value={effConcurrency} disabled={running} onChange={(e) => setConcurrency(Number(e.target.value))} />
              <span className="text-[11px] text-muted">
                云端并发上限 2；当前 {data.cloud.active} / {data.cloud.limit}
              </span>
            </label>

            <Toggle checked={onlyMissing} onChange={setOnlyMissing} label="只补跑缺产物的分镜" hint="关掉即全量重绘（会重复计费，慎用）" />
            <Toggle checked={resetClips} onChange={setResetClips} label="清掉已有 3D 产物重来" hint="换风格时用，避免新旧风格混在一起" />
          </StepParams>

          <Panel
            title={<span className="text-[12px]">渲染概况</span>}
            aside={
              <Badge tone={data.gpu.busy ? 'accent' : 'muted'}>
                <Cloud size={10} /> {data.gpu.busy ? data.gpu.label ?? 'GPU 占用中' : 'GPU 空闲'}
              </Badge>
            }
            bodyClass="px-4 py-2"
          >
            <KeyVal k="分镜总数" v={String(shots.length)} mono />
            <KeyVal k="已接受" v={String(accepted.length)} mono />
            <KeyVal k="待处理" v={String(shots.filter((s) => s.acceptStatus === 'pending').length)} mono />
            <KeyVal k="失败" v={String(failed.length)} mono />
            <KeyVal k="低一致性(<0.75)" v={String(lowConsistency.length)} mono />
            <KeyVal k="平均一致性" v={avgConsistency(shots.map((s) => s.consistencyScore))} mono />
          </Panel>

          <Panel title={<span className="text-[12px]">逐个分镜一致性</span>} bodyClass="p-3">
            {withKeyframe.length === 0 ? (
              <p className="text-[11px] text-muted">尚无关键帧。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {withKeyframe
                  .slice()
                  .sort((a, b) => (a.consistencyScore ?? 1) - (b.consistencyScore ?? 1))
                  .slice(0, 10)
                  .map((s) => {
                    const tone = consistencyTone(s.consistencyScore)
                    return (
                      <div key={s.id} className="flex flex-col gap-1">
                        <div className="mono flex items-center justify-between text-[10px]">
                          <span className="text-muted">#{String(s.index).padStart(2, '0')}</span>
                          <span className={TONE_TEXT[tone]}>{pct(s.consistencyScore, 1)}</span>
                        </div>
                        <Meter value={s.consistencyScore ?? 0} tone={tone} />
                      </div>
                    )
                  })}
                <p className="text-[11px] text-muted">只列最差 10 个；红条建议「重跑低一致性分镜」。</p>
              </div>
            )}
          </Panel>
        </>
      }
    />
  )
}

function consistencyTone(score: number | null): Tone {
  if (score === null) return 'muted'
  if (score >= 0.85) return 'success'
  if (score >= 0.7) return 'warn'
  return 'error'
}

function avgConsistency(list: (number | null)[]): string {
  const nums = list.filter((v): v is number => v !== null)
  return nums.length === 0 ? '—' : pct(nums.reduce((a, b) => a + b, 0) / nums.length, 1)
}

function FrameBox({ label, path, note, tone = 'muted' }: { label: string; path: string | null; note?: string; tone?: Tone }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span className={`mono text-[10px] ${TONE_TEXT[tone]}`}>{note}</span>
      </div>
      <div className="aspect-video w-full border border-hairline bg-canvas">
        {path ? (
          <img src={fileUrl(path)} alt={label} className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-[11px] text-muted">
            <Images size={18} />
            尚无产物
          </div>
        )}
      </div>
    </div>
  )
}
