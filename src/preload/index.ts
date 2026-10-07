/**
 * preload（SPEC-001 §7.5）：只暴露「原生目录/文件选择」「在资源管理器中显示」「读取服务地址」。
 * 渲染层拿不到 fs / net / child_process，一切数据走 /api/*。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppInfoDto, PickResponse, RendererBridgeApi } from '../shared/api'

function argValue(prefix: string): string {
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}

const apiBase = argValue('--api-base=')
const dev = argValue('--dev=') === '1'

const bridge: RendererBridgeApi = {
  apiBase,
  dev,
  pick: (kind, opts) => ipcRenderer.invoke('dialog:pick', { kind, title: opts?.title, multi: opts?.multi }) as Promise<PickResponse>,
  reveal: (path: string) => {
    ipcRenderer.send('shell:reveal', path)
  },
  info: () => ipcRenderer.invoke('app:info') as Promise<AppInfoDto>,
  onNavigate: (cb) => {
    const handler = (_e: IpcRendererEvent, target: string): void => cb(target)
    ipcRenderer.on('app:navigate', handler)
    return () => ipcRenderer.removeListener('app:navigate', handler)
  }
}

contextBridge.exposeInMainWorld('varidub', bridge)

export type Bridge = RendererBridgeApi
