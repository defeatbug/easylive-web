import { useState } from 'react'
import { DevicePicker } from './DevicePicker'
import type { DeviceOption } from '../lib/devices'

/** 表情面板里可用的表情（写在前面的是最常用的） */
const REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '🎉', '🤔']

interface ControlBarProps {
  micEnabled: boolean
  camEnabled: boolean
  screenSharing: boolean
  chatOpen: boolean
  statsOpen: boolean
  view: 'grid' | 'sidebar'
  mics: DeviceOption[]
  cams: DeviceOption[]
  micId?: string
  camId?: string
  onToggleMic: () => void
  onToggleCam: () => void
  onToggleScreen: () => void
  onToggleChat: () => void
  onToggleStats: () => void
  onToggleView: () => void
  onShare: () => void
  onLeave: () => void
  onSelectMic: (deviceId: string) => void
  onSelectCam: (deviceId: string) => void
  /** 自己是否已举手（状态来自服务端） */
  handRaised: boolean
  /** 数据通道是否就绪：表情与举手都走数据面，未就绪时禁用 */
  dataChannelReady: boolean
  onToggleHand: () => void
  onReaction: (emoji: string) => void
  /** 令牌是否允许发布媒体（无鉴权模式下恒为 true） */
  canPublish: boolean
  /** 令牌是否允许发布数据（表情/举手） */
  canPublishData: boolean
}

/**
 * 底部控制栏。
 *
 * 视觉与交互对齐 LiveKit Meet：**图标 + 文字**的胶囊按钮，麦克风与摄像头各自带独立下拉箭头
 * （点主体是开关，点箭头才换设备），"离开"用红色描边而不是红色实心——它是破坏性操作，
 * 不应该在视觉上比"静音"更抢眼。
 */
export function ControlBar({
  micEnabled,
  camEnabled,
  screenSharing,
  chatOpen,
  statsOpen,
  view,
  mics,
  cams,
  micId,
  camId,
  onToggleMic,
  onToggleCam,
  onToggleScreen,
  onToggleChat,
  onToggleStats,
  onToggleView,
  onShare,
  onLeave,
  onSelectMic,
  onSelectCam,
  handRaised,
  dataChannelReady,
  onToggleHand,
  onReaction,
  canPublish,
  canPublishData,
}: ControlBarProps) {
  const [emojiOpen, setEmojiOpen] = useState(false)

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-t border-white/5 bg-[var(--surface)] px-4 py-3">
      <DevicePicker
        icon={<IconMic muted={!micEnabled} />}
        label={micEnabled ? '麦克风' : '已静音'}
        title={micEnabled ? '静音（m）' : '取消静音（m）'}
        active={micEnabled}
        devices={mics}
        currentId={micId}
        onToggle={onToggleMic}
        onSelect={onSelectMic}
        disabled={!micEnabled}
      />
      <DevicePicker
        icon={<IconCam muted={!camEnabled} />}
        label={camEnabled ? '摄像头' : '已关闭'}
        title={camEnabled ? '关闭摄像头（v）' : '开启摄像头（v）'}
        active={camEnabled}
        devices={cams}
        currentId={camId}
        onToggle={onToggleCam}
        onSelect={onSelectCam}
        disabled={!camEnabled}
      />

      <PillButton
        active={screenSharing}
        onClick={onToggleScreen}
        title={canPublish ? '共享屏幕（s）' : '当前令牌无发布权限'}
        label={canPublish ? '共享屏幕' : '无发布权限'}
        disabled={!canPublish}
      >
        <IconScreen />
      </PillButton>
      <PillButton
        active={view === 'sidebar'}
        onClick={onToggleView}
        title="切换布局：宫格 / 左侧访客栏"
        label={view === 'sidebar' ? '左侧栏' : '宫格'}
      >
        {view === 'sidebar' ? <IconSidebar /> : <IconGrid />}
      </PillButton>
      <PillButton active={false} onClick={onShare} title="邀请他人入会（二维码）" label="邀请">
        <IconShare />
      </PillButton>
      <PillButton
        active={handRaised}
        onClick={onToggleHand}
        title={
          !canPublishData
            ? '当前令牌无发布数据权限'
            : dataChannelReady
              ? handRaised
                ? '放下手'
                : '举手（数据通道上报）'
              : '数据通道尚未就绪'
        }
        label={handRaised ? '已举手' : '举手'}
        disabled={!canPublishData}
      >
        <IconHand raised={handRaised} />
      </PillButton>

      {/* 表情：与按钮同一个相对容器，弹层向上展开 */}
      <div className="relative">
        <PillButton
          active={emojiOpen}
          onClick={() => setEmojiOpen((v) => !v)}
          title={canPublishData ? '发送表情（走数据通道）' : '当前令牌无发布数据权限'}
          label="表情"
          disabled={!canPublishData}
        >
          <IconSmile />
        </PillButton>
        {emojiOpen && (
          <div className="absolute bottom-full left-1/2 z-20 mb-2 flex -translate-x-1/2 gap-1 rounded-xl border border-white/10 bg-[var(--surface-2)] p-2 shadow-2xl">
            {REACTION_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => {
                  onReaction(e)
                  setEmojiOpen(false)
                }}
                className="rounded-lg px-2 py-1 text-lg transition hover:bg-white/10"
                title={`发送 ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>

      <PillButton active={chatOpen} onClick={onToggleChat} title="聊天" label="聊天">
        <IconChat />
      </PillButton>
      <PillButton active={statsOpen} onClick={onToggleStats} title="连接质量与指标" label="指标">
        <IconStats />
      </PillButton>

      <button
        onClick={onLeave}
        title="离开会议"
        className="flex items-center gap-2 rounded-lg border border-[var(--danger)] px-4 py-2 text-sm font-medium text-[var(--danger)] transition hover:bg-[var(--danger)]/12"
      >
        <IconLeave />
        离开
      </button>
    </div>
  )
}

function PillButton({
  active,
  onClick,
  title,
  label,
  disabled,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  label: string
  /** 令牌权限不足时置灰（服务端仍会校验，这里只是不让用户白点） */
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
        disabled
          ? 'cursor-not-allowed bg-white/4 text-neutral-600'
          : active
            ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
            : 'bg-white/8 text-neutral-200 hover:bg-white/12'
      }`}
    >
      <span className="shrink-0">{children}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
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

const IconScreen = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
)

const IconGrid = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
)

const IconSidebar = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="M5.5 8h1.5M5.5 12h1.5M5.5 16h1.5" />
  </svg>
)

const IconHand = ({ raised }: { raised: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className={raised ? 'text-amber-300' : undefined}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
    <path d="M11 12V4.5a1.5 1.5 0 0 1 3 0V12" />
    <path d="M14 12V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2l-1.2-2.4a1.5 1.5 0 0 1 2.5-1.6L8 12" />
  </svg>
)

const IconSmile = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
)

const IconShare = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <path d="M12 4v10M8.5 7.5L12 4l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </svg>
)

const IconChat = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4z" />
  </svg>
)

const IconStats = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 19V5M4 19h16M8 16v-5M13 16V8M18 16v-3" />
  </svg>
)

const IconLeave = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <path d="M15 12H4m0 0l3-3m-3 3l3 3M10 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7" />
  </svg>
)
