/**
 * RoomClient —— WebRTC 与信令的唯一持有者（ADR D11）。
 *
 * 为什么不用 React state 管理 PeerConnection：
 *  1. React 18+ 的 StrictMode 在开发模式下会"挂载→卸载→挂载"，把 PC 建在 useEffect 里会创建两条连接；
 *  2. MediaStream / RTCPeerConnection 不是不可变数据，放进 state 只会引发无意义的重渲染；
 *  3. 断线重连、重协商这些操作有严格顺序，放在一个显式状态机里比分散在 hooks 里可靠得多。
 *
 * 所以：本类独占所有浏览器 API，对外只暴露不可变快照 + 订阅（配合 useSyncExternalStore）。
 */
import { startVirtualBackground, type VirtualBackgroundHandle, type VirtualBackgroundMode } from './virtualBackground'
import { fetchRecordings, type RecordingState, type RecordingsResponse } from './recordings'
import type { WhiteboardOp } from './protocol'
import type {
  AISummaryState,
  Candidate,
  ChatMessage,
  ConnectionState,
  MediaTarget,
  Message,
  MsgType,
  DataMessage,
  PeerInfo,
  Reaction,
  SpeakerInfo,
  TrackInfo,
  VideoGrant,
} from './protocol'
import { decodeGrant } from './token'

export interface LinkStats {
  rttMs: number
  jitterMs: number
  packetsLost: number
  /** 最近一个采样窗口内的丢包率（0—100，%） */
  lossRate: number
  /** 上行总码率（kbps），用于"我发出去多少" */
  outKbps: number
  /** 下行总码率（kbps），用于"我收到多少" */
  inKbps: number
  candidateType: string

}

/**
 * ICE 候选类型的中文短标签。
 *
 * 顶栏只有一行位置，直接打 `host` / `srflx` / `relay` 对中文界面是噪音；
 * 但这些值本身是有用的诊断信息（relay 说明媒体在走 TURN 中继，带宽与延迟都会更差），
 * 所以做法是：界面上显示短标签，原始值放进 tooltip，完整解释留在统计面板里。
 */
export function candidateTypeLabel(type: string): string {
  switch (type) {
    case 'host': return '直连'
    case 'srflx': return '映射'
    case 'prflx': return '对端映射'
    case 'relay': return '中继'
    case '': return '—'
    default: return type
  }
}

/** tooltip 里的完整说明（保留原始值，方便排查）。 */
export function candidateTypeHint(type: string): string {
  const explain: Record<string, string> = {
    host: '同一局域网内直连',
    srflx: '经 STUN 得到的公网映射地址',
    prflx: '对端反射候选',
    relay: '经 TURN 中继转发（带宽与延迟开销更大）',
  }
  return `ICE 候选类型：${type || '未知'}${explain[type] ? `（${explain[type]}）` : ''}`
}

export interface RoomSnapshot {
  connection: ConnectionState
  roomId: string
  self: PeerInfo | null
  participants: PeerInfo[]
  tracks: TrackInfo[]
  /** trackId -> MediaStream（订阅到的远端媒体） */
  remoteStreams: Record<string, MediaStream>
  chat: ChatMessage[]
  /** 当前正在说话的人（按电平降序，服务端只在变化时推送） */
  speakers: SpeakerInfo[]
  /** 已举手参与者 ID（状态来自服务端信令广播，不是本地猜测） */
  hands: string[]
  /** 界面上正在飘的表情（本地自动过期） */
  reactions: Reaction[]
  /** 数据通道是否就绪（表情/举手依赖它） */
  dataChannelReady: boolean
  /** 令牌权限（仅用于 UI 取舍；服务端会独立校验） */
  grants: VideoGrant | null
  /** 非错误类提示（如"你已被主持人静音"） */
  notice: string | null
  localStream: MediaStream | null
  screenStream: MediaStream | null
  micEnabled: boolean
  camEnabled: boolean
  stats: LinkStats | null
  error: string | null
  /** 已尝试的自动重连次数（0 = 未在重连）；UI 用它显示"第 N 次重连" */
  reconnectAttempt: number
  /** 端侧虚拟背景当前模式（off/blur/color） */
  virtualBackground: VirtualBackgroundMode
  /** 正在加载模型/切换中（UI 用来禁用按钮并显示"处理中"） */
  virtualBackgroundBusy: boolean
  /** 当前录制状态（服务端广播 + 入会快照；active=true 时全员显示红点） */
  recording: RecordingState
  aiSummary: AISummaryState
  /** 房间白板内容（来自入会快照 + 服务端广播；存操作序列，可撤销、可完整还原） */
  whiteboard: WhiteboardOp[]
}

export interface RoomClientOptions {
  /** 信令地址，默认取当前页面同源的 /ws（开发期由 Vite 代理到 Go 服务） */
  wsUrl?: string
  roomId: string
  displayName: string
  /** 鉴权令牌（JWT）。为空表示服务端未启用鉴权 */
  token?: string | null
  iceServers?: RTCIceServer[]
  onError?: (msg: string) => void
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

/**
 * 自动重连参数（指数退避）。
 *
 * 退避序列：0.5s → 1s → 2s → 4s → 8s → 8s → 8s → 8s，累计约 40s。
 * 与服务端 30s 的 RESUME_GRACE 大致对齐：宽限期内重连上是"无感恢复"，
 * 超过之后服务端已经把我们移出房间，此时只能靠 Full Reconnect 重新入会。
 */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000
const RECONNECT_MAX_ATTEMPTS = 8

/**
 * 断线恢复令牌的持久化键。
 *
 * 为什么必须持久化：**刷新页面**时浏览器会直接杀掉进程，WebSocket 断开时来不及发 `leave`，
 * 服务端只能把该参与者标记为"重连中"并进入宽限期。如果这时候前端不带 `resumeToken`
 * 重新入会，服务端就会把它当成**新参与者**——于是每刷新一次就多一个幽灵，
 * 连续刷新十几下就能看到一屏"重连中"（它们还会占用房间人数上限）。
 *
 * 带上令牌 + resetMedia 之后：刷新 = 恢复同一个身份，刷新前后的瓦片是同一张。
 */
function resumeStorageKey(roomId: string): string {
  return `easylive.resume.${roomId}`
}

function loadResumeToken(roomId: string): string | null {
  try {
    const raw = sessionStorage.getItem(resumeStorageKey(roomId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { token?: string; at?: number }
    if (!parsed.token) return null
    // 服务端宽限期默认 30s，超过这个时间的令牌肯定已经失效，直接丢掉避免无谓的一次失败恢复
    if (parsed.at && Date.now() - parsed.at > 25_000) return null
    return parsed.token
  } catch {
    return null
  }
}

function saveResumeToken(roomId: string, token: string) {
  try {
    sessionStorage.setItem(resumeStorageKey(roomId), JSON.stringify({ token, at: Date.now() }))
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用：退化为每次都是新参与者，不影响可用性 */
  }
}

function clearResumeToken(roomId: string) {
  try {
    sessionStorage.removeItem(resumeStorageKey(roomId))
  } catch {
    /* 忽略 */
  }
}

/**
 * 取出 SDP 里**最后一个** a=mid:（服务端每次订阅只在末尾追加一个 m-line）。
 * 用来把即将到来的 ontrack 精确对应到我们请求的 trackId。
 */
function lastMidFromSDP(sdp: string): string | null {
  const matches = [...sdp.matchAll(/^a=mid:(.+)$/gm)]
  const last = matches[matches.length - 1]
  return last ? last[1].trim() : null
}

function wsURLFromLocation(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

export class RoomClient {
  private readonly opts: Required<Pick<RoomClientOptions, 'roomId' | 'displayName'>> &
    Omit<RoomClientOptions, 'roomId' | 'displayName'>

  private ws: WebSocket | null = null
  private pubPC: RTCPeerConnection | null = null
  private subPC: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  /** 虚拟背景句柄与"被替换掉的原始摄像头轨"（关掉特效时要换回来） */
  private vb: VirtualBackgroundHandle | null = null
  private vbCameraTrack: MediaStreamTrack | null = null

  /** 请求-响应匹配：key 是请求的 id */
  private pending = new Map<string, { types: MsgType[]; resolve: (m: Message) => void; reject: (e: Error) => void; timer: number }>()
  /** 远端描述未就绪时先缓存 ICE 候选（浏览器在 SetRemoteDescription 之前 addIceCandidate 会抛错） */
  private pendingCandidates: Record<MediaTarget, RTCIceCandidateInit[]> = { pub: [], sub: [] }
  /** 订阅必须串行：服务端在 sub 连接上是 offerer，并发订阅会撞 LocalDescription 状态 */
  private subQueue: Promise<void> = Promise.resolve()
  /**
   * 待绑定的服务端 trackId 队列（FIFO）。
   *
   * 为什么需要它：RTCPeerConnection.ontrack 给出的 MediaStream.id 是**发布者浏览器里的 msid**，
   * 与服务端的 trackId 毫无关系；而 UI 是按服务端 trackId 取流的。
   * 订阅是串行的，所以 ontrack 与 subscribe 请求严格一一对应，FIFO 即可精确配对。
   */
  private pendingTrackIds: string[] = []
  /**
   * 远端轨道登记表：mid → trackId。
   *
   * 为什么不能靠 FIFO 队列：重协商时浏览器可能对**已存在的轨道**再次触发 ontrack，
   * 于是队列被多消耗一次、后面的轨道全部错位——表现就是"能听到声音、看不到画面"
   * （视频瓦片绑到了音频流上）。mid 是每条 m-line 的唯一标识，按它匹配不会错位。
   */
  private pendingByMid = new Map<string, string>()
  /**
   * 自己屏幕共享轨道的服务端 trackId。
   * 结束共享时要靠它发 unpublish —— 否则服务端会一直留着这条轨道，
   * 表现为「别人永远看到最后一帧」+「重新共享时多出一个瓦片」。
   */
  private myScreenTrackId: string | null = null
  /**
   * 屏幕共享是否正在启动中。
   * getDisplayMedia 的选源弹窗期间 snapshot.screenStream 仍是 null，按钮依旧显示"共享屏幕"，
   * 连点两次（或同时按热键）就会发出**两条**屏幕轨 → 对方看到两张屏幕卡片。这里做个闸门。
   */
  private screenStarting = false

  /** 数据通道：pubDC 由本端创建（上行）；服务端反向开的通道在 ondatachannel 里直接挂监听 */
  private pubDC: RTCDataChannel | null = null

  /** 鉴权令牌：断线重连时复用同一个令牌（身份不变，恢复才不会失败） */
  private token: string | null

  /** 服务端下发的恢复令牌：断线重连时带上即可恢复同一参与者身份（M4） */
  private resumeToken: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null

  private listeners = new Set<() => void>()
  private snapshot: RoomSnapshot
  private statsTimer: number | null = null
  private lastStatsBytes: { out: number; in: number; at: number } = { out: 0, in: 0, at: 0 }
  private lastStatsPackets: { lost: number; received: number } = { lost: 0, received: 0 }
  private closed = false

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.token = opts.token ?? null
    // 刷新后自动带上上次的恢复令牌（同一房间、且在宽限期内）
    this.resumeToken = loadResumeToken(opts.roomId)
    this.snapshot = {
      connection: 'idle',
      roomId: opts.roomId,
      self: null,
      participants: [],
      tracks: [],
      remoteStreams: {},
      chat: [],
      speakers: [],
      hands: [],
      reactions: [],
      dataChannelReady: false,
      grants: null,
      notice: null,
      localStream: null,
      screenStream: null,
      micEnabled: true,
      camEnabled: true,
      stats: null,
      error: null,
      reconnectAttempt: 0,
      virtualBackground: 'off',
      virtualBackgroundBusy: false,
      recording: { active: false },
      aiSummary: { active: false },
      whiteboard: [],
    }
  }

  // ---------- 对外：快照订阅（useSyncExternalStore 用） ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): RoomSnapshot => this.snapshot

  private update(patch: Partial<RoomSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  // ---------- 连接与入会 ----------

  async connect(): Promise<void> {
    if (this.ws) return
    this.update({ connection: 'connecting', error: null })

    const ws = await this.openSocket()
    this.ws = ws
    this.update({ connection: 'connected' })
    this.createPeerConnections()

    // 入会并等待 joined（joined 里带回房间快照）。
    //
    // 若带着上次的恢复令牌：这是一次**页面刷新**（新页面还没有任何 PeerConnection），
    // 所以必须同时置 resetMedia —— 让服务端清掉刷新前那套已经死掉的轨道，
    // 否则会留下"永远停在最后一帧"的旧瓦片。
    const hasResume = !!this.resumeToken
    const joined = await this.request(
      {
        type: 'join',
        roomId: this.opts.roomId,
        displayName: this.opts.displayName,
        token: this.token ?? undefined,
        resumeToken: this.resumeToken ?? undefined,
        resetMedia: hasResume || undefined,
      },
      ['joined'],
      10000,
    )
    if (joined.resumeToken) {
      this.resumeToken = joined.resumeToken
      saveResumeToken(this.opts.roomId, joined.resumeToken)
    }
    this.update({
      // 服务端下发的权限优先：无鉴权模式下服务端会给全权限 devGrants，
      // 只从令牌推断会让界面把主持人功能（录制/管理）误藏起来。
      grants: joined.grants ?? decodeGrant(this.token),
      notice: null,
      // 入会快照带回录制状态：中途进来的人不必等下一次广播才知道"正在录制"
      recording: joined.room?.recording ?? { active: false },
      aiSummary: joined.room?.aiSummary ?? { active: false },
      whiteboard: joined.room?.whiteboard ?? [],
    })
    const self = joined.room?.participants.find((p) => p.id === joined.participantId) ?? null
    this.update({
      self,
      participants: joined.room?.participants ?? [],
      tracks: joined.room?.tracks ?? [],
      hands: joined.room?.hands ?? [],
    })

    // 入会前房间里已有的轨道，自动订阅（按需转发的开关就在这一步）
    for (const t of joined.room?.tracks ?? []) {
      if (t.publisherId !== joined.participantId) this.enqueueSubscribe(t.id)
    }
    this.startStatsPolling()
    this.exposeDebugHooks()
  }

  /**
   * 打开一条 WebSocket 并等待 open。
   *
   * 两个要点：
   *  1. 失败（超时/错误/立刻关闭）会 reject，由调用方决定是否退避重试；
   *  2. **只有已经被采用的连接**（this.ws === ws）断开时才触发自动重连——
   *     否则初次连接失败会同时走 reject 与重连两条路。
   */
  private openSocket(): Promise<WebSocket> {
    const url = this.opts.wsUrl ?? wsURLFromLocation()
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(url)
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* 忽略 */ }
        reject(new Error('信令连接超时'))
      }, 8000)

      ws.onopen = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(ws)
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(new Error('信令连接失败：' + url))
      }
      ws.onclose = () => {
        if (!settled) {
          settled = true
          window.clearTimeout(timer)
          reject(new Error('信令连接已关闭'))
        }
        this.handleSocketClosed(ws)
      }
      ws.onmessage = (ev) => this.onMessage(ev)
    })
  }

  // ---------- 断线自动重连（M4） ----------

  /** 连接意外断开：保留会话状态，进入指数退避重连；主动离会（closed）时什么都不做。 */
  private handleSocketClosed(ws: WebSocket) {
    if (this.closed) return
    if (this.ws !== ws) return // 已被新连接替换（例如重连过程中），忽略旧 socket 的关闭
    this.ws = null
    this.rejectPending('连接已断开')
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.update({ connection: 'closed', error: '连接已断开，自动重连失败，请点"重新连接"' })
      return
    }
    this.reconnectAttempt += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS)
    this.update({ connection: 'reconnecting', reconnectAttempt: this.reconnectAttempt })
    console.info(`[RoomClient] ${delay}ms 后进行第 ${this.reconnectAttempt} 次重连`)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.attemptReconnect()
    }, delay)
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) return
    let ws: WebSocket | null = null
    try {
      ws = await this.openSocket()
      this.ws = ws
      await this.rejoin()
      this.reconnectAttempt = 0
      this.update({ connection: 'connected', reconnectAttempt: 0, error: null })
      console.info('[RoomClient] 重连成功')
    } catch (e) {
      console.warn('[RoomClient] 重连尝试失败', e)
      if (this.ws === ws) this.ws = null
      try { ws?.close() } catch { /* 忽略 */ }
      this.scheduleReconnect()
    }
  }

  /** 自动重连放弃后，由 UI 的"重新连接"按钮触发。 */
  retryConnect(): void {
    if (this.closed) return
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try { this.ws?.close() } catch { /* 忽略 */ }
    this.ws = null
    this.reconnectAttempt = 0
    this.update({ error: null })
    this.scheduleReconnect()
  }

  /**
   * 用 resumeToken 重新入会。
   *
   * 两条路径（对应 LiveKit 的 resume / full reconnect）：
   *  - resumed=true：服务端在宽限期内保留了我们的身份与轨道，只需把可能已死的传输拉起来；
   *  - resumed=false：宽限期已过或服务端重启，只能**重建媒体面并把已有的本地流重新发布**
   *    （注意是复用 this.localStream，不重新 getUserMedia——否则摄像头会黑一下甚至打不开）。
   */
  private async rejoin(): Promise<void> {
    // 媒体面是否已经死了：死了就必须让服务端先清掉旧轨道（resetMedia），
    // 否则新连接的 SSRC 会让服务端为同一路媒体再建一条轨道。
    const resetMedia = this.isMediaPlaneDead()

    const joined = await this.request(
      {
        type: 'join',
        roomId: this.opts.roomId,
        displayName: this.opts.displayName,
        token: this.token ?? undefined,
        resumeToken: this.resumeToken ?? undefined,
        resetMedia: resetMedia || undefined,
      },
      ['joined'],
      10000,
    )
    if (joined.resumeToken) {
      this.resumeToken = joined.resumeToken
      saveResumeToken(this.opts.roomId, joined.resumeToken)
    }

    if (joined.resumed && !resetMedia) {
      // ---- 就地恢复：媒体面还活着，只把可能已死的传输拉起来 ----
      const self = joined.room?.participants.find((p) => p.id === joined.participantId) ?? this.snapshot.self
      this.update({
        self,
        participants: joined.room?.participants ?? [],
        tracks: joined.room?.tracks ?? [],
        hands: joined.room?.hands ?? [],
      })
      await this.reviveMediaPlane(joined)
      return
    }

    // ---- 需要重建媒体面 ----
    // 两种情况会走到这里：① 宽限期已过/服务端重启（resumed=false，身份也换了）；
    // ② 身份恢复了但媒体面已死（resumed=true + resetMedia，身份不变）。
    console.info(
      joined.resumed
        ? '[RoomClient] 身份已恢复但媒体面需重建：复用本地流重新发布'
        : '[RoomClient] 恢复失败（宽限期已过），执行全量重连',
    )
    const self = joined.room?.participants.find((p) => p.id === joined.participantId) ?? null
    this.update({
      self,
      participants: joined.room?.participants ?? [],
      tracks: [],
      remoteStreams: {},
      hands: joined.room?.hands ?? [],
    })
    await this.fullReconnect(joined)
  }

  /** 两条 PeerConnection 是否已有一方不可用（不可用则重连时必须重新发布媒体） */
  private isMediaPlaneDead(): boolean {
    const dead = (pc: RTCPeerConnection | null) =>
      !pc || pc.connectionState === 'failed' || pc.connectionState === 'closed'
    return dead(this.pubPC) || dead(this.subPC)
  }

  /**
   * 就地恢复时的传输修复。
   *
   * 关键：**绝不重建发布连接**。重建会换掉 RTP 的 SSRC，服务端会把它当成新轨道，
   * 于是同一路视频出现两条轨道（界面多一张卡片）。这里用 ICE restart 在**同一条连接**上
   * 换 ICE 凭据，SSRC 与 m-line 全部保持不变。
   */
  private async reviveMediaPlane(joined: Message): Promise<void> {
    const pub = this.pubPC
    if (pub && pub.connectionState !== 'connected') {
      try {
        pub.restartIce()
      } catch (e) {
        console.warn('[RoomClient] restartIce 失败', e)
      }
      // restartIce 只是换了本地 ICE 凭据，必须再发一次 offer，服务端才拿得到新凭据
      await this.renegotiatePublish('camera')
    }

    // 订阅侧：连接还活着，只补订阅"房间快照里有、本地还没有流"的轨道
    for (const t of joined.room?.tracks ?? []) {
      if (t.publisherId === this.snapshot.self?.id) continue
      if (!this.snapshot.remoteStreams[t.id]) this.enqueueSubscribe(t.id)
    }
  }

  /**
   * 重建发布连接并把**已有**本地流重新发布出去。
   * 全量重连与传输死亡恢复共用这一条路径。
   */
  private async recreatePublishPC(): Promise<void> {
    try { this.pubPC?.close() } catch { /* 忽略 */ }
    this.pubPC = null
    this.pendingCandidates.pub = []
    this.myScreenTrackId = null
    this.createPubPC()

    // 显式标注类型：this.pubPC 刚被置为 null，TS 的控制流分析会把后续引用收窄成 never
    // 断言掉控制流收窄：this.pubPC 刚被置空，TS 会把后续引用判定为 never
    const pub = this.pubPC as RTCPeerConnection | null
    const stream = this.localStream
    if (stream && pub) {
      stream.getTracks().forEach((t) => pub.addTrack(t, stream))
      this.update({ localStream: stream })
      await this.renegotiatePublish('camera')
    }
    const screen = this.screenStream
    const screenTrack = screen?.getVideoTracks()[0]
    if (screen && screenTrack && pub) {
      pub.addTrack(screenTrack, screen)
      await this.renegotiatePublish('screen')
    }
  }

  /** 全量重连：两条连接与订阅关系全部重建，但本地设备流原样复用。 */
  private async fullReconnect(joined: Message): Promise<void> {
    try { await this.pubPC?.close() } catch { /* 忽略 */ }
    try { await this.subPC?.close() } catch { /* 忽略 */ }
    this.pubPC = null
    this.subPC = null
    this.pendingCandidates = { pub: [], sub: [] }
    this.pendingTrackIds = []
    this.pendingByMid.clear()
    this.subQueue = Promise.resolve()
    this.myScreenTrackId = null

    this.createPeerConnections()
    await this.recreatePublishPC()

    for (const t of joined.room?.tracks ?? []) {
      if (t.publisherId === joined.participantId) continue
      this.enqueueSubscribe(t.id)
    }
  }

  private rejectPending(reason: string) {
    this.pending.forEach((p) => {
      window.clearTimeout(p.timer)
      p.reject(new Error(reason))
    })
    this.pending.clear()
  }

  private createPeerConnections() {
    this.createPubPC()
    this.createSubPC()
  }

  /** 发布者连接：客户端是 offerer */
  private createPubPC() {
    const iceServers = this.opts.iceServers ?? DEFAULT_ICE
    const pub = new RTCPeerConnection({ iceServers })
    pub.onicecandidate = (e) => {
      if (e.candidate) this.sendCandidate('pub', e.candidate.toJSON())
    }
    pub.onconnectionstatechange = () => {
      if (pub.connectionState === 'failed') void this.pubPC?.restartIce()
    }

    // 数据通道：客户端是 pub 连接的 offerer，所以由本端创建，
    // 必须在第一次 offer 之前建好，否则 SDP 里不会有 m=application 段。
    const dc = pub.createDataChannel('easylive', { ordered: true })
    this.pubDC = dc
    dc.onopen = () => this.update({ dataChannelReady: true })
    dc.onclose = () => this.update({ dataChannelReady: false })
    // **必须在自己建的这条上也监听**：SCTP 通道是双向的，服务端就在这条上回推。
    // 之前只有下面那条"服务端反向开的通道"挂了 onmessage，而它在当前 SDP 时序下
    // 根本不会触发 ondatachannel —— 结果就是别人发的表情/弹幕永远收不到，
    // 发送方却一切正常（服务端还显示"送达 1/1"），非常难查。
    dc.onmessage = (ev) => this.onDataMessage(ev.data as string)

    // 服务端会在同一条 SCTP 关联上反向开一条用于推送（不需要重新协商）
    pub.ondatachannel = (e) => {
      // DEV 诊断：数据面没有"送达确认"，出问题时必须能看出"服务端那条通道到底建起来没有"
      if (import.meta.env.DEV) console.debug('[dc] 服务端反向通道已建立 label=' + e.channel.label)
      e.channel.onopen = () => { if (import.meta.env.DEV) console.debug('[dc] 服务端反向通道已就绪') }
      e.channel.onmessage = (ev) => this.onDataMessage(ev.data as string)
    }

    this.update({ dataChannelReady: false })
    this.pubPC = pub
  }

  /** 订阅者连接：服务端是 offerer（我们在 subscribe_offer 里应答） */
  private createSubPC() {
    const iceServers = this.opts.iceServers ?? DEFAULT_ICE
    const sub = new RTCPeerConnection({ iceServers })
    sub.onicecandidate = (e) => {
      if (e.candidate) this.sendCandidate('sub', e.candidate.toJSON())
    }
    sub.ontrack = (e) => {
      // 1) 首选：按 mid 精确匹配（重协商不会错位）
      const mid = e.transceiver?.mid ?? ''
      let trackId = mid ? this.pendingByMid.get(mid) : undefined
      if (trackId) this.pendingByMid.delete(mid)

      // 2) 退路：按类型在"还没有流的远端轨道"里找一条（快照里就有 kind，不需要猜）
      if (!trackId) {
        const fallback = this.snapshot.tracks.find(
          (t) =>
            t.kind === e.track.kind &&
            t.publisherId !== this.snapshot.self?.id &&
            !this.snapshot.remoteStreams[t.id],
        )
        trackId = fallback?.id
      }
      // 3) 最后的退路：队列（旧行为）
      if (!trackId) trackId = this.pendingTrackIds.shift()
      if (!trackId) {
        console.warn('[RoomClient] 收到未登记的远端轨道，忽略', e.track.kind, mid)
        return
      }

      // 关键：把轨道显式并入流。
      // e.streams[0] 可能只含音频（同一发布者的音频/视频共用 stream id 时尤其如此），
      // 那样视频瓦片就会"有声音没画面"。这里保证流里确实有这条轨道。
      const stream = e.streams[0] ?? new MediaStream()
      if (!stream.getTracks().some((t) => t.id === e.track.id)) stream.addTrack(e.track)
      this.update({ remoteStreams: { ...this.snapshot.remoteStreams, [trackId]: stream } })
    }
    this.subPC = sub
  }

  /**
   * 开发模式下把两条连接的原始 getStats 挂到 window，供浏览器探针排查
   * "远端画面黑屏/收不到媒体"这类问题（生产构建里 import.meta.env.DEV 为 false，
   * 这段会被摇树掉，不进入产物）。
   *
   * 存在的理由：只有它能把"RTP 到了但解不出帧（关键帧/编解码）"和
   * "RTP 根本没到（ICE/转发）"分开——这两类的修法完全不同。
   */
  private exposeDebugHooks(): void {
    if (!import.meta.env?.DEV) return
    const w = window as unknown as Record<string, unknown>
    // 开发用：屏幕共享的发送参数与轨道信息（生产构建里这段不会存在）
    w.__easyliveDebugScreen = async () => {
      const pc = this.pubPC
      if (!pc) return null
      const out = { video: 0, audio: 0, contentHint: null as string | null, degradation: null as string | null, maxFramerate: null as number | null }
      for (const s of pc.getSenders()) {
        const t = s.track
        if (!t) continue
        if (t.kind === 'audio') out.audio++
        if (t.kind === 'video') {
          out.video++
          if (t.contentHint === 'text') out.contentHint = 'text'
        }
        const params = s.getParameters?.()
        if (params?.degradationPreference) out.degradation = params.degradationPreference
        if (params?.encodings?.[0]?.maxFramerate) out.maxFramerate = params.encodings[0].maxFramerate ?? null
      }
      return out
    }
    w.__easyliveDebugPCs = async () => {
      const dump = async (pc: RTCPeerConnection | null) => {
        if (!pc) return null
        const rows: Record<string, unknown>[] = []
        const report = await pc.getStats()
        report.forEach((r) => {
          const v = r as unknown as Record<string, unknown>
          if (v.type === 'inbound-rtp' || v.type === 'outbound-rtp') {
            rows.push({
              type: v.type, kind: v.kind, bytesReceived: v.bytesReceived, packetsReceived: v.packetsReceived,
              framesReceived: v.framesReceived, framesDecoded: v.framesDecoded, freezeCount: v.freezeCount,
              bytesSent: v.bytesSent, packetsSent: v.packetsSent, framesEncoded: v.framesEncoded,
            })
          } else if (v.type === 'candidate-pair' && v.nominated) {
            rows.push({ type: v.type, state: v.state, nominated: v.nominated, currentRoundTripTime: v.currentRoundTripTime })
          } else if (v.type === 'transport') {
            rows.push({ type: v.type, dtlsState: v.dtlsState, bytesReceived: v.bytesReceived })
          }
        })
        return { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, iceGatheringState: pc.iceGatheringState, rows }
      }
      return { pub: await dump(this.pubPC), sub: await dump(this.subPC) }
    }
    // 快照要转成可序列化的摘要：直接返回会带 MediaStream 对象，探针读不到内容
    w.__easyliveDebugSnapshot = () => ({
      self: this.snapshot.self?.id ?? null,
      participants: this.snapshot.participants.map((p) => ({ id: p.id, name: p.name, state: p.state })),
      tracks: this.snapshot.tracks.map((t) => ({ id: t.id, publisherId: t.publisherId, kind: t.kind, source: t.source, muted: t.muted })),
      remoteStreamKeys: Object.keys(this.snapshot.remoteStreams),
      remoteStreams: Object.entries(this.snapshot.remoteStreams).map(([tid, st]) => ({
        tid, tracks: st.getTracks().map((tr) => `${tr.kind}:${tr.id}:${tr.readyState}:enabled=${tr.enabled}:muted=${tr.muted}`),
      })),
      localTracks: this.localStream ? this.localStream.getTracks().map((tr) => `${tr.kind}:${tr.readyState}`) : [],
      // 端侧 AI 状态：给自动化探针一个可读的出口（真实用户界面不依赖它）
      grants: this.snapshot.grants,
      whiteboardStrokes: this.snapshot.whiteboard.length,
      recordingActive: this.snapshot.recording.active,
      virtualBackground: this.snapshot.virtualBackground,
      virtualBackgroundBusy: this.snapshot.virtualBackgroundBusy,
      localVideoFromCanvas: this.localStream?.getVideoTracks()[0]?.label?.includes('canvas') ?? false,
      stats: this.snapshot.stats,
    })
  }

  // ---------- 发布本地媒体 ----------

  /**
   * 打开摄像头/麦克风并发布（首次 publish，source=camera）。
   *
   * provided：会前页已经拿到的预览流。**务必优先复用它**——
   * 如果先 stop() 预览再重新 getUserMedia，会因为"设备释放是异步的"而偶发
   * NotReadableError/AbortError，表现为"自己的卡片不显示"（本地瓦片完全由 localStream 驱动）。
   */
  /** 设备打开失败后，用户点"重试"时调用（仅在尚未拿到本地流时才有意义）。 */
  async retryLocalMedia(): Promise<void> {
    if (this.localStream) return
    await this.publishLocalMedia({ video: true, audio: true })
  }

  /**
   * 申请设备并带退避重试。
   *
   * 为什么需要：摄像头的**释放是异步的**。上一个流刚 stop()，系统可能还占用设备几百毫秒，
   * 这时 getUserMedia 会抛 NotReadableError/AbortError。以下场景都会踩到：
   *   - 会前页预览刚被释放
   *   - 开发模式 StrictMode 的 effect 双调用（第一个 client 刚接手预览流就被销毁）
   *   - 在设置里来回切换设备
   * 退避重试三次（300/600/900ms）基本可以完全覆盖。
   */
  private async acquireWithRetry(constraints: MediaStreamConstraints, attempts = 3): Promise<MediaStream> {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints)
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 300 * (i + 1)))
      }
    }
    throw lastErr
  }

  async publishLocalMedia(
    constraints: MediaStreamConstraints = { video: true, audio: true },
    provided?: MediaStream | null,
  ): Promise<void> {
    if (!this.pubPC) throw new Error('尚未连接信令')

    let stream: MediaStream
    if (provided && provided.getTracks().some((t) => t.readyState === 'live')) {
      stream = provided
    } else {
      try {
        stream = await this.acquireWithRetry(constraints)
      } catch (e) {
        // 摄像头可能被其他程序占用/尚未释放：退化为仅音频，保证仍能参会并出现在成员列表，
        // 而不是整个入会失败、连自己的卡片都没有。
        if (!constraints.video || !constraints.audio) throw e
        const reason = e instanceof Error ? e.message : String(e)
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false })
        this.update({ error: `摄像头不可用（${reason}），已仅发布音频` })
      }
    }

    this.localStream = stream
    for (const track of stream.getTracks()) {
      this.pubPC.addTrack(track, stream)
    }
    // 如实反映实际发布出去的轨道（例如摄像头失败时不该显示"摄像头已开"）
    //
    // 同时清掉过期的媒体错误：顺利拿到视频轨说明"摄像头不可用"已经不成立了。
    // 不清的话，重试成功的用户会看到红字错误与正常画面同时存在——
    // 那比没有提示更糟：他以为摄像头还是坏的（这正是用户报的"摄像头不可用了"）。
    const hasVideo = stream.getVideoTracks().length > 0
    this.update({
      localStream: stream,
      micEnabled: stream.getAudioTracks().length > 0,
      camEnabled: hasVideo,
      ...(hasVideo ? { error: null } : {}),
    })
    await this.renegotiatePublish('camera')
  }

  /** 开始屏幕共享：新增一路视频轨并重协商（source=screen，服务端据此打标） */
  async startScreenShare(): Promise<void> {
    if (!this.pubPC) throw new Error('尚未连接信令')
    if (this.screenStarting || this.screenStream) return
    this.screenStarting = true

    let stream: MediaStream
    try {
      // 屏幕共享的两件事都在这一个请求里定下来：
      //  1. **同时要系统声音**（讲 PPT 里的视频/音乐时是刚需）。Chrome 支持共享标签页/
      //     屏幕时带音频，Safari/Firefox 多数不支持——不支持时整条请求会直接失败，
      //     所以必须回退成"仅视频"，不能让共享功能因为音频不可用而不可用。
      //  2. 分辨率按屏幕给足、帧率压到 15 帧：文字/图表只需要清晰，不需要 30 帧，
      //     省下来的码率全给分辨率——这就是"文字优先"的第一半。
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: {
          // 本地不要再放一遍（否则自己的系统声音会绕回来叠一层）。
          // 该字段是 Chrome 的实际能力，但 lib.dom 里还没有它，所以断言成宽松类型。
          suppressLocalAudioPlayback: true,
          // 系统声音不是人声，任何语音处理都会损伤它
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      })
    } catch (err) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      }).catch((e) => {
        throw e instanceof Error ? e : err instanceof Error ? err : new Error('屏幕共享被拒绝')
      })
    } finally {
      this.screenStarting = false
    }
    this.screenStream = stream
    const track = stream.getVideoTracks()[0]
    // "文字优先"的另一半：告诉编码器这是**文字/图形**内容，
    // 它会据此选编码参数（不为了运动模糊掉细节）。这是浏览器原生机制，零成本。
    try {
      track.contentHint = 'text'
    } catch {
      /* 个别浏览器不支持 contentHint，忽略即可 */
    }
    // 用户点击浏览器"停止共享"时也要通知服务端重协商
    track.onended = () => void this.stopScreenShare()
    this.pubPC.addTrack(track, stream)
    // 系统声音也发布（source 由 renegotiatePublish('screen') 统一标记为 screen，服务端无需改动）
    for (const a of stream.getAudioTracks()) this.pubPC.addTrack(a, stream)
    this.update({ screenStream: stream })
    await this.renegotiatePublish('screen')
    // 协商完成后设置发送参数：丢包时**保分辨率**（宁可掉帧也不要糊成一片），
    // 这是"文字优先"最实际的体现——弱网下别人仍能看清 PPT 上的字。
    this.tuneScreenSender(track)
  }

  /** 屏幕共享的发送参数：丢包时保分辨率、限制帧率上限。 */
  private tuneScreenSender(track: MediaStreamTrack): void {
    const pc = this.pubPC
    if (!pc) return
    const sender = pc.getSenders().find((s) => s.track === track)
    if (!sender) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxFramerate = 15
      params.degradationPreference = 'maintain-resolution'
      void sender.setParameters(params).catch((err) => {
        console.warn('[RoomClient] 屏幕共享发送参数设置失败（不影响共享本身）', err)
      })
    } catch (err) {
      console.warn('[RoomClient] 读取发送参数失败（不影响共享本身）', err)
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this.pubPC || !this.screenStream) return

    // 1) 先告诉服务端这条轨道下线：它会从房间移除并广播 track_unpublished，
    //    其他人才会移除瓦片，而不是永远停在最后一帧。
    const trackId = this.myScreenTrackId
    this.myScreenTrackId = null
    if (trackId) this.send({ type: 'unpublish', trackId })

    // 2) 再在本地移除轨道并重协商
    const [track] = this.screenStream.getVideoTracks()
    const sender = this.pubPC.getSenders().find((s) => s.track === track)
    if (sender) this.pubPC.removeTrack(sender)
    this.screenStream.getTracks().forEach((t) => t.stop())
    this.screenStream = null
    this.update({ screenStream: null })

    // 3) 清掉本地残留的该轨道记录，避免瓦片残留
    if (trackId) {
      const remoteStreams = { ...this.snapshot.remoteStreams }
      delete remoteStreams[trackId]
      this.update({
        tracks: this.snapshot.tracks.filter((t) => t.id !== trackId),
        remoteStreams,
      })
    }

    await this.renegotiatePublish('camera')
  }

  /** 在 pub 连接上重协商（客户端始终是 offerer，因此不会与服务端的 sub offer 冲突） */
  private async renegotiatePublish(source: string): Promise<void> {
    const pc = this.pubPC
    if (!pc) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await this.request({ type: 'publish', sdp: pc.localDescription?.sdp ?? '', source }, ['publish_answer'], 15000)
    if (!answer.sdp) throw new Error('publish_answer 缺少 sdp')
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    await this.flushCandidates('pub')
  }

  // ---------- 订阅远端轨道 ----------

  /** 串行化订阅：服务端在 sub 连接上是 offerer，必须一次协商完成后再进行下一次 */
  private enqueueSubscribe(trackId: string) {
    this.subQueue = this.subQueue.then(() => this.subscribeTrack(trackId)).catch((e) => {
      console.warn('[RoomClient] 订阅失败', trackId, e)
    })
  }

  async subscribeTrack(trackId: string): Promise<void> {
    const pc = this.subPC
    if (!pc) return
    if (this.snapshot.remoteStreams[trackId]) return

    const offer = await this.request({ type: 'subscribe', trackId }, ['subscribe_offer'], 15000)
    if (!offer.sdp) throw new Error('subscribe_offer 缺少 sdp')

    // 必须在 setRemoteDescription **之前**登记：ontrack 是随应用远端描述一起触发的。
    // 服务端每次只在末尾追加一个 m-line，所以最后一个 a=mid: 就是这次新增的那条。
    const mid = lastMidFromSDP(offer.sdp)
    if (mid) this.pendingByMid.set(mid, trackId)
    else this.pendingTrackIds.push(trackId) // 解析不出 mid 时退回队列
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    await this.flushCandidates('sub')
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.send({ type: 'answer', target: 'sub', id: offer.id, sdp: pc.localDescription?.sdp ?? '' })
  }

  // ---------- 设备切换（不重协商，用 replaceTrack 热替换）----------

  async switchMicrophone(deviceId: string): Promise<void> {
    await this.replaceDevice('audio', deviceId)
  }

  async switchCamera(deviceId: string): Promise<void> {
    await this.replaceDevice('video', deviceId)
  }

  /**
   * 热切换设备：getUserMedia 拿到新轨道 → sender.replaceTrack → 停掉旧轨道。
   * 用 replaceTrack 而不是重新 addTrack + 重协商：不会中断已经建立的连接，
   * 对端也感知不到（这正是"设置"面板里切设备应该有的行为）。
   */
  private async replaceDevice(kind: 'audio' | 'video', deviceId: string): Promise<void> {
    const pc = this.pubPC
    if (!pc) return

    const current =
      kind === 'audio' ? this.localStream?.getAudioTracks()[0] : this.localStream?.getVideoTracks()[0]
    const sender = pc.getSenders().find((s) => s.track === current)

    const fresh = await navigator.mediaDevices.getUserMedia(
      kind === 'audio'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    )
    const next = kind === 'audio' ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0]
    if (!next) return

    next.enabled = current?.enabled ?? true // 继承当前的静音/关闭状态
    if (sender) await sender.replaceTrack(next)
    current?.stop()

    // 用新轨道重建 MediaStream：对象换新，React 才会重新给 <video> 赋 srcObject
    const merged = new MediaStream()
    if (kind === 'audio') {
      this.localStream?.getVideoTracks().forEach((t) => merged.addTrack(t))
      merged.addTrack(next)
    } else {
      this.localStream?.getAudioTracks().forEach((t) => merged.addTrack(t))
      merged.addTrack(next)
    }
    this.localStream = merged
    this.update({ localStream: merged })
  }

  // ---------- 本地开关 ----------

  setMicEnabled(enabled: boolean) {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled))
    this.update({ micEnabled: enabled })
    const track = this.snapshot.tracks.find((t) => t.publisherId === this.snapshot.self?.id && t.kind === 'audio')
    if (track) this.send({ type: 'mute', trackId: track.id, muted: !enabled })
  }

  setCamEnabled(enabled: boolean) {
    // 关摄像头时先收掉虚拟背景：处理管线会一直往 SFU 推最后一帧，
    // 否则"关了摄像头别人还能看到我"——这正是虚拟背景最容易踩的坑。
    if (!enabled && this.snapshot.virtualBackground !== 'off') void this.setVirtualBackground('off')
    // 开启虚拟背景时流里放的是画布轨，真正代表"摄像头开关"的是 vbCameraTrack
    const camTrack = this.vbCameraTrack ?? this.localStream?.getVideoTracks()[0]
    if (camTrack) camTrack.enabled = enabled
    this.update({ camEnabled: enabled })
    const track = this.snapshot.tracks.find((t) => t.publisherId === this.snapshot.self?.id && t.kind === 'video' && t.source !== 'screen')
    if (track) this.send({ type: 'mute', trackId: track.id, muted: !enabled })
  }

  /**
   * 开关端侧虚拟背景。
   *
   * 关键点：换轨走 `sender.replaceTrack()`，**m-line 与 SSRC 都不变**，
   * 所以 SFU 侧完全无感，也不需要任何信令/协议改动——服务端看到的还是同一条轨道。
   * 同时把 localStream 里的视频轨也换成处理后的轨，保证"自己看到的 = 别人看到的"。
   */
  async setVirtualBackground(mode: VirtualBackgroundMode) {
    if (this.snapshot.virtualBackgroundBusy) return
    const sender = this.pubPC?.getSenders().find((s) => s.track?.kind === 'video')
    if (!sender) {
      this.update({ notice: '当前没有可处理的视频轨（先发布摄像头）' })
      return
    }
    const camera = this.localStream?.getVideoTracks()[0] ?? null

    // ---- 关闭 ----
    if (mode === 'off') {
      const vb = this.vb
      const cam = this.vbCameraTrack
      this.vb = null
      this.vbCameraTrack = null
      if (cam) {
        try {
          await sender.replaceTrack(cam)
        } catch (e) {
          this.update({ notice: `恢复摄像头失败：${e instanceof Error ? e.message : String(e)}` })
        }
        this.swapLocalVideoTrack(cam)
      }
      vb?.stop()
      this.update({ virtualBackground: 'off', notice: vb ? '已关闭虚拟背景' : null })
      return
    }

    // ---- 开启 ----
    if (!camera) {
      this.update({ notice: '请先打开摄像头再启用虚拟背景' })
      return
    }
    this.update({ virtualBackgroundBusy: true })
    try {
      const handle = await startVirtualBackground(camera)
      this.vb?.stop()
      this.vb = handle
      this.vbCameraTrack = camera

      this.swapLocalVideoTrack(handle.track)
      await sender.replaceTrack(handle.track)
      this.update({
        virtualBackground: mode,
        virtualBackgroundBusy: false,
        notice: '虚拟背景已开启：背景虚化（端侧处理，画面不出本机）',
      })
    } catch (e) {
      this.update({
        virtualBackground: 'off',
        virtualBackgroundBusy: false,
        // 明确告诉用户"原画面没受影响"，否则会以为摄像头坏了
        notice: `虚拟背景启用失败：${e instanceof Error ? e.message : String(e)}（摄像头画面不受影响）`,
      })
    }
  }

  /**
   * 把本地预览流里的视频轨换成另一条（虚拟背景开关用）。
   *
   * 为什么必须**换掉整个 MediaStream 对象**，而不是就地在原对象上 removeTrack/addTrack：
   * <video> 的 srcObject 只在"对象变了"时才重新绑定；就地增删轨时 React 侧看到的
   * 还是同一个对象 → 不会重新赋 srcObject → 播放器继续显示那条已被 stop 的旧轨
   * = **关掉特效后画面一直黑**（真人实测踩到的就是这个）。
   */
  private swapLocalVideoTrack(track: MediaStreamTrack) {
    const old = this.localStream
    const audio = old ? old.getAudioTracks() : []
    const next = new MediaStream([...audio, track])
    this.localStream = next
    this.update({ localStream: next })
  }

  sendChat(text: string) {
    this.send({ type: 'chat', text })
  }

  // ---------- 数据面（SCTP 数据通道）----------

  /**
   * 在数据通道上发送。数据面语义是"尽力而为"：
   * 通道没就绪就静默丢弃，绝不能因为一个表情让界面报错。
   */
  private sendData(msg: DataMessage): boolean {
    const dc = this.pubDC
    if (!dc || dc.readyState !== 'open') return false
    try {
      dc.send(JSON.stringify(msg))
      return true
    } catch (e) {
      console.warn('[RoomClient] 数据通道发送失败', e)
      return false
    }
  }

  /**
   * 保证发布连接完成协商，即使本端没有任何媒体。
   *
   * 为什么需要：数据通道（举手/表情）建在**发布连接**上，而发布连接原本只在
   * "有本地媒体"时才会协商。于是没有摄像头 / 权限被拒的用户会静默失去这两个功能
   * （表现为"点了没反应"）。这里补一次只带数据通道的 offer，让数据面独立于媒体建立。
   */
  async ensureDataPlane(): Promise<void> {
    if (!this.pubPC || this.localStream) return
    try {
      await this.renegotiatePublish('camera')
    } catch (e) {
      console.warn('[RoomClient] 无媒体时协商数据通道失败', e)
    }
  }

  /**
   * 发一个表情 / 弹幕 / 互动动效。本地立即回显（服务端只中继给其他人），
   * 避免自己看不到自己发的东西。
   *
   * 三者共用 type='reaction' 一条消息：
   *   · 只有 emoji     → 角落里的表情浮层
   *   · emoji + text   → 弹幕（底栏上方滚一条"谁：说了什么"）
   *   · kind='action'  → 互动动效（从底栏往上弹一下）
   */
  sendReaction(emoji: string, text?: string, kind?: 'action') {
    // **走信令面**（原来是数据面）。
    //
    // 为什么改：数据面在浏览器上出现了"服务端显示送达、页面收不到"的情况，
    // 而信令这条路上的聊天/举手/白板在所有客户端上都已验证可靠。
    // 弹幕与互动是低频消息，走信令完全够用。
    // 服务端会把这条广播给房间里**所有人（含发送者自己）**，所以这里**不做本地回显**——
    // 否则自己会看到两条，而且"自己看到的"和"别人看到的"可能不一致。
    this.send({ type: 'flash', emoji, text, kind })
  }

  /**
   * 举手/取消举手。**上报走数据面，状态回传走信令**：
   * 举手是状态，必须可靠、断线恢复后仍在、新人入会能看到，所以由服务端落库并广播。
   */
  toggleHand() {
    const selfId = this.snapshot.self?.id
    if (!selfId) return
    const raised = !this.snapshot.hands.includes(selfId)

    // 优先走数据面（低延迟，也顺带验证数据通道可用）；
    // 数据面不可用时回退信令面——举手是**状态**，状态本来就该走可靠通道。
    // 两条路在服务端是同一个处理函数，重复送达也是幂等的。
    if (!this.sendData({ type: 'raise_hand', raised })) {
      this.send({ type: 'hand_state', raised })
    }
  }

  /** 清掉提示条（用户点"知道了"） */
  clearNotice() {
    this.update({ notice: null })
  }

  // ---------- 主持人管理 ----------

  /**
   * 执行主持人操作。服务端会校验 roomAdmin；失败时 request() 会以 error 拒绝，
   * 调用方据此给出提示（前端不自己判断权限，避免"看起来能点但必然失败"）。
   */
  /**
   * 提交一条白板操作。
   *
   * 刻意做成**一笔一条消息**（而不是每个采样点一条）：白板是共享状态，
   * 一次绘制只产生一条小消息，既省带宽也避免把信令队列打满。
   * 服务端会校验/裁剪并补上 by/seq，再广播回来——本地不等广播、立即先画（乐观渲染），
   * 广播到达后按 seq 收敛，体感无延迟。
   */
  sendWhiteboardOp(op: WhiteboardOp): void {
    // 仅开发环境的调试钩子：把提交延后 N 毫秒，用来复现"上一笔还没确认就画下一笔"
    // 这条真实网络下必现、而回环(<50ms 回声)下永远触发不到的路径。
    // 生产构建里 import.meta.env.DEV 为 false，这段会被摇掉。
    if (import.meta.env.DEV) {
      const delay = (window as unknown as { __easyliveWhiteboardDelay?: number }).__easyliveWhiteboardDelay
      if (typeof delay === 'number' && delay > 0) {
        window.setTimeout(() => this.send({ type: 'whiteboard', op }), delay)
        return
      }
    }
    this.send({ type: 'whiteboard', op })
  }

  /** 把服务端广播/入会快照里的白板操作应用到本地状态。 */
  private applyWhiteboardOp(op: WhiteboardOp | undefined): void {
    if (!op) return
    const cur = this.snapshot.whiteboard
    switch (op.kind) {
      case 'clear':
        this.update({ whiteboard: [] })
        break
      case 'undo':
        // 服务端现在按绘制者归属撤销，并带上被撤销那一笔的 seq；
        // 按 seq 精确删除，兼容收不到 undoSeq 的旧服务端（回退为弹最后一笔）
        this.update({ whiteboard: op.undoSeq ? cur.filter((o) => o.seq !== op.undoSeq) : cur.slice(0, -1) })
        break
      default:
        this.update({ whiteboard: [...cur, op] })
    }
  }

  /**
   * 开始/结束录制（需要 roomAdmin，服务端会强制校验）。
   *
   * 服务端在"转发即录制"的前提下启停都是即时的：开始 = 给房间里已在发布的轨道挂写入器，
   * 停止 = 摘掉并收尾清单，所以这里不需要等待任何媒体协商。
   */
  async setRecording(action: 'start' | 'stop'): Promise<void> {
    await this.request({ type: 'record', action }, ['record'], 8000)
    this.update({ notice: action === 'start' ? '已开始录制（本机零转码落盘）' : '已停止录制，录制文件已写入服务端' })
  }

  /**
   * 开关 AI 会议总结（任何参会者可用，服务端会校验已入会）。
   *
   * 开启后服务端订阅各路音频做转写 + 定时生成 markdown 纪要，
   * 通过 ai_summary_state / ai_summary_update 推送回来。
   */
  async setAISummary(action: 'start' | 'stop'): Promise<void> {
    await this.request({ type: 'ai_summary', action }, ['ai_summary'], 8000)
  }

  /** 拉注册制会话列表（HTTP 查询，不走信令）。失败返回 null，由 UI 提示。 */
  async listRecordings(): Promise<RecordingsResponse | null> {
    return fetchRecordings()
  }

  async moderate(action: 'mute' | 'kick', targetId: string): Promise<void> {
    await this.request({ type: 'moderate', action, targetId }, ['moderate'], 5000)
    if (action === 'kick') {
      this.update({ notice: '已将该参与者移出房间' })
    } else {
      this.update({ notice: '已强制静音该参与者' })
    }
  }

  private pushReaction(fromId: string, emoji: string, text?: string, kind?: 'action', fromName?: string) {
    const item: Reaction = {
      id: crypto.randomUUID(),
      fromId,
      fromName: fromName ?? this.snapshot.participants.find((p) => p.id === fromId)?.name ?? '我',
      emoji,
      at: Date.now(),
      text,
      kind,
      // 互动动效的横向位置在这里定下来：渲染时再随机的话，每帧重算会导致左右乱跳
      x: Math.random(),
    }
    // 带文字的当弹幕显示，读起来要点时间，所以留久一点（6s vs 3.2s）
    const ttl = text ? 6000 : 3200
    this.update({ reactions: [...this.snapshot.reactions, item].slice(-12) })
    // 到期自动移除，UI 不需要额外的重绘定时器
    window.setTimeout(() => {
      this.update({ reactions: this.snapshot.reactions.filter((r) => r.id !== item.id) })
    }, ttl)
  }

  private onDataMessage(raw: string) {
    let msg: DataMessage
    try {
      msg = JSON.parse(raw) as DataMessage
    } catch {
      return
    }
    // DEV 专用诊断：数据面是"尽力而为"的，收到没收到在界面上分辨不出来，
    // 出问题时只能靠这一行判断"消息到底有没有到浏览器"（生产构建会被摇掉）。
    if (import.meta.env.DEV) {
      console.debug('[datachannel] 收到', msg.type, msg.emoji ?? '', msg.text ?? '', msg.kind ?? '', msg.fromId ?? '')
    }
    if (msg.type === 'reaction' && msg.emoji && msg.fromId) {
      // 名字优先用服务端填的那个：客户端自报的名字不可信，否则谁都能冒充别人发弹幕
      this.pushReaction(msg.fromId, msg.emoji, msg.text, msg.kind, msg.fromName)
    }
  }

  // ---------- 收尾 ----------

  leave() {
    this.closed = true
    // 主动离开：清掉恢复令牌。否则下次打开这一页会尝试"恢复身份"，
    // 而那个参与者其实已经正常离会了，恢复必然失败、白等一次往返。
    clearResumeToken(this.opts.roomId)
    this.myScreenTrackId = null
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.statsTimer) window.clearInterval(this.statsTimer)
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'leave' })
    } catch {
      /* 忽略 */
    }
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.screenStream?.getTracks().forEach((t) => t.stop())
    void this.pubPC?.close()
    void this.subPC?.close()
    try { this.pubDC?.close() } catch { /* 忽略 */ }
    this.pubDC = null
    this.ws?.close()
    this.ws = null
    this.rejectPending('已离开房间')
    this.update({ connection: 'closed', reconnectAttempt: 0 })
  }

  // ---------- 协议收发 ----------

  private send(msg: Message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  /** 发送请求并等待指定类型的响应（用 id 匹配，超时抛错） */
  private request(msg: Message, expect: MsgType[], timeoutMs: number): Promise<Message> {
    const id = msg.id ?? crypto.randomUUID()
    return new Promise<Message>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待 ${expect.join('/')} 超时`))
      }, timeoutMs)
      this.pending.set(id, { types: expect, resolve, reject, timer })
      this.send({ ...msg, id })
    })
  }

  private sendCandidate(target: MediaTarget, c: RTCIceCandidateInit) {
    this.send({ type: 'candidate', target, candidate: c as Candidate })
  }

  private async flushCandidates(target: MediaTarget) {
    const pc = target === 'pub' ? this.pubPC : this.subPC
    const list = this.pendingCandidates[target]
    this.pendingCandidates[target] = []
    for (const c of list) {
      try {
        await pc?.addIceCandidate(c)
      } catch (e) {
        console.warn('[RoomClient] addIceCandidate 失败', e)
      }
    }
  }

  private onMessage(ev: MessageEvent) {
    let msg: Message
    try {
      msg = JSON.parse(ev.data as string) as Message
    } catch {
      return
    }

    // 弹幕/互动：服务端广播回来的那条。fromId/fromName 由服务端填（客户端无法伪造），
    // 而且**发送者自己也会收到**——所以客户端不做本地回显，两边看到的内容永远一致。
    if (msg.type === 'flash_message' && msg.flash) {
      const f = msg.flash
      this.pushReaction(f.fromId, f.emoji, f.text, f.kind, f.fromName)
    }

    // 1) 先看是否有人在等这个响应
    if (msg.id) {
      const waiter = this.pending.get(msg.id)
      if (waiter && (waiter.types.includes(msg.type) || msg.type === 'error')) {
        window.clearTimeout(waiter.timer)
        this.pending.delete(msg.id)
        if (msg.type === 'error') waiter.reject(new Error(`${msg.code}: ${msg.reason}`))
        else waiter.resolve(msg)
        return
      }
    }

    // 2) 事件与请求（服务端主动发起的信令）
    switch (msg.type) {
      case 'candidate': {
        if (!msg.candidate) return
        const target = msg.target ?? 'pub'
        const pc = target === 'pub' ? this.pubPC : this.subPC
        if (pc?.remoteDescription) void pc.addIceCandidate(msg.candidate as RTCIceCandidateInit)
        else this.pendingCandidates[target].push(msg.candidate as RTCIceCandidateInit)
        return
      }
      case 'participant_joined': {
        if (!msg.participant) return
        const exists = this.snapshot.participants.some((p) => p.id === msg.participant!.id)
        if (!exists) this.update({ participants: [...this.snapshot.participants, msg.participant] })
        return
      }
      case 'participant_left': {
        const left = msg.participantId
        const remoteStreams = { ...this.snapshot.remoteStreams }
        for (const t of this.snapshot.tracks.filter((x) => x.publisherId === left)) delete remoteStreams[t.id]
        this.update({
          participants: this.snapshot.participants.filter((p) => p.id !== left),
          tracks: this.snapshot.tracks.filter((t) => t.publisherId !== left),
          remoteStreams,
          hands: this.snapshot.hands.filter((id) => id !== left),
        })
        return
      }
      case 'track_published': {
        if (!msg.track) return
        if (this.snapshot.tracks.some((t) => t.id === msg.track!.id)) return
        this.update({ tracks: [...this.snapshot.tracks, msg.track] })
        if (msg.track.publisherId === this.snapshot.self?.id) {
          // 服务端也会把 track_published 发回给发布者，就是为了让发布者知道自己的 trackId
          if (msg.track.source === 'screen') this.myScreenTrackId = msg.track.id
          return
        }
        this.enqueueSubscribe(msg.track.id)
        return
      }
      case 'track_unpublished': {
        const remoteStreams = { ...this.snapshot.remoteStreams }
        delete remoteStreams[msg.trackId ?? '']
        this.update({
          tracks: this.snapshot.tracks.filter((t) => t.id !== msg.trackId),
          remoteStreams,
        })
        return
      }
      case 'track_muted': {
        this.update({
          tracks: this.snapshot.tracks.map((t) => (t.id === msg.trackId ? { ...t, muted: !!msg.muted } : t)),
        })
        return
      }
      case 'hand_state': {
        const id = msg.participantId ?? ''
        const raised = !!msg.raised
        const hands = raised
          ? Array.from(new Set([...this.snapshot.hands, id]))
          : this.snapshot.hands.filter((x) => x !== id)
        this.update({ hands })
        return
      }
      case 'force_mute': {
        // 被主持人强制静音：服务端已经停止转发我的音频，这里同步 UI 状态
        if (msg.muted) {
          this.localStream?.getAudioTracks().forEach((t) => (t.enabled = false))
          this.update({ micEnabled: false, notice: '你已被主持人静音' })
        } else {
          this.update({ notice: '主持人已解除静音' })
        }
        return
      }
      case 'active_speakers': {
        this.update({ speakers: msg.speakers ?? [] })
        return
      }
      case 'whiteboard_op': {
        this.applyWhiteboardOp(msg.op)
        break
      }
      case 'recording_state': {
        this.update({ recording: msg.recording ?? { active: false } })
        break
      }
      case 'ai_summary_state':
      case 'ai_summary_update': {
        this.update({ aiSummary: msg.aiSummary ?? { active: false } })
        break
      }
      case 'chat_message': {
        if (!msg.message) return
        this.update({ chat: [...this.snapshot.chat, msg.message] })
        return
      }
      case 'error': {
        const text = `${msg.code}: ${msg.reason}`
        this.update({ error: text })
        this.opts.onError?.(text)
        return
      }
      default:
        return
    }
  }

  // ---------- 指标采集（评测章节的数据来源） ----------

  private startStatsPolling() {
    if (this.statsTimer) return
    this.statsTimer = window.setInterval(() => void this.collectStats(), 2000)
    void this.collectStats()
  }

  private async collectStats() {
    let rtt = 0
    let nominatedFound = false
    let jitter = 0
    let lost = 0
    let outBytes = 0
    let inBytes = 0
    let inPackets = 0
    let candidateType = '-'

    const read = async (pc: RTCPeerConnection | null) => {
      if (!pc) return
      const reports = await pc.getStats()
      reports.forEach((r) => {
        const s = r as unknown as Record<string, number | string | boolean>
        if (r.type === 'candidate-pair' && typeof s.currentRoundTripTime === 'number') {
          // 评测口径（docs/evaluation.md）：RTT 取被提名（nominated）的候选对；
          // 直接对所有 succeeded 对取最大会虚高约 500 倍。无 nominated 对时回退到旧行为。
          if (s.nominated === true) {
            rtt = (s.currentRoundTripTime as number) * 1000
            nominatedFound = true
          } else if (!nominatedFound && s.state === 'succeeded') {
            rtt = Math.max(rtt, (s.currentRoundTripTime as number) * 1000)
          }
        }
        if (r.type === 'inbound-rtp') {
          if (typeof s.jitter === 'number') jitter = Math.max(jitter, (s.jitter as number) * 1000)
          if (typeof s.packetsLost === 'number') lost = Math.max(lost, s.packetsLost as number)
          if (typeof s.bytesReceived === 'number') inBytes += s.bytesReceived as number
          if (typeof s.packetsReceived === 'number') inPackets += s.packetsReceived as number
        }
        if (r.type === 'outbound-rtp' && typeof s.bytesSent === 'number') outBytes += s.bytesSent as number
        if (r.type === 'local-candidate' && typeof s.candidateType === 'string') candidateType = s.candidateType as string
      })
    }
    await read(this.pubPC)
    await read(this.subPC)

    // 丢包率 = 本窗口丢失 / (本窗口丢失 + 本窗口收到)
    const dLost = Math.max(0, lost - this.lastStatsPackets.lost)
    const dRecv = Math.max(0, inPackets - this.lastStatsPackets.received)
    const lossRate = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0
    this.lastStatsPackets = { lost, received: inPackets }

    // 用真实采样间隔算码率，避免定时器抖动导致数字跳动
    const now = performance.now()
    if (this.lastStatsBytes.at === 0) {
      this.lastStatsBytes = { out: outBytes, in: inBytes, at: now }
      return
    }
    const dtSec = Math.max(0.5, (now - this.lastStatsBytes.at) / 1000)
    const outKbps = ((outBytes - this.lastStatsBytes.out) * 8) / 1000 / dtSec
    const inKbps = ((inBytes - this.lastStatsBytes.in) * 8) / 1000 / dtSec
    this.lastStatsBytes = { out: outBytes, in: inBytes, at: now }

    this.update({
      stats: {
        rttMs: Math.round(rtt),
        jitterMs: Math.round(jitter),
        packetsLost: lost,
        lossRate: Math.round(lossRate * 10) / 10,
        outKbps: Math.max(0, Math.round(outKbps)),
        inKbps: Math.max(0, Math.round(inKbps)),
        candidateType,
      },
    })
  }
}
