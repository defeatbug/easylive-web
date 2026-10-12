import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, PeerInfo, SpeakerInfo } from '../lib/protocol'
import type { LinkStats } from '../lib/RoomClient'
import { evaluateQuality } from '../lib/quality'
import { useImeGuard } from '../lib/ime'

interface SidePanelProps {
  tab: 'chat' | 'people' | 'stats'
  onTabChange: (tab: 'chat' | 'people' | 'stats') => void
  onClose: () => void
  chat: ChatMessage[]
  selfId: string | null
  participants: PeerInfo[]
  /** 已举手参与者 ID（来自服务端信令广播） */
  hands: string[]
  /** 正在说话的人：成员列表据此把它们排到前面（视频区不重排，避免画面跳动） */
  speakers: SpeakerInfo[]
  /** 自己是否拥有主持人权限（来自令牌；服务端会独立校验） */
  isAdmin: boolean
  onModerate: (action: 'mute' | 'kick', targetId: string) => void
  stats: LinkStats | null
  onSend: (text: string) => void
}

/**
 * 右侧面板：聊天 / 成员 / 指标。
 * 样式对齐 LiveKit Meet 的 Messages 面板：平面深色、顶部标题 + 关闭按钮、底部输入框 + 发送。
 * （比 LiveKit 多两个 Tab：成员列表与指标面板——后者是评测章节的数据出口，属于我们自己的价值。）
 */
export function SidePanel({
  tab,
  onTabChange,
  onClose,
  chat,
  selfId,
  participants,
  hands,
  speakers,
  isAdmin,
  onModerate,
  stats,
  onSend,
}: SidePanelProps) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-white/5 bg-[var(--surface)]">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex gap-1">
          <TabButton active={tab === 'chat'} onClick={() => onTabChange('chat')}>
            聊天
          </TabButton>
          <TabButton active={tab === 'people'} onClick={() => onTabChange('people')}>
            成员 {participants.length}
          </TabButton>
          <TabButton active={tab === 'stats'} onClick={() => onTabChange('stats')}>
            指标
          </TabButton>
        </div>
        <button
          onClick={onClose}
          title="关闭面板"
          className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {tab === 'chat' && <ChatList chat={chat} selfId={selfId} onSend={onSend} />}
      {tab === 'people' && (
        <PeopleList
          participants={participants}
          selfId={selfId}
          hands={hands}
          speakers={speakers}
          isAdmin={isAdmin}
          onModerate={onModerate}
        />
      )}
      {tab === 'stats' && <StatsView stats={stats} />}
    </aside>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
        active ? 'bg-white/10 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  )
}

function ChatList({
  chat,
  selfId,
  onSend,
}: {
  chat: ChatMessage[]
  selfId: string | null
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const ime = useImeGuard()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.length])

  const submit = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-2">
        {chat.length === 0 && <p className="pt-8 text-center text-xs text-neutral-500">还没有消息</p>}
        {chat.map((m, i) => {
          const mine = m.fromId === selfId
          return (
            <div key={`${m.ts}-${i}`} className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
              <span className="px-1 text-[10px] text-neutral-500">
                {mine ? '我' : m.fromName} · {new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm leading-relaxed ${
                  mine ? 'bg-[var(--brand)] text-white' : 'bg-[var(--surface-2)] text-neutral-100'
                }`}
              >
                {m.text}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 border-t border-white/5 p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // 输入法正在组合 / 刚刚确认候选词的回车：不发送（否则会发一次、再发一次）
            if (ime.isImeEnter(e)) return
            e.preventDefault()
            submit()
          }}
          placeholder="输入消息…"
          maxLength={2000}
          className="min-w-0 flex-1 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm outline-none placeholder:text-neutral-500 focus:ring-1 focus:ring-[var(--brand)]"
        />
        <button
          onClick={submit}
          className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--brand)] transition hover:bg-white/10"
        >
          发送
        </button>
      </div>
    </>
  )
}

function PeopleList({
  participants,
  selfId,
  hands,
  speakers,
  isAdmin,
  onModerate,
}: {
  participants: PeerInfo[]
  selfId: string | null
  hands: string[]
  speakers: SpeakerInfo[]
  isAdmin: boolean
  onModerate: (action: 'mute' | 'kick', targetId: string) => void
}) {
  // 正在说话的人排前面：这是"排序"最合适的位置——
  // 视频区按音量重排会让画面不断跳动，成员列表重排则完全可预期。
  const order = new Map(speakers.map((s, i) => [s.participantId, i]))
  const sorted = [...participants].sort((a, b) => {
    const oa = order.has(a.id) ? (order.get(a.id) as number) : Number.POSITIVE_INFINITY
    const ob = order.has(b.id) ? (order.get(b.id) as number) : Number.POSITIVE_INFINITY
    return oa - ob
  })

  return (
    <div className="flex-1 space-y-1 overflow-y-auto p-3">
      {sorted.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-medium text-neutral-300">
            {p.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-neutral-200">
              {hands.includes(p.id) && <span className="mr-1">✋</span>}
              {p.name}
              {order.has(p.id) && <span className="ml-1 text-[10px] text-emerald-400">说话中</span>}
              {p.id === selfId && <span className="ml-1 text-xs text-[var(--brand)]">（我）</span>}
            </p>
            <p className="truncate text-[10px] text-neutral-500">{p.identity ?? p.id}</p>
          </div>

          {/* 主持人操作：只对别人显示。前端只是隐藏按钮，权限由服务端校验 */}
          {isAdmin && p.id !== selfId && (
            <span className="flex shrink-0 gap-1">
              <button
                onClick={() => onModerate('mute', p.id)}
                title="强制静音（服务端停止转发其音频）"
                className="rounded px-1.5 py-1 text-[10px] text-amber-300 transition hover:bg-amber-500/15"
              >
                静音
              </button>
              <button
                onClick={() => onModerate('kick', p.id)}
                title="移出房间"
                className="rounded px-1.5 py-1 text-[10px] text-red-300 transition hover:bg-red-500/15"
              >
                移出
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function StatsView({ stats }: { stats: LinkStats | null }) {
  const q = evaluateQuality(stats)

  if (!stats) {
    return <p className="flex-1 p-3 text-xs text-neutral-500">指标采集中（约 2 秒后出现）…</p>
  }

  const rows: Array<[string, string]> = [
    ['RTT', `${stats.rttMs} ms`],
    ['抖动', `${stats.jitterMs} ms`],
    ['丢包率', `${stats.lossRate} %`],
    ['累计丢包', `${stats.packetsLost}`],
    ['上行码率', `${stats.outKbps} kbps`],
    ['下行码率', `${stats.inKbps} kbps`],
    ['候选类型', stats.candidateType],
  ]

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      <div className="rounded-lg bg-[var(--surface-2)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-neutral-300">网络质量</span>
          <span className={`text-xs font-medium ${q.text}`}>
            {q.label} · {q.score}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className={`h-full rounded-full transition-all duration-500 ${q.bar}`} style={{ width: `${q.score}%` }} />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
          加权口径：RTT 0.4 + 丢包 0.4 + 抖动 0.2（启发式指标，不是 MOS）
        </p>
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-500">
        来自 <code className="text-neutral-400">RTCPeerConnection.getStats()</code>，每 2 秒刷新，
        是论文评测章节的端侧数据出口。
      </p>

      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between border-b border-white/5 pb-1.5">
          <span className="text-xs text-neutral-400">{k}</span>
          <span className="font-mono text-xs text-neutral-100">{v}</span>
        </div>
      ))}

      <p className="pt-1 text-[10px] leading-relaxed text-neutral-500">
        提示：候选类型为 <code className="text-neutral-400">relay</code> 说明走了 TURN 中继，
        延迟与带宽开销都会明显高于直连。
      </p>
    </div>
  )
}
