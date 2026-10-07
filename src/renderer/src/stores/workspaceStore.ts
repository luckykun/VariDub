/**
 * 项目工作区状态（六步流水线共用）：一屏数据 + 所有人工动作。
 * 数据来自 GET /overview，之后靠 SSE 增量刷新；所有写操作复用同一份 pending 标记。
 */
import { create } from 'zustand'
import type { LineDto, ProjectDto, ServerEvent, ShotDto, SpeakerDto, StepId, StepState } from '@shared/types'
import type { FinalProductDto, LinePatchRequest, OverviewDto, ShotPatchRequest, SpeakerPatchRequest, StepRunRequest } from '@shared/api'
import { api } from '@renderer/api/client'
import { useAppStore } from '@renderer/stores/appStore'

interface WorkspaceState {
  projectId: string | null
  data: OverviewDto | null
  loading: boolean
  error: string | null
  activeStep: StepId
  pending: Record<string, boolean>
  open: (projectId: string, step?: StepId) => Promise<void>
  close: () => void
  refresh: (silent?: boolean) => Promise<void>
  setActiveStep: (step: StepId) => void
  busy: (key: string) => boolean
  run: (step: StepId, body?: StepRunRequest) => Promise<void>
  confirmStep: (step: StepId, force?: boolean) => Promise<void>
  reopen: (step: StepId) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  patchShot: (shotId: string, body: ShotPatchRequest) => Promise<void>
  splitShot: (shotId: string, atMs: number) => Promise<void>
  mergeShot: (shotId: string) => Promise<void>
  removeShot: (shotId: string) => Promise<void>
  acceptShots: (shotIds?: string[]) => Promise<void>
  pilot: (body: StepRunRequest & { shotId?: string | null }) => Promise<void>
  rerunShots: (shotIds: string[]) => Promise<void>
  rerunLow: (threshold?: number) => Promise<void>
  patchLine: (lineId: string, body: LinePatchRequest) => Promise<LineDto | null>
  confirmLine: (lineId: string, confirmed: boolean) => Promise<void>
  confirmAllLines: () => Promise<void>
  lineAction: (lineId: string, action: 'translate' | 'alts' | 'dub') => Promise<void>
  patchSpeaker: (speakerId: string, body: SpeakerPatchRequest) => Promise<void>
  resample: (speakerId: string, startMs: number, endMs: number) => Promise<void>
  exportFinal: (body: { destDir?: string; name?: string | null }) => Promise<string | null>
  setProduct: (product: FinalProductDto | null) => void
  handleEvent: (evt: ServerEvent) => void
}

/** 尾部合并刷新：SSE 高频事件下避免请求风暴 */
let refreshTimer: number | undefined
let queuedSilent = true

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projectId: null,
  data: null,
  loading: false,
  error: null,
  activeStep: 1,
  pending: {},

  open: async (projectId, step) => {
    set({ projectId, loading: true, error: null, activeStep: step ?? 1, data: null, pending: {} })
    try {
      const data = await api.projects.overview(projectId)
      set({ data, loading: false, activeStep: step ?? data.project.currentStep })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  close: () => set({ projectId: null, data: null, error: null, pending: {} }),

  refresh: async (silent = true) => {
    const id = get().projectId
    if (!id) return
    if (!silent) set({ loading: true })
    try {
      const data = await api.projects.overview(id)
      set((s) => ({ data, loading: false, error: null, activeStep: s.activeStep }))
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  setActiveStep: (step) => set({ activeStep: step }),

  busy: (key) => get().pending[key] === true,

  run: async (step, body = {}) => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, [`run${step}`]: true } }))
    try {
      await api.pipeline.run(id, step, body)
      await get().refresh(false)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, [`run${step}`]: false } }))
    }
  },

  confirmStep: async (step, force = false) => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, [`confirm${step}`]: true } }))
    try {
      const res = await api.pipeline.confirm(id, step, force)
      if (res.ok) useAppStore.getState().toast('success', `步骤${step} 已确认，下一步解锁`)
      await get().refresh(false)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, [`confirm${step}`]: false } }))
    }
  },

  reopen: async (step) => {
    const id = get().projectId
    if (!id) return
    try {
      await api.pipeline.reopen(id, step)
      useAppStore.getState().pushEvent(`步骤${step} 已回改，下游产物标记为待重跑`)
      await get().refresh(false)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  cancelJob: async (jobId) => {
    const id = get().projectId
    if (!id) return
    try {
      await api.pipeline.cancel(id, jobId)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  patchShot: async (shotId, body) => {
    try {
      const shot = await api.shots.patch(shotId, body)
      patchLocal(set, get, (d) => ({ ...d, shots: d.shots.map((s) => (s.id === shot.id ? shot : s)) }))
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  splitShot: async (shotId, atMs) => {
    const id = get().projectId
    if (!id) return
    try {
      const shots = await api.shots.split(id, shotId, atMs)
      patchLocal(set, get, (d) => ({ ...d, shots }))
      useAppStore.getState().pushEvent(`分镜已在 ${Math.round(atMs)}ms 处拆分`)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  mergeShot: async (shotId) => {
    const id = get().projectId
    if (!id) return
    try {
      const shots = await api.shots.merge(id, shotId)
      patchLocal(set, get, (d) => ({ ...d, shots }))
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  removeShot: async (shotId) => {
    try {
      const res = await api.shots.remove(shotId)
      patchLocal(set, get, (d) => ({ ...d, shots: res.shots }))
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  acceptShots: async (shotIds) => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, accept: true } }))
    try {
      const res = await api.pipeline.accept(id, shotIds)
      patchLocal(set, get, (d) => ({ ...d, shots: res.shots }))
      useAppStore.getState().toast('success', `已接受 ${res.accepted} 个分镜`)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, accept: false } }))
    }
  },

  pilot: async (body) => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, pilot: true } }))
    try {
      await api.pipeline.pilot(id, body)
      await get().refresh(false)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, pilot: false } }))
    }
  },

  rerunShots: async (shotIds) => {
    const id = get().projectId
    if (!id) return
    try {
      await api.pipeline.rerunShots(id, shotIds)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  rerunLow: async (threshold) => {
    const id = get().projectId
    if (!id) return
    try {
      await api.pipeline.rerunLow(id, threshold)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  patchLine: async (lineId, body) => {
    try {
      const line = await api.lines.patch(lineId, body)
      patchLocal(set, get, (d) => ({ ...d, lines: d.lines.map((l) => (l.id === line.id ? line : l)) }))
      return line
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
      return null
    }
  },

  confirmLine: async (lineId, confirmed) => {
    try {
      const res = await api.lines.confirm(lineId, confirmed)
      patchLocal(set, get, (d) => ({ ...d, lines: d.lines.map((l) => (l.id === res.line.id ? res.line : l)) }))
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  confirmAllLines: async () => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, confirmAll: true } }))
    try {
      const res = await api.lines.confirmAll(id)
      patchLocal(set, get, (d) => ({ ...d, lines: res.lines }))
      useAppStore.getState().toast('success', `已确认 ${res.confirmed} 句`)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, confirmAll: false } }))
    }
  },

  lineAction: async (lineId, action) => {
    try {
      await api.pipeline.lineAction(lineId, action)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  patchSpeaker: async (speakerId, body) => {
    try {
      const speaker = await api.speakers.patch(speakerId, body)
      patchLocal(set, get, (d) => ({ ...d, speakers: d.speakers.map((s) => (s.id === speaker.id ? speaker : s)) }))
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  resample: async (speakerId, startMs, endMs) => {
    const id = get().projectId
    if (!id) return
    set((s) => ({ pending: { ...s.pending, [`resample:${speakerId}`]: true } }))
    try {
      const speaker = await api.speakers.resample(speakerId, startMs, endMs)
      patchLocal(set, get, (d) => ({ ...d, speakers: d.speakers.map((s) => (s.id === speaker.id ? speaker : s)) }))
      useAppStore.getState().toast('success', `样本已更新（${speaker.sampleQuality}）`)
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => ({ pending: { ...s.pending, [`resample:${speakerId}`]: false } }))
    }
  },

  exportFinal: async (body) => {
    const id = get().projectId
    if (!id) return null
    set((s) => ({ pending: { ...s.pending, export: true } }))
    try {
      const res = await api.pipeline.exportFinal(id, body)
      patchLocal(set, get, (d) => ({ ...d, product: res.product }))
      useAppStore.getState().toast('success', `已导出到 ${res.exportedTo}`)
      return res.exportedTo
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      set((s) => ({ pending: { ...s.pending, export: false } }))
    }
  },

  setProduct: (product) => patchLocal(set, get, (d) => ({ ...d, product })),

  handleEvent: (evt) => {
    const state = get()
    if (!state.projectId) return
    if (evt.type === 'job:update' && evt.job.projectId === state.projectId) {
      if (state.data) patchLocal(set, get, (d) => ({ ...d, jobs: updateJob(d.jobs, evt.job) }))
      const terminal = evt.job.state === 'succeeded' || evt.job.state === 'failed' || evt.job.state === 'cancelled'
      scheduleRefresh(set, get, !terminal)
      return
    }
    if (evt.type === 'project:update' && evt.projectId === state.projectId) scheduleRefresh(set, get, true)
    if (evt.type === 'shots:update' && evt.projectId === state.projectId) scheduleRefresh(set, get, true)
    if (evt.type === 'lines:update' && evt.projectId === state.projectId) scheduleRefresh(set, get, true)
    if (evt.type === 'speakers:update' && evt.projectId === state.projectId) scheduleRefresh(set, get, true)
    if (evt.type === 'gpu:occupy') {
      patchLocal(set, get, (d) => ({ ...d, gpu: { busy: evt.jobId !== null, label: evt.label, jobId: evt.jobId, queueLength: d.gpu.queueLength } }))
    }
    if (evt.type === 'sidecar:status') scheduleRefresh(set, get, true)
  }
}))

type Setter = (partial: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>)) => void

function patchLocal(set: Setter, get: () => WorkspaceState, mutate: (data: OverviewDto) => OverviewDto): void {
  const data = get().data
  if (!data) return
  set({ data: mutate(data) })
}

function updateJob(jobs: OverviewDto['jobs'], job: OverviewDto['jobs'][number]): OverviewDto['jobs'] {
  const exists = jobs.some((j) => j.id === job.id)
  return exists ? jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...jobs]
}

function scheduleRefresh(set: Setter, get: () => WorkspaceState, silent: boolean): void {
  queuedSilent = queuedSilent && silent
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    const silentNow = queuedSilent
    queuedSilent = true
    void get().refresh(silentNow)
  }, 600)
}

/** 供步骤页快速读取的派生值 */
export function stepStateOf(data: OverviewDto | null, step: StepId): StepState {
  return data?.project.stepStates[step] ?? 'locked'
}

export function projectOf(data: OverviewDto | null): ProjectDto | null {
  return data?.project ?? null
}

export function shotById(data: OverviewDto | null, id: string | null): ShotDto | null {
  if (!data || !id) return null
  return data.shots.find((s) => s.id === id) ?? null
}

export function speakerById(data: OverviewDto | null, id: string | null): SpeakerDto | null {
  if (!data || !id) return null
  return data.speakers.find((s) => s.id === id) ?? null
}
