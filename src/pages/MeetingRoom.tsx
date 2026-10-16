import { useEffect, useMemo, useRef, useState } from 'react'
import { ControlBar } from '../components/ControlBar'
import { IconCheck, IconCopy } from '../components/Icons'
import type { AccountUser } from '../lib/auth'
import { RecordingsPanel } from '../components/RecordingsPanel'
import { Whiteboard } from '../components/Whiteboard'
import { AudioSink } from '../components/AudioSink'
import { closeAllDetachedWindows } from '../lib/multiWindow'
import { ShareDialog } from '../components/ShareDialog'
import { SidePanel } from '../components/SidePanel'
import { VideoTile } from '../components/VideoTile'
import { useRoom } from '../hooks/useRoom'
import { useDevices, type DeviceSelection } from '../lib/devices'
import type { LinkStats } from '../lib/RoomClient'
import { evaluateQuality } from '../lib/quality'

interface MeetingRoomProps {
  roomId: string
  displayName: string
  initialDevices: DeviceSelection
  initialMicOn: boolean
  initialCamOn: boolean
  /** 会前页交接过来的预览流（刷新后自动回会时为 null，会重新申请） */
  previewStream?: MediaStream | null
  /** 以主持人身份加入（申请 roomAdmin） */
  asAdmin?: boolean
  onLeave: () => void
  user: AccountUser | null
  onLogout: () => Promise<void>
}

interface Tile {
  key: string
  label: string
  stream: MediaStream | null
  isLocal: boolean
  screen: boolean
  muted: boolean
  /** 该瓦片属于哪个参与者（用于每个发布者只保留一张屏幕卡片） */
  owner: string
  /** 角标：目前只用于标记"对方正在重连" */
  badge?: string
  /** 正在说话（来自服务端 active_speakers，而不是本地音量猜测） */
  speaking?: boolean
}

/** 只剩两种布局：宫格 / 左侧访客栏。屏幕共享不再是一种"视图"，而是自动占据主舞台。 */
type ViewMode = 'grid' | 'sidebar'
type PanelTab = 'chat' | 'people' | 'stats'

/**
 * 会议主界面。
 *
 * 布局规则（有意做得很确定，避免"点了按钮又被自动切回去"）：
 *   - 没有人共享屏幕 → 宫格（或左侧栏）
 *   - 有人共享屏幕   → 屏幕占据主舞台，摄像头缩成右下角小窗（可点击换到主舞台）
 *   - 左侧栏模式     → 访客卡片竖排在左侧，主舞台在右边（两种情况下都可用）
 */
export function MeetingRoom({
  roomId,
  displayName,
  initialDevices,
  initialMicOn,
  initialCamOn,
  previewStream,
  asAdmin,
  onLeave,
  user,
  onLogout,
}: MeetingRoomProps) {
  const { client, snapshot, error, retryMedia, retryConnect } = useRoom(true, roomId, displayName, {
    devices: initialDevices,
    micOn: initialMicOn,
    camOn: initialCamOn,
    previewStream,
    asAdmin,
  })
  const { mics, cams } = useDevices()

  const [panelOpen, setPanelOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('chat')
  const [view, setView] = useState<ViewMode>('grid')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  /** 复制会议号后的短暂反馈（1.5s 后自动消失，不弹窗打断） */
  const [copied, setCopied] = useState(false)
  /** 录制列表面板（仅主持人可打开） */
  const [recordingsOpen, setRecordingsOpen] = useState(false)
  /** 白板叠加层 */
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)

  // 离开会中页时关掉所有"独立窗口"：否则会留下一堆播放着已结束流的空窗口
  useEffect(() => () => closeAllDetachedWindows(), [])
  const [micId, setMicId] = useState<string | undefined>(initialDevices.micId)
  const [camId, setCamId] = useState<string | undefined>(initialDevices.camId)

  // 快捷键：m 静音 / v 摄像头 / s 屏幕共享
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return
      if (!client) return
      if (e.key === 'm') client.setMicEnabled(!snapshot.micEnabled)
      if (e.key === 'v') client.setCamEnabled(!snapshot.camEnabled)
      if (e.key === 's') void (snapshot.screenStream ? client.stopScreenShare() : client.startScreenShare())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, snapshot.micEnabled, snapshot.camEnabled, snapshot.screenStream])

  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = []
    const selfId = snapshot.self?.id ?? 'self'
    // 服务端按 RFC 6464 音频电平判定的活跃说话人集合
    const speaking = new Set(snapshot.speakers.map((sp) => sp.participantId))

    // 本地卡片始终存在（设备没打开/摄像头关闭时渲染成头像占位）
    out.push({
      key: 'local',
      label: `${displayName}（我）`,
      stream: snapshot.camEnabled ? snapshot.localStream : null,
      isLocal: true,
      screen: false,
      muted: !snapshot.micEnabled,
      owner: selfId,
      speaking: speaking.has(selfId),
      badge: snapshot.hands.includes(selfId) ? '✋ 举手' : undefined,
    })
    if (snapshot.screenStream) {
      out.push({
        key: 'local-screen',
        label: `${displayName} 的屏幕`,
        stream: snapshot.screenStream,
        isLocal: true,
        screen: true,
        muted: false,
        owner: selfId,
      })
    }

    for (const p of snapshot.participants) {
      if (p.id === snapshot.self?.id) continue
      const tracks = snapshot.tracks.filter((t) => t.publisherId === p.id)
      const cam = tracks.find((t) => t.kind === 'video' && t.source !== 'screen')
      const audio = tracks.find((t) => t.kind === 'audio')

      // 角标优先级：举手（需要回应）> 重连中（画面会卡住，但状态自己会恢复）
      const raised = snapshot.hands.includes(p.id)
      const reconnecting = raised ? '✋ 举手' : p.state === 'reconnecting' ? '重连中' : undefined

      out.push({
        key: `cam-${p.id}`,
        label: p.name,
        // 摄像头被对方关掉时给 null，让瓦片显示头像而不是黑屏
        stream: cam && !cam.muted ? (snapshot.remoteStreams[cam.id] ?? null) : null,
        isLocal: false,
        screen: false,
        muted: !!audio?.muted,
        owner: p.id,
        badge: reconnecting,
        speaking: speaking.has(p.id),
      })

      // 防御：同一个发布者只保留**最后一条**屏幕轨。
      // 正常情况下不该出现多条（服务端轨道下线 + 客户端 unpublish 已经闭环），
      // 但万一有陈旧轨道，也不该让界面上冒出两张屏幕卡片。
      const screens = tracks.filter((t) => t.source === 'screen')
      const latest = screens[screens.length - 1]
      if (latest) {
        out.push({
          key: `screen-${latest.id}`,
          label: `${p.name} 的屏幕`,
          stream: snapshot.remoteStreams[latest.id] ?? null,
          isLocal: false,
          screen: true,
          muted: false,
          owner: p.id,
          badge: reconnecting,
          speaking: speaking.has(p.id),
        })
      }
    }
    return out
  }, [snapshot, displayName])

  const screenTiles = tiles.filter((t) => t.screen)
  const hasScreen = screenTiles.length > 0

  // 主舞台：手动选中的优先；否则有人共享就默认给屏幕，没人共享就用第一张
  const activeTile =
    tiles.find((t) => t.key === activeKey) ?? screenTiles[0] ?? tiles[0] ?? null
  const quality = evaluateQuality(snapshot.stats)
  // 顶部"谁在说话"：把 participantId 换成显示名
  const speakerNames = snapshot.speakers
    .map((sp) => (sp.participantId === snapshot.self?.id ? '我' : (snapshot.participants.find((p) => p.id === sp.participantId)?.name ?? '')))
    .filter((n) => n !== '')

  return (
    <div className="theme-meeting flex h-full flex-col bg-[var(--bg)]">
      <header className="meeting-topbar relative z-20 flex shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-5">
        <span className="meeting-brand" aria-label="Easylive">e<span>.</span></span>
        <span className="meeting-topbar-divider" />
        <div className="meeting-title-group">
          <span className="meeting-title-label">正在进行的会议</span>
          <span className="meeting-room-name" title={roomId}>{roomId}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(roomId).then(
              () => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              },
              () => {},
            )
          }}
          title="复制会议号"
          aria-label={copied ? '会议号已复制' : '复制会议号'}
          className="meeting-icon-button"
        >
          {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
        </button>
        <ConnectionPill connection={snapshot.connection} />
        <button type="button" onClick={() => { setTab('people'); setPanelOpen(true) }} className="meeting-participants" title="查看参会成员">
          {snapshot.participants.length} 人在线
        </button>
        {hasScreen && (
          <span className="meeting-screen-indicator rounded bg-[var(--brand-tint)] px-1.5 py-0.5 text-[11px] text-[var(--brand)]">
            正在共享屏幕
          </span>
        )}
        {/* 录制红点：**全员可见**。"有人在录我"不该只有主持人知道。
            状态来自服务端广播与入会快照，不是本地猜测。 */}
        {snapshot.recording.active && (
          <span
            className="meeting-recording-indicator flex items-center gap-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-400"
            title={`录制中${snapshot.recording.sessionId ? `（会话 ${snapshot.recording.sessionId}）` : ''}${
              snapshot.recording.startedBy ? ` · 由 ${snapshot.recording.startedBy} 发起` : ''
            }`}
          >
            <span className="tm-pulse h-1.5 w-1.5 rounded-full bg-red-500" />
            录制中
            {typeof snapshot.recording.files === 'number' && snapshot.recording.files > 0 && (
              <span className="text-red-300/80">{snapshot.recording.files} 路</span>
            )}
          </span>
        )}
        {speakerNames.length > 0 && (
          <span className="meeting-speaker-indicator flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">
            <span className="flex h-3 items-end gap-[2px]">
              <span className="w-[2px] animate-pulse rounded-sm bg-emerald-400" style={{ height: '60%' }} />
              <span className="w-[2px] animate-pulse rounded-sm bg-emerald-400" style={{ height: '100%' }} />
              <span className="w-[2px] animate-pulse rounded-sm bg-emerald-400" style={{ height: '40%' }} />
            </span>
            {speakerNames.join('、')} 正在说话
          </span>
        )}

        <div className="meeting-topbar-right ml-auto flex items-center gap-3">
          <div className="meeting-quality" title={`网络质量：${quality.label}（${quality.score}）`}>
            <span className={`h-2 w-2 rounded-full ${quality.dot}`} />
            <span className={`text-[11px] font-medium ${quality.text}`}>{quality.label}</span>
          </div>
          <StatsInline stats={snapshot.stats} />
          {user && <span className="meeting-account" title={`已登录：${user.username}`}>{user.displayName || user.username} · {user.role === 'host' ? '主持人' : '成员'}</span>}
          <button type="button" onClick={() => setShareOpen(true)} className="meeting-invite">邀请参会 <span aria-hidden="true">↗</span></button>
        </div>
      </header>

      {snapshot.connection === 'reconnecting' && (
        <div className="relative z-20 mx-4 mb-2 flex shrink-0 items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          <span className="min-w-0 flex-1">
            信令连接已断开，正在自动重连（第 {snapshot.reconnectAttempt} 次）… 画面保持最后一帧，恢复后不会中断
          </span>
        </div>
      )}

      {snapshot.notice && (
        <div className="relative z-20 mx-4 mb-2 flex shrink-0 items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
          <span className="min-w-0 flex-1">{snapshot.notice}</span>
          <button
            onClick={() => client?.clearNotice()}
            className="shrink-0 rounded px-2 py-1 transition hover:bg-white/10"
          >
            知道了
          </button>
        </div>
      )}

      {(error || accountError) && (
        <div role="alert" className="relative z-20 mx-4 mb-2 flex shrink-0 items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0 flex-1">{accountError ?? error}</span>
          {accountError && <button type="button" onClick={() => setAccountError(null)} className="shrink-0 rounded px-2 py-1 hover:bg-red-500/20">关闭</button>}
          {error && snapshot.connection === 'closed' && (
            <button
              onClick={retryConnect}
              className="shrink-0 rounded border border-red-400/40 px-2 py-1 font-medium transition hover:bg-red-500/20"
            >
              重新连接
            </button>
          )}
          {error && !snapshot.localStream && (
            <button
              onClick={() => void retryMedia()}
              className="shrink-0 rounded border border-red-400/40 px-2 py-1 font-medium transition hover:bg-red-500/20"
            >
              重试打开设备
            </button>
          )}
        </div>
      )}

      <div className="meeting-body relative flex min-h-0 flex-1">
        <main className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* 表情浮层：绝对定位、不参与排版、不拦截鼠标 */}
          {snapshot.reactions.length > 0 && (
            <div className="pointer-events-none absolute bottom-28 left-4 z-10 flex flex-col-reverse gap-2">
              {snapshot.reactions.map((r) => (
                <div
                  key={r.id}
                  className="reaction-float flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 shadow-lg"
                >
                  <span className="text-xl leading-none">{r.emoji}</span>
                  <span className="text-xs text-neutral-300">
                    {r.fromId === snapshot.self?.id ? '我' : r.fromName}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="meeting-stage min-h-0 flex-1 overflow-y-auto px-4 pb-24">
            {tiles.length === 0 ? (
              <p className="py-24 text-center text-sm text-neutral-500">等待其他人加入…</p>
            ) : view === 'sidebar' && activeTile ? (
              <SidebarLayout
                active={activeTile}
                tiles={tiles}
                onSelect={setActiveKey}
                onToggleSidebar={() => setView('grid')}
              />
            ) : hasScreen && activeTile ? (
              <StageWithPip
                stage={activeTile}
                // 右下角只放"当前共享屏幕那位"的摄像头；其他访客不在这里出现
                // （想看全部就切到左侧访客栏布局）
                presenterCam={
                  tiles.find((t) => t.owner === activeTile.owner && !t.screen) ?? null
                }
                onToggleSidebar={() => setView('sidebar')}
              />
            ) : (
              <GridView tiles={tiles} />
            )}
          </div>

          <ControlBar
            micEnabled={snapshot.micEnabled}
            camEnabled={snapshot.camEnabled}
            screenSharing={!!snapshot.screenStream}
            chatOpen={panelOpen && tab === 'chat'}
            statsOpen={panelOpen && tab === 'stats'}
            view={view}
            mics={mics}
            cams={cams}
            micId={micId}
            camId={camId}
            onToggleMic={() => client?.setMicEnabled(!snapshot.micEnabled)}
            onToggleCam={() => client?.setCamEnabled(!snapshot.camEnabled)}
            onToggleScreen={() =>
              void (snapshot.screenStream ? client?.stopScreenShare() : client?.startScreenShare())
            }
            onToggleView={() => setView(view === 'grid' ? 'sidebar' : 'grid')}
            onShare={() => setShareOpen(true)}
            onToggleChat={() => {
              setPanelOpen(!(panelOpen && tab === 'chat'))
              setTab('chat')
            }}
            onToggleStats={() => {
              setPanelOpen(!(panelOpen && tab === 'stats'))
              setTab('stats')
            }}
            onSelectMic={(id) => {
              setMicId(id)
              void client?.switchMicrophone(id)
            }}
            onSelectCam={(id) => {
              setCamId(id)
              void client?.switchCamera(id)
            }}
            handRaised={snapshot.hands.includes(snapshot.self?.id ?? '')}
            dataChannelReady={snapshot.dataChannelReady}
            canPublish={snapshot.grants?.canPublish ?? true}
            canPublishData={snapshot.grants?.canPublishData ?? true}
            whiteboardOpen={whiteboardOpen}
            onToggleWhiteboard={() => setWhiteboardOpen((v) => !v)}
            recordingActive={snapshot.recording.active}
            canRecord={snapshot.grants?.roomAdmin ?? false}
            onToggleRecording={() =>
              void client?.setRecording(snapshot.recording.active ? 'stop' : 'start')
            }
            onOpenRecordings={() => setRecordingsOpen(true)}
            virtualBackground={snapshot.virtualBackground}
            vbBusy={snapshot.virtualBackgroundBusy}
            onVirtualBackground={(m) => void client?.setVirtualBackground(m)}
            onToggleHand={() => client?.toggleHand()}
            onReaction={(emoji) => client?.sendReaction(emoji)}
            onLogout={user ? async () => { try { await onLogout() } catch (reason) { setAccountError(reason instanceof Error ? reason.message : '退出登录失败，请重试。') } } : undefined}
            onLeave={() => {
              closeAllDetachedWindows()
              client?.leave()
              onLeave()
            }}
          />
        </main>

        {panelOpen && (
          <SidePanel
            tab={tab}
            onTabChange={setTab}
            onClose={() => setPanelOpen(false)}
            chat={snapshot.chat}
            selfId={snapshot.self?.id ?? null}
            participants={snapshot.participants}
            hands={snapshot.hands}
            speakers={snapshot.speakers}
            stats={snapshot.stats}
            isAdmin={snapshot.grants?.roomAdmin ?? false}
            onModerate={(action, targetId) => {
              const who = snapshot.participants.find((p) => p.id === targetId)?.name ?? targetId
              if (action === 'kick' && !window.confirm(`确定把 ${who} 移出房间？`)) return
              void client?.moderate(action, targetId).catch((e: unknown) => {
                window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`)
              })
            }}
            onSend={(t) => client?.sendChat(t)}
          />
        )}
      </div>

      {shareOpen && <ShareDialog roomId={roomId} onClose={() => setShareOpen(false)} />}

      {/* 远端音频（麦克风 + 屏幕共享的系统声音）：与视频瓦片解耦。
          以前音频轨从未被任何元素播放——界面能看不能听，这是补上的缺口。 */}
      {snapshot.tracks
        .filter((t) => t.kind === 'audio' && t.publisherId !== snapshot.self?.id)
        .map((t) => (
          <AudioSink
            key={`audio-${t.id}`}
            stream={snapshot.remoteStreams[t.id] ?? null}
            label={
              (snapshot.participants.find((p) => p.id === t.publisherId)?.name ?? '参会者') +
              (t.source === 'screen' ? ' 的屏幕声音' : '')
            }
          />
        ))}

      {whiteboardOpen && (
        <Whiteboard
          ops={snapshot.whiteboard}
          selfId={snapshot.self?.id ?? null}
          nameOf={(id) => snapshot.participants.find((p) => p.id === id)?.name ?? id}
          onOp={(op) => client?.sendWhiteboardOp(op)}
          onClose={() => setWhiteboardOpen(false)}
        />
      )}

      {recordingsOpen && (
        <RecordingsPanel
          onLoad={() => client?.listRecordings() ?? Promise.resolve(null)}
          onClose={() => setRecordingsOpen(false)}
        />
      )}
    </div>
  )
}

/** 纯宫格：没有人共享屏幕时使用（保持原来的观感：固定断点 + 16:9 宽度驱动） */
function GridView({ tiles }: { tiles: Tile[] }) {
  const cols =
    tiles.length <= 1
      ? 'grid-cols-1'
      : tiles.length <= 4
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
  const single = tiles.length === 1
  return (
    // h-full + auto-rows-fr：让宫格铺满整个舞台高度。
    // 原来只有宽度约束，单人时瓦片按 16:9 撑开，下方会空出一大片——腾讯会议里
    // 单人是"铺满舞台"的观感，多人时行高平分剩余高度。
    <div className={`grid h-full min-h-0 gap-3 ${cols} ${single ? '' : 'auto-rows-fr'}`}>
      {tiles.map((t) => (
        <VideoTile
          key={t.key}
          stream={t.stream}
          label={t.label}
          mirrored={t.isLocal && !t.screen}
          muted={t.muted}
          badge={t.badge}
          speaking={t.speaking}
          fit={single ? 'stage' : undefined}
        />
      ))}
    </div>
  )
}

/**
 * 屏幕共享布局：屏幕占满主舞台（contain 显示，文字不被裁切），
 * **当前共享屏幕那位的摄像头**缩成一个小窗浮在上面，可用鼠标拖动到任意位置
 * （双击回到右下角默认位置）。
 */
function StageWithPip({
  stage,
  presenterCam,
  onToggleSidebar,
}: {
  stage: Tile
  presenterCam: Tile | null
  onToggleSidebar: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pipRef = useRef<HTMLDivElement>(null)
  /** null = 默认右下角；有值表示用户拖动过 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{
    pointerX: number
    pointerY: number
    originX: number
    originY: number
    maxX: number
    maxY: number
    w: number
    h: number
    moved: boolean
  } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    const wrap = wrapRef.current
    const pip = pipRef.current
    if (!wrap || !pip) return
    const wr = wrap.getBoundingClientRect()
    const pr = pip.getBoundingClientRect()
    drag.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originX: pr.left - wr.left,
      originY: pr.top - wr.top,
      maxX: wr.width - pr.width,
      maxY: wr.height - pr.height,
      w: wr.width,
      h: wr.height,
      moved: false,
    }
    // 捕获指针：拖到窗口外面也能继续收到 move 事件
    pip.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.pointerX
    const dy = e.clientY - d.pointerY
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return // 抖动阈值，避免误判为拖动
    d.moved = true
    setPos({
      x: clamp(d.originX + dx, 0, Math.max(0, d.maxX)),
      y: clamp(d.originY + dy, 0, Math.max(0, d.maxY)),
    })
  }

  const endDrag = (e: React.PointerEvent) => {
    drag.current = null
    pipRef.current?.releasePointerCapture(e.pointerId)
  }

  // 窗口尺寸变化后把小窗夹回可视范围内，避免"拖出去就找不回来了"
  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      const wrap = wrapRef.current
      const pip = pipRef.current
      if (!wrap || !pip) return
      const wr = wrap.getBoundingClientRect()
      const pr = pip.getBoundingClientRect()
      setPos((p) =>
        p ? { x: clamp(p.x, 0, Math.max(0, wr.width - pr.width)), y: clamp(p.y, 0, Math.max(0, wr.height - pr.height)) } : p,
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos])

  return (
    <div ref={wrapRef} className="relative h-full min-h-0 overflow-hidden">
      <VideoTile
        stream={stage.stream}
        label={stage.label}
        screen={stage.screen}
        mirrored={stage.isLocal && !stage.screen}
        muted={stage.muted}
        badge={stage.badge}
        speaking={stage.speaking}
        onToggleSidebar={onToggleSidebar}
        fit="stage"
      />

      {presenterCam?.stream && (
        <div
          ref={pipRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => setPos(null)}
          style={pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 12 }}
          title="拖动可移动位置，双击回到右下角"
          className="absolute w-28 cursor-grab touch-none select-none active:cursor-grabbing sm:w-40"
        >
          <PipVideo stream={presenterCam.stream} label={presenterCam.label} />
        </div>
      )}
    </div>
  )
}

/** 小窗里的画面：不挂任何交互（拖动与双击都由外层容器负责） */
function PipVideo({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream) void el.play().catch(() => {})
  }, [stream])

  return (
    <div className="relative overflow-hidden rounded-lg bg-black shadow-lg ring-1 ring-white/15">
      <video ref={ref} autoPlay playsInline muted className="aspect-video w-full object-cover" />
      <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/60 px-1 text-[10px] text-white/90">
        {label}
      </span>
    </div>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

/** 左侧访客栏：一列竖排卡片 + 右侧主舞台 */
function SidebarLayout({
  active,
  tiles,
  onSelect,
  onToggleSidebar,
}: {
  active: Tile
  tiles: Tile[]
  onSelect: (key: string) => void
  onToggleSidebar: () => void
}) {
  return (
    <div className="meeting-sidebar-layout flex h-full min-h-0 gap-3">
      {/* p-1 保证选中态 ring 不被 overflow 裁掉 */}
      <aside className="meeting-sidebar-list flex w-40 shrink-0 flex-col gap-2 overflow-y-auto p-1 sm:w-44">
        {tiles.map((t) => (
          <button
            key={t.key}
            onClick={() => onSelect(t.key)}
            className={`shrink-0 overflow-hidden rounded-lg text-left transition ${
              t.key === active.key ? 'ring-2 ring-[var(--brand)]' : 'opacity-60 hover:opacity-100'
            }`}
            title={t.label}
          >
            <VideoTile
              stream={t.stream}
              label={t.label}
              screen={t.screen}
              muted={t.muted}
              badge={t.badge}
              speaking={t.speaking}
            />
          </button>
        ))}
      </aside>

      <div className="meeting-sidebar-stage h-full min-h-0 flex-1">
        <VideoTile
          stream={active.stream}
          label={active.label}
          screen={active.screen}
          mirrored={active.isLocal && !active.screen}
          muted={active.muted}
          speaking={active.speaking}
          onToggleSidebar={onToggleSidebar}
          sidebarOpen
          fit="stage"
        />
      </div>
    </div>
  )
}

function ConnectionPill({ connection }: { connection: string }) {
  const style: Record<string, string> = {
    connected: 'bg-emerald-500/15 text-emerald-400',
    connecting: 'bg-amber-500/15 text-amber-400',
    reconnecting: 'bg-amber-500/15 text-amber-400',
    closed: 'bg-white/10 text-neutral-400',
    idle: 'bg-white/10 text-neutral-400',
  }
  const text: Record<string, string> = {
    connected: '已连接',
    connecting: '连接中',
    reconnecting: '重连中',
    closed: '已断开',
    idle: '待连接',
  }
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${style[connection] ?? style.idle}`}>
      {text[connection] ?? connection}
    </span>
  )
}

function StatsInline({ stats }: { stats: LinkStats | null }) {
  if (!stats) return null
  return (
    <span className="hidden items-center gap-3 font-mono text-[11px] text-neutral-500 lg:flex">
      <span>RTT {stats.rttMs}ms</span>
      <span>丢包 {stats.lossRate}%</span>
      <span>↑{stats.outKbps}</span>
      <span>↓{stats.inKbps}</span>
      <span className={stats.candidateType === 'relay' ? 'text-amber-400' : ''}>{stats.candidateType}</span>
    </span>
  )
}
