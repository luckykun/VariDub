/**
 * 句子卡片（SPEC-001 §3.2 ASR 校对 / §3.3 人工校对重点 / §3.4 逐句配音）。
 * 编辑采用「本地草稿 + 失焦提交」，避免每 keystroke 一次 PATCH 导致下游 stale 风暴（§7.7-2）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Info, RotateCcw, SkipForward, Sparkles, TriangleAlert } from 'lucide-react'
import type { LineDto, OverflowPolicy } from '@shared/types'
import type { LinePatchRequest } from '@shared/api'
import { AnchorSlider } from '@renderer/components/AnchorSlider'
import { WaveCard } from '@renderer/components/WaveCard'
import { Badge, TONE_TEXT, type Tone } from '@renderer/components/ui'
import { msClock, msShort, signed } from '@renderer/util/format'

export type LineCardMode = 'asr' | 'translate' | 'dub'

const POLICY_LABEL: Record<OverflowPolicy, string> = {
  none: '未处理',
  compress: '精简译文（推荐）',
  freeze: '允许画面停顿'
}

export function LineCard({
  line,
  mode,
  totalMs,
  speakerLabel,
  shotIndex,
  busy = false,
  headerExtra,
  onPatch,
  onCommitAnchors,
  onConfirm,
  onRegenerate,
  onAltBatch,
  onJumpToShot
}: {
  line: LineDto
  mode: LineCardMode
  totalMs: number
  speakerLabel: string | null
  shotIndex: number | null
  busy?: boolean
  /** 说话人归属一类的行内控件 */
  headerExtra?: ReactNode
  onPatch: (body: LinePatchRequest) => void
  onCommitAnchors: (startMs: number, endMs: number) => void
  onConfirm: (confirmed: boolean) => void
  /** translate=重译此句，dub=重配此句 */
  onRegenerate?: () => void
  onAltBatch?: () => void
  onJumpToShot?: () => void
}): JSX.Element {
  const confirmed = line.confirmStatus === 'confirmed'
  const overflowing = line.overflowMs > 0
  const lowSimilarity = line.similarity !== null && line.similarity < 80

  return (
    <article
      className={`card flex flex-col gap-2 p-3 ${
        confirmed ? 'border-success/40' : overflowing || lowSimilarity ? 'border-error/40' : 'border-hairline'
      }`}
    >
      {/* 头：句号 / 说话人 / 分镜 / 时间码 */}
      <header className="flex flex-wrap items-center gap-2">
        <span className="mono text-[11px] text-muted">#{String(line.index).padStart(2, '0')}</span>
        {speakerLabel ? (
          <Badge tone="info">{speakerLabel}</Badge>
        ) : (
          <Badge tone="warn">
            <TriangleAlert size={10} /> 未归属说话人
          </Badge>
        )}
        <span className="mono text-[11px] text-body">
          {msClock(line.startMs)} → {msClock(line.endMs)}
        </span>
        <span className="mono text-[11px] text-muted">{msShort(line.endMs - line.startMs)}</span>

        {shotIndex !== null && (
          <button type="button" className="ml-auto flex items-center gap-1 text-[11px] text-muted hover:text-ink" onClick={onJumpToShot}>
            <SkipForward size={11} /> 分镜 #{String(shotIndex).padStart(2, '0')}
          </button>
        )}
        {line.anchorStale && (
          <Badge tone="warn">
            <RotateCcw size={10} /> 锚点已变更，下游待重跑
          </Badge>
        )}
        {headerExtra}
      </header>

      {/* 中文原文 */}
      {mode === 'asr' ? (
        <InlineEditor
          value={line.zhText}
          placeholder="（ASR 未识别到文本）"
          disabled={busy}
          className="min-h-[42px] text-[13px] text-ink"
          onCommit={(text) => onPatch({ zhText: text })}
        />
      ) : (
        <p className="text-[13px] leading-[1.5] text-ink">{line.zhText || '（空）'}</p>
      )}

      {/* 英文译文 */}
      {mode === 'translate' && (
        <div className="flex flex-col gap-2">
          <InlineEditor
            value={line.enText}
            placeholder="（尚无译文）"
            disabled={busy}
            accent
            className="min-h-[52px] text-[13px]"
            onCommit={(text) => onPatch({ enText: text })}
          />
          <div className="flex flex-col gap-1">
            <span className="label">AI 备选译文</span>
            {line.enAlts.length === 0 ? (
              <span className="text-[11px] text-muted">（无备选，点「重译此句」生成）</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {line.enAlts.map((alt, i) => (
                  <li key={`${line.id}-alt-${i}`}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onPatch({ enText: alt })}
                      className="w-full border border-hairline bg-canvas px-2 py-1 text-left text-[12px] text-body hover:border-accent hover:text-ink disabled:opacity-40"
                      title="点击用该备选替换当前译文"
                    >
                      <span className="mono mr-2 text-[10px] text-muted">{String(i + 1).padStart(2, '0')}</span>
                      {alt}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {mode === 'dub' && <p className="text-[12px] leading-[1.5] text-body">{line.enText || '（无译文，无法配音）'}</p>}

      {/* 俚语 / 梗 存疑标黄（§3.3） */}
      {line.slangFlag && (
        <p className="flex items-start gap-2 border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
          <Info size={12} className="mt-[2px] shrink-0" />
          <span>俚语/梗，语义存疑：{line.slangNote ?? '请人工确认译法'}</span>
        </p>
      )}

      {/* 锚点（②③ 可拖，④ 只读展示） */}
      <AnchorSlider
        startMs={line.startMs}
        endMs={line.endMs}
        totalMs={totalMs}
        overflowMs={line.overflowMs}
        disabled={busy || mode === 'dub'}
        onCommit={onCommitAnchors}
      />

      {/* 超支处理：全局策略 + 逐句二选一（§3.3） */}
      {mode === 'translate' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] ${overflowing ? 'text-error' : 'text-muted'}`}>
            {overflowing ? `译文时长超支 ${signed(line.overflowMs)}` : `时长可容纳（余量 ${signed(-line.overflowMs)}）`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {(['compress', 'freeze'] as OverflowPolicy[]).map((p) => (
              <button
                key={p}
                type="button"
                disabled={busy}
                onClick={() => onPatch({ overflowPolicy: p })}
                className={`border px-2 py-[2px] text-[11px] ${
                  line.overflowPolicy === p ? 'border-accent bg-accent/15 text-accent' : 'border-hairline text-muted hover:text-body'
                }`}
              >
                {POLICY_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 配音试听 + 相似度（§3.4） */}
      {mode === 'dub' && (
        <div className="flex flex-col gap-2">
          <WaveCard
            path={line.dubWavPath}
            compact
            label={`配音 ${msShort(line.dubDurationMs)}`}
            note={line.lipsyncStatus === 'done' ? '口型已对齐' : line.lipsyncStatus === 'stale' ? '口型待重算' : line.lipsyncStatus === 'failed' ? '口型失败' : '未做口型'}
          />
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={lowSimilarity ? 'text-error' : 'text-muted'}>
              音色相似度 <span className={`mono ${lowSimilarity ? 'text-error' : TONE_TEXT.success}`}>{line.similarity === null ? '—' : `${line.similarity.toFixed(0)}%`}</span>
            </span>
            {line.dubDurationMs !== null && (
              <span className="text-muted">
                实际时长偏差{' '}
                <span className={`mono ${signedSpan(line.dubDurationMs - (line.endMs - line.startMs))}`}>
                  {signed(line.dubDurationMs - (line.endMs - line.startMs))}
                </span>
              </span>
            )}
            {lowSimilarity && (
              <Badge tone="error">
                <TriangleAlert size={10} /> 低于 80%，建议重配
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* 底栏 */}
      <footer className="flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(!confirmed)}
          className={`btn btn-sm ${confirmed ? 'btn-ghost' : 'btn-accent'}`}
          title={confirmed ? '取消确认' : '确认本句（全句确认才解锁下一步）'}
        >
          <Check size={11} />
          {confirmed ? '已确认' : '确认本句'}
        </button>

        {onRegenerate && (
          <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={onRegenerate}>
            <RotateCcw size={11} />
            {mode === 'dub' ? '重配此句' : '重译此句'}
          </button>
        )}
        {onAltBatch && mode === 'translate' && (
          <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={onAltBatch}>
            <Sparkles size={11} />
            换一批备选
          </button>
        )}

        {overflowing && mode === 'translate' && line.overflowPolicy === 'none' && (
          <span className="text-[11px] text-error">超支句必须二选一后才能确认</span>
        )}
        <span className="mono ml-auto text-[10px] text-muted">{line.id.slice(0, 8)}</span>
      </footer>
    </article>
  )
}

function signedSpan(ms: number): string {
  const abs = Math.abs(ms)
  if (abs <= 150) return 'text-success'
  if (ms > 0) return 'text-error'
  return 'text-warn'
}

/** 本地草稿编辑框：失焦或 Ctrl+Enter 提交 */
function InlineEditor({
  value,
  placeholder,
  className = '',
  accent = false,
  disabled = false,
  onCommit
}: {
  value: string
  placeholder?: string
  className?: string
  accent?: boolean
  disabled?: boolean
  onCommit: (text: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  return (
    <textarea
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (draft !== value) onCommit(draft.trim())
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          setEditing(false)
          if (draft !== value) onCommit(draft.trim())
        }
      }}
      className={`w-full resize-y rounded-input px-2 py-1 leading-[1.5] ${accent ? 'text-ink' : 'text-body'} ${className}`}
    />
  )
}
