/**
 * 波形试听卡（SPEC-001 §7.2：wavesurfer.js；§3.2 双音轨 / §3.4 逐句配音 / §2 音色样本）。
 * 音频本体经 /api/files 流式读取，渲染层不碰文件系统。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { Pause, Play, Volume2 } from 'lucide-react'
import { fileUrl } from '@renderer/api/client'
import { cssVar } from '@renderer/util/theme'
import { msShort } from '@renderer/util/format'

export function WaveCard({
  path,
  label,
  note,
  height = 52,
  compact = false,
  actions
}: {
  path: string | null
  label?: ReactNode
  note?: ReactNode
  height?: number
  compact?: boolean
  actions?: ReactNode
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const url = fileUrl(path)

  useEffect(() => {
    const box = boxRef.current
    setPlaying(false)
    setFailed(false)
    if (!box || !path) return

    const ws = WaveSurfer.create({
      container: box,
      url,
      height,
      waveColor: cssVar('--color-muted', '#8b8b8b'),
      progressColor: cssVar('--color-accent', '#DA291C'),
      cursorColor: cssVar('--color-ink', '#f2f2f2'),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
      dragToSeek: true
    })
    wsRef.current = ws
    ws.on('ready', (duration) => setDurationMs(Math.round((duration || 0) * 1000)))
    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => setPlaying(false))
    ws.on('finish', () => setPlaying(false))
    ws.on('error', () => {
      setFailed(true)
      setPlaying(false)
    })
    return () => {
      ws.destroy()
      wsRef.current = null
    }
  }, [path, url, height])

  return (
    <div className={`flex items-center gap-3 border border-hairline bg-canvas ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}>
      <button
        type="button"
        className={`flex size-[26px] shrink-0 items-center justify-center border border-hairline text-ink transition-colors hover:bg-elevated disabled:text-muted ${
          // 灰底只给「正在播放」这个高亮态，平时是黑的
          playing ? 'bg-elevated' : 'bg-canvas'
        }`}
        disabled={!path || failed}
        title={playing ? '暂停' : '播放'}
        onClick={() => wsRef.current?.playPause()}
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        {(label || note) && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12px] text-ink">{label}</span>
            <span className="mono shrink-0 text-[10px] text-muted">{note}</span>
          </div>
        )}
        {!path ? (
          <div className="flex h-[22px] items-center gap-1 text-[11px] text-muted">
            <Volume2 size={12} /> 暂无音频产物
          </div>
        ) : failed ? (
          <div className="h-[22px] text-[11px] text-error">波形加载失败（文件可能尚未生成）</div>
        ) : (
          <div ref={boxRef} className="min-w-0" style={{ height: `${compact ? 24 : height}px` }} />
        )}
        {!compact && <div className="mono text-[10px] text-muted">{durationMs === null ? '—' : msShort(durationMs)}</div>}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  )
}
