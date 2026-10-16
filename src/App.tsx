import { Suspense, lazy, useEffect, useState } from 'react'
import { JoinPage, type JoinRequest } from './pages/JoinPage'
import { LoginPage } from './pages/LoginPage'
import { MeetingRoom } from './pages/MeetingRoom'
import { restoreAuth, signIn, signOut, type AccountUser, type AuthSession } from './lib/auth'

const MetricsPage = lazy(() => import('./pages/MetricsPage').then((m) => ({ default: m.MetricsPage })))
const SESSION_KEY = 'easylive.session'
/**
 * 开发用登录页预览路由。
 *
 * 为什么需要它：AUTH_MODE=off 时 restoreAuth() 判定为 guest，应用直接跳过登录页——
 * 于是"改完登录页却看不到"变成一件很别扭的事（要么改后端鉴权、要么改代码）。
 * 这条路由只在开发构建里存在（import.meta.env.DEV），生产打包时整段会被静态移除；
 * 它只影响"显示哪一页"，提交仍然走真实的 /auth/login，不伪造登录态。
 */
const DEV_LOGIN_HASH = '#/dev/login'
type SavedMeeting = JoinRequest & { accountId?: number }
type AuthState = AuthSession | { status: 'checking' } | { status: 'error'; message: string }

function loadSession(): SavedMeeting | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedMeeting>
    if (typeof parsed.roomId !== 'string' || !parsed.roomId || typeof parsed.displayName !== 'string' || !parsed.displayName) return null
    return {
      roomId: parsed.roomId, displayName: parsed.displayName,
      micId: parsed.micId, camId: parsed.camId,
      micOn: parsed.micOn ?? true, camOn: parsed.camOn ?? true,
      asAdmin: parsed.asAdmin ?? false,
      accountId: typeof parsed.accountId === 'number' ? parsed.accountId : undefined,
    }
  } catch {
    return null
  }
}

function clearMeeting(roomId?: string) {
  try {
    sessionStorage.removeItem(SESSION_KEY)
    if (roomId) sessionStorage.removeItem(`easylive.resume.${roomId}`)
  } catch {
    // 隐私模式下存储可能不可用，当前 React 状态仍会清除
  }
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash)
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' })
  const [session, setSession] = useState<SavedMeeting | null>(loadSession)
  const [authVersion, setAuthVersion] = useState(0)

  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    let cancelled = false
    void restoreAuth().then(
      (result) => { if (!cancelled) setAuth(result) },
      (reason: unknown) => {
        if (!cancelled) setAuth({ status: 'error', message: reason instanceof Error ? reason.message : '无法检查登录状态，请重试。' })
      },
    )
    return () => { cancelled = true }
  }, [authVersion])

  // 仅同一账号能从刷新前的会议记录恢复；旧版本无归属的记录也不能带入登录账号。
  const matchingSession = auth.status === 'signed-in'
    ? (session?.accountId === auth.user.id ? session : null)
    : auth.status === 'guest'
      ? (session?.accountId === undefined ? session : null)
      : null
  useEffect(() => {
    if ((auth.status === 'signed-in' || auth.status === 'guest' || auth.status === 'signed-out') && session && !matchingSession) {
      clearMeeting(session.roomId)
      setSession(null)
    }
  }, [auth, session, matchingSession])

  const login = async (username: string, password: string): Promise<AccountUser> => {
    const user = await signIn(username, password)
    if (session) clearMeeting(session.roomId)
    setSession(null)
    setAuth({ status: 'signed-in', user })
    return user
  }
  /** 账号资料变更（昵称/用户名/头像）后同步到全局登录态，顶栏与会前页随之刷新。 */
  const updateUser = (user: AccountUser) => {
    setAuth((current) => (current.status === 'signed-in' ? { status: 'signed-in', user } : current))
  }
  const logout = async () => {
    await signOut()
    clearMeeting(session?.roomId)
    setSession(null)
    setAuth({ status: 'signed-out' })
    if (window.location.hash === '#/metrics') window.location.hash = ''
  }
  const join = (req: JoinRequest) => {
    const saved: SavedMeeting = { ...req, accountId: auth.status === 'signed-in' ? auth.user.id : undefined,
      asAdmin: auth.status === 'guest' ? req.asAdmin : false }
    try {
      // 媒体流不能序列化；只保存当前账号的会议与设备偏好
      const { previewStream: _previewStream, ...persistable } = saved
      void _previewStream
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(persistable))
    } catch {
      // 隐私模式下仍可入会
    }
    setSession(saved)
  }
  const leave = () => {
    clearMeeting(session?.roomId)
    setSession(null)
  }

  const invitedRoom = new URLSearchParams(window.location.search).get('room') ?? undefined
  // 开发预览：强制显示登录页（仅开发构建）。提交仍走真实接口，成功后再回到正常流程。
  // 刻意放在 loading/error 分支之前：登录服务不可用时应用会进入 error 状态，
  // 而"想看登录页本身长什么样"恰恰是那条分支下最需要的能力。
  if (import.meta.env.DEV && hash === DEV_LOGIN_HASH) {
    return <LoginPage
      onLogin={async (username, password) => {
        const user = await login(username, password)
        window.location.hash = ''
        return user
      }}
      invitedRoom={invitedRoom}
      previewNotice="开发预览：这条路由只强制显示登录页，提交仍会真实调用 /auth/login。"
    />
  }
  if (auth.status === 'checking' || auth.status === 'error') {
    return <div className="login-loading"><div>
      <span className="login-brand-mark" aria-hidden="true">e.</span>
      <span role={auth.status === 'error' ? 'alert' : 'status'}>{auth.status === 'error' ? auth.message : '正在确认登录状态…'}</span>
      {auth.status === 'error' && <button type="button" onClick={() => { setAuth({ status: 'checking' }); setAuthVersion((v) => v + 1) }}>重新连接</button>}
    </div></div>
  }
  if (auth.status === 'signed-out') {
    return <LoginPage onLogin={login} invitedRoom={invitedRoom} />
  }
  if (hash === '#/metrics') {
    return <Suspense fallback={<div className="p-6 text-sm text-neutral-400">正在加载指标报表…</div>}>
      <MetricsPage onBack={() => { window.location.hash = '' }} />
    </Suspense>
  }
  if (!matchingSession) {
    return <JoinPage
      onJoin={join}
      user={auth.status === 'signed-in' ? auth.user : null}
      onLogout={logout}
      onUserChange={updateUser}
    />
  }
  return <MeetingRoom
    roomId={matchingSession.roomId}
    displayName={matchingSession.displayName}
    initialDevices={{ micId: matchingSession.micId, camId: matchingSession.camId }}
    initialMicOn={matchingSession.micOn}
    initialCamOn={matchingSession.camOn}
    previewStream={matchingSession.previewStream}
    asAdmin={auth.status === 'guest' ? matchingSession.asAdmin : false}
    onLeave={leave}
    user={auth.status === 'signed-in' ? auth.user : null}
    onLogout={logout}
  />
}
