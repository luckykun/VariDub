/**
 * 分镜卡（§3.1 预览缩略网格 / §3.5 3D 重绘网格）。
 * variant=step1 显示原分镜缩略图与切点操作；variant=step5 显示 3D 关键帧/片段与接受状态。
 */
import { Check, ChevronRight, Copy, Scissors, Trash2, Wand2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ShotDto } from '@shared/types'
import { fileUrl } from '@renderer/api/client'
import { Badge, Meter, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { ShotAcceptChip } from '@renderer/components/StatusChip'
import { msClock, msShort, pct } from '@renderer/util/format'

const SOURCE_LABEL: Record<ShotDto['source'], string> = {
  vl: '云端视觉理解',
  pyscenedetect: '本地分镜检测',
  manual: '人工切分'
}

export function ShotCard({
  shot,
  variant,
  active = false,
  selected = false,
  busy = false,
  onSelect,
  onAccept,
  onReject,
  onRegenerate,
  onSplit,
  onMerge,
  onRemove
}: {
  shot: ShotDto
  variant: 'step1' | 'step5'
  active?: boolean
  selected?: boolean
  busy?: boolean
  onSelect?: () => void
  onAccept?: () => void
  onReject?: () => void
  onRegenerate?: () => void
  onSplit?: () => void
  onMerge?: () => void
  onRemove?: () => void
}): JSX.Element {
  const preview = variant === 'step5' ? shot.frame3dPath ?? shot.clip3dPath ?? shot.thumbPath : shot.thumbPath
  const consistency = shot.consistencyScore
  const consistencyTone: Tone = consistency === null ? 'muted' : consistency >= 0.85 ? 'success' : consistency >= 0.7 ? 'warn' : 'error'

  return (
    <article
      className={`card flex flex-col overflow-hidden transition-colors ${
        active ? 'border-accent' : selected ? 'border-info' : 'border-hairline hover:border-muted'
      }`}
    >
      <button type="button" className="relative block aspect-video w-full bg-canvas text-left" onClick={onSelect} title="查看该分镜">
        {preview ? (
          <img src={fileUrl(preview)} alt={`分镜 ${shot.index}`} className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-[11px] text-muted">无缩略图</span>
        )}
        <span className="mono absolute left-1 top-1 bg-canvas/80 px-1 text-[10px] text-ink">#{String(shot.index).padStart(2, '0')}</span>
        {shot.isPilot && (
          <span className="absolute right-1 top-1">
            <Badge tone="info">
              <Wand2 size={10} /> 试跑基准
            </Badge>
          </span>
        )}
        <span className="mono absolute bottom-1 left-1 bg-canvas/80 px-1 text-[10px] text-body">
          {msClock(shot.startMs, false)} → {msClock(shot.endMs, false)} · {msShort(shot.endMs - shot.startMs)}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-2">
        <p className="line-clamp-2 text-[12px] leading-[1.45] text-body" title={shot.sceneDesc}>
          {shot.sceneDesc || '（无场景描述）'}
        </p>

        <div className="flex flex-wrap items-center gap-1">
          {variant === 'step5' ? <ShotAcceptChip status={shot.acceptStatus} /> : <Badge tone="muted">{SOURCE_LABEL[shot.source]}</Badge>}
          {shot.persons.length > 0 && <Badge tone="muted">{shot.persons.join(' / ')}</Badge>}
        </div>

        {variant === 'step5' && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted">人脸一致性</span>
              <span className={`mono ${TONE_TEXT[consistencyTone]}`}>{pct(consistency)}</span>
            </div>
            <Meter value={consistency ?? 0} tone={consistencyTone} />
          </div>
        )}

        {shot.error && <p className="line-clamp-2 text-[11px] text-error" title={shot.error}>{shot.error}</p>}

        <div className="mt-auto flex items-center gap-1 border-t border-hairline pt-2">
          {variant === 'step1' && (
            <>
              <IconButton title="从中间拆分" disabled={busy || !onSplit} onClick={onSplit}>
                <Scissors size={12} />
              </IconButton>
              <IconButton title="与上一分镜合并" disabled={busy || !onMerge || shot.index <= 1} onClick={onMerge}>
                <Copy size={12} />
              </IconButton>
              <IconButton title="删除分镜" danger disabled={busy || !onRemove} onClick={onRemove}>
                <Trash2 size={12} />
              </IconButton>
            </>
          )}
          {variant === 'step5' && (
            <>
              <IconButton title="接受该 3D 分镜" tone="success" disabled={busy || !onAccept || shot.acceptStatus === 'accepted'} onClick={onAccept}>
                <Check size={12} />
              </IconButton>
              <IconButton title="拒绝并要求重做" danger disabled={busy || !onReject} onClick={onReject}>
                <X size={12} />
              </IconButton>
              <IconButton title="重新生成该分镜" disabled={busy || !onRegenerate} onClick={onRegenerate}>
                <Wand2 size={12} />
              </IconButton>
            </>
          )}
          <span className="mono ml-auto text-[10px] text-muted">{shot.styleId}</span>
          {onSelect && (
            <button type="button" className="text-muted hover:text-ink" title="查看详情" onClick={onSelect}>
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function IconButton({
  title,
  danger = false,
  tone,
  disabled = false,
  onClick,
  children
}: {
  title: string
  danger?: boolean
  tone?: 'success'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}): JSX.Element {
  const color = danger ? 'hover:text-error' : tone === 'success' ? 'hover:text-success' : 'hover:text-ink'
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`p-[2px] text-muted disabled:opacity-30 ${color}`}>
      {children}
    </button>
  )
}
