/** 全局 UI 状态：路由、设置、模型目录、系统信息、sidecar 视图、提示条与实时日志缓冲 */
import { create } from 'zustand'
import type { ModelRouteDto, ServerEvent, SettingsDto, StepId } from '@shared/types'
import type { ModelCatalogDto, SecretStateDto, SidecarViewDto, SystemInfoDto } from '@shared/api'
import { api } from '@renderer/api/client'
import { nowLabel } from '@renderer/util/format'

export type Route =
  | { view: 'projects' }
  | { view: 'voices' }
  | { view: 'settings' }
  | { view: 'project'; projectId: string; step?: StepId }

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'warn' | 'error'
  text: string
}

export interface EventLine {
  at: string
  kind: 'info' | 'warn' | 'error'
  text: string
}

interface AppState {
  ready: boolean
  bootError: string | null
  route: Route
  toasts: Toast[]
  events: EventLine[]
  settings: SettingsDto | null
  routes: ModelRouteDto[]
  secret: SecretStateDto | null
  catalog: ModelCatalogDto | null
  system: SystemInfoDto | null
  sidecar: SidecarViewDto | null
  gpu: { busy: boolean; label: string | null; jobId: string | null; queueLength: number } | null
  cloud: { active: number; limit: number } | null
  navigate: (route: Route) => void
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: string) => void
  pushEvent: (text: string, kind?: EventLine['kind']) => void
  handleEvent: (evt: ServerEvent) => void
  boot: () => Promise<void>
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<SettingsDto>) => Promise<void>
  saveApiKey: (key: string) => Promise<boolean>
  clearApiKey: () => Promise<void>
  testConnection: () => Promise<void>
  refreshSidecar: () => Promise<void>
  refreshSystem: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  route: { view: 'projects' },
  toasts: [],
  events: [],
  settings: null,
  routes: [],
  secret: null,
  catalog: null,
  system: null,
  sidecar: null,
  gpu: null,
  cloud: null,

  navigate: (route) => set({ route }),

  toast: (kind, text) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }))
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8_000 : 3_600)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pushEvent: (text, kind = 'info') => set((s) => ({ events: [...s.events, { at: nowLabel(), kind, text }].slice(-240) })),

  handleEvent: (evt) => {
    const state = get()
    switch (evt.type) {
      case 'job:update':
        state.pushEvent(`[${evt.job.name}] ${evt.job.state}${evt.job.message ? ` · ${evt.job.message}` : ''}`, evt.job.state === 'failed' ? 'error' : 'info')
        break
      case 'log':
        if (evt.line) state.pushEvent(evt.line, 'info')
        break
      case 'gpu:occupy':
        set({ gpu: evt.jobId ? { busy: true, label: evt.label, jobId: evt.jobId, queueLength: state.gpu?.queueLength ?? 0 } : { busy: false, label: null, jobId: null, queueLength: 0 } })
        break
      case 'sidecar:status':
        void state.refreshSidecar()
        break
      case 'settings:update':
        void state.loadSettings()
        break
      default:
        break
    }
  },

  boot: async () => {
    try {
      await Promise.all([get().loadSettings(), api.models.catalog().then((catalog) => set({ catalog })), get().refreshSidecar(), get().refreshSystem()])
      set({ ready: true, bootError: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ ready: true, bootError: message })
      get().toast('error', `本地服务未就绪：${message}`)
    }
  },

  loadSettings: async () => {
    const res = await api.settings.get()
    set({ settings: res.settings, routes: res.routes, secret: res.secret })
  },

  saveSettings: async (patch) => {
    const res = await api.settings.patch(patch)
    set({ settings: res.settings, routes: res.routes, secret: res.secret })
    get().toast('success', '设置已保存')
  },

  saveApiKey: async (key) => {
    try {
      const res = await api.settings.saveApiKey(key)
      await get().loadSettings()
      get().toast('success', `API-KEY 已加密保存（${res.masked ?? ''}）`)
      return true
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
      return false
    }
  },

  clearApiKey: async () => {
    await api.settings.clearApiKey()
    await get().loadSettings()
    get().toast('info', 'API-KEY 已清除')
  },

  testConnection: async () => {
    const res = await api.settings.testConnection()
    get().toast(res.ok ? 'success' : 'error', `连接测试：${res.detail}`)
  },

  refreshSidecar: async () => {
    try {
      set({ sidecar: await api.sidecar.view() })
    } catch (err) {
      set({ sidecar: null })
      get().pushEvent(`sidecar 状态读取失败：${err instanceof Error ? err.message : String(err)}`, 'warn')
    }
  },

  refreshSystem: async () => {
    try {
      set({ system: await api.system.info() })
    } catch {
      set({ system: null })
    }
  }
}))
