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
  | 'flash' // 弹幕/互动：{emoji, text?, kind?}（走信令，低频）
  | 'ping'
  | 'moderate' // 主持人操作：mute | kick（需要 roomAdmin）
  | 'record' // 录制开关：start | stop（需要 roomAdmin）
  | 'whiteboard' // 白板操作：{op:{kind,stroke}}（任何参会者都可画）
  // 服务端 -> 客户端
  | 'joined'
  | 'flash_message' // 服务端广播的弹幕/互动 {flash}
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
  | 'force_mute'
  | 'chat_message'
  | 'recording_state' // 服务端广播录制状态（全员可见的"录制中"红点）
  | 'whiteboard_op' // 服务端广播一条被接受的白板操作（带 by/seq）
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

/**
 * 令牌权限（与服务端 auth.VideoGrant 对齐，字段名参照 LiveKit）。
 * 前端只用它做 UI 取舍；真正的校验在服务端。
 */
export interface VideoGrant {
  roomJoin: boolean
  room?: string
  canPublish: boolean
  canSubscribe: boolean
  canPublishData: boolean
  roomAdmin: boolean
}

export interface PeerInfo {
  id: string
  name: string
  /** 令牌身份（跨重连稳定），无鉴权模式下等于昵称 */
  identity?: string
  joinedAt: number
  /** 缺省等价于 active（兼容旧服务端） */
  state?: ParticipantState
  /**
   * 已设置的头像地址（服务端按令牌身份查库填充，客户端无法自报）。
   * 为空表示没设头像，界面回落成昵称首字母。
   */
  avatarUrl?: string
}

export interface TrackInfo {
  id: string
  publisherId: string
  kind: TrackKind
  source: string
  muted: boolean
}

import type { RecordingState } from './recordings'

/**
 * 白板操作（与服务端 protocol.WhiteboardOp 1:1）。
 *
 * 坐标**归一化到 0..1**：参会者窗口大小不同，用设备像素会导致"我画的圆在别人那里变形"。
 * Width 是"画布宽度按 1000 计"时的像素值，渲染时按实际宽度缩放。
 */
export type WhiteboardKind = 'stroke' | 'clear' | 'undo'
export type WhiteboardTool = 'pen' | 'eraser' | 'line' | 'rect' | 'ellipse'

export interface WhiteboardStroke {
  tool: WhiteboardTool
  color: string
  width: number
  points: [number, number][]
}

export interface WhiteboardOp {
  kind: WhiteboardKind
  stroke?: WhiteboardStroke
  /** 服务端填写：谁画的 */
  by?: string
  /** 服务端填写：房间内递增序号 */
  seq?: number
}

export interface RoomState {
  /** 当前是否正在录制（入会快照携带，中途进来的人也能看到红点） */
  recording?: RecordingState
  roomId: string
  participants: PeerInfo[]
  tracks: TrackInfo[]
  /** 已举手参与者 ID（举手是状态，所以进快照：新入会者也能看到） */
  hands?: string[]
  /** 房间当前的白板内容（入会快照携带：中途进来的人也能看到已画的内容） */
  whiteboard?: WhiteboardOp[]
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
/** 弹幕 / 互动：走**信令面**（服务端广播给房间内所有人，含发送者自己）。 */
export interface FlashMessage {
  fromId: string
  fromName: string
  emoji: string
  text?: string
  /** 空 = 普通表情浮层；'action' = 互动动效（小红花等） */
  kind?: 'action'
  ts: number
}

export interface DataMessage {
  type: 'reaction' | 'raise_hand'
  emoji?: string
  raised?: boolean
  /** 表情附带的一句话；有它就把这条当**弹幕**显示（服务端限 60 字，超出截断） */
  text?: string
  /** 'action' = 互动动效（从底栏弹起的小红花之类）；缺省是角落里的表情浮层 */
  kind?: 'action'
  /** 服务端中继时填充，客户端无法伪造 */
  fromId?: string
  /** 同上：发送者名字由服务端填，避免冒充 */
  fromName?: string
}

/** 界面上飘一下的表情 / 弹幕 / 互动动效（三者共用一条数据通道消息） */
export interface Reaction {
  id: string
  fromId: string
  fromName: string
  emoji: string
  at: number
  /** 有文字就是弹幕（底栏上方滚一条），没有就是普通表情浮层 */
  text?: string
  /** 'action' 表示互动动效（从底栏往上弹一下） */
  kind?: 'action'
  /** 互动动效的横向位置（0—1）。**生成时就固定**，否则每帧重算会左右乱跳。 */
  x?: number
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
  /** 鉴权令牌（JWT）；AUTH_MODE=required 时必带 */
  token?: string
  /** 主持人操作的载荷 */
  targetId?: string
  action?: string
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
  recording?: RecordingState
  /** 白板操作载荷（whiteboard / whiteboard_op） */
  op?: WhiteboardOp
  /** 服务端实际生效的权限（joined 下发；无鉴权模式为全权限 devGrants） */
  grants?: VideoGrant
  track?: TrackInfo
  message?: ChatMessage
  /** 弹幕/互动的入参（客户端 → 服务端） */
  emoji?: string
  kind?: 'action'
  /** 服务端广播的弹幕/互动 */
  flash?: FlashMessage
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
