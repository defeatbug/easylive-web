import { useEffect, useState } from 'react'
import {
  formatBytes,
  formatDuration,
  type RecordingSession,
  type RecordingsResponse,
} from '../lib/recordings'

interface RecordingsPanelProps {
  /** 拉取列表（由 RoomClient 提供，失败返回 null） */
  onLoad: () => Promise<RecordingsResponse | null>
  onClose: () => void
}

/**
 * 录制列表（仅主持人可见/可用）。
 *
 * 为什么是"列表 + 下载 + 复制命令"而不是内置播放器：服务端坚持**零转码**落盘
 * （每轨一个 IVF/Ogg，写盘即转发，不占 CPU、不引入 ffmpeg 依赖），而浏览器
 * <video> 不支持 IVF 容器。所以列表给出文件、大小、时长与**现成的 ffmpeg 命令**，
 * 让使用者在自己的机器上一条命令转成 mp4——这比为了"能预览"而在服务端引入转码
 * 或自研 muxer 更符合这个项目的取舍（README 里同样写明了这一点）。
 */
export function RecordingsPanel({ onLoad, onClose }: RecordingsPanelProps) {
  const [data, setData] = useState<RecordingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    void onLoad().then((d) => {
      setData(d)
      setLoading(false)
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      /* 剪贴板不可用时静默：命令本身已经显示在界面上，可手动选中复制 */
    }
  }

  return (
    <div
      className="tm-anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="tm-anim-pop theme-meeting flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">会议录制</h2>
          {data?.recording.active && (
            <span className="flex items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 tm-pulse" />
              正在录制
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="tm-btn px-2.5 py-1 text-[11px]"
              title="重新读取列表"
            >
              {loading ? '读取中…' : '刷新'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[var(--text-dim)] transition hover:bg-[var(--surface-2)]"
              title="关闭"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && <p className="py-8 text-center text-xs text-[var(--text-mute)]">正在读取录制列表…</p>}

          {!loading && data === null && (
            <p className="py-8 text-center text-xs text-red-400">
              无法读取录制列表（服务端未响应；生产环境下 /recordings 需要 X-API-Key）
            </p>
          )}

          {!loading && data && !data.enabled && (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-4 text-xs leading-relaxed text-[var(--text-dim)]">
              <p className="font-medium text-[var(--text)]">服务端未开启录制能力</p>
              <p className="mt-1">
                在服务端 <code className="rounded bg-[var(--surface-3)] px-1">.env</code> 里设置{' '}
                <code className="rounded bg-[var(--surface-3)] px-1">RECORD_ENABLED=true</code> 并重启 api，
                之后主持人就能在会中随时开始/结束录制。
              </p>
            </div>
          )}

          {!loading && data?.enabled && data.sessions.length === 0 && (
            <p className="py-8 text-center text-xs text-[var(--text-mute)]">还没有录制。主持人点"录制"即可开始。</p>
          )}

          {!loading &&
            data?.enabled &&
            data.sessions.map((s) => <SessionCard key={s.id} session={s} onCopy={copy} copied={copied} />)}
        </div>

        {data?.dir && (
          <footer className="shrink-0 border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--text-mute)]">
            服务端录制目录：<code>{data.dir}</code>
          </footer>
        )}
      </div>
    </div>
  )
}

function SessionCard({
  session,
  onCopy,
  copied,
}: {
  session: RecordingSession
  onCopy: (text: string) => void
  copied: string | null
}) {
  const started = new Date(session.startedAt)
  const live = !session.endedAt
  const totalBytes = session.files.reduce((n, f) => n + f.sizeBytes, 0)
  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-[var(--line)]">
      <header className="flex flex-wrap items-center gap-2 bg-[var(--surface-2)] px-3 py-2 text-xs">
        <span className="font-medium text-[var(--text)]">{started.toLocaleString()}</span>
        <span className="text-[var(--text-mute)]">房间 {session.roomId}</span>
        <span className="text-[var(--text-mute)]">发起人 {session.startedBy}</span>
        <span className="ml-auto text-[var(--text-mute)]">
          {session.files.length} 个文件 · {formatBytes(totalBytes)}
          {live && <span className="ml-2 text-red-400">录制中</span>}
        </span>
      </header>
      <ul className="divide-y divide-[var(--line)]">
        {session.files.map((f) => (
          <li key={f.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span
              className={`rounded px-1.5 py-0.5 ${
                f.kind === 'video' ? 'bg-[var(--brand-tint)] text-[var(--brand)]' : 'bg-emerald-500/15 text-emerald-400'
              }`}
            >
              {f.kind === 'video' ? '画面' : '声音'}
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--text-dim)]" title={f.name}>
              {f.name}
            </span>
            <span className="text-[var(--text-mute)]">{formatBytes(f.sizeBytes)}</span>
            <span className="text-[var(--text-mute)]">{formatDuration(f.durationMs)}</span>
            {f.kind === 'video' && (
              <span className="text-[var(--text-mute)]">
                {f.frames} 帧{f.corrupt > 0 ? `（丢包丢帧 ${f.corrupt}）` : ''}
              </span>
            )}
            <button
              type="button"
              className="tm-btn px-2 py-0.5 text-[11px]"
              onClick={() => onCopy(f.ffmpegHint)}
              title="复制把该文件转成 mp4 的命令"
            >
              {copied === f.ffmpegHint ? '已复制 ✓' : '复制转码命令'}
            </button>
            <a
              className="tm-btn px-2 py-0.5 text-[11px]"
              href={`/recordings/${encodeURIComponent(session.id)}/${encodeURIComponent(f.name)}`}
              download={f.name}
              title="下载原始文件"
            >
              下载
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
