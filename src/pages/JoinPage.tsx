import { useEffect, useRef, useState } from 'react'
import { AccountDialog } from '../components/AccountDialog'
import { DevicePicker } from '../components/DevicePicker'
import {
  IconCalendar,
  IconCam,
  IconCheck,
  IconCopy,
  IconLink,
  IconMic,
  IconPlus,
  IconShield,
  IconStats,
  IconVideo,
} from '../components/Icons'
import { buildConstraints, useDevices } from '../lib/devices'
import { useImeGuard } from '../lib/ime'
import { initialsOf } from '../lib/avatar'
import type { AccountUser } from '../lib/auth'

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
  user: AccountUser | null
  onLogout: () => Promise<void>
  /** 账号资料变更后回传最新用户，顶栏与会前页首字母随之刷新 */
  onUserChange: (user: AccountUser) => void
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
export function JoinPage({ onJoin, user, onLogout, onUserChange }: JoinPageProps) {
  const params = new URLSearchParams(location.search)
  const [roomId, setRoomId] = useState(params.get('room') ?? 'demo-room')
  const [displayName, setDisplayName] = useState(() => user?.displayName || user?.username || randomName())
  const [micId, setMicId] = useState<string | undefined>()
  const [camId, setCamId] = useState<string | undefined>()
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [asAdmin, setAsAdmin] = useState(false)
  const [preview, setPreview] = useState<MediaStream | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deviceRetry, setDeviceRetry] = useState(0)
  /** 账号中心弹窗：左下角头像与顶栏账号都能打开它 */
  const [accountOpen, setAccountOpen] = useState(false)

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
        if (!cancelled) {
          setPreview(null)
          setHint(`无法访问摄像头/麦克风：${e instanceof Error ? e.message : String(e)}`)
        }
      })

    return () => {
      cancelled = true
      // 除非已把流交接给 RoomClient，否则切换设备/离开页面时要释放设备
      if (!transferredRef.current) stream?.getTracks().forEach((t) => t.stop())
    }
  }, [micId, camId, refresh, deviceRetry])

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

  const copyInvite = async () => {
    if (!roomId.trim()) return
    try {
      const url = new URL(window.location.href)
      url.hash = ''
      url.search = ''
      url.searchParams.set('room', roomId.trim())
      await navigator.clipboard.writeText(url.toString())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setHint('无法复制邀请链接，请检查浏览器的剪贴板权限。')
    }
  }

  return (
    <div className="prejoin-shell">
      <nav className="prejoin-rail" aria-label="主导航">
        <a className="prejoin-logo" href="/" title="Easylive 首页" aria-label="Easylive 首页"><IconVideo size={22} /></a>
        <div className="prejoin-rail-links">
          <a className="prejoin-rail-link is-active" href="/" aria-current="page" title="会议"><IconVideo size={20} /><span>会议</span></a>
          <a className="prejoin-rail-link" href="#/metrics" title="数据看板"><IconStats size={20} /><span>数据</span></a>
        </div>
        {/* 左下角：当前身份入口。已登录显示头像，访客显示昵称首字母；
            点击后弹出居中的账号中心（资料 / 密码 / 头像 / 退出登录）。 */}
        <button
          type="button"
          className={`prejoin-rail-bottom ${accountOpen ? 'is-open' : ''}`}
          onClick={() => setAccountOpen(true)}
          title={user ? `账号：${user.username}` : `访客：${displayName}`}
          aria-haspopup="dialog"
          aria-expanded={accountOpen}
          aria-label={user ? `打开账号信息（${user.displayName || user.username}）` : '打开账号信息（访客）'}
        >
          {user?.avatarUrl
            ? <img src={user.avatarUrl} alt="" />
            : initialsOf(user ? (user.displayName || user.username) : displayName)}
        </button>
      </nav>

      <div className="prejoin-workspace">
        <header className="prejoin-topbar">
          <div className="prejoin-wordmark">easylive<span className="prejoin-wordmark-dot">.</span></div>
          <div className="prejoin-topbar-right">
            <span className="prejoin-topbar-caption">让每一次连接，都恰到好处</span>
            {/* 账号入口就是这一颗按钮：退出登录、改资料、改密码都在它弹出的弹窗里，
                不再单独放一个"退出登录"，避免顶栏出现两个入口指向同一件事。 */}
            <button
              type="button"
              className={`prejoin-account ${accountOpen ? 'is-open' : ''}`}
              onClick={() => setAccountOpen(true)}
              title={user ? `账号：${user.username}` : `访客：${displayName}`}
              aria-haspopup="dialog"
              aria-expanded={accountOpen}
            >
              <span className="prejoin-account-avatar" aria-hidden="true">
                {user?.avatarUrl
                  ? <img src={user.avatarUrl} alt="" />
                  : initialsOf(user ? (user.displayName || user.username) : displayName)}
              </span>
              <span className="prejoin-account-name">{user ? (user.displayName || user.username) : displayName}</span>
              <small>{user ? (user.role === 'host' ? '主持人' : '成员') : '访客'}</small>
            </button>
            <a className="prejoin-dashboard" href="#/metrics"><IconStats size={16} /> 数据看板</a>
          </div>
        </header>
        <main className="prejoin-content">
          <section className="prejoin-intro" aria-labelledby="prejoin-heading">
            <div className="prejoin-eyebrow"><span className="prejoin-eyebrow-line" /> YOUR MEETING SPACE</div>
            <h1 id="prejoin-heading">好沟通，从这里<span>开始。</span></h1>
            <p>进入熟悉的会议，或者开启一场新的对话。先确认设备，再安心入会。</p>
          </section>
          <div className="prejoin-grid">
          {/* 左：加入会议卡片 */}
          <form onSubmit={submit} className="prejoin-join-card">
            <div className="prejoin-card-topline"><span>01 / JOIN A MEETING</span><IconPlus size={19} /></div>
            <h2>加入会议</h2>
            <p className="prejoin-card-description">填好会议号和你的名字，下一步就是见面。</p>
            <div className="prejoin-fields">
              <label className="prejoin-field">
                <span>会议号</span>
                <input
                  value={roomId}
                  onChange={(e) => { setRoomId(e.target.value); setCopied(false) }}
                  onKeyDown={onInputKeyDown}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  placeholder="输入会议号，例如 demo-room"
                  autoComplete="off"
                  required
                />
              </label>
              <label className="prejoin-field">
                <span>你的昵称</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  placeholder="会中显示的名字"
                  maxLength={24}
                  required
                />
              </label>
            </div>

            {user ? (
              <p className="prejoin-host-option"><IconShield size={14} />
                <span>已登录为 {user.role === 'host' ? '主持人' : '成员'} <small>会议权限由服务器按账号分配</small></span>
              </p>
            ) : (
              <label className="prejoin-host-option">
                <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
                <IconShield size={14} />
                <span>以主持人身份加入 <small>演示模式 · 可管理参会者</small></span>
              </label>
            )}

            <div className="prejoin-actions">
              <button type="submit" className="prejoin-primary">
                加入会议 <span aria-hidden="true">↗</span>
              </button>
              <button type="button" onClick={quickStart} className="prejoin-secondary">
                <IconVideo size={17} /> 快速会议
              </button>
            </div>

            <p data-testid="prejoin-hint" role={hint ? 'alert' : undefined} className={`prejoin-hint ${hint ? 'is-error' : ''}`}>
              {hint ?? '会前先确认设备与昵称。快速会议将自动生成一个新的会议号。'}
            </p>
          </form>

          {/* 右：入会前设置（预览 + 设备） */}
          <section className="prejoin-device-card" aria-labelledby="prejoin-device-heading">
            <div className="prejoin-device-header">
              <div>
                <div className="prejoin-section-label">02 / CHECK YOUR SETUP</div>
                <h2 id="prejoin-device-heading">入会前设置</h2>
              </div>
              <span className={`prejoin-device-status ${preview ? 'is-ready' : ''}`}>
                <span aria-hidden="true" />{preview ? '设备已就绪' : '等待设备授权'}
              </span>
            </div>

            <div className="prejoin-camera-stage">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`prejoin-video ${camOn && preview ? '' : 'opacity-0'}`}
              />
              {(!camOn || !preview) && (
                <div className="prejoin-camera-placeholder">
                  <div className="prejoin-avatar">{displayName.slice(0, 1).toUpperCase()}</div>
                  <span>{camOn ? '等待摄像头画面…' : '摄像头已关闭'}</span>
                </div>
              )}
              <div className="prejoin-preview-tag"><span aria-hidden="true" /> 本地预览</div>
              <div className="prejoin-preview-name">{displayName.trim() || '我'}</div>
            </div>

            <div className="prejoin-device-controls">
              <div className="prejoin-control-label">设备检查 <span>只有加入会议后才会发布音视频</span></div>
              <div className="prejoin-pickers">
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
                <button type="button" className="prejoin-refresh" onClick={() => { refresh(); setDeviceRetry((v) => v + 1) }}>
                  {hint?.startsWith('无法访问') ? '重试打开设备' : '刷新设备'}
                </button>
              </div>
            </div>
          </section>
          </div>

          <div className="prejoin-bottom-grid">
            <div className="prejoin-info-card">
              <span className="prejoin-info-icon"><IconLink size={19} /></span>
              <div><strong>分享会议链接</strong><p>复制当前会议号的邀请链接，发给想见的人。</p></div>
              <button type="button" className="prejoin-info-action" onClick={() => void copyInvite()} disabled={!roomId.trim()} aria-live="polite">
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}{copied ? '已复制' : '复制链接'}
              </button>
            </div>
            <div className="prejoin-info-card prejoin-info-card-muted">
              <span className="prejoin-info-icon"><IconCalendar size={19} /></span>
              <div><strong>随时开始</strong><p>无需预约，快速会议会生成一个新的会议号。</p></div>
            </div>
          </div>
          <footer className="prejoin-footer"><span>easylive · 轻量实时音视频会议</span><span>为了更好的体验，请使用支持 WebRTC 的浏览器</span></footer>
        </main>
      </div>

      {accountOpen && (
        <AccountDialog
          user={user}
          guestName={displayName}
          onClose={() => setAccountOpen(false)}
          onUserChange={onUserChange}
          onLogout={onLogout}
        />
      )}
    </div>
  )
}
