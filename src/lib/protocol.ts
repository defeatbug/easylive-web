/**
 * 信令协议类型定义（TypeScript 侧镜像）。
 *
 * ⚠️ 唯一事实源在 easylive-api/protocol/protocol.go，本文件必须与之 1:1 对齐。
 *    改协议时两边一起改（M3 起建议用 JSON Schema + 代码生成替代手工同步）。
 */

export type MsgType =
  // 客户端 -> 服务端
  | 'join' // 带 resumeToken 即为"断线重连恢复"
  | 'leave'
  | 'publish'
  | 'answer'
  | 'candidate'
  | 'subscribe'
  | 'unsubscribe'
  | 'unpublish'
  | 'mute'
  | 'chat'
  | 'ping'
  // 服务端 -> 客户端
  | 'joined'
  | 'participant_state'
  | 'publish_answer'
  | 'subscribe_offer'
  | 'participant_joined'
  | 'participant_left'
  | 'track_published'
  | 'track_unpublished'
  | 'track_muted'
  | 'active_speakers'
  | 'hand_state'
  | 'chat_message'
  | 'pong'
  | 'error'

export type MediaTarget = 'pub' | 'sub'

export type TrackKind = 'audio' | 'video' | 'screen'

/**
 * 参与者连接状态。
 *   - active：正常参会
 *   - reconnecting：信令连接断开、处于恢复宽限期内（轨道与订阅仍然保留，其他人只看到状态变化）
 */
export type ParticipantState = 'active' | 'reconnecting'

export interface Candidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export interface PeerInfo {
  id: string
  name: string
  joinedAt: number
  /** 缺省等价于 active（兼容旧服务端） */
  state?: ParticipantState
}

export interface TrackInfo {
  id: string
  publisherId: string
  kind: TrackKind
  source: string
  muted: boolean
}

export interface RoomState {
  roomId: string
  participants: PeerInfo[]
  tracks: TrackInfo[]
  /** 已举手参与者 ID（举手是状态，所以进快照：新入会者也能看到） */
  hands?: string[]
}

/**
 * 活跃说话人。Level 是归一化音频电平（0—1），由服务端从 RFC 6464 头扩展解析并平滑。
 * 服务端只在**集合变化**时推送（与 LiveKit 的 ActiveSpeakersChanged 同语义）。
 */
export interface SpeakerInfo {
  participantId: string
  level: number
}

/**
 * 数据通道（SCTP 数据面）上的消息。
 *
 * 为什么和信令分开两套：信令是**控制面**（可靠、有序、断线要能恢复，队列不能被高频小消息占满），
 * 数据通道是**数据面**（低延迟，瞬时事件丢了无所谓）。
 */
export interface DataMessage {
  type: 'reaction' | 'raise_hand'
  emoji?: string
  raised?: boolean
  /** 服务端中继时填充，客户端无法伪造 */
  fromId?: string
}

/** 界面上飘一下的表情 */
export interface Reaction {
  id: string
  fromId: string
  fromName: string
  emoji: string
  at: number
}

export interface ChatMessage {
  fromId: string
  fromName: string
  text: string
  ts: number
}

/** 与 Go 的 protocol.Message 结构一一对应（扁平结构，按 type 取用字段）。 */
export interface Message {
  type: MsgType
  id?: string
  seq?: number
  ts?: number

  // 请求载荷
  roomId?: string
  displayName?: string
  /** 断线重连时带上；命中则恢复同一 participantId（服务端返回 resumed=true） */
  resumeToken?: string
  /**
   * 与 resumeToken 配合：两条 PeerConnection 已经不可用、必须重新发布时置 true。
   * 服务端会先清掉旧轨道（保留身份），避免新连接的 SSRC 让服务端重复建轨。
   */
  resetMedia?: boolean
  sdp?: string
  target?: MediaTarget
  candidate?: Candidate
  publisherId?: string
  trackId?: string
  muted?: boolean
  text?: string
  /**
   * publish 时声明本次协商新增媒体的来源：camera / screen / microphone。
   * 浏览器不允许自定义 MediaStream id（msid），所以无法只靠 SDP 区分摄像头与屏幕。
   */
  source?: string

  // 服务端载荷
  sessionId?: string
  participantId?: string
  /** joined.resumed：本次是否是断线恢复（true 时不重新发布本地轨道） */
  resumed?: boolean
  state?: ParticipantState
  participant?: PeerInfo
  room?: RoomState
  track?: TrackInfo
  message?: ChatMessage
  speakers?: SpeakerInfo[]
  raised?: boolean
  code?: string
  reason?: string
}

export const ErrorCode = {
  badRequest: 'bad_request',
  notJoined: 'not_joined',
  roomFull: 'room_full',
  serverBusy: 'server_at_capacity',
  internal: 'internal_error',
} as const

/** 客户端连接状态（UI 用；与 WebSocket 的 readyState 不是一回事）。 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/** 服务端轨道 ID 里带有来源信息，前端渲染时用它区分屏幕共享与摄像头。 */
export function trackSourceOf(track: TrackInfo): 'screen' | 'camera' | 'microphone' {
  if (track.kind === 'audio') return 'microphone'
  if (track.source === 'screen' || track.id.includes('/screen/')) return 'screen'
  return 'camera'
}
