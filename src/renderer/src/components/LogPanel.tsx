/** 侧栏任务/日志面板：进行中的 Job（可取消）+ 本地任务日志尾 200 行（§7.7-3） */
import { useEffect, useState, type ReactNode } from 'react'
import { FileText, RefreshCw, X } from 'lucide-react'
import type { JobDto } from '@shared/types'
import { api } from '@renderer/api/client'
import { Badge, Meter, Panel } from '@renderer/components/ui'
import { JobStatusChip } from '@renderer/components/StatusChip'
import { useAppStore } from '@renderer/stores/appStore'

export function LogPanel({ projectId, step, jobs }: { projectId: string; step: number; jobs: JobDto[] }): JSX.Element {
  const events = useAppStore((s) => s.events)
  const pushEvent = useAppStore((s) => s.pushEvent)
  const [logName, setLogName] = useState(`step${step}`)
  const [logText, setLogText] = useState('')
  const [logFile, setLogFile] = useState('')
  const [available, setAvailable] = useState<Array<{ name: string; path: string; exists: boolean }>>([])
  const [tab, setTab] = useState<'events' | 'log'>('events')

  useEffect(() => {
    setLogName(`step${step}`)
  }, [step])

  useEffect(() => {
    let alive = true
    void api.system.logFiles(projectId).then((res) => {
      if (alive) setAvailable(res.files)
    }).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    if (tab !== 'log') return
    let alive = true
    void api.system
      .logs(projectId, logName, 200)
      .then((res) => {
        if (!alive) return
        setLogText(res.exists ? res.text : `（还没有 ${logName}.log 内容）`)
        setLogFile(res.file)
      })
      .catch((err: Error) => {
        if (alive) setLogText(`读取失败：${err.message}`)
      })
    return () => {
      alive = false
    }
  }, [tab, logName, projectId])

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued')

  return (
    <Panel
      className="min-h-0 flex-1"
      title={
        <span className="flex items-center gap-2 text-[12px]">
          <FileText size={13} /> 任务与日志
          {active.length > 0 && <Badge tone="accent">{active.length} 个进行中</Badge>}
        </span>
      }
      aside={
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'events'} onClick={() => setTab('events')}>
            实时
          </TabButton>
          <TabButton active={tab === 'log'} onClick={() => setTab('log')}>
            日志
          </TabButton>
        </div>
      }
      bodyClass="p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {active.length > 0 && (
          <div className="space-y-2 border-b border-hairline p-3">
            {active.map((job) => (
              <div key={job.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] text-ink">{job.name}</span>
                  <span className="flex items-center gap-1">
                    <JobStatusChip state={job.state} />
                    <button
                      type="button"
                      title="取消任务"
                      className="text-muted hover:text-error"
                      onClick={() => {
                        void api.pipeline
                          .cancel(projectId, job.id)
                          .then(() => pushEvent(`已请求取消「${job.name}」`, 'warn'))
                          .catch((err: Error) => pushEvent(`取消失败：${err.message}`, 'error'))
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
                <Meter value={job.progress} tone={job.state === 'queued' ? 'muted' : 'accent'} />
                <div className="mono flex items-center justify-between text-[10px] text-muted">
                  <span className="truncate">{job.message ?? job.error ?? '—'}</span>
                  <span>{Math.round(job.progress * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'events' ? (
          <ul className="min-h-0 flex-1 space-y-[2px] overflow-auto p-3">
            {events.length === 0 && <li className="text-[11px] text-muted">（暂无事件推送）</li>}
            {events
              .slice()
              .reverse()
              .map((line, i) => (
                <li key={`${line.at}-${i}`} className="mono flex gap-2 text-[11px] leading-[1.5]">
                  <span className="shrink-0 text-muted">{line.at}</span>
                  <span className={line.kind === 'error' ? 'text-error' : line.kind === 'warn' ? 'text-warn' : 'text-body'}>{line.text}</span>
                </li>
              ))}
          </ul>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
              <select value={logName} onChange={(e) => setLogName(e.target.value)} className="flex-1">
                {available
                  .filter((f) => f.exists || f.name === logName)
                  .map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}.log
                    </option>
                  ))}
              </select>
              <button type="button" className="btn btn-ghost px-2" title="重新读取" onClick={() => setTab('log')}>
                <RefreshCw size={12} />
              </button>
            </div>
            <pre className="mono min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 text-[11px] leading-[1.55] text-body">{logText}</pre>
            {logFile && <div className="mono truncate border-t border-hairline px-3 py-1 text-[10px] text-muted">{logFile}</div>}
          </div>
        )}
      </div>
    </Panel>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className={`px-2 py-[2px] text-[11px] transition-colors ${active ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated/50 hover:text-body'}`}>
      {children}
    </button>
  )
}
