/**
 * 项目工作区外壳（SPEC-001 §4 屏 02A-02F）：项目头 + 大号步骤条 + 步骤工作区 + 底部导航。
 * 六步页面只负责自己的预览区与参数栏，通用骨架与门禁展示集中在此。
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FolderOpen, Pencil, TriangleAlert } from 'lucide-react'
import type { StepId } from '@shared/types'
import { STEP_LABELS } from '@shared/types'
import { api } from '@renderer/api/client'
import { Badge, Spinner } from '@renderer/components/ui'
import { StepFooter } from '@renderer/components/StepFooter'
import { Stepper, type StepView } from '@renderer/components/Stepper'
import { useAppStore } from '@renderer/stores/appStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { Step1Analyze } from '@renderer/pages/pipeline/Step1Analyze'
import { Step2Separate } from '@renderer/pages/pipeline/Step2Separate'
import { Step3Translate } from '@renderer/pages/pipeline/Step3Translate'
import { Step4Dub } from '@renderer/pages/pipeline/Step4Dub'
import { Step5Render3D } from '@renderer/pages/pipeline/Step5Render3D'
import { Step6Export } from '@renderer/pages/pipeline/Step6Export'
import { fileName, msClock } from '@renderer/util/format'

export function ProjectWorkspace({ projectId, initialStep }: { projectId: string; initialStep?: StepId }): JSX.Element {
  const data = useWorkspaceStore((s) => s.data)
  const loading = useWorkspaceStore((s) => s.loading)
  const error = useWorkspaceStore((s) => s.error)
  const activeStep = useWorkspaceStore((s) => s.activeStep)
  const open = useWorkspaceStore((s) => s.open)
  const close = useWorkspaceStore((s) => s.close)
  const refresh = useWorkspaceStore((s) => s.refresh)
  const setActiveStep = useWorkspaceStore((s) => s.setActiveStep)
  const confirmStep = useWorkspaceStore((s) => s.confirmStep)
  const navigate = useAppStore((s) => s.navigate)
  const confirmBusy = useWorkspaceStore((s) => s.pending[`confirm${activeStep}`] === true)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  useEffect(() => {
    void open(projectId, initialStep)
    return () => close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, initialStep])

  const steps: StepView[] = useMemo(
    () =>
      (data?.steps ?? []).map((hint) => ({
        step: hint.step,
        state: hint.state,
        locked: hint.locked,
        hint: hint.locked ? (hint.reason ?? '上一步未确认') : hint.hint
      })),
    [data]
  )

  const running = data?.jobs.some((j) => j.step === activeStep && (j.state === 'running' || j.state === 'queued')) ?? false
  const issues = data?.gate[activeStep] ?? []

  if (loading && !data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="打开项目工作区" />
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="flex items-center gap-2 text-[13px] text-error">
          <TriangleAlert size={15} /> {error}
        </p>
        <button type="button" className="btn" onClick={() => void refresh(false)}>
          重试
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate({ view: 'projects' })}>
          返回项目列表
        </button>
      </div>
    )
  }
  if (!data) return <div className="flex-1" />

  const project = data.project
  const view = steps.find((s) => s.step === activeStep)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 项目头 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline bg-canvas px-6 py-3">
        <button type="button" className="btn btn-ghost px-2 py-[5px] text-[12px]" onClick={() => navigate({ view: 'projects' })}>
          <ArrowLeft size={13} />
          项目列表
        </button>

        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false)
              const v = nameDraft.trim()
              if (v && v !== project.name) void api.projects.rename(project.id, v).then(() => void refresh(false))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-[220px] max-w-[380px] rounded-input px-2 py-1 text-[15px] text-ink"
          />
        ) : (
          <button
            type="button"
            className="group flex items-center gap-2"
            title="重命名项目"
            onClick={() => {
              setNameDraft(project.name)
              setRenaming(true)
            }}
          >
            <span className="font-display truncate text-[15px] text-ink">{project.name}</span>
            <Pencil size={12} className="text-muted group-hover:text-body" />
          </button>
        )}

        <Badge tone={view?.state === 'confirmed' ? 'success' : 'accent'}>{STEP_LABELS[activeStep]}</Badge>
        <span className="mono text-[11px] text-muted">
          {msClock(project.durationMs, false)} · {project.width}×{project.height} · {project.stats.shotCount} 分镜 / {project.stats.lineCount} 句 /{' '}
          {project.stats.speakerCount} 说话人
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="mono max-w-[240px] truncate text-[10px] text-muted" title={project.sourceVideoPath}>
            源片 {fileName(project.sourceVideoPath)}
          </span>
          <button type="button" className="btn btn-ghost px-2 py-[5px] text-[11px]" title="显示检查点目录" onClick={() => void api.system.reveal(project.workspaceDir)}>
            <FolderOpen size={12} />
            工作区
          </button>
        </div>
      </header>

      <Stepper steps={steps} active={activeStep} onPick={setActiveStep} />

      {running && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-6 py-2 text-[12px] text-accent">
          <Spinner label={`步骤${activeStep} 运行中`} />
          <span className="text-muted">本步骤的产物会逐个落盘为检查点，可直接在下方日志区看进度</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {activeStep === 1 && <Step1Analyze />}
        {activeStep === 2 && <Step2Separate />}
        {activeStep === 3 && <Step3Translate />}
        {activeStep === 4 && <Step4Dub />}
        {activeStep === 5 && <Step5Render3D />}
        {activeStep === 6 && <Step6Export />}
      </div>

      <StepFooter
        step={activeStep}
        steps={steps}
        issues={issues}
        busy={confirmBusy}
        running={running}
        onPrev={() => activeStep > 1 && setActiveStep((activeStep - 1) as StepId)}
        onNext={() => void confirmStep(activeStep)}
      />
    </div>
  )
}
