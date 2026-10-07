/**
 * 应用外壳（SPEC-001 §4：窗口栏 + 左侧三菜单 + 右侧全局算力状态 + Toast 宿主）。
 * 颜色全部走 theme token（styles/theme.css），图标全部来自 lucide-react（§7.3）。
 */
import { Clapperboard, Cloud, Cpu, Mic, Server, Settings, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { useAppStore, type Route } from '@renderer/stores/appStore'

const MENU: Array<{ key: Route['view']; label: string; icon: ReactNode; route: Route }> = [
  { key: 'projects', label: '项目列表', icon: <Clapperboard size={15} />, route: { view: 'projects' } },
  { key: 'voices', label: '音色库', icon: <Mic size={15} />, route: { view: 'voices' } },
  { key: 'settings', label: '设置', icon: <Settings size={15} />, route: { view: 'settings' } }
]

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const route = useAppStore((s) => s.route)
  const navigate = useAppStore((s) => s.navigate)
  const system = useAppStore((s) => s.system)
  const bootError = useAppStore((s) => s.bootError)

  const activeKey: Route['view'] = route.view === 'project' ? 'projects' : route.view

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas font-ui text-body">
      <header className="flex h-[38px] shrink-0 items-center gap-3 border-b border-hairline bg-canvas px-4">
        <span className="flex items-baseline gap-2">
          <span className="font-display text-[14px] tracking-[0.02em] text-ink">VariDub</span>
          <span className="text-[11px] text-muted">综译</span>
        </span>
        <span className="mono text-[10px] text-muted">{system?.version ? `v${system.version}` : '—'}</span>

        {system?.mockMode && (
          <Badge tone="warn">
            <Server size={10} /> Mock 模式（不发真实云端请求）
          </Badge>
        )}
        {system && !system.hasApiKey && !system.mockMode && (
          <Badge tone="error">
            <TriangleAlert size={10} /> 未配置 API-KEY
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-3">
          <GlobalStatus />
        </div>
      </header>

      {bootError && (
        <div className="flex items-center gap-2 border-b border-error/40 bg-error/10 px-4 py-2 text-[12px] text-error">
          <TriangleAlert size={13} />
          本地服务未就绪：{bootError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[176px] shrink-0 flex-col border-r border-hairline bg-canvas">
          <ul className="flex flex-col p-2">
            {MENU.map((item) => {
              const active = activeKey === item.key
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => navigate(item.route)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors ${
                      // 选中项用灰底高亮，正常项就是黑的
                      active ? 'border-l-2 border-accent bg-elevated text-ink' : 'border-l-2 border-transparent text-muted hover:bg-elevated/50 hover:text-body'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                </li>
              )
            })}
          </ul>

          {/* 与步骤工作区 Footer 取同一个 --bar-h 并同样贴底，两者的上描边才能落在同一水平线上（SPEC §7.6） */}
          <div className="mt-auto flex h-[var(--bar-h)] shrink-0 flex-col justify-center gap-1 overflow-hidden border-t border-hairline px-3 text-[10px] text-muted">
            <div className="mono truncate" title={system?.workspaceRoot}>
              工作区 {system?.workspaceRoot?.split(/[\\/]/).pop() ?? '—'}
            </div>
            <div className="mono truncate" title={system?.serverPort ? `127.0.0.1:${system.serverPort}` : ''}>
              本地服务 127.0.0.1:{system?.serverPort ?? '—'}
            </div>
          </div>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>

      <ToastHost />
    </div>
  )
}

/** 顶栏右侧：本地 GPU / 云端并发 / sidecar */
function GlobalStatus(): JSX.Element {
  const sidecar = useAppStore((s) => s.sidecar)
  const gpu = useAppStore((s) => s.gpu)
  const cloud = useAppStore((s) => s.cloud)

  const sidecarTone: Tone = sidecar === null ? 'muted' : sidecar.online ? (sidecar.gpu ? 'success' : 'warn') : 'error'
  const sidecarText =
    sidecar === null
      ? 'sidecar 未知'
      : sidecar.online
        ? sidecar.gpu
          ? `本地算力 ${sidecar.device ?? 'GPU'}`
          : '本地算力仅 CPU'
        : '本地算力未启动'

  return (
    <>
      <StatusIcon tone={sidecarTone} icon={<Cpu size={12} />} text={sidecarText} title={sidecar?.reason ?? sidecar?.mismatch ?? sidecarText} />
      <StatusIcon
        tone={gpu?.busy ? 'accent' : 'muted'}
        icon={<Server size={12} />}
        text={gpu?.busy ? `GPU 占用：${gpu.label ?? '任务'}` : 'GPU 空闲'}
        title={gpu && gpu.queueLength > 0 ? `排队 ${gpu.queueLength} 个` : '同一时刻仅 1 个本地 GPU 任务（§7.7-4）'}
      />
      <StatusIcon
        tone={cloud && cloud.active >= cloud.limit ? 'warn' : 'muted'}
        icon={<Cloud size={12} />}
        text={cloud ? `云端 ${cloud.active}/${cloud.limit}` : '云端 —'}
        title="云端异步任务并发上限 2（防限流）"
      />
    </>
  )
}

function StatusIcon({ tone, icon, text, title }: { tone: Tone; icon: ReactNode; text: string; title: string }): JSX.Element {
  return (
    <span className={`mono flex items-center gap-1 text-[10px] ${TONE_TEXT[tone]}`} title={title}>
      {icon}
      <span className="max-w-[150px] truncate">{text}</span>
    </span>
  )
}

function ToastHost(): JSX.Element | null {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)
  if (toasts.length === 0) return null

  const toneOf: Record<'info' | 'success' | 'warn' | 'error', Tone> = { info: 'info', success: 'success', warn: 'warn', error: 'error' }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[380px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto card flex items-start gap-2 border px-3 py-2 text-[12px] shadow-lg ${
            t.kind === 'error' ? 'border-error/50' : t.kind === 'warn' ? 'border-warn/50' : t.kind === 'success' ? 'border-success/50' : 'border-hairline'
          }`}
        >
          <span className={`mt-[3px] size-[6px] shrink-0 rounded-full ${t.kind === 'error' ? 'bg-error' : t.kind === 'warn' ? 'bg-warn' : t.kind === 'success' ? 'bg-success' : 'bg-info'}`} />
          <span className={TONE_TEXT[toneOf[t.kind]]}>{t.text}</span>
          <button type="button" className="ml-auto text-muted hover:text-ink" onClick={() => dismiss(t.id)} title="关闭">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
