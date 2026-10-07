/**
 * 渲染层根组件（SPEC-001 §4）：路由分发 + SSE 订阅 + 启动自检。
 * 渲染层不直连文件系统与外网，所有数据走主进程内嵌服务的 /api/*（§7.5）。
 */
import { useEffect } from 'react'
import { AppShell } from '@renderer/components/AppShell'
import { connectSse } from '@renderer/api/sse'
import { ProjectList } from '@renderer/pages/ProjectList'
import { VoiceLibrary } from '@renderer/pages/VoiceLibrary'
import { Settings } from '@renderer/pages/Settings'
import { ProjectWorkspace } from '@renderer/pages/pipeline/ProjectWorkspace'
import { useAppStore, type Route } from '@renderer/stores/appStore'
import { useProjectsStore } from '@renderer/stores/projectsStore'
import { useVoicesStore } from '@renderer/stores/voicesStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import type { StepId } from '@shared/types'

export function App(): JSX.Element {
  const route = useAppStore((s) => s.route)
  const ready = useAppStore((s) => s.ready)
  const boot = useAppStore((s) => s.boot)
  const navigate = useAppStore((s) => s.navigate)

  useEffect(() => {
    void boot()
  }, [boot])

  // 单一 SSE 通道扇出到各 store
  useEffect(() => {
    const app = useAppStore.getState
    const off = connectSse((evt) => {
      app().handleEvent(evt)
      useWorkspaceStore.getState().handleEvent(evt)
      useProjectsStore.getState().handleEvent(evt)
      useVoicesStore.getState().handleEvent(evt)
    })
    return off
  }, [])

  // 主进程深链（托盘/通知点击）
  useEffect(() => {
    const bridge = window.varidub
    if (!bridge?.onNavigate) return
    return bridge.onNavigate((target) => navigate(parseTarget(target)))
  }, [navigate])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas font-ui">
        <div className="flex flex-col items-center gap-3">
          <span className="font-display text-[18px] text-ink">VariDub 综译</span>
          <span className="text-[12px] text-muted">正在启动本地服务…</span>
        </div>
      </div>
    )
  }

  return (
    <AppShell>
      {route.view === 'projects' && <ProjectList />}
      {route.view === 'voices' && <VoiceLibrary />}
      {route.view === 'settings' && <Settings />}
      {route.view === 'project' && <ProjectWorkspace key={route.projectId} projectId={route.projectId} initialStep={route.step} />}
    </AppShell>
  )
}

function parseTarget(target: string): Route {
  if (target.startsWith('project:')) {
    const [, id, step] = target.split(':')
    const parsed = Number(step)
    const isStep = parsed >= 1 && parsed <= 6
    return { view: 'project', projectId: id, step: isStep ? (parsed as StepId) : undefined }
  }
  if (target === 'voices') return { view: 'voices' }
  if (target === 'settings') return { view: 'settings' }
  return { view: 'projects' }
}
