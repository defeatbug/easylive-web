import { useRef, useState } from 'react'
import { DevicePicker } from './DevicePicker'
import { ReactionDock } from './ReactionDock'
import {
  IconCam,
  IconRecord,
  IconChat,
  IconFullscreen,
  IconHand,
  IconLeave,
  IconMembers,
  IconMic,
  IconMore,
  IconQr,
  IconScreenShare,
  IconWhiteboard,
  IconStats,
} from './Icons'
import { IconSparkle } from './Icons'
import type { DeviceOption } from '../lib/devices'
import { usePopover } from '../lib/popover'
import type { VirtualBackgroundMode } from '../lib/virtualBackground'

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
  /** emoji + 可选文字（有文字就是弹幕）+ 可选 kind='action'（互动动效） */
  onReaction: (emoji: string, text?: string, kind?: 'action') => void
  /** 令牌是否允许发布媒体（无鉴权模式下恒为 true） */
  canPublish: boolean
  /** 令牌是否允许发布数据（表情/举手） */
  canPublishData: boolean
  /** 端侧虚拟背景当前模式 */
  virtualBackground: VirtualBackgroundMode
  /** 模型加载/切换中 */
  vbBusy: boolean
  onVirtualBackground: (mode: VirtualBackgroundMode) => void
  /** 当前是否正在录制（全员可见的红点由顶部信息栏负责，这里只管开关） */
  recordingActive: boolean
  /** 是否有录制权限（roomAdmin）。没有权限时按钮不出现——服务端仍会独立校验 */
  canRecord: boolean
  onToggleRecording: () => void
  /** 打开录制列表 */
  onOpenRecordings: () => void
  /** 白板是否已打开 */
  whiteboardOpen: boolean
  onToggleWhiteboard: () => void
}

/**
 * 会中底部工具栏：布局对齐腾讯会议客户端。
 *
 * 两个刻意的选择：
 *  1. **悬浮在画面之上的一整条圆角栏**，而不是贴着底边的通栏——会议里视频才是主体，
 *     工具栏压住画面底部会让宫格看起来"被切掉"，腾讯会议同样把栏做成悬浮胶囊。
 *  2. 把"邀请 / 布局 / 指标"收进**"更多"弹层**：腾讯会议的主工具栏只留高频操作，
 *     低频项进更多。这样主栏在窄屏也不会挤成一团（我们原来的通栏换行就会出现这个毛病）。
 *
 * 麦克风与摄像头仍复用 DevicePicker：点主体开关、点箭头换设备，开会时不会误触。
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
  virtualBackground,
  vbBusy,
  onVirtualBackground,
  recordingActive,
  canRecord,
  onToggleRecording,
  onOpenRecordings,
  whiteboardOpen,
  onToggleWhiteboard,
}: ControlBarProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const [fxOpen, setFxOpen] = useState(false)
  // 三个浮层共用同一套互斥逻辑：打开任一都会关掉其它（真人实测：以前会叠在一起）
  const moreRef = useRef<HTMLDivElement>(null)
  const fxRef = useRef<HTMLDivElement>(null)
  usePopover(moreOpen, setMoreOpen, moreRef)
  usePopover(fxOpen, setFxOpen, fxRef)

  return (
    // 底部一行三块：**左**表情/互动、**中**导航按钮、**右**退出。
    // 三者同高（都走 .meeting-bar-slot 的 48px），整体落在舞台预留的下边距里，
    // 所以不会压在视频画面上。
    <div className="meeting-toolbar pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 px-4 pb-3">
      {/* 左：表情 + 互动 */}
      <ReactionDock
        onSend={(emoji, text, kind) => onReaction(emoji, text, kind)}
        disabled={!canPublishData}
      />

      {/* 中：导航按钮 */}
      <div className="meeting-toolbar-inner meeting-bar-slot pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--line)] bg-[var(--surface)]/95 px-2 shadow-[var(--shadow-pop)] backdrop-blur">
        <DevicePicker
          variant="tool"
          icon={<IconMic size={20} muted={!micEnabled} />}
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
          variant="tool"
          icon={<IconCam size={20} muted={!camEnabled} />}
          label={camEnabled ? '摄像头' : '已关闭'}
          title={camEnabled ? '关闭摄像头（v）' : '开启摄像头（v）'}
          active={camEnabled}
          devices={cams}
          currentId={camId}
          onToggle={onToggleCam}
          onSelect={onSelectCam}
          disabled={!camEnabled}
        />

        <ToolButton
          active={screenSharing}
          onClick={onToggleScreen}
          title={canPublish ? '共享屏幕（s）' : '当前令牌无发布权限'}
          label={canPublish ? '共享屏幕' : '无权限'}
          disabled={!canPublish}
        >
          <IconScreenShare size={20} />
        </ToolButton>

        <ToolButton
          mobileSecondary
          active={view === 'sidebar'}
          onClick={onToggleView}
          title="成员列表：切换宫格 / 左侧访客栏"
          label="成员"
        >
          <IconMembers size={20} />
        </ToolButton>
        <ToolButton active={chatOpen} onClick={onToggleChat} title="聊天" label="聊天">
          <IconChat size={20} />
        </ToolButton>
        <ToolButton
          mobileSecondary
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
          <IconHand size={20} raised={handRaised} />
        </ToolButton>

        {/* 白板：任何参会者都能用（服务端会校验发布数据权限） */}
        <ToolButton
          mobileSecondary
          active={whiteboardOpen}
          onClick={onToggleWhiteboard}
          title={canPublishData ? '白板（所有人实时共享同一块画布）' : '当前令牌无发布数据权限'}
          label="白板"
          disabled={!canPublishData}
        >
          <IconWhiteboard size={20} />
        </ToolButton>

        {/* 录制：仅主持人可见。未开启录制能力时服务端会返回明确错误，按钮不显示。
            红点状态在顶部信息栏，全员可见——"有人在录我"这件事不该只有主持人知道。 */}
        {canRecord && (
          <button
            type="button"
            onClick={onToggleRecording}
            title={recordingActive ? '停止录制' : '开始录制（转发即录制，零转码落盘）'}
            className={`tm-tool meeting-mobile-secondary ${recordingActive ? 'tm-tool-recording' : ''}`}
          >
            <span className={recordingActive ? 'tm-pulse' : undefined}>
              <IconRecord size={20} />
            </span>
            <span>{recordingActive ? '录制中' : '录制'}</span>
          </button>
        )}

        {/* 端侧 AI：虚拟背景（人像分割在本机跑，画面不上传） */}
        <div className="meeting-mobile-secondary relative" ref={fxRef}>
          <ToolButton
            active={virtualBackground !== 'off'}
            onClick={() => setFxOpen((v) => !v)}
            title={canPublish ? '虚拟背景（端侧人像分割）' : '当前令牌无发布权限'}
            label={vbBusy ? '处理中' : virtualBackground === 'off' ? '特效' : '已开启'}
            disabled={!canPublish || vbBusy}
          >
            <span className={vbBusy ? 'tm-pulse' : undefined}>
              <IconSparkle size={20} />
            </span>
          </ToolButton>
          {fxOpen && (
            <div className="tm-menu absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2">
              <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-[var(--text-mute)]">
                端侧处理 · 画面不出本机
              </p>
              {(
                [
                  ['off', '关闭'],
                  ['blur', '背景虚化'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className={`tm-menu-item ${virtualBackground === m ? 'tm-menu-item-active' : ''}`}
                  onClick={() => {
                    onVirtualBackground(m)
                    setFxOpen(false)
                  }}
                >
                  {label}
                  {virtualBackground === m && <span className="ml-auto">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>


        {/* 更多：邀请 / 布局 / 指标 */}
        <div className="relative" ref={moreRef}>
          <ToolButton
            active={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            title="更多"
            label="更多"
          >
            <IconMore size={20} />
          </ToolButton>
          {moreOpen && (
            <div className="tm-menu meeting-more-menu absolute bottom-full right-0 z-20 mb-2 w-52">
              <button
                type="button"
                className="tm-menu-item"
                onClick={() => {
                  onShare()
                  setMoreOpen(false)
                }}
              >
                <IconQr size={16} />
                邀请他人入会
              </button>
              <div className="meeting-mobile-menu-items">
                <button type="button" className="tm-menu-item" onClick={() => { onToggleHand(); setMoreOpen(false) }} disabled={!canPublishData}>
                  <IconHand size={16} raised={handRaised} />{handRaised ? '放下手' : '举手'}
                </button>
                <button type="button" className="tm-menu-item" onClick={() => { onToggleWhiteboard(); setMoreOpen(false) }} disabled={!canPublishData}>
                  <IconWhiteboard size={16} />{whiteboardOpen ? '关闭白板' : '打开白板'}
                </button>
                <button type="button" className="tm-menu-item" onClick={() => { onVirtualBackground(virtualBackground === 'off' ? 'blur' : 'off'); setMoreOpen(false) }} disabled={!canPublish || vbBusy}>
                  <IconSparkle size={16} />{vbBusy ? '特效处理中' : virtualBackground === 'off' ? '开启背景虚化' : '关闭背景虚化'}
                </button>
                {canRecord && <button type="button" className="tm-menu-item" onClick={() => { onToggleRecording(); setMoreOpen(false) }}>
                  <IconRecord size={16} />{recordingActive ? '停止录制' : '开始录制'}
                </button>}
                <div className="meeting-mobile-reactions" aria-label="发送表情">
                  {REACTION_EMOJIS.map((emoji) => <button key={emoji} type="button" onClick={() => { onReaction(emoji); setMoreOpen(false) }} disabled={!canPublishData} title={`发送 ${emoji}`}>{emoji}</button>)}
                </div>
              </div>
              <button
                type="button"
                className={`tm-menu-item ${statsOpen ? 'tm-menu-item-active' : ''}`}
                onClick={() => {
                  onToggleStats()
                  setMoreOpen(false)
                }}
              >
                <IconStats size={16} />
                连接质量与指标
              </button>
              <button
                type="button"
                className="tm-menu-item"
                onClick={() => {
                  void document.documentElement.requestFullscreen?.().catch(() => {})
                  setMoreOpen(false)
                }}
              >
                <IconFullscreen size={16} />
                全屏
              </button>
              {canRecord && (
                <button
                  type="button"
                  className="tm-menu-item"
                  onClick={() => {
                    onOpenRecordings()
                    setMoreOpen(false)
                  }}
                >
                  <IconRecord size={16} />
                  录制列表
                </button>
              )}
            </div>
          )}
        </div>

        <span className="mx-1 h-8 w-px bg-[var(--line)]" />

      </div>

      {/* 右：退出（与导航条同高、水平对齐） */}
      <button
        type="button"
        onClick={onLeave}
        title="离开会议"
        className="tm-leave meeting-bar-slot pointer-events-auto flex items-center gap-1.5 rounded-xl px-4 text-[12px] font-medium"
      >
        <IconLeave size={18} />
        离开
      </button>
    </div>
  )
}

function ToolButton({
  active,
  onClick,
  title,
  label,
  disabled,
  mobileSecondary,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  label: string
  /** 令牌权限不足时置灰（服务端仍会校验，这里只是不让用户白点） */
  disabled?: boolean
  mobileSecondary?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`tm-tool ${mobileSecondary ? 'meeting-mobile-secondary' : ''} ${active ? 'tm-tool-active' : ''}`}
    >
      <span className="shrink-0">{children}</span>
      <span>{label}</span>
    </button>
  )
}
