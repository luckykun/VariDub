/** 项目列表页状态（SPEC-001 §4：导入即前置检查，三项通过才允许建项目） */
import { create } from 'zustand'
import type { PrecheckResult, ProjectDto, ServerEvent } from '@shared/types'
import { api } from '@renderer/api/client'
import { useAppStore } from '@renderer/stores/appStore'

interface ProjectsState {
  items: ProjectDto[]
  loading: boolean
  busy: boolean
  error: string | null
  precheck: PrecheckResult | null
  pickedPath: string | null
  refresh: () => Promise<void>
  pickVideo: () => Promise<string | null>
  precheckFile: (filePath: string) => Promise<void>
  create: (name?: string) => Promise<ProjectDto | null>
  remove: (id: string, purgeFiles: boolean) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  clearPrecheck: () => void
  handleEvent: (evt: ServerEvent) => void
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  items: [],
  loading: false,
  busy: false,
  error: null,
  precheck: null,
  pickedPath: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      set({ items: await api.projects.list(), loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  pickVideo: async () => {
    const res = await api.system.pick('video', { title: '选择综艺片段（MP4/MOV，≤5 分钟）' })
    const path = res.path
    if (path) {
      set({ pickedPath: path })
      await get().precheckFile(path)
    }
    return path
  },

  precheckFile: async (filePath) => {
    set({ busy: true, error: null })
    try {
      const precheck = await api.projects.precheck(filePath)
      set({ precheck, pickedPath: filePath, busy: false })
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err), precheck: null })
    }
  },

  create: async (name) => {
    const path = get().pickedPath
    if (!path) {
      useAppStore.getState().toast('warn', '请先选择视频文件')
      return null
    }
    set({ busy: true })
    try {
      const project = await api.projects.create(path, name)
      set({ busy: false, precheck: null, pickedPath: null })
      await get().refresh()
      useAppStore.getState().toast('success', `已创建项目「${project.name}」`)
      return project
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : String(err) })
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
      return null
    }
  },

  remove: async (id, purgeFiles) => {
    try {
      await api.projects.remove(id, purgeFiles)
      await get().refresh()
      useAppStore.getState().toast('info', purgeFiles ? '项目与工作区文件已删除' : '项目已删除（工作区文件保留）')
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  rename: async (id, name) => {
    try {
      await api.projects.rename(id, name)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  clearPrecheck: () => set({ precheck: null, pickedPath: null, error: null }),

  handleEvent: (evt) => {
    if (evt.type === 'project:update' || evt.type === 'step:update' || evt.type === 'job:update') void get().refresh()
  }
}))
