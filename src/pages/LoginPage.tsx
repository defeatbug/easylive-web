import { useRef, useState } from 'react'
import { IconCheck, IconEye, IconEyeOff, IconLock, IconShield, IconSparkle, IconSpinner, IconUser, IconVideo } from '../components/Icons'
import { useImeGuard } from '../lib/ime'
import type { AccountUser } from '../lib/auth'

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<AccountUser>
  invitedRoom?: string
  /** 仅开发预览路由会传：在表单上方显示一条说明，避免把预览误当成正式登录入口。 */
  previewNotice?: string
}

const REMEMBER_KEY = 'easylive.rememberUser'

export function LoginPage({ onLogin, invitedRoom, previewNotice }: LoginPageProps) {
  const [username, setUsername] = useState(() => {
    try { return sessionStorage.getItem(REMEMBER_KEY) ?? '' } catch { return '' }
  })
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(() => {
    try { return !!sessionStorage.getItem(REMEMBER_KEY) } catch { return false }
  })
  const [error, setError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<'username' | 'password' | null>(null)
  const usernameInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const ime = useImeGuard()

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
    setBusy(true)
    setError(null)
    setErrorField(null)
    try {
      // 持久化"记住用户名"偏好（sessionStorage：关闭标签页即清除，不走 localStorage）
      try {
        if (remember) sessionStorage.setItem(REMEMBER_KEY, username.trim())
        else sessionStorage.removeItem(REMEMBER_KEY)
      } catch { /* 隐私模式不可写，忽略 */ }
      await onLogin(username.trim(), password)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请稍后重试。')
      // 密码错误时清空密码框，方便用户重新输入
      if (reason instanceof Error && reason.message.includes('密码')) {
        setPassword('')
        passwordInput.current?.focus()
      }
    } finally {
      setBusy(false)
    }
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
            <div className="login-welcome-icon"><IconShield size={23} /></div>
            <div className="login-overline">WELCOME BACK</div>
            <h2 id="login-heading">欢迎回来</h2>
            <p className="login-intro">登录账号，进入你的会议空间。</p>
            {previewNotice && <div className="login-preview"><IconSparkle size={16} /> {previewNotice}</div>}
            {invitedRoom && <div className="login-invite"><IconCheck size={17} /> 登录后继续加入会议 <strong title={invitedRoom}>{invitedRoom}</strong></div>}

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
                    onChange={(event) => { setUsername(event.target.value); setError(null); setErrorField(null) }}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(event) => { if (event.key === 'Enter' && ime.isImeEnter(event)) event.preventDefault() }}
                    placeholder="请输入用户名"
                    required
                    maxLength={128}
                    disabled={busy}
                    aria-invalid={errorField === 'username'}
                    aria-describedby={error && errorField === 'username' ? 'login-error' : undefined}
                  />
                </div>
              </label>

              {/* 密码 */}
              <label className={`login-field ${errorField === 'password' ? 'is-error' : ''}`}>
                <span>密码</span>
                <div className="login-input-wrap">
                  <span className="login-input-icon" aria-hidden="true"><IconLock size={18} /></span>
                  <input
                    ref={passwordInput}
                    type={visible ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => { setPassword(event.target.value); setError(null); setErrorField(null) }}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(event) => { if (event.key === 'Enter' && ime.isImeEnter(event)) event.preventDefault() }}
                    placeholder="请输入密码"
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

              {/* 记住用户名 + 忘记密码提示 */}
              <div className="login-form-row">
                <label className="login-remember">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
                  <span>记住用户名</span>
                </label>
                <span className="login-forgot" title="如忘记密码，请联系管理员重置">忘记密码？</span>
              </div>

              {/* 错误信息 */}
              <p id="login-error" className="login-error" role="alert">{error}</p>

              {/* 提交按钮 */}
              <button type="submit" className="login-submit" disabled={busy}>
                {busy ? <><IconSpinner size={20} /> 正在登录…</> : <>登录并继续 <span aria-hidden="true">↗</span></>}
              </button>
            </form>
            <div className="login-note"><IconShield size={16} /><span>账号由管理员创建，密码不会保存在浏览器中。</span></div>
          </div>
          <footer className="login-panel-footer">© easylive · 让每一次连接，都恰到好处</footer>
        </section>
      </div>
    </main>
  )
}
