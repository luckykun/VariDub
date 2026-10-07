/**
 * 步骤① 视频解析（SPEC-001 §3.1）：分镜缩略网格 + 拖动切点手动修正 + 合并/拆分。
 * 产物 shots.json + 分镜缩略图；云端视觉理解失败自动降级本地 PySceneDetect（§5.3）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Play, RotateCcw, Scissors, Trash2, TriangleAlert } from 'lucide-react'
import type { ShotDto } from '@shared/types'
import { fileUrl } from '@renderer/api/client'
import { AnchorSlider } from '@renderer/components/AnchorSlider'
import { ShotCard } from '@renderer/components/ShotCard'
import { ModelPicker } from '@renderer/components/ModelPicker'
import { Badge, EmptyState, KeyVal, Panel, Spinner, Toggle } from '@renderer/components/ui'
import { StepDoc, StepPane, StepParams, useOverview, usePending } from '@renderer/pages/pipeline/StepPane'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { msClock, msShort } from '@renderer/util/format'

export function Step1Analyze(): JSX.Element {
  const data = useOverview()
  const running = usePending('run1')
  const run = useWorkspaceStore((s) => s.run)
  const patchShot = useWorkspaceStore((s) => s.patchShot)
  const splitShot = useWorkspaceStore((s) => s.splitShot)
  const mergeShot = useWorkspaceStore((s) => s.mergeShot)
  const removeShot = useWorkspaceStore((s) => s.removeShot)

  const [model, setModel] = useState('auto')
  const [force, setForce] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const shots = useMemo(() => (data?.shots ?? []).slice().sort((a, b) => a.index - b.index), [data])
  const selected = shots.find((s) => s.id === selectedId) ?? null

  useEffect(() => {
    if (selected && videoRef.current) videoRef.current.currentTime = selected.startMs / 1000
  }, [selected])

  if (!data) return <StepPane preview={<Spinner label="载入分镜" />} aside={<Spinner label="载入分镜" />} />

  const project = data.project
  const tooShort = shots.filter((s) => s.endMs - s.startMs < 200)
  const noDesc = shots.filter((s) => !s.sceneDesc.trim())
  const avg = shots.length > 0 ? shots.reduce((acc, s) => acc + (s.endMs - s.startMs), 0) / shots.length : 0
  const lineCountOf = (shotId: string): number => data.lines.filter((l) => l.shotId === shotId).length
  const alreadyConfirmed = project.stepStates[1] === 'confirmed'

  return (
    <StepPane
      preview={
        <>
          <Panel title={<span className="text-[12px]">源视频</span>} aside={<Badge tone="muted">{shots.length} 个分镜</Badge>} bodyClass="p-3">
            <video ref={videoRef} src={fileUrl(project.sourceVideoPath)} controls className="max-h-[min(56vh,520px)] w-full bg-black" preload="metadata" />
            <div className="mono mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted">
              <span>{msClock(project.durationMs, false)}</span>
              <span>
                {project.width}×{project.height}
              </span>
              <span title={project.sourceVideoPath}>{project.sourceVideoPath}</span>
            </div>
          </Panel>

          <Panel
            title={<span className="text-[12px]">分镜表（可拖动切点、拆分、合并）</span>}
            aside={
              <>
                {tooShort.length > 0 && (
                  <Badge tone="error">
                    <TriangleAlert size={10} /> {tooShort.length} 个不足 0.2s
                  </Badge>
                )}
                {noDesc.length > 0 && <Badge tone="warn">{noDesc.length} 个缺场景描述</Badge>}
              </>
            }
          >
            {shots.length === 0 ? (
              <EmptyState
                icon={<Play size={22} />}
                text="还没有分镜表。右侧点「运行解析」，云端视觉模型会把视频切成一个个分镜并写场景描述；识别失败会自动降级到本地 PySceneDetect 切分。"
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3">
                {shots.map((shot) => (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    variant="step1"
                    active={shot.id === selectedId}
                    busy={running}
                    onSelect={() => setSelectedId(shot.id === selectedId ? null : shot.id)}
                    onSplit={() => {
                      void splitShot(shot.id, Math.round((shot.startMs + shot.endMs) / 2))
                      setSelectedId(null)
                    }}
                    onMerge={() => {
                      void mergeShot(shot.id)
                      setSelectedId(null)
                    }}
                    onRemove={() => {
                      void removeShot(shot.id)
                      setSelectedId(null)
                    }}
                  />
                ))}
              </div>
            )}
          </Panel>

          {selected && (
            <ShotEditor
              key={selected.id}
              shot={selected}
              totalMs={project.durationMs}
              lineCount={lineCountOf(selected.id)}
              busy={running}
              onPatch={(body) => void patchShot(selected.id, body)}
              onSplit={(atMs) => void splitShot(selected.id, atMs)}
              onMerge={() => void mergeShot(selected.id)}
              onRemove={() => {
                void removeShot(selected.id)
                setSelectedId(null)
              }}
            />
          )}
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '导入的综艺片段（原画质）' },
              { k: '处理', v: '云端视觉理解切分镜 + 逐镜场景/人物描述' },
              { k: '兜底', v: '视觉调用失败 → 本地 PySceneDetect（¥0）' },
              { k: '产物', v: 'shots.json + 分镜缩略图' },
              { k: '门禁', v: '分镜表非空，且每镜时长 ≥ 0.2s' }
            ]}
          />

          <StepParams title="运行本步骤">
            <ModelPicker stage="stage1" value={model} onChange={setModel} disabled={running} />
            <Toggle checked={force} onChange={setForce} label="强制重跑（默认沿用已有分镜）" />
            {alreadyConfirmed && (
              <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                <span>本步骤已确认，重跑会把它降为「待确认」并把下游步骤退回重改状态。</span>
              </p>
            )}
            <button type="button" className="btn btn-accent w-full" disabled={running} onClick={() => void run(1, { model: model === 'auto' ? null : model, force })}>
              {running ? <Spinner label="解析中" /> : <><RotateCcw size={13} /> 运行解析</>}
            </button>
            <p className="text-[11px] text-muted">云端并发上限 2；失败自动重试 2 次，仍失败则在日志区给出原因。</p>
          </StepParams>

          <Panel title={<span className="text-[12px]">分镜统计</span>} bodyClass="px-4 py-2">
            <KeyVal k="分镜数" v={String(shots.length)} mono />
            <KeyVal k="平均时长" v={msShort(avg)} mono />
            <KeyVal k="最短分镜" v={shots.length > 0 ? msShort(Math.min(...shots.map((s) => s.endMs - s.startMs))) : '—'} mono />
            <KeyVal k="覆盖时长" v={msShort(shots.reduce((a, s) => a + (s.endMs - s.startMs), 0))} mono />
            <KeyVal k="来源分布" v={sourceSummary(shots)} />
          </Panel>
        </>
      }
    />
  )
}

function sourceSummary(shots: ShotDto[]): string {
  const c = { vl: 0, pyscenedetect: 0, manual: 0 }
  for (const s of shots) c[s.source] += 1
  return `视觉 ${c.vl} / 本地 ${c.pyscenedetect} / 人工 ${c.manual}`
}

/** 选中分镜的编辑区：切点拖拽 + 场景描述 + 人物 + 拆分位置 */
function ShotEditor({
  shot,
  totalMs,
  lineCount,
  busy,
  onPatch,
  onSplit,
  onMerge,
  onRemove
}: {
  shot: ShotDto
  totalMs: number
  lineCount: number
  busy: boolean
  onPatch: (body: { startMs?: number; endMs?: number; sceneDesc?: string; persons?: string[] }) => void
  onSplit: (atMs: number) => void
  onMerge: () => void
  onRemove: () => void
}): JSX.Element {
  const [desc, setDesc] = useState(shot.sceneDesc)
  const [persons, setPersons] = useState(shot.persons.join(', '))
  const [splitPct, setSplitPct] = useState(50)

  useEffect(() => {
    setDesc(shot.sceneDesc)
    setPersons(shot.persons.join(', '))
  }, [shot.sceneDesc, shot.persons])

  const span = shot.endMs - shot.startMs
  const splitAt = Math.round(shot.startMs + (span * splitPct) / 100)

  return (
    <Panel
      title={
        <span className="flex items-center gap-2 text-[12px]">
          分镜 <span className="mono text-accent">#{String(shot.index).padStart(2, '0')}</span> 详情
        </span>
      }
      aside={
        <>
          <Badge tone="muted">{lineCount} 句台词</Badge>
          <Badge tone="muted">{msShort(span)}</Badge>
        </>
      }
      bodyClass="p-3"
    >
      <div className="flex flex-col gap-3">
        <div className={`mono flex flex-wrap items-center gap-2 text-[11px] ${span < 200 ? 'text-error' : 'text-body'}`}>
          <span>
            {msClock(shot.startMs)} → {msClock(shot.endMs)}
          </span>
          {span < 200 && (
            <span className="flex items-center gap-1 text-error">
              <TriangleAlert size={11} /> 时长不足 0.2s，无法确认本步骤
            </span>
          )}
        </div>

        <AnchorSlider
          startMs={shot.startMs}
          endMs={shot.endMs}
          totalMs={totalMs}
          minMs={200}
          stepMs={10}
          disabled={busy}
          onCommit={(startMs, endMs) => onPatch({ startMs, endMs })}
        />

        <div className="flex flex-col gap-1">
          <span className="label">场景描述（用于步骤⑤ 重绘提示词）</span>
          <textarea
            value={desc}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              if (desc.trim() !== shot.sceneDesc) onPatch({ sceneDesc: desc.trim() })
            }}
            className="min-h-[64px] w-full resize-y rounded-input px-2 py-1 text-[12px] leading-[1.5] text-ink"
            placeholder="例：演播厅，两位主持人面对面坐着，背景为蓝色灯带"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="label">画面人物（逗号分隔）</span>
          <input
            value={persons}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => setPersons(e.target.value)}
            onBlur={() => {
              const next = persons
                .split(/[,，]/)
                .map((p) => p.trim())
                .filter(Boolean)
              if (next.join(', ') !== shot.persons.join(', ')) onPatch({ persons: next })
            }}
            className="rounded-input px-2 py-1 text-[12px] text-ink"
            placeholder="主持人A, 嘉宾B"
          />
        </div>

        <div className="flex flex-col gap-1 border-t border-hairline pt-2">
          <div className="flex items-center justify-between">
            <span className="label">拆分位置</span>
            <span className="mono text-[11px] text-body">{msClock(splitAt)}</span>
          </div>
          <input type="range" min={5} max={95} value={splitPct} disabled={busy} onChange={(e) => setSplitPct(Number(e.target.value))} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" disabled={busy || span < 400} onClick={() => onSplit(splitAt)} title="在该时间点把本分镜拆成两个">
              <Scissors size={11} /> 拆分为两个分镜
            </button>
            <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" disabled={busy || shot.index <= 1} onClick={onMerge} title="与上一个分镜合并">
              <Copy size={11} /> 与上一分镜合并
            </button>
            <button type="button" className="btn btn-danger px-2 py-[3px] text-[11px]" disabled={busy} onClick={onRemove}>
              <Trash2 size={11} /> 删除分镜
            </button>
            <span className="mono ml-auto text-[10px] text-muted">{shot.id.slice(0, 8)}</span>
          </div>
        </div>
      </div>
    </Panel>
  )
}
