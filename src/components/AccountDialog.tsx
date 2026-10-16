import { useEffect, useRef, useState } from 'react'
import {
  IconCamera,
  IconCheck,
  IconClose,
  IconKey,
  IconLeave,
  IconShield,
  IconSpinner,
  IconTrash,
  IconUser,
} from './Icons'
import { changePassword, removeAvatar, updateProfile, uploadAvatar, type AccountUser } from '../lib/auth'
import { initialsOf, resizeAvatarFile } from '../lib/avatar'
import { useImeGuard } from '../lib/ime'

interface AccountDialogProps {
  /** 已登录账号；null 表示当前是访客（AUTH_MODE=off 的免登录演示） */
  user: AccountUser | null
  /** 访客模式下展示的昵称（会前页填的那个） */
  guestName: string
  onClose: () => void
  /** 资料变更成功后把最新用户交回上层（顶栏、会前页首字母都跟着变） */
  onUserChange: (user: AccountUser) => void
  onLogout: () => Promise<void>
}

type Busy = null | 'avatar' | 'profile' | 'password' | 'logout'

/**
 * 账号中心：居中的模态弹窗。
 *
 * 为什么用居中 Dialog 而不是侧边抽屉：这里要展示的是"当前用户是谁 + 能改什么"，
 * 内容量小、与背景没有并列关系，居中弹窗的注意力更集中，也不会在窄屏上被裁掉。
 *
 * 三处刻意的设计：
 *  1. **改资料/改密码都要当前密码**——这是后端的要求，界面必须把它讲清楚，
 *     否则用户会以为"填了新昵称为什么保存不了"；
 *  2. **访客不是错误状态**：AUTH_MODE=off 时没有账号，弹窗照常打开但只解释边界，
 *     不显示一个点了必然失败的"退出登录"；
 *  3. **头像在客户端先缩放**（lib/avatar.ts）：手机直出的照片必然超过后端 512KB 上限。
 */
export function AccountDialog({ user, guestName, onClose, onUserChange, onLogout }: AccountDialogProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ime = useImeGuard()

  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 资料表单
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [username, setUsername] = useState(user?.username ?? '')
  const [profilePassword, setProfilePassword] = useState('')

  // 密码表单
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const display = user ? (user.displayName || user.username) : guestName || '访客'

  // 账号资料变化时同步表单（例如改完用户名后，输入框要显示新值而不是旧值）
  useEffect(() => {
    if (!user) return
    setDisplayName(user.displayName)
    setUsername(user.username)
  }, [user])

  // 焦点管理：打开时聚焦、Tab 不逃出弹窗、关闭后把焦点还给触发元素。
  // onClose 放进 ref：否则父组件每次重渲染都会让这个 effect 重跑并抢走焦点。
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null

    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null)

    focusables()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          items[items.length - 1]!.focus()
        }
      } else if (index === -1 || index === items.length - 1) {
        event.preventDefault()
        items[0]!.focus()
      }
    }

    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [])

  const reset = () => {
    setError(null)
    setNotice(null)
  }

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    if (busy) return
    reset()
    setBusy(kind)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(null)
    }
  }

  const pickAvatar = () => {
    reset()
    fileRef.current?.click()
  }

  const onAvatarChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 立刻清空：否则连续选同一张图不会触发 change
    event.target.value = ''
    if (!file || !user) return
    await run('avatar', async () => {
      const resized = await resizeAvatarFile(file)
      const updated = await uploadAvatar(resized)
      onUserChange(updated)
      setNotice('头像已更新。')
    })
  }

  const onRemoveAvatar = () =>
    run('avatar', async () => {
      await removeAvatar()
      onUserChange({ ...(user as AccountUser), avatarUrl: undefined })
      setNotice('已恢复默认头像。')
    })

  const onSaveProfile = (event: React.FormEvent) => {
    event.preventDefault()
    if (!user) return
    const nextName = displayName.trim()
    const nextUser = username.trim()
    if (nextName === user.displayName && nextUser === user.username) {
      reset()
      setNotice('资料没有改动。')
      return
    }
    if (!profilePassword) {
      reset()
      setError('修改资料需要先输入当前密码。')
      return
    }
    void run('profile', async () => {
      const updated = await updateProfile({
        displayName: nextName,
        username: nextUser,
        currentPassword: profilePassword,
      })
      onUserChange(updated)
      setProfilePassword('')
      setNotice('资料已保存。')
    })
  }

  const onChangePassword = (event: React.FormEvent) => {
    event.preventDefault()
    if (!user) return
    if (newPassword.length < 8) {
      reset()
      setError('新密码至少 8 个字符。')
      return
    }
    if (newPassword !== confirmPassword) {
      reset()
      setError('两次输入的新密码不一致。')
      return
    }
    void run('password', async () => {
      await changePassword({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setNotice('密码已修改。其它设备上的登录不会自动失效，如需强制下线请让管理员处理。')
    })
  }

  const onLogoutClick = () =>
    run('logout', async () => {
      await onLogout()
    })

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && ime.isImeEnter(event)) event.preventDefault()
  }

  return (
    <div className="account-backdrop" onClick={onClose}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
        className="account-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-head">
          <div className="account-identity">
            <span className="account-avatar" aria-hidden="true">
              {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initialsOf(display)}
            </span>
            <div className="account-names">
              <h2 id="account-dialog-title">{display}</h2>
              <p>
                {user ? (
                  <>
                    <span className="account-handle">@{user.username}</span>
                    <span className={`account-role ${user.role === 'admin' ? 'is-host' : ''}`}>
                      <IconShield size={13} />
                      {user.role === 'admin' ? '管理员' : '成员'}
                    </span>
                    {/* 只有管理员看得到这个入口；真正的权限判定在服务端（普通用户会拿到 403） */}
                    {user.role === 'admin' && (
                      <a className="account-handle" href="#/admin/users" onClick={onClose} title="查看全部用户">
                        用户管理 ↗
                      </a>
                    )}
                  </>
                ) : (
                  <span className="account-handle">访客 · 未登录</span>
                )}
              </p>
            </div>
          </div>
          <button type="button" className="account-close" onClick={onClose} aria-label="关闭账号信息">
            <IconClose size={18} />
          </button>
        </header>

        <div className="account-body">
          {error && <p className="account-msg is-error" role="alert">{error}</p>}
          {notice && <p className="account-msg is-ok" role="status">{notice}</p>}

          {!user ? (
            <section className="account-section">
              <h3><IconUser size={16} /> 访客模式</h3>
              <p className="account-hint">
                当前服务未启用登录，你以访客身份入会：昵称只对本场会议生效，也不会被保存。
                头像、用户名与密码属于账号资料，需要管理员创建账号并启用登录后才能修改。
              </p>
            </section>
          ) : (
            <>
              <section className="account-section">
                <h3><IconCamera size={16} /> 头像</h3>
                <div className="account-avatar-row">
                  <span className="account-avatar is-preview" aria-hidden="true">
                    {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initialsOf(display)}
                  </span>
                  <div className="account-avatar-actions">
                    <button type="button" className="account-btn" onClick={pickAvatar} disabled={busy !== null}>
                      {busy === 'avatar' ? <IconSpinner size={15} /> : <IconCamera size={15} />}
                      {user.avatarUrl ? '更换头像' : '上传头像'}
                    </button>
                    {user.avatarUrl && (
                      <button
                        type="button"
                        className="account-btn is-quiet"
                        onClick={() => void onRemoveAvatar()}
                        disabled={busy !== null}
                      >
                        <IconTrash size={15} /> 移除
                      </button>
                    )}
                  </div>
                </div>
                <p className="account-hint">支持 PNG / JPEG / WebP，会自动压缩到 256px 以内再上传。</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="account-file"
                  onChange={(event) => void onAvatarChosen(event)}
                />
              </section>

              <form className="account-section" onSubmit={onSaveProfile} noValidate>
                <h3><IconUser size={16} /> 账号资料</h3>
                <label className="account-field">
                  <span>昵称</span>
                  <input
                    value={displayName}
                    onChange={(event) => { setDisplayName(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    maxLength={32}
                    placeholder="会中显示的名字"
                    disabled={busy !== null}
                  />
                </label>
                <label className="account-field">
                  <span>用户名 <small>登录用，字母/数字与 . _ -</small></span>
                  <input
                    value={username}
                    onChange={(event) => { setUsername(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    maxLength={32}
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={busy !== null}
                  />
                </label>
                <label className="account-field">
                  <span>当前密码 <small>确认是你本人操作</small></span>
                  <input
                    type="password"
                    value={profilePassword}
                    onChange={(event) => { setProfilePassword(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    autoComplete="current-password"
                    placeholder="修改资料必须输入"
                    disabled={busy !== null}
                  />
                </label>
                <button type="submit" className="account-submit" disabled={busy !== null}>
                  {busy === 'profile' ? <IconSpinner size={16} /> : <IconCheck size={16} />} 保存资料
                </button>
              </form>

              <form className="account-section" onSubmit={onChangePassword} noValidate>
                <h3><IconKey size={16} /> 修改密码</h3>
                <label className="account-field">
                  <span>当前密码</span>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(event) => { setCurrentPassword(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    autoComplete="current-password"
                    disabled={busy !== null}
                  />
                </label>
                <label className="account-field">
                  <span>新密码 <small>至少 8 个字符</small></span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => { setNewPassword(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    autoComplete="new-password"
                    disabled={busy !== null}
                  />
                </label>
                <label className="account-field">
                  <span>确认新密码</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => { setConfirmPassword(event.target.value); reset() }}
                    onKeyDown={onInputKeyDown}
                    autoComplete="new-password"
                    disabled={busy !== null}
                  />
                </label>
                <button type="submit" className="account-submit" disabled={busy !== null}>
                  {busy === 'password' ? <IconSpinner size={16} /> : <IconKey size={16} />} 修改密码
                </button>
              </form>

              <section className="account-section is-footer">
                <button
                  type="button"
                  className="account-btn is-danger"
                  onClick={() => void onLogoutClick()}
                  disabled={busy !== null}
                >
                  {busy === 'logout' ? <IconSpinner size={15} /> : <IconLeave size={15} />}
                  {busy === 'logout' ? '正在退出…' : '退出登录'}
                </button>
                <p className="account-hint">退出后需要重新输入用户名与密码。</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
