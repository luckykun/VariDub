/** 音色库（SPEC-001 §4 屏 05：纯资产管理，克隆/预置筛选 + 试听 + 引用计数） */
import { create } from 'zustand'
import type { ServerEvent, VoiceDto } from '@shared/types'
import type { VoiceCreateRequest } from '@shared/api'
import { api, fileUrl } from '@renderer/api/client'
import { useAppStore } from '@renderer/stores/appStore'

type VoiceFilter = 'all' | 'cloned' | 'preset'

interface VoicesState {
  items: VoiceDto[]
  filter: VoiceFilter
  loading: boolean
  busy: boolean
  previewUrl: string | null
  setFilter: (filter: VoiceFilter) => void
  clearPreview: () => void
  refresh: () => Promise<void>
  create: (body: VoiceCreateRequest) => Promise<VoiceDto | null>
  update: (id: string, body: { name?: string; tags?: string[] }) => Promise<void>
  remove: (id: string) => Promise<void>
  preview: (id: string, text?: string) => Promise<void>
  handleEvent: (evt: ServerEvent) => void
}

export const useVoicesStore = create<VoicesState>((set, get) => ({
  items: [],
  filter: 'all',
  loading: false,
  busy: false,
  previewUrl: null,

  clearPreview: () => set({ previewUrl: null }),

  setFilter: (filter) => {
    set({ filter })
    void get().refresh()
  },

  refresh: async () => {
    set({ loading: true })
    try {
      set({ items: await api.voices.list(get().filter), loading: false })
    } catch (err) {
      set({ loading: false })
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  create: async (body) => {
    set({ busy: true })
    try {
      const voice = await api.voices.create(body)
      await get().refresh()
      useAppStore.getState().toast('success', `音色「${voice.name}」已入库`)
      return voice
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      set({ busy: false })
    }
  },

  update: async (id, body) => {
    try {
      await api.voices.patch(id, body)
      await get().refresh()
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  remove: async (id) => {
    try {
      await api.voices.remove(id)
      await get().refresh()
      useAppStore.getState().toast('info', '音色已删除，引用它的说话人映射已清空')
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  preview: async (id, text) => {
    set({ busy: true })
    try {
      const res = await api.voices.preview(id, text)
      set({ previewUrl: res.exists ? fileUrl(res.path) : null })
      if (!res.exists) useAppStore.getState().toast('warn', '试听文件未生成')
    } catch (err) {
      useAppStore.getState().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set({ busy: false })
    }
  },

  handleEvent: (evt) => {
    if (evt.type === 'voices:update') void get().refresh()
  }
}))
