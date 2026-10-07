/**
 * 步骤⑥ 口型对齐·导出（SPEC-001 §3.6）。
 * MuseTalk 逐句驱动 + ffmpeg 合成 → 成片审片器（完整播放 + 时间轴句标记 + 上/下一句跳转 + 口型检测报告）。
 * R4：伴奏原音量直接混音；R7：默认外挂 SRT，不烧字幕进画面。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Captions, Clock, Film, FolderOpen, Play, Save, SkipBack, SkipForward, TriangleAlert } from 'lucide-react'
import type { DeviationRowDto, ReportDto } from '@shared/api'
import { api, fileUrl } from '@renderer/api/client'
import { Badge, EmptyState, KeyVal, Panel, Spinner, Toggle } from '@renderer/components/ui'
import { StepDoc, StepPane, StepParams, byIndex, useOverview, usePending } from '@renderer/pages/pipeline/StepPane'
import { useAppStore } from '@renderer/stores/appStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { fileName, msClock, msShort, signed } from '@renderer/util/format'

const FLAG_TONE = { green: 'success', yellow: 'warn', red: 'error' } as const

export function Step6Export(): JSX.Element {
  const data = useOverview()
  const projectId = useWorkspaceStore((s) => s.projectId)
  const running = usePending('run6')
  const exportBusy = usePending('export')
  const run = useWorkspaceStore((s) => s.run)
  const exportFinal = useWorkspaceStore((s) => s.exportFinal)
  const setActiveStep = useWorkspaceStore((s) => s.setActiveStep)

  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [skipLipsync, setSkipLipsync] = useState(false)
  const [destDir, setDestDir] = useState('')
  const [name, setName] = useState('')
  const [report, setReport] = useState<ReportDto | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const product = data?.product ?? null
  const refreshReport = useCallback(async () => {
    if (!projectId) return
    try {
      setReport(await api.projects.report(projectId))
      setReportError(null)
    } catch (err) {
      setReportError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void refreshReport()
  }, [refreshReport, product?.mp4, product?.exportedTo, data?.lines.length, running])

  useEffect(() => {
    const dir = settings?.storage.exportDir
    if (dir && !destDir) setDestDir(dir)
  }, [settings?.storage.exportDir, destDir])

  if (!data) return <StepPane preview={<Spinner label="载入成片" />} aside={<Spinner label="载入成片" />} />

  const lines = data.lines.slice().sort(byIndex)
  const totalMs = product?.durationMs ?? data.project.durationMs
  const rows = report?.lines ?? []
  const selected = rows.find((r) => r.line_id === cursor) ?? null
  const selectedLine = selected ? lines.find((l) => l.id === selected.line_id) ?? null : null
  const exportedTo = product?.exportedTo ?? null

  const seek = (ms: number | null | undefined): void => {
    if (ms === null || ms === undefined || !videoRef.current) return
    videoRef.current.currentTime = Math.max(0, ms / 1000)
    void videoRef.current.play().catch(() => undefined)
  }

  const jump = (delta: number): void => {
    if (rows.length === 0) return
    const at = selected ? rows.findIndex((r) => r.line_id === selected.line_id) : -1
    const next = Math.max(0, Math.min(rows.length - 1, at + delta))
    const row = rows[next]
    if (!row) return
    setCursor(row.line_id)
    const anchorMs = anchorOf(row, lines.find((l) => l.id === row.line_id)?.startMs ?? row.target_ms)
    seek(anchorMs)
  }

  return (
    <StepPane
      preview={
        <>
          <Panel
            title={<span className="text-[12px]">成片审片器</span>}
            aside={
              product ? (
                <>
                  <Badge tone="muted">
                    {product.width}×{product.height} · {product.fps}fps
                  </Badge>
                  <Badge tone="success">{msShort(product.durationMs)}</Badge>
                </>
              ) : (
                <Badge tone="warn">尚未合成</Badge>
              )
            }
          >
            {product ? (
              <div className="flex flex-col gap-3">
                <video ref={videoRef} src={fileUrl(product.mp4)} controls className="max-h-[min(56vh,520px)] w-full bg-black" preload="metadata" />

                <Timeline rows={rows} totalMs={totalMs} cursor={cursor} onPick={(row) => { setCursor(row.line_id); seek(anchorOf(row, lines.find((l) => l.id === row.line_id)?.startMs ?? row.target_ms)) }} />

                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" onClick={() => jump(-1)} disabled={rows.length === 0}>
                    <SkipBack size={11} /> 上一句
                  </button>
                  <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" onClick={() => jump(1)} disabled={rows.length === 0}>
                    下一句 <SkipForward size={11} />
                  </button>
                  <button type="button" className="btn btn-ghost px-2 py-[3px] text-[11px]" onClick={() => seek(0)}>
                    <Play size={11} /> 从头播放
                  </button>
                  <span className="mono ml-auto text-[10px] text-muted">{fileName(product.mp4)}</span>
                </div>

                {selected && (
                  <DeviationDetail row={selected} zhText={selectedLine?.zhText ?? ''} enText={selectedLine?.enText ?? ''} onBackToTranslate={() => setActiveStep(3)} onBackToDub={() => setActiveStep(4)} />
                )}

                <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-2 text-[11px]">
                  <span className="text-muted">
                    口型：<span className="mono text-ink">{product.lipsyncDone}</span> 句已完成 /{' '}
                    <span className={`mono ${product.lipsyncSkipped > 0 ? 'text-warn' : 'text-ink'}`}>{product.lipsyncSkipped}</span> 句跳过
                  </span>
                  <span className="text-muted">
                    红标 <span className="mono text-error">{report?.summary.red ?? 0}</span> · 黄标{' '}
                    <span className="mono text-warn">{report?.summary.yellow ?? 0}</span>
                  </span>
                  {exportedTo ? (
                    <button type="button" className="btn btn-ghost ml-auto px-2 py-[2px] text-[11px]" onClick={() => api.system.reveal(exportedTo)}>
                      <FolderOpen size={11} /> 已导出：{fileName(exportedTo)}
                    </button>
                  ) : (
                    <span className="ml-auto text-warn">尚未导出到目标文件夹</span>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<Film size={22} />}
                text={
                  lines.length === 0
                    ? '没有可合成的内容：请先完成上游步骤。'
                    : '右侧点「运行口型对齐·合成」：本地 MuseTalk 逐句驱动口型，再用 ffmpeg 把 3D 分镜、配音与伴奏混音成一条成片。'
                }
              />
            )}
          </Panel>

          <Panel title={<span className="text-[12px]">口型检测报告</span>} aside={<Badge tone="muted">{rows.length} 句</Badge>} bodyClass="p-0">
            {reportError && <p className="px-4 py-2 text-[11px] text-error">报告读取失败：{reportError}</p>}
            {rows.length === 0 ? (
              <p className="px-4 py-3 text-[11px] text-muted">尚无逐句偏差数据（合成后生成）。</p>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="mono border-b border-hairline text-muted">
                  <tr>
                    <th className="px-3 py-1 font-normal">#</th>
                    <th className="px-3 py-1 font-normal">说话人</th>
                    <th className="px-3 py-1 font-normal">窗口</th>
                    <th className="px-3 py-1 font-normal">配音</th>
                    <th className="px-3 py-1 font-normal">偏差</th>
                    <th className="px-3 py-1 font-normal">口型</th>
                    <th className="px-3 py-1 font-normal">标记</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.line_id}
                      className={`cursor-pointer border-b border-hairline/60 hover:bg-elevated ${row.line_id === cursor ? 'bg-elevated' : ''}`}
                      onClick={() => {
                        setCursor(row.line_id)
                        seek(anchorOf(row, lines.find((l) => l.id === row.line_id)?.startMs ?? row.target_ms))
                      }}
                    >
                      <td className="mono px-3 py-1 text-muted">{String(row.index + 1).padStart(2, '0')}</td>
                      <td className="px-3 py-1 text-body">{row.speaker ?? '—'}</td>
                      <td className="mono px-3 py-1 text-muted">{row.target_ms}ms</td>
                      <td className="mono px-3 py-1 text-muted">{row.dub_ms === null ? '—' : `${row.dub_ms}ms`}</td>
                      <td className={`mono px-3 py-1 ${deviationTone(row.deviation_ms)}`}>{signed(row.deviation_ms)}</td>
                      <td className="mono px-3 py-1 text-muted">
                        {row.lipsync === 'done' ? `✓ ${row.lipsync_offset_ms ?? 0}ms` : row.lipsync === 'failed' ? <span className="text-error">失败</span> : row.lipsync === 'stale' ? <span className="text-warn">待重算</span> : '跳过'}
                      </td>
                      <td className="px-3 py-1">
                        <Badge tone={FLAG_TONE[row.flag]}>{row.flag === 'green' ? '通过' : row.flag === 'yellow' ? '时长压缩' : '口型待修'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      }
      aside={
        <>
          <StepDoc
            rows={[
              { k: '输入', v: '已接受的 3D 分镜 + 配音 + 伴奏轨 + SRT' },
              { k: '处理', v: 'MuseTalk 逐句口型驱动（本地）→ ffmpeg 合成' },
              { k: '混音', v: '伴奏原音量直接混入，不做 ducking（R4）' },
              { k: '字幕', v: '默认外挂 SRT，不烧进画面（R7）' },
              { k: '产物', v: 'final.mp4 + final.srt + report.json' }
            ]}
          />

          <StepParams title="运行本步骤">
            {!data.sidecar.online && (
              <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                <span>本地算力未启动：口型对齐会整体跳过（成片仍有配音）。到设置页「本地算力」启动。</span>
              </p>
            )}
            <Toggle checked={skipLipsync} onChange={setSkipLipsync} label="跳过口型对齐" hint="只想快速出一条检查配音与画面的版本时用" />
            <button type="button" className="btn btn-accent w-full" disabled={running} onClick={() => void run(6, { skipLipsync, name: name.trim() || null })}>
              {running ? <Spinner label="合成中" /> : <><Play size={13} /> 运行口型对齐·合成</>}
            </button>
            <button type="button" className="btn btn-ghost w-full" disabled={running || !product} onClick={() => void refreshReport()}>
              重新读取检测报告
            </button>
          </StepParams>

          <StepParams title="导出设置">
            <label className="flex flex-col gap-1">
              <span className="label">导出文件夹</span>
              <div className="flex items-center gap-1">
                <input value={destDir} disabled={exportBusy} onChange={(e) => setDestDir(e.target.value)} className="min-w-0 flex-1 rounded-input bg-canvas px-2 py-1 text-[12px] text-ink" placeholder="默认取设置页导出目录" />
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-[5px] text-[11px]"
                  onClick={async () => {
                    const res = await api.system.pick('directory', { title: '选择导出文件夹' })
                    if (res.path) setDestDir(res.path)
                  }}
                >
                  浏览
                </button>
              </div>
              <span className="text-[11px] text-muted">默认桌面；改到别的盘请在设置页保存。</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="label">文件名（不含扩展名）</span>
              <input value={name} disabled={exportBusy} onChange={(e) => setName(e.target.value)} placeholder={data.project.name} className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink" />
            </label>

            {settings && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="label">分辨率</span>
                  <select
                    value={settings.export.resolution}
                    disabled={exportBusy}
                    onChange={(e) => void saveSettings({ export: { ...settings.export, resolution: e.target.value === '720p' ? '720p' : '1080p' } })}
                    className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink"
                  >
                    <option value="1080p">1080p（默认）</option>
                    <option value="720p">720p（快速预览）</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">帧率</span>
                  <select
                    value={String(settings.export.fps)}
                    disabled={exportBusy}
                    onChange={(e) => void saveSettings({ export: { ...settings.export, fps: Number(e.target.value) } })}
                    className="rounded-input bg-canvas px-2 py-1 text-[12px] text-ink"
                  >
                    {['24', '25', '30', '50', '60'].map((f) => (
                      <option key={f} value={f}>
                        {f} fps{f === '30' ? '（默认）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <Toggle checked={settings.export.bilingualSrt} onChange={(v) => void saveSettings({ export: { ...settings.export, bilingualSrt: v } })} label="双语字幕（上英下中）" hint={`当前 ${settings.export.bilingualSrt ? '双语' : '仅英文'}；字幕始终外挂 .srt，不烧进画面`} />
              </>
            )}

            <button
              type="button"
              className="btn btn-accent w-full"
              disabled={exportBusy || running || !product}
              onClick={() => void exportFinal({ destDir: destDir.trim(), name: name.trim() || null })}
            >
              {exportBusy ? <Spinner label="导出中" /> : <><Save size={13} /> 导出到文件夹</>}
            </button>
            {product?.srt && (
              <p className="flex items-center gap-1 text-[11px] text-muted">
                <Captions size={12} /> 字幕 {fileName(product.srt)}
              </p>
            )}
          </StepParams>

          <Panel title={<span className="text-[12px]">合成概况</span>} bodyClass="px-4 py-2">
            <KeyVal k="句子数" v={String(lines.length)} mono />
            <KeyVal k="已接受分镜" v={`${data.project.stats.shot3dAccepted} / ${data.project.stats.shotCount}`} mono />
            <KeyVal k="配音完成" v={`${data.project.stats.dubDone} / ${data.project.stats.lineCount}`} mono />
            <KeyVal k="口型偏差>150ms" v={String(rows.filter((r) => r.deviation_ms !== null && Math.abs(r.deviation_ms) > 150).length)} mono />
            <KeyVal k="GPU" v={data.gpu.busy ? data.gpu.label ?? '占用中' : '空闲'} />
            {report && (
              <KeyVal
                k="生成时间"
                v={
                  <span className="flex items-center gap-1">
                    <Clock size={10} /> {new Date(report.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                }
              />
            )}
          </Panel>
        </>
      }
    />
  )
}

/** 时间轴标记：绿=通过 / 黄=时长压缩 / 红=口型待修 */
function Timeline({ rows, totalMs, cursor, onPick }: { rows: DeviationRowDto[]; totalMs: number; cursor: string | null; onPick: (row: DeviationRowDto) => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-[30px] w-full border border-hairline bg-canvas">
        {rows.map((row, i) => {
          const at = row.target_ms
          const left = totalMs > 0 ? Math.min(99.6, (at / totalMs) * 100) : 0
          const tone = row.flag === 'green' ? 'bg-success' : row.flag === 'yellow' ? 'bg-warn' : 'bg-error'
          return (
            <button
              key={row.line_id}
              type="button"
              title={`#${String(row.index + 1).padStart(2, '0')} ${msClock(at)} · ${row.note ?? row.flag}`}
              onClick={() => onPick(row)}
              className={`absolute bottom-0 top-0 w-[3px] ${tone} ${row.line_id === cursor ? 'w-[5px] ring-1 ring-ink' : 'opacity-80 hover:opacity-100'}`}
              style={{ left: `${left}%` }}
            >
              <span className="sr-only">{i}</span>
            </button>
          )
        })}
      </div>
      <div className="mono flex justify-between text-[10px] text-muted">
        <span>00:00</span>
        <span>绿=通过 · 黄=时长压缩 · 红=口型待修（点击跳转）</span>
        <span>{msClock(totalMs, false)}</span>
      </div>
    </div>
  )
}

function DeviationDetail({
  row,
  zhText,
  enText,
  onBackToTranslate,
  onBackToDub
}: {
  row: DeviationRowDto
  zhText: string
  enText: string
  onBackToTranslate: () => void
  onBackToDub: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 border border-hairline bg-canvas p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[11px] text-muted">#{String(row.index + 1).padStart(2, '0')}</span>
        <Badge tone={FLAG_TONE[row.flag]}>{row.flag === 'green' ? '通过' : row.flag === 'yellow' ? '时长压缩' : '口型待修'}</Badge>
        <span className="mono text-[11px] text-body">
          窗口 {row.target_ms}ms · 配音 {row.dub_ms === null ? '—' : `${row.dub_ms}ms`} · 偏差{' '}
          <span className={deviationTone(row.deviation_ms)}>{signed(row.deviation_ms)}</span>
        </span>
        {row.lipsync_offset_ms !== null && <span className="mono text-[11px] text-muted">口型偏移 {row.lipsync_offset_ms}ms</span>}
      </div>
      <p className="text-[12px] text-ink">{enText || '（无英文）'}</p>
      <p className="text-[11px] text-muted">{zhText}</p>
      {row.note && <p className="text-[11px] text-warn">{row.note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {row.flag !== 'green' && (
          <>
            <button type="button" className="btn btn-ghost px-2 py-[2px] text-[11px]" onClick={onBackToTranslate} title="问题多半出在译文长度：回步骤③改文案最便宜">
              查看问题句（回步骤③）
            </button>
            <button type="button" className="btn btn-ghost px-2 py-[2px] text-[11px]" onClick={onBackToDub} title="回步骤④重配这一句">
              重配此句（回步骤④）
            </button>
          </>
        )}
        <span className="ml-auto text-[11px] text-muted">回改上游会把下游产物标记为待重跑</span>
      </div>
    </div>
  )
}

function deviationTone(ms: number | null): string {
  if (ms === null) return 'text-muted'
  if (Math.abs(ms) <= 150) return 'text-success'
  return ms > 0 ? 'text-error' : 'text-warn'
}

/** 句标记定位：优先用句子起始锚点，缺省退回 target_ms */
function anchorOf(row: DeviationRowDto, fallback: number): number {
  return Math.max(0, fallback)
}
