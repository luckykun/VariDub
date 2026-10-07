/**
 * 步骤工作区的统一骨架（SPEC-001 §3 通用规则）：
 * 左 = 结果预览区，右 = 本步骤说明 / 参数 / 模型 + 任务与日志面板。
 */
import type { ReactNode } from 'react'
import { KeyVal, Panel } from '@renderer/components/ui'
import { LogPanel } from '@renderer/components/LogPanel'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import type { OverviewDto } from '@shared/api'
import type { ArtifactKind, LineDto } from '@shared/types'

export function useOverview(): OverviewDto | null {
  return useWorkspaceStore((s) => s.data)
}

export function usePending(key: string): boolean {
  return useWorkspaceStore((s) => s.pending[key] === true)
}

/** 取某类产物的最新落盘路径（波形/成片都靠它，避免渲染层猜目录结构） */
export function artifactPath(data: OverviewDto | null, kind: ArtifactKind): string | null {
  if (!data) return null
  const matched = data.artifacts.filter((a) => a.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return matched[0]?.path ?? null
}

export function byIndex<T extends { index: number }>(a: T, b: T): number {
  return a.index - b.index
}

/** 句子卡片头的说话人名 / 分镜号查找 */
export function lookupOf(data: OverviewDto) {
  const speakers = new Map(data.speakers.map((s) => [s.id, s.label]))
  const shots = new Map(data.shots.map((s) => [s.id, s.index]))
  return {
    speakerLabel: (id: string | null): string | null => (id ? speakers.get(id) ?? null : null),
    shotIndex: (id: string | null): number | null => (id ? shots.get(id) ?? null : null)
  }
}

/** ③④ 列表的快筛（与门禁红/黄标同源） */
export type LineFilterKey = 'all' | 'unconfirmed' | 'confirmed' | 'overflow' | 'slang' | 'nodub' | 'red'

export const FILTER_LABELS: Record<LineFilterKey, string> = {
  all: '全部',
  unconfirmed: '未确认',
  confirmed: '已确认',
  overflow: '超支',
  slang: '俚语存疑',
  nodub: '缺配音',
  red: '相似度红标'
}

export function filterLines(lines: LineDto[], key: LineFilterKey): LineDto[] {
  if (key === 'all') return lines
  return lines.filter((l) => {
    switch (key) {
      case 'unconfirmed':
        return l.confirmStatus !== 'confirmed'
      case 'confirmed':
        return l.confirmStatus === 'confirmed'
      case 'overflow':
        return l.overflowMs > 0
      case 'slang':
        return l.slangFlag
      case 'nodub':
        return !l.dubWavPath
      case 'red':
        return l.similarity !== null && l.similarity < 80
      default:
        return true
    }
  })
}

export function StepPane({ preview, aside }: { preview: ReactNode; aside: ReactNode }): JSX.Element {
  const projectId = useWorkspaceStore((s) => s.projectId)
  const step = useWorkspaceStore((s) => s.activeStep)
  const jobs = useWorkspaceStore((s) => s.data?.jobs ?? [])

  return (
    /* 整条工作区只在这一层滚一次：两栏都按内容自然撑高。
       右栏原来是「最大高度 58% + 内部滚动」，卡片被压扁后内部再滚一次，
       「运行本步骤」的按钮整块被裁到可视区外——用户根本找不到运行入口。 */
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="grid min-h-full grid-cols-[minmax(0,1fr)_350px] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-3">{preview}</div>
        <div className="flex min-w-0 flex-col gap-3 [&>*]:shrink-0">
          {aside}
          <div className="flex h-[300px] min-h-[220px] flex-col">{projectId ? <LogPanel projectId={projectId} step={step} jobs={jobs} /> : null}</div>
        </div>
      </div>
    </div>
  )
}

/** 本步骤说明卡（与 SPEC §3.x 表格一一对应：输入 / 处理 / 模型 / 产物 / 门禁）；卡内不滚，整卡正常铺开 */
export function StepDoc({ rows }: { rows: Array<{ k: string; v: ReactNode }> }): JSX.Element {
  return (
    <Panel title={<span className="text-[12px]">本步骤说明</span>} bodyClass="px-4 py-2" bodyScroll={false}>
      <div className="flex flex-col gap-[2px]">
        {rows.map((row) => (
          <KeyVal key={row.k} k={row.k} v={row.v} />
        ))}
      </div>
    </Panel>
  )
}

/** 参数卡：运行按钮所在，卡内绝不出现滚动条（bodyScroll=false），否则主入口会被裁掉 */
export function StepParams({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Panel title={<span className="text-[12px]">{title}</span>} bodyClass="p-4" bodyScroll={false}>
      <div className="flex flex-col gap-3">{children}</div>
    </Panel>
  )
}
