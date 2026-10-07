/**
 * 音色库卡片（SPEC-001 §4 屏 05：名称 + 标签 + 试听 + 来源 + 被引用计数）。
 * §7.3 禁止单字母圆形假图标，因此来源标识用 Mic 图标而非头像。
 */
import { useEffect, useState } from 'react'
import { FolderOpen, Mic, Play, Trash2 } from 'lucide-react'
import type { VoiceDto } from '@shared/types'
import { Badge, TONE_TEXT } from '@renderer/components/ui'
import { fileName, msShort } from '@renderer/util/format'

export function VoiceCard({
  voice,
  busy = false,
  selectable = false,
  selected = false,
  onPreview,
  onRename,
  onRemove,
  onSelect
}: {
  voice: VoiceDto
  busy?: boolean
  /** 步骤④里作为「从音色库挑选」的选择器使用 */
  selectable?: boolean
  selected?: boolean
  onPreview?: () => void
  onRename?: (name: string) => void
  onRemove?: () => void
  onSelect?: () => void
}): JSX.Element {
  const [name, setName] = useState(voice.name)
  useEffect(() => setName(voice.name), [voice.name])

  const cloned = voice.sourceType === 'cloned'

  return (
    <article
      className={`card flex flex-col gap-2 p-3 ${selected ? 'border-accent' : 'border-hairline'} ${
        selectable ? 'cursor-pointer hover:border-muted' : ''
      }`}
      onClick={selectable ? onSelect : undefined}
    >
      <header className="flex items-center gap-2">
        <span className={`flex size-[26px] shrink-0 items-center justify-center border border-hairline bg-canvas ${TONE_TEXT[cloned ? 'accent' : 'info']}`}>
          <Mic size={14} />
        </span>

        {onRename && !selectable ? (
          <input
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim()
              if (trimmed && trimmed !== voice.name) onRename(trimmed)
            }}
            className="min-w-0 flex-1 rounded-input bg-transparent px-1 py-[2px] text-[13px] text-ink hover:bg-canvas"
            title="点击重命名"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{voice.name}</span>
        )}

        <Badge tone={cloned ? 'accent' : 'info'}>{cloned ? '克隆' : '预置'}</Badge>
      </header>

      {voice.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {voice.tags.map((tag) => (
            <span key={tag} className="border border-hairline bg-canvas px-[6px] py-[1px] text-[10px] text-muted">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span title={voice.samplePath ?? ''}>样本 {voice.samplePath ? `${fileName(voice.samplePath)} · ${msShort(voice.durationMs)}` : '—'}</span>
        <span className={voice.refCount > 0 ? 'text-body' : ''}>被引用 {voice.refCount} 次</span>
        {voice.originProjectName && (
          <span className="flex items-center gap-1">
            <FolderOpen size={10} /> {voice.originProjectName}
          </span>
        )}
      </div>

      <footer className="flex items-center gap-1 border-t border-hairline pt-2">
        {onPreview && (
          <button type="button" disabled={busy || !voice.samplePath} className="btn btn-ghost btn-sm" onClick={onPreview} title="试听">
            <Play size={11} />
            试听
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            disabled={busy}
            className="ml-auto p-[2px] text-muted hover:text-error"
            title={`删除音色${voice.refCount > 0 ? `（仍被 ${voice.refCount} 处引用，引用方的映射会被清空）` : ''}`}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </button>
        )}
      </footer>
    </article>
  )
}
