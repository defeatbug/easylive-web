import { useMemo } from 'react'
import type { AISummaryState } from '../lib/protocol'
import { renderMarkdown } from '../lib/markdown'
import { IconAISummary } from './Icons'

interface AISummaryPanelProps {
  summary: AISummaryState
  onStart: () => void
  onStop: () => void
  starting: boolean
}

/**
 * AI 会议总结面板：一个实时更新的 markdown 文档。
 *
 * 三种状态：
 *  1. 未启动 → 空态 + "开始总结"按钮
 *  2. 运行中但纪要还没生成 → "正在聆听…"（转写 + 首版纪要需要 1~2 分钟）
 *  3. 有纪要 → 渲染 markdown，服务端推送更新时自动刷新
 */
export function AISummaryPanel({ summary, onStart, onStop, starting }: AISummaryPanelProps) {
  const html = useMemo(
    () => (summary.markdown ? renderMarkdown(summary.markdown) : ''),
    [summary.markdown],
  )

  if (!summary.active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-[var(--text-mute)]">
          <IconAISummary size={40} />
        </span>
        <p className="text-sm font-medium">AI 会议总结</p>
        <p className="text-xs leading-relaxed text-[var(--text-mute)]">
          开始后，AI 会实时转写会议语音，
          <br />
          并持续生成一份可阅读的纪要文档。
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="tm-btn-primary mt-1 px-4 py-2 text-sm disabled:opacity-50"
        >
          {starting ? '启动中…' : '开始总结'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-[var(--text-mute)]">
          <span className="tm-pulse inline-block h-2 w-2 rounded-full bg-emerald-400" />
          {summary.markdown ? '实时更新中' : '正在聆听会议内容…'}
          {summary.segmentCount ? ` · 已转写 ${summary.segmentCount} 段` : ''}
        </div>
        <button
          type="button"
          onClick={onStop}
          className="rounded px-2 py-1 text-xs text-[var(--text-mute)] hover:bg-white/5 hover:text-[var(--danger)]"
          title="停止 AI 总结（转写与纪要生成都会停）"
        >
          停止
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {summary.markdown ? (
          <article
            className="md-doc text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="tm-pulse text-[var(--text-mute)]">
              <IconAISummary size={32} />
            </span>
            <p className="text-xs text-[var(--text-mute)]">
              已开始转写，首版纪要约 1~2 分钟后生成…
            </p>
          </div>
        )}
      </div>
      {summary.updatedAt ? (
        <div className="border-t border-white/5 px-4 py-1.5 text-[11px] text-[var(--text-mute)]">
          更新于 {new Date(summary.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          {summary.startedByName ? ` · 由 ${summary.startedByName} 发起` : ''}
        </div>
      ) : null}
    </div>
  )
}
