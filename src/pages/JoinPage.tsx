import { useEffect, useRef, useState } from 'react'
import { DevicePicker } from '../components/DevicePicker'
import {
  IconCalendar,
  IconCam,
  IconContacts,
  IconDoc,
  IconLink,
  IconMic,
  IconPlus,
  IconSettings,
  IconShield,
  IconVideo,
} from '../components/Icons'
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
  /** 以主持人身份加入（申请 roomAdmin 权限）。仅演示用：生产应由登录鉴权决定 */
  asAdmin?: boolean
}

interface JoinPageProps {
  onJoin: (req: JoinRequest) => void
}

const randomName = () => `访客${Math.floor(Math.random() * 900 + 100)}`
const randomRoom = () => `room-${Math.random().toString(36).slice(2, 8)}`

/**
 * 会前页：布局对齐腾讯会议 macOS 客户端。
 *
 *   左侧竖排导航（会议/通讯录/文档/设置）+ 中间"加入会议"卡片 + 右侧"入会前设置"预览。
 *
 * 布局是从它的出厂资源里读出来的：主导航对应 home_group / relationship_group /
 * cooperation_group 三个功能模块组，文档入口对应 WWLink 里的 icon_doc/icon_slide/icon_excel，
 * 而"每个图标都有浅色/深色两套"的约定决定了这里用 currentColor 而不是写死颜色。
 *
 * 功能上仍然保留我们原有的全部能力：实时预览、设备选择、昵称、主持人申请、
 * 以及把预览流**交接**给 RoomClient（避免 stop/start 之间摄像头被占用导致的偶发失败）。
 */
export function JoinPage({ onJoin }: JoinPageProps) {
  const params = new URLSearchParams(location.search)
  const [roomId, setRoomId] = useState(params.get('room') ?? 'demo-room')
  const [displayName, setDisplayName] = useState(randomName())
  const [micId, setMicId] = useState<string | undefined>()
  const [camId, setCamId] = useState<string | undefined>()
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [asAdmin, setAsAdmin] = useState(false)
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
      asAdmin,
    })
  }

  /** 快速会议：随机房间号 + 默认昵称直接进会，对应客户端的"快速会议" */
  const quickStart = () => {
    transferredRef.current = true
    onJoin({
      roomId: randomRoom(),
      displayName: displayName.trim() || randomName(),
      micId,
      camId,
      micOn,
      camOn,
      previewStream: preview,
      asAdmin,
    })
  }

  const navItems = [
    { icon: <IconVideo size={22} />, label: '会议', active: true },
    { icon: <IconContacts size={22} />, label: '通讯录', active: false },
    { icon: <IconDoc size={22} />, label: '文档', active: false },
    { icon: <IconCalendar size={22} />, label: '预定', active: false },
  ]

  return (
    <div className="flex min-h-full bg-[var(--bg)]">
      {/* ---------- 左侧竖排导航（对齐客户端主导航）---------- */}
      <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-[var(--line)] bg-[var(--surface)] py-4">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-strong)] text-sm font-semibold text-white">
          E
        </div>
        {navItems.map((it) => (
          <button
            key={it.label}
            type="button"
            title={it.label}
            className={`flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition ${
              it.active
                ? 'bg-[var(--brand-tint)] text-[var(--brand-strong)]'
                : 'text-[var(--text-dim)] hover:bg-[var(--surface-2)]'
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <button
            type="button"
            title="设置"
            className="flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[11px] text-[var(--text-dim)] transition hover:bg-[var(--surface-2)]"
          >
            <IconSettings size={22} />
            设置
          </button>
          <div className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-3)] text-xs font-medium text-[var(--text-dim)]">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        </div>
      </nav>

      {/* ---------- 主区 ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between px-8 pt-6">
          <div>
            <h1 className="text-[15px] font-semibold text-[var(--text)]">Easylive 会议</h1>
            <p className="mt-0.5 text-[11px] text-[var(--text-mute)]">
              基于 WebRTC 的轻量级实时音视频会议系统 · 单节点 SFU
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--brand-tint)] px-2.5 py-1 text-[11px] text-[var(--brand-strong)]">
              {preview ? '设备就绪' : '等待设备授权'}
            </span>
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 content-start items-start gap-6 p-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* 左：加入会议卡片 */}
          <form onSubmit={submit} className="tm-card p-6">
            <div className="mb-5 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand-tint)] text-[var(--brand-strong)]">
                <IconPlus size={18} />
              </span>
              <div>
                <h2 className="text-sm font-semibold">加入会议</h2>
                <p className="text-[11px] text-[var(--text-mute)]">输入会议号与昵称，或直接快速开会</p>
              </div>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs text-[var(--text-dim)]">会议号 / 房间号</span>
                <input
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  placeholder="例如 demo-room"
                  className="tm-input"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-[var(--text-dim)]">你的昵称</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  placeholder="会中显示的名字"
                  maxLength={24}
                  className="tm-input"
                />
              </label>
            </div>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-[var(--text-dim)]">
              <input
                type="checkbox"
                checked={asAdmin}
                onChange={(e) => setAsAdmin(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--brand-strong)]"
              />
              <IconShield size={14} />
              以主持人身份加入（可强制静音 / 移出参与者）
            </label>

            <div className="mt-5 flex gap-3">
              <button type="submit" className="tm-btn-primary flex-1 py-2.5 text-sm">
                加入房间
              </button>
              <button type="button" onClick={quickStart} className="tm-btn px-4 py-2.5 text-sm">
                快速会议
              </button>
            </div>

            {/* data-testid：探针原来用 "form 里第一个 p" 定位这句提示，属于隐式耦合——
                卡片副标题一变就会误抓。给它一个显式钩子，文案布局怎么改都不会误判。 */}
            <p
              data-testid="prejoin-hint"
              className="mt-4 text-[11px] leading-relaxed text-[var(--text-mute)]"
            >
              {hint ?? '会前先确认设备与昵称；局域网访问需要 HTTPS，后端需设置 SFU_ADVERTISE_IP。'}
            </p>
          </form>

          {/* 右：入会前设置（预览 + 设备） */}
          <section className="tm-card flex flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">入会前设置</h2>
              <button
                type="button"
                onClick={() => refresh()}
                className="rounded-md px-2 py-1 text-[11px] text-[var(--text-dim)] transition hover:bg-[var(--surface-2)]"
                title="重新枚举设备"
              >
                刷新设备
              </button>
            </div>

            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-[#0d0f12]">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`h-full w-full -scale-x-100 object-cover ${camOn && preview ? '' : 'opacity-0'}`}
              />
              {(!camOn || !preview) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--brand-strong)]/85 text-2xl font-medium text-white">
                    {displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="text-[11px] text-white/70">
                    {camOn ? '等待摄像头画面…' : '摄像头已关闭'}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <DevicePicker
                icon={<IconMic size={18} muted={!micOn} />}
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
                icon={<IconCam size={18} muted={!camOn} />}
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

            <div className="mt-4 rounded-lg bg-[var(--surface-2)] p-3">
              <div className="flex items-center gap-2 text-[11px] text-[var(--text-dim)]">
                <IconLink size={14} />
                邀请链接会带上会议号，可直接分享
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
