/**
 * 录制会话（服务端 /recordings 的返回结构）与拉取。
 *
 * 为什么要单独一个模块：录制列表不是信令消息（它是一次性的 HTTP 查询），
 * 而"是否正在录制"是信令（服务端广播）。两者来源不同，但展示在同一处，
 * 所以类型放在一起、职责分开写清楚。
 */
export type RecordingFileKind = 'video' | 'audio'

export interface RecordingFile {
  name: string
  kind: RecordingFileKind
  source: string
  participant: string
  sizeBytes: number
  frames: number
  dropped: number
  corrupt: number
  durationMs: number
  /** 零转码转成 mp4 的一行 ffmpeg 命令（服务端不装 ffmpeg，交给本机执行） */
  ffmpegHint: string
}

export interface RecordingSession {
  id: string
  roomId: string
  startedAt: string
  endedAt?: string
  startedBy: string
  files: RecordingFile[]
}

export interface RecordingState {
  active: boolean
  sessionId?: string
  startedAt?: number
  startedBy?: string
  files?: number
}

export interface RecordingsResponse {
  enabled: boolean
  recording: RecordingState
  sessions: RecordingSession[]
  /** 服务端录制根目录，显示给运维看 */
  dir?: string
}

/** 拉注册制列表。失败时返回 null（UI 显示"读取失败"，不抛错打断会议）。 */
export async function fetchRecordings(): Promise<RecordingsResponse | null> {
  try {
    const resp = await fetch('/recordings')
    if (!resp.ok) return null
    return (await resp.json()) as RecordingsResponse
  } catch {
    return null
  }
}

/** 人类可读的大小/时长（列表里每行都要显示，放这里避免组件里重复写）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`
}
