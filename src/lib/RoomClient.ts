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
import type {
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

    // 入会并等待 joined（joined 里带回房间快照）
    const joined = await this.request(
      { type: 'join', roomId: this.opts.roomId, displayName: this.opts.displayName, token: this.token ?? undefined },
      ['joined'],
      10000,
    )
    if (joined.resumeToken) this.resumeToken = joined.resumeToken
    this.update({ grants: decodeGrant(this.token), notice: null })
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
    if (joined.resumeToken) this.resumeToken = joined.resumeToken

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

    // 服务端会在同一条 SCTP 关联上反向开一条用于推送（不需要重新协商）
    pub.ondatachannel = (e) => {
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
      const trackId = this.pendingTrackIds.shift()
      if (!trackId) {
        console.warn('[RoomClient] 收到未登记的远端轨道，忽略', e.track.kind, e.streams[0]?.id)
        return
      }
      const stream = e.streams[0] ?? new MediaStream([e.track])
      // 同一个发布者的麦克风+摄像头可能来自同一个 MediaStream，这里按 trackId 分别持有即可
      this.update({ remoteStreams: { ...this.snapshot.remoteStreams, [trackId]: stream } })
    }
    this.subPC = sub
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
    this.update({
      localStream: stream,
      micEnabled: stream.getAudioTracks().length > 0,
      camEnabled: stream.getVideoTracks().length > 0,
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
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } finally {
      this.screenStarting = false
    }
    this.screenStream = stream
    const track = stream.getVideoTracks()[0]
    // 用户点击浏览器"停止共享"时也要通知服务端重协商
    track.onended = () => void this.stopScreenShare()
    this.pubPC.addTrack(track, stream)
    this.update({ screenStream: stream })
    await this.renegotiatePublish('screen')
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

    // 先登记，随后 ontrack 会按 FIFO 取走它
    this.pendingTrackIds.push(trackId)
    const offer = await this.request({ type: 'subscribe', trackId }, ['subscribe_offer'], 15000)
    if (!offer.sdp) {
      this.pendingTrackIds.pop()
      throw new Error('subscribe_offer 缺少 sdp')
    }
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
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled))
    this.update({ camEnabled: enabled })
    const track = this.snapshot.tracks.find((t) => t.publisherId === this.snapshot.self?.id && t.source !== 'screen')
    if (track) this.send({ type: 'mute', trackId: track.id, muted: !enabled })
  }

  sendChat(text: string) {
    this.send({ type: 'chat', text })
  }

  // ---------- 数据面（SCTP 数据通道）----------

  /**
   * 在数据通道上发送。数据面语义是"尽力而为"：
   * 通道没就绪就静默丢弃，绝不能因为一个表情让界面报错。
   */
  private sendData(msg: DataMessage) {
    const dc = this.pubDC
    if (!dc || dc.readyState !== 'open') return
    try {
      dc.send(JSON.stringify(msg))
    } catch (e) {
      console.warn('[RoomClient] 数据通道发送失败', e)
    }
  }

  /** 发一个表情。本地立即回显（服务端只中继给其他人），避免自己看不到自己的表情。 */
  sendReaction(emoji: string) {
    this.sendData({ type: 'reaction', emoji })
    this.pushReaction(this.snapshot.self?.id ?? 'me', emoji)
  }

  /**
   * 举手/取消举手。**上报走数据面，状态回传走信令**：
   * 举手是状态，必须可靠、断线恢复后仍在、新人入会能看到，所以由服务端落库并广播。
   */
  toggleHand() {
    const selfId = this.snapshot.self?.id
    if (!selfId) return
    const raised = !this.snapshot.hands.includes(selfId)
    this.sendData({ type: 'raise_hand', raised })
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
  async moderate(action: 'mute' | 'kick', targetId: string): Promise<void> {
    await this.request({ type: 'moderate', action, targetId }, ['moderate'], 5000)
    if (action === 'kick') {
      this.update({ notice: '已将该参与者移出房间' })
    } else {
      this.update({ notice: '已强制静音该参与者' })
    }
  }

  private pushReaction(fromId: string, emoji: string) {
    const item: Reaction = {
      id: crypto.randomUUID(),
      fromId,
      fromName: this.snapshot.participants.find((p) => p.id === fromId)?.name ?? '我',
      emoji,
      at: Date.now(),
    }
    this.update({ reactions: [...this.snapshot.reactions, item].slice(-12) })
    // 3.2 秒后自动移除，UI 不需要额外的重绘定时器
    window.setTimeout(() => {
      this.update({ reactions: this.snapshot.reactions.filter((r) => r.id !== item.id) })
    }, 3200)
  }

  private onDataMessage(raw: string) {
    let msg: DataMessage
    try {
      msg = JSON.parse(raw) as DataMessage
    } catch {
      return
    }
    if (msg.type === 'reaction' && msg.emoji && msg.fromId) {
      this.pushReaction(msg.fromId, msg.emoji)
    }
  }

  // ---------- 收尾 ----------

  leave() {
    this.closed = true
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
        const s = r as unknown as Record<string, number | string>
        if (r.type === 'candidate-pair' && s.state === 'succeeded' && typeof s.currentRoundTripTime === 'number') {
          rtt = Math.max(rtt, (s.currentRoundTripTime as number) * 1000)
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
