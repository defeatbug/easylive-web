import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconEye, IconEyeOff, IconLock, IconShield, IconSparkle, IconSpinner, IconUser, IconVideo } from '../components/Icons'
import { useImeGuard } from '../lib/ime'
import { fetchAuthCapabilities, type AccountUser } from '../lib/auth'

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<AccountUser>
  /** 未传则完全不显示注册入口（例如某些嵌入场景只想给登录）。 */
  onRegister?: (input: { username: string; password: string; displayName: string }) => Promise<AccountUser>
  invitedRoom?: string
  /** 仅开发预览路由会传：在表单上方显示一条说明，避免把预览误当成正式登录入口。 */
  previewNotice?: string
}

const REMEMBER_KEY = 'easylive.rememberUser'
const MIN_PASSWORD = 8
const MAX_USERNAME = 32

type Mode = 'signin' | 'signup'

/**
 * 登录 / 注册页。
 *
 * 为什么注册做成**同一个页面的另一个模式**而不是独立页面：
 *  1. 两种操作的字段高度重合（用户名 + 密码），共用一套校验与输入框，
 *     分成两页只会让"我是不是点错了"变成一个新的失败来源；
 *  2. 邀请链接（?room=）在两种模式下都要显示"登录/注册后继续加入会议"，
 *     独立页面就得把这段逻辑复制一遍。
 *
 * 注册入口是否出现由**服务端**决定（GET /auth/capabilities）：
 * 部署没开放注册时，一个填完必然失败的表单比"没有这个入口"更糟。
 */
export function LoginPage({ onLogin, onRegister, invitedRoom, previewNotice }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>('signin')
  const [username, setUsername] = useState(() => {
    try { return sessionStorage.getItem(REMEMBER_KEY) ?? '' } catch { return '' }
  })
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(() => {
    try { return !!sessionStorage.getItem(REMEMBER_KEY) } catch { return false }
  })
  const [error, setError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<'username' | 'password' | 'confirm' | null>(null)
  // 乐观默认 true：本地开发（默认开放注册）不会出现"入口闪一下才出现"。
  // 服务端说没有，再收起来。
  const [signupEnabled, setSignupEnabled] = useState(true)
  const usernameInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const confirmInput = useRef<HTMLInputElement>(null)
  const ime = useImeGuard()

  const canSignup = !!onRegister && signupEnabled
  const isSignup = mode === 'signup'

  useEffect(() => {
    let cancelled = false
    void fetchAuthCapabilities().then((caps) => {
      if (cancelled) return
      setSignupEnabled(caps.signupEnabled)
      // 能力确认后才知道注册不可用；此时如果用户正停在注册模式，退回登录模式，
      // 否则会留下一个提交必然 403 的表单。
      if (!caps.signupEnabled) setMode((m) => (m === 'signup' ? 'signin' : m))
    })
    return () => { cancelled = true }
  }, [])

  const resetMessages = () => {
    setError(null)
    setErrorField(null)
  }

  const switchMode = (next: Mode) => {
    if (busy || next === mode) return
    setMode(next)
    resetMessages()
    setPassword('')
    setConfirm('')
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    if (!username.trim()) {
      setErrorField('username')
      setError('请输入用户名。')
      usernameInput.current?.focus()
      return
    }
    if (!password) {
      setErrorField('password')
      setError('请输入密码。')
      passwordInput.current?.focus()
      return
    }
    if (isSignup) {
      // 前端只拦"明显不合法"的输入，真正的判定仍在服务端（口径见 docs/auth-api.md）
      if (username.trim().length < 3) {
        setErrorField('username')
        setError('用户名至少 3 个字符。')
        usernameInput.current?.focus()
        return
      }
      if (password.length < MIN_PASSWORD) {
        setErrorField('password')
        setError(`密码至少 ${MIN_PASSWORD} 个字符。`)
        passwordInput.current?.focus()
        return
      }
      if (password !== confirm) {
        setErrorField('confirm')
        setError('两次输入的密码不一致。')
        confirmInput.current?.focus()
        return
      }
    }

    setBusy(true)
    resetMessages()
    try {
      if (isSignup && onRegister) {
        await onRegister({ username: username.trim(), password, displayName: displayName.trim() })
      } else {
        // 持久化"记住用户名"偏好（sessionStorage：关闭标签页即清除，不走 localStorage）
        try {
          if (remember) sessionStorage.setItem(REMEMBER_KEY, username.trim())
          else sessionStorage.removeItem(REMEMBER_KEY)
        } catch { /* 隐私模式不可写，忽略 */ }
        await onLogin(username.trim(), password)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (isSignup ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。'))
      // 口令相关失败时清空口令框，方便重新输入（用户名被占用则保留用户名不动）
      if (reason instanceof Error && reason.message.includes('密码')) {
        setPassword('')
        setConfirm('')
        passwordInput.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && ime.isImeEnter(event)) event.preventDefault()
  }

  return (
    <main className="login-shell">
      <div className="login-layout">
        <section className="login-story" aria-label="产品介绍">
          <div className="login-brand"><span className="login-brand-mark"><IconVideo size={23} /></span>easylive<span className="login-brand-dot">.</span></div>
          <div className="login-story-content">
            <span className="login-eyebrow"><span className="login-eyebrow-line" /> CONNECT BETTER, WORK TOGETHER</span>
            <h1>把距离留在屏幕外，<br /><span>让沟通发生在这里。</span></h1>
            <p>从一声问候到一次高效协作，轻松加入属于你的会议空间。</p>
            <div className="login-illustration" aria-hidden="true">
              <div className="login-illustration-glow" />
              <div className="login-video-card login-video-card-back"><span className="login-video-avatar">会</span><span className="login-video-caption">随时面对面</span></div>
              <div className="login-video-card login-video-card-front"><span className="login-video-avatar">你</span><span className="login-video-caption"><span className="login-live-dot" /> 沟通，正在发生</span></div>
              <div className="login-signal login-signal-one" /><div className="login-signal login-signal-two" />
            </div>
          </div>
          <p className="login-story-footer">实时连接 · 清晰画面 · 自在协作</p>
        </section>

        <section className="login-panel" aria-labelledby="login-heading">
          <div className="login-panel-inner">
            <div className="login-mobile-brand">easylive<span>.</span></div>
            <div className="login-welcome-icon">{isSignup ? <IconSparkle size={23} /> : <IconShield size={23} />}</div>
            <div className="login-overline">{isSignup ? 'CREATE ACCOUNT' : 'WELCOME BACK'}</div>
            <h2 id="login-heading">{isSignup ? '创建账号' : '欢迎回来'}</h2>
            <p className="login-intro">
              {isSignup ? '注册一个账号，开始你的第一次会议。' : '登录账号，进入你的会议空间。'}
            </p>

            {canSignup && (
              <div className="login-modes" role="group" aria-label="登录或注册">
                <button
                  type="button"
                  className={`login-mode ${isSignup ? '' : 'is-active'}`}
                  onClick={() => switchMode('signin')}
                  aria-pressed={!isSignup}
                  disabled={busy}
                >
                  登录
                </button>
                <button
                  type="button"
                  className={`login-mode ${isSignup ? 'is-active' : ''}`}
                  onClick={() => switchMode('signup')}
                  aria-pressed={isSignup}
                  disabled={busy}
                >
                  注册
                </button>
              </div>
            )}

            {previewNotice && <div className="login-preview"><IconSparkle size={16} /> {previewNotice}</div>}
            {invitedRoom && (
              <div className="login-invite">
                <IconCheck size={17} /> {isSignup ? '注册后继续加入会议' : '登录后继续加入会议'} <strong title={invitedRoom}>{invitedRoom}</strong>
              </div>
            )}

            <form onSubmit={(event) => void submit(event)} className="login-form" noValidate aria-busy={busy}>
              {/* 用户名 */}
              <label className={`login-field ${errorField === 'username' ? 'is-error' : ''}`}>
                <span>用户名</span>
                <div className="login-input-wrap">
                  <span className="login-input-icon" aria-hidden="true"><IconUser size={18} /></span>
                  <input
                    ref={usernameInput}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(event) => { setUsername(event.target.value); resetMessages() }}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={onInputKeyDown}
                    placeholder={isSignup ? '字母、数字与 . _ -（3–32 位）' : '请输入用户名'}
                    required
                    maxLength={isSignup ? MAX_USERNAME : 128}
                    disabled={busy}
                    aria-invalid={errorField === 'username'}
                    aria-describedby={error && errorField === 'username' ? 'login-error' : undefined}
                  />
                </div>
              </label>

              {/* 昵称：仅注册。选填，留空则沿用用户名 */}
              {isSignup && (
                <label className="login-field">
                  <span>昵称 <small>选填，会中显示的名字</small></span>
                  <div className="login-input-wrap">
                    <span className="login-input-icon" aria-hidden="true"><IconSparkle size={18} /></span>
                    <input
                      autoComplete="nickname"
                      value={displayName}
                      onChange={(event) => { setDisplayName(event.target.value); resetMessages() }}
                      onCompositionStart={ime.onCompositionStart}
                      onCompositionEnd={ime.onCompositionEnd}
                      onKeyDown={onInputKeyDown}
                      placeholder="不填就沿用用户名"
                      maxLength={MAX_USERNAME}
                      disabled={busy}
                    />
                  </div>
                </label>
              )}

              {/* 密码 */}
              <label className={`login-field ${errorField === 'password' ? 'is-error' : ''}`}>
                <span>密码{isSignup && <small>至少 {MIN_PASSWORD} 个字符</small>}</span>
                <div className="login-input-wrap">
                  <span className="login-input-icon" aria-hidden="true"><IconLock size={18} /></span>
                  <input
                    ref={passwordInput}
                    type={visible ? 'text' : 'password'}
                    autoComplete={isSignup ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(event) => { setPassword(event.target.value); resetMessages() }}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={onInputKeyDown}
                    placeholder={isSignup ? `至少 ${MIN_PASSWORD} 个字符` : '请输入密码'}
                    required
                    disabled={busy}
                    aria-invalid={errorField === 'password'}
                    aria-describedby={error && errorField === 'password' ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setVisible((value) => !value)}
                    aria-label={visible ? '隐藏密码' : '显示密码'}
                    aria-pressed={visible}
                    className="login-password-toggle"
                    disabled={busy}
                    tabIndex={0}
                  >
                    {visible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                  </button>
                </div>
              </label>

              {/* 确认密码：仅注册 */}
              {isSignup && (
                <label className={`login-field ${errorField === 'confirm' ? 'is-error' : ''}`}>
                  <span>确认密码</span>
                  <div className="login-input-wrap">
                    <span className="login-input-icon" aria-hidden="true"><IconLock size={18} /></span>
                    <input
                      ref={confirmInput}
                      type={confirmVisible ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(event) => { setConfirm(event.target.value); resetMessages() }}
                      onKeyDown={onInputKeyDown}
                      placeholder="再输入一次"
                      required
                      disabled={busy}
                      aria-invalid={errorField === 'confirm'}
                      aria-describedby={error && errorField === 'confirm' ? 'login-error' : undefined}
                    />
                    <button
                      type="button"
                      onClick={() => setConfirmVisible((value) => !value)}
                      aria-label={confirmVisible ? '隐藏密码' : '显示密码'}
                      aria-pressed={confirmVisible}
                      className="login-password-toggle"
                      disabled={busy}
                      tabIndex={0}
                    >
                      {confirmVisible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
                    </button>
                  </div>
                </label>
              )}

              {/* 登录模式才有：记住用户名 + 忘记密码提示 */}
              {!isSignup && (
                <div className="login-form-row">
                  <label className="login-remember">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
                    <span>记住用户名</span>
                  </label>
                  <span className="login-forgot" title="如忘记密码，请联系管理员重置">忘记密码？</span>
                </div>
              )}

              {/* 错误信息 */}
              <p id="login-error" className="login-error" role="alert">{error}</p>

              {/* 提交按钮 */}
              <button type="submit" className="login-submit" disabled={busy}>
                {busy
                  ? <><IconSpinner size={20} /> {isSignup ? '正在创建…' : '正在登录…'}</>
                  : <>{isSignup ? '创建账号并继续' : '登录并继续'} <span aria-hidden="true">↗</span></>}
              </button>
            </form>

            <div className="login-note"><IconShield size={16} />
              <span>
                {isSignup
                  ? '新账号是普通成员；主持人权限由管理员分配。密码不会保存在浏览器中。'
                  : '密码不会保存在浏览器中；没有账号可以直接注册。'}
              </span>
            </div>
          </div>
          <footer className="login-panel-footer">© easylive · 让每一次连接，都恰到好处</footer>
        </section>
      </div>
    </main>
  )
}
