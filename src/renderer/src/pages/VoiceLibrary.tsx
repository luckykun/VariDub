/** 屏 05 音色库（SPEC-001 §4：纯资产管理 —— 全部/克隆/预置筛选 + 试听 + 来源 + 被引用计数 + 克隆新音色） */
import { useEffect, useState } from 'react'
import { Mic, Plus, RotateCcw, Upload, X } from 'lucide-react'
import type { VoiceDto } from '@shared/types'
import type { VoiceCreateRequest } from '@shared/api'
import { api } from '@renderer/api/client'
import { Badge, EmptyState, Field, Panel, Spinner } from '@renderer/components/ui'
import { VoiceCard } from '@renderer/components/VoiceCard'
import { useVoicesStore } from '@renderer/stores/voicesStore'
import { fileName } from '@renderer/util/format'

type Filter = 'all' | 'cloned' | 'preset'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'cloned', label: '克隆' },
  { key: 'preset', label: '预置' }
]

export function VoiceLibrary(): JSX.Element {
  const store = useVoicesStore()
  const [cloning, setCloning] = useState(false)

  useEffect(() => {
    void store.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <header className="flex items-center gap-3">
        <div>
          <h1 className="font-display text-[18px] text-ink">音色库</h1>
          <p className="text-[12px] text-muted">跨项目复用的嗓音资产。预置音色走同一 TTS；克隆音色来自某项目的干净人声样本。</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center border border-hairline">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => store.setFilter(f.key)}
                className={`px-3 py-[5px] text-[12px] transition-colors ${store.filter === f.key ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated/50 hover:text-body'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-accent" onClick={() => setCloning(true)}>
            <Plus size={13} />
            克隆新音色
          </button>
        </div>
      </header>

      {store.previewUrl && (
        // 只在「正在试听」这一刻存在，属于高亮态，所以允许灰底
        <div className="flex items-center gap-3 border border-hairline bg-elevated px-3 py-2">
          <Badge tone="accent">
            <Mic size={10} /> 试听
          </Badge>
          <audio className="h-[30px] flex-1" src={store.previewUrl} controls autoPlay />
          <button type="button" className="p-[2px] text-muted hover:text-ink" onClick={store.clearPreview} title="关闭">
            <X size={12} />
          </button>
        </div>
      )}

      {cloning && <ClonePanel busy={store.busy} onClose={() => setCloning(false)} onCreate={store.create} />}

      <Panel
        title={
          <span className="flex items-center gap-2 text-[13px]">
            <Mic size={14} /> 音色
            <span className="mono text-[11px] text-muted">{store.items.length}</span>
          </span>
        }
        aside={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void store.refresh()}>
            <RotateCcw size={11} />
            刷新
          </button>
        }
        bodyClass="p-4"
      >
        {store.loading && store.items.length === 0 ? (
          <Spinner label="读取音色库" />
        ) : store.items.length === 0 ? (
          <EmptyState
            icon={<Mic size={26} />}
            text="这里还没有音色。预置音色（Sofia / Marcus / 播音员 / Vivi）在首次启动时自动入库；也可以点右上「克隆新音色」用一段干净人声样本复刻。"
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {store.items.map((voice) => (
              <VoiceCard
                key={voice.id}
                voice={voice}
                busy={store.busy}
                onPreview={() => void store.preview(voice.id)}
                onRename={(name) => void store.update(voice.id, { name })}
                onRemove={() => void store.remove(voice.id)}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/** 克隆新音色：本地样本 → 云端音色复刻（§3.4 音色来源③） */
function ClonePanel({
  busy,
  onClose,
  onCreate
}: {
  busy: boolean
  onClose: () => void
  onCreate: (body: VoiceCreateRequest) => Promise<VoiceDto | null>
}): JSX.Element {
  const [name, setName] = useState('')
  const [sample, setSample] = useState<string | null>(null)
  const [tags, setTags] = useState('')

  return (
    <Panel
      title={<span className="text-[13px]">克隆新音色</span>}
      aside={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <X size={11} />
          收起
        </button>
      }
      bodyClass="p-4"
    >
      <div className="flex flex-col gap-3">
        <p className="text-[11px] leading-[1.6] text-muted">
          样本要求：≥3 秒清晰单人人声（推荐 10–20 秒，无 BGM、无重叠说话）。可直接选项目里的 `voice_samples/*.wav`，也可选本地任意 WAV。
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="音色名称" className="min-w-[200px] flex-1">
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="例如：男主持-热血" />
          </Field>
          <Field label="标签（逗号分隔）" className="min-w-[200px] flex-1">
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="男声, 中年, 综艺" />
          </Field>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const res = await api.system.pick('audio', { title: '选择人声样本（WAV）' })
              setSample(res.path)
            }}
          >
            <Upload size={13} />
            选择样本
          </button>
        </div>

        <div className="mono truncate border border-hairline bg-canvas px-2 py-1 text-[11px] text-muted" title={sample ?? ''}>
          {sample ? fileName(sample) : '尚未选择样本文件'}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || !name.trim() || !sample}
            onClick={async () => {
              const created = await onCreate({
                name: name.trim(),
                samplePath: sample,
                tags: tags
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 8),
                sourceType: 'cloned'
              })
              if (created) {
                setName('')
                setSample(null)
                setTags('')
                onClose()
              }
            }}
          >
            {busy ? <Spinner label="复刻中" /> : <Mic size={13} />}
            开始克隆
          </button>
          <span className="text-[11px] text-muted">克隆会调用云端 TTS 音色复刻，按订阅额度计费。</span>
        </div>
      </div>
    </Panel>
  )
}
