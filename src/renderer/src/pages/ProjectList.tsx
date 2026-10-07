/**
 * 屏 01 项目列表（SPEC-001 §4）：拖入/选择视频 → 导入前置检查卡（时长/人声/画面三项 ✓）→「确定，开始创作」。
 * 版权提示按 §8 放在新建项目面板底部，一行小字、可关闭（写回 settings.ui.copyrightNoticeDismissed）。
 */
import { useEffect, useState } from 'react'
import { Check, Clapperboard, FolderOpen, Plus, RotateCcw, Trash2, TriangleAlert, Upload, X } from 'lucide-react'
import type { PrecheckItem, PrecheckResult, ProjectDto } from '@shared/types'
import { api, fileUrl } from '@renderer/api/client'
import { Badge, EmptyState, Panel, Spinner, Toggle, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { StepStatusChip } from '@renderer/components/StatusChip'
import { useAppStore } from '@renderer/stores/appStore'
import { useProjectsStore } from '@renderer/stores/projectsStore'
import { msClock, fileName } from '@renderer/util/format'

export function ProjectList(): JSX.Element {
  const store = useProjectsStore()
  const navigate = useAppStore((s) => s.navigate)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [importing, setImporting] = useState(false)
  const [name, setName] = useState('')
  const [dropHint, setDropHint] = useState(false)

  useEffect(() => {
    void store.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyrightDismissed = settings?.ui.copyrightNoticeDismissed ?? false

  async function pickFile(): Promise<void> {
    const path = await store.pickVideo()
    if (path) {
      setName(fileName(path).replace(/\.[^.]+$/, ''))
      setImporting(true)
    }
  }

  async function confirmCreate(): Promise<void> {
    const project = await store.create(name.trim() || undefined)
    if (project) {
      setImporting(false)
      setName('')
      navigate({ view: 'project', projectId: project.id, step: 1 })
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dropHint) setDropHint(true)
      }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropHint(false)
        const file = e.dataTransfer.files.item(0) as (File & { path?: string }) | null
        const path = file?.path
        if (path) {
          void store.precheckFile(path)
          setName(fileName(path).replace(/\.[^.]+$/, ''))
          setImporting(true)
        }
      }}
    >
      <header className="flex items-center gap-3">
        <div>
          <h1 className="font-display text-[18px] text-ink">项目列表</h1>
          <p className="text-[12px] text-muted">
            中文综艺片段 → 3D 动画 + 英文配音。{dropHint ? '松开即可导入' : '可把 MP4/MOV 直接拖进本窗口'}
          </p>
        </div>
        <button type="button" className="btn btn-accent ml-auto" onClick={pickFile}>
          <Plus size={13} />
          导入视频
        </button>
      </header>

      {importing && (
        <ImportPrecheck
          items={store.precheck?.items ?? []}
          precheck={store.precheck}
          busy={store.busy}
          name={name}
          error={store.error}
          copyrightNoticeDismissed={copyrightDismissed}
          onNameChange={setName}
          onCreate={confirmCreate}
          onCancel={() => {
            setImporting(false)
            store.clearPrecheck()
          }}
          onDismissCopyright={async (dismiss) => {
            await saveSettings({ ui: { ...(settings?.ui ?? { copyrightNoticeDismissed: false }), copyrightNoticeDismissed: dismiss } })
          }}
        />
      )}

      {store.error && !importing && (
        <div className="flex items-center gap-2 border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
          <TriangleAlert size={13} /> {store.error}
        </div>
      )}

      <Panel
        title={
          <span className="flex items-center gap-2 text-[13px]">
            <Clapperboard size={14} /> 全部项目
            <span className="mono text-[11px] text-muted">{store.items.length}</span>
          </span>
        }
        aside={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void store.refresh()}>
            <RotateCcw size={11} />
            刷新
          </button>
        }
        bodyClass="p-4"
        className="min-h-[280px]"
      >
        {store.loading && store.items.length === 0 ? (
          <Spinner label="读取项目" />
        ) : store.items.length === 0 ? (
          <EmptyState
            icon={<Clapperboard size={26} />}
            text="还没有项目。点右上「导入视频」，或直接拖一个 MP4/MOV 到窗口里 —— 导入时会先做时长/人声/画面三项前置检查。"
            action={
              <button type="button" className="btn" onClick={pickFile}>
                <Upload size={13} />
                选择文件
              </button>
            }
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {store.items.map((project) => (
              <ProjectCard key={project.id} project={project} onOpen={() => navigate({ view: 'project', projectId: project.id })} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function ImportPrecheck({
  items,
  precheck,
  busy,
  name,
  error,
  copyrightNoticeDismissed,
  onNameChange,
  onCreate,
  onCancel,
  onDismissCopyright
}: {
  items: PrecheckItem[]
  precheck: PrecheckResult | null
  busy: boolean
  name: string
  error: string | null
  copyrightNoticeDismissed: boolean
  onNameChange: (v: string) => void
  onCreate: () => void
  onCancel: () => void
  onDismissCopyright: (dismiss: boolean) => void
}): JSX.Element {
  const allPassed = precheck !== null && precheck.ok

  return (
    <Panel
      title={<span className="text-[13px]">导入前置检查</span>}
      aside={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          <X size={11} />
          取消
        </button>
      }
      bodyClass="p-4"
    >
      <div className="flex flex-col gap-4">
        {precheck && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-muted">
            <span className="mono truncate text-ink" title={precheck.filePath}>
              {precheck.fileName}
            </span>
            <span>时长 {msClock(precheck.durationMs, false)}</span>
            <span>
              {precheck.width}×{precheck.height}
            </span>
            <span>音轨 {precheck.hasAudio ? '有' : '无'}</span>
          </div>
        )}

        <ul className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {items.length === 0 ? (
            <li className="flex items-center gap-2 text-[12px] text-muted">
              {error ? <span className="text-error">{error}</span> : <Spinner label="正在检查：时长 / 人声 / 画面" />}
            </li>
          ) : (
            items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 border border-hairline bg-canvas p-3">
              <span className={`mt-[2px] flex size-[18px] shrink-0 items-center justify-center border ${item.pass ? 'border-success text-success' : 'border-error text-error'}`}>
                {item.pass ? <Check size={12} /> : <X size={12} />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">{item.label}</span>
                <span className={`text-[11px] ${item.pass ? 'text-muted' : TONE_TEXT[item.blocking ? 'error' : 'warn']}`}>{item.detail}</span>
              </span>
            </li>
            ))
          )}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="label">项目名称</span>
            <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="默认取文件名" />
          </label>
          <button type="button" className="btn btn-accent" disabled={!allPassed || busy} onClick={onCreate} title={allPassed ? '创建项目并进入步骤①' : '三项检查全部通过才能开始创作'}>
            <Check size={13} />
            确定，开始创作
          </button>
        </div>

        {!copyrightNoticeDismissed && (
          <div className="flex items-center justify-between gap-3 border-t border-hairline pt-3">
            <p className="text-[11px] leading-[1.6] text-muted">
              本工具仅用于个人学习与研究，请勿用于传播未经授权的视频内容；导入即视为你已获得该片段的使用授权。
            </p>
            <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => onDismissCopyright(true)}>
              知道了，不再提示
            </button>
          </div>
        )}
      </div>
    </Panel>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectDto; onOpen: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [purge, setPurge] = useState(false)
  const remove = useProjectsStore((s) => s.remove)
  const done = project.stepStates[6] === 'confirmed'
  const tone: Tone = done ? 'success' : project.status === 'draft' ? 'muted' : 'accent'

  return (
    <li className="card flex flex-col overflow-hidden">
      <button type="button" className="relative block aspect-video w-full bg-canvas" onClick={onOpen} title="进入项目">
        {project.thumbPath ? (
          <img src={fileUrl(project.thumbPath)} alt={project.name} className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-muted">
            <Clapperboard size={22} />
          </span>
        )}
        <span className="absolute bottom-1 left-1 flex items-center gap-1 bg-canvas/85 px-1 py-[1px]">
          <StepStatusChip state={project.stepStates[project.currentStep]} />
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={project.name}>
            {project.name}
          </span>
          <Badge tone={tone}>{done ? '已完成' : `步骤${project.currentStep}`}</Badge>
        </div>

        <div className="mono flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
          <span>{msClock(project.durationMs, false)}</span>
          <span>
            {project.width}×{project.height}
          </span>
          <span>{project.stats.shotCount} 分镜</span>
          <span>{project.stats.lineCount} 句</span>
          <span>{project.stats.speakerCount} 说话人</span>
        </div>

        {confirming ? (
          <div className="flex flex-col gap-2 border-t border-hairline pt-2">
            <p className="text-[11px] text-warn">删除后不可恢复；工作区文件（分镜/音轨/3D 片段）位于</p>
            <p className="mono truncate text-[10px] text-muted" title={project.workspaceDir}>
              {project.workspaceDir}
            </p>
            <Toggle checked={purge} onChange={setPurge} label={<span className="text-[11px]">同时删除工作区文件</span>} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  setConfirming(false)
                  void remove(project.id, purge)
                }}
              >
                确认删除
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1 border-t border-hairline pt-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen}>
              继续创作
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api.system.reveal(project.workspaceDir)} title="显示工作区文件">
              <FolderOpen size={11} />
            </button>
            <button type="button" className="mono ml-auto text-[10px] text-muted" onClick={onOpen} title="打开项目">
              {project.stats.dubDone}/{project.stats.lineCount} 已配音
            </button>
            <button type="button" className="p-[2px] text-muted hover:text-error" title="删除项目" onClick={() => setConfirming(true)}>
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
