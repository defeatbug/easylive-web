import { useEffect, useRef, useState } from 'react'
import { DevicePicker } from '../components/DevicePicker'
import { buildConstraints, useDevices } from '../lib/devices'
import { useImeGuard } from '../lib/ime'

export interface JoinRequest {
  roomId: string
  displayName: string
  micId?: string
  camId?: string
  micOn: boolean
  camOn: boolean
  /**
   * 会前页已经打开的预览流，交给 RoomClient 直接复用。
   * 不能序列化，所以不会被写进 sessionStorage（刷新后为 undefined，会重新申请）。
   */
  previewStream?: MediaStream | null
}

interface JoinPageProps {
  onJoin: (req: JoinRequest) => void
}

const randomName = () => `访客${Math.floor(Math.random() * 900 + 100)}`

/**
 * 会前页（对齐 LiveKit Meet 的 pre-join）：
 *   大预览 + 麦克风/摄像头选择器 + 昵称 + 蓝色大按钮。
 *
 * 为什么值得做：会前能看见自己、能选设备，是"这个系统是完整的"最直观的证据；
 * 答辩演示时也省掉"进去才发现摄像头选错了"的尴尬。
 */
export function JoinPage({ onJoin }: JoinPageProps) {
  const params = new URLSearchParams(location.search)
  const [roomId, setRoomId] = useState(params.get('room') ?? 'demo-room')
  const [displayName, setDisplayName] = useState(randomName())
  const [micId, setMicId] = useState<string | undefined>()
  const [camId, setCamId] = useState<string | undefined>()
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [preview, setPreview] = useState<MediaStream | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const ime = useImeGuard()
  /** 交接标记：置位后卸载时不再停掉预览流（所有权已交给 RoomClient） */
  const transferredRef = useRef(false)
  const { mics, cams, refresh } = useDevices()

  // 预览流：同时申请音频（不播放），这样设备名才是可读的而不是"麦克风 1"
  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null

    void navigator.mediaDevices
      .getUserMedia(buildConstraints({ micId, camId }, { audio: true, video: true }))
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        setPreview(s)
        refresh() // 授权后设备名才可用
        setHint(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setHint(`无法访问摄像头/麦克风：${e instanceof Error ? e.message : String(e)}`)
      })

    return () => {
      cancelled = true
      // 除非已把流交接给 RoomClient，否则切换设备/离开页面时要释放设备
      if (!transferredRef.current) stream?.getTracks().forEach((t) => t.stop())
    }
  }, [micId, camId, refresh])

  // 开关状态只影响预览画面是否显示（真实发布在入会后由 RoomClient 处理）
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== preview) el.srcObject = preview
    if (preview) void el.play().catch(() => {})
  }, [preview])

  /** 输入框里按回车会触发表单提交；输入法确认候选词的那次回车必须拦下来 */
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && ime.isImeEnter(e)) e.preventDefault()
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!roomId.trim() || !displayName.trim()) return

    // 把预览流的所有权交接给 RoomClient，而不是停掉再重新申请。
    //
    // 为什么：摄像头的释放是**异步**的。stop() 之后设备可能还被系统占用几百毫秒，
    // 紧接着的 getUserMedia 会偶发 NotReadableError/AbortError，入会就没有本地流，
    // 表现为"自己的卡片不显示"（而且只发生在两个访客中的某一个，取决于时机）。
    transferredRef.current = true
    onJoin({
      roomId: roomId.trim(),
      displayName: displayName.trim(),
      micId,
      camId,
      micOn,
      camOn,
      previewStream: preview,
    })
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--bg)] p-6">
      <form onSubmit={submit} className="w-full max-w-lg space-y-4">
        {/* 预览 */}
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[var(--surface)]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full -scale-x-100 object-cover ${camOn && preview ? '' : 'opacity-0'}`}
          />
          {(!camOn || !preview) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white/10 text-3xl font-medium text-neutral-300">
                {displayName.slice(0, 1).toUpperCase()}
              </div>
            </div>
          )}
        </div>

        {/* 设备选择 */}
        <div className="flex flex-wrap gap-2">
          <DevicePicker
            icon={<IconMic muted={!micOn} />}
            label={micOn ? '麦克风' : '麦克风已关'}
            title={micOn ? '关闭麦克风' : '开启麦克风'}
            active={micOn}
            devices={mics}
            currentId={micId}
            onToggle={() => setMicOn((v) => !v)}
            onSelect={setMicId}
            disabled={!micOn}
          />
          <DevicePicker
            icon={<IconCam muted={!camOn} />}
            label={camOn ? '摄像头' : '摄像头已关'}
            title={camOn ? '关闭摄像头' : '开启摄像头'}
            active={camOn}
            devices={cams}
            currentId={camId}
            onToggle={() => setCamOn((v) => !v)}
            onSelect={setCamId}
            disabled={!camOn}
          />
        </div>

        {/* 房间号 / 昵称 */}
        <div className="space-y-2">
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            onKeyDown={onInputKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            placeholder="房间号"
            className="w-full rounded-lg bg-[var(--surface-2)] px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:ring-1 focus:ring-[var(--accent)]"
          />
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={onInputKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            placeholder="你的昵称"
            maxLength={24}
            className="w-full rounded-lg bg-[var(--surface-2)] px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-[var(--accent)] py-3 text-sm font-medium text-white transition hover:brightness-110 active:scale-[0.99]"
        >
          加入房间
        </button>

        <p className="text-center text-[11px] leading-relaxed text-neutral-500">
          {hint ?? '先在会前页确认设备与昵称；局域网访问需要 HTTPS，后端需设置 SFU_ADVERTISE_IP。'}
        </p>
      </form>
    </div>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const IconMic = ({ muted }: { muted?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    {muted ? (
      <path d="M9 5a3 3 0 0 1 6 0v5M9 11a3 3 0 0 0 5.1 2.1M5 11a7 7 0 0 0 10.6 6M12 18v3M4 4l16 16" />
    ) : (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </>
    )}
  </svg>
)

const IconCam = ({ muted }: { muted?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    {muted ? (
      <path d="M15 10l6-3v10l-3-1.5M3 6h9a3 3 0 0 1 3 3v1M3 6v12h9M4 4l16 16" />
    ) : (
      <>
        <rect x="3" y="6" width="12" height="12" rx="2" />
        <path d="M15 10l6-3v10l-6-3z" />
      </>
    )}
  </svg>
)
