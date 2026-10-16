import { Suspense, lazy, useEffect, useState } from 'react'
import { JoinPage, type JoinRequest } from './pages/JoinPage'
import { MeetingRoom } from './pages/MeetingRoom'
// 报表页懒加载：它不是入会必需模块，单独切一个 chunk，主包更小
const MetricsPage = lazy(() => import('./pages/MetricsPage').then((m) => ({ default: m.MetricsPage })))

/**
 * 只有一个状态：当前是否在会议中。
 * 会议状态本身不由 React 管理（见 lib/RoomClient.ts 的说明）。
 *
 * 刷新页面会重新加载整个应用，所以这里把入会信息存进 sessionStorage，刷新后自动重新入会。
 * 用 sessionStorage 而不是 localStorage：关掉标签页就结束会话，下次打开应该回到会前页。
 */
const SESSION_KEY = 'easylive.session'

function loadSession(): JoinRequest | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<JoinRequest>
    if (!parsed.roomId || !parsed.displayName) return null
    return {
      roomId: parsed.roomId,
      displayName: parsed.displayName,
      micId: parsed.micId,
      camId: parsed.camId,
      micOn: parsed.micOn ?? true,
      camOn: parsed.camOn ?? true,
        // 刷新前是不是主持人也要恢复：以前这里漏了 asAdmin，于是刷新会把主持人悄悄
        // 降级成普通参会者（表现是录制/管理按钮消失，很难联想到是刷新导致的）。
        // 注意这只是**演示模式**下的体验修复：正式鉴权上线后权限必须来自新令牌，
        // 而不是本地存储——本地存储是用户可改的。
        asAdmin: parsed.asAdmin ?? false,
    }
  } catch {
    return null
  }
}

export default function App() {
  // 报表页走 hash 路由：项目刻意不引路由库，一个 hash 足够，也不需要改构建配置。
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [session, setSession] = useState<JoinRequest | null>(loadSession)

  if (hash === '#/metrics') {
    return (
      <Suspense fallback={<div className="p-6 text-sm text-neutral-400">正在加载指标报表…</div>}>
        <MetricsPage onBack={() => { window.location.hash = '' }} />
      </Suspense>
    )
  }

  const join = (req: JoinRequest) => {
    try {
      // MediaStream 不能序列化，显式剔除后只存房间/昵称/设备偏好
      const persistable = {
        roomId: req.roomId,
        displayName: req.displayName,
        micId: req.micId,
        camId: req.camId,
        micOn: req.micOn,
        camOn: req.camOn,
        asAdmin: req.asAdmin,
      }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(persistable))
    } catch {
      /* 隐私模式下 sessionStorage 可能不可用，忽略即可 */
    }
    setSession(req)
  }

  const leave = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      /* 同上 */
    }
    setSession(null)
  }

  if (!session) return <JoinPage onJoin={join} />

  return (
    <MeetingRoom
      roomId={session.roomId}
      displayName={session.displayName}
      initialDevices={{ micId: session.micId, camId: session.camId }}
      initialMicOn={session.micOn ?? true}
      initialCamOn={session.camOn ?? true}
      previewStream={session.previewStream}
      asAdmin={session.asAdmin}
      onLeave={leave}
    />
  )
}
