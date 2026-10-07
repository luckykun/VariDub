/// <reference types="vite/client" />
import type { RendererBridgeApi } from '@shared/api'

declare global {
  interface Window {
    /** preload 注入的桥接（浏览器直开时为 undefined，此时走同域 /api/*） */
    varidub?: RendererBridgeApi
  }
}

export {}
