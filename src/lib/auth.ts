export interface AccountUser {
  id: number
  username: string
  displayName: string
  role: 'host' | 'member'
  /**
   * 头像地址（形如 /auth/avatar/1?v=1730000000）。
   * 未设置头像时后端不下发该字段，界面回落到首字母头像。
   * 带 v 参数是刻意的：换头像后 URL 会变，浏览器缓存自然失效，不需要额外清缓存。
   */
  avatarUrl?: string
}

export type AuthSession =
  | { status: 'guest' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AccountUser }

function parseUser(value: unknown): AccountUser {
  if (!value || typeof value !== 'object') throw new Error('登录服务返回了无效的用户资料，请稍后重试。')
  const user = value as Record<string, unknown>
  if (typeof user.id !== 'number' || typeof user.username !== 'string' ||
      typeof user.displayName !== 'string' || (user.role !== 'host' && user.role !== 'member')) {
    throw new Error('登录服务返回了无效的用户资料，请稍后重试。')
  }
  const out: AccountUser = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  }
  // avatarUrl 是可选字段：只接受非空字符串，其它一律当作"没有头像"
  if (typeof user.avatarUrl === 'string' && user.avatarUrl) out.avatarUrl = user.avatarUrl
  return out
}

/** 后端错误一律是 {"error": "..."}；优先把它原样呈现给用户，比前端猜状态码准确。 */
async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = (await response.json()) as { error?: unknown } | null
    if (data && typeof data.error === 'string' && data.error) return new Error(data.error)
  } catch {
    // 响应不是 JSON（例如反代返回的 HTML 错误页），落到下面的兜底文案
  }
  return new Error(`${fallback}（HTTP ${response.status}）`)
}

async function readUser(response: Response): Promise<AccountUser> {
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('登录服务返回异常，请稍后重试。')
  }
  return parseUser((data as { user?: unknown } | null)?.user)
}

/** Cookie 由浏览器管理；此处只读取用户视图，不保存密码或 Cookie。 */
export async function restoreAuth(): Promise<AuthSession> {
  let response: Response
  try {
    response = await fetch('/auth/me', { credentials: 'include', cache: 'no-store' })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.ok) {
    return { status: 'signed-in', user: await readUser(response) }
  }
  if (response.status !== 401) throw new Error(`登录服务暂不可用（HTTP ${response.status}），请稍后重试。`)

  // /auth/me 在 AUTH_MODE=off 时也返回 401；仅在未登录时探测 /auth/login 的
  // 501（免登录演示）或 400（登录已启用）。空请求在后端不会触发密码校验/限流。
  let mode: Response
  try {
    mode = await fetch('/auth/login', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (mode.status === 501) return { status: 'guest' }
  if (mode.status === 400 || mode.status === 401) return { status: 'signed-out' }
  throw new Error(`登录服务暂不可用（HTTP ${mode.status}），请稍后重试。`)
}

export async function signIn(username: string, password: string): Promise<AccountUser> {
  let response: Response
  try {
    response = await fetch('/auth/login', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.ok) {
    return readUser(response)
  }
  const errors: Record<number, string> = {
    400: '请填写用户名和密码。',
    401: '用户名或密码错误，请重新输入。',
    403: '账号已停用，请联系管理员。',
    429: '尝试过于频繁，请稍后再试。',
    501: '当前服务未启用登录，请刷新页面直接入会。',
    503: '登录服务暂不可用，请联系管理员。',
  }
  throw new Error(errors[response.status] ?? `登录失败（HTTP ${response.status}），请稍后重试。`)
}

export async function signOut(): Promise<void> {
  let response: Response
  try {
    response = await fetch('/auth/logout', { method: 'POST', credentials: 'include', cache: 'no-store' })
  } catch {
    throw new Error('无法连接登录服务，退出登录失败，请重试。')
  }
  if (response.status !== 204) throw new Error(`退出登录失败（HTTP ${response.status}），请重试。`)
}

/** 这个部署"能做什么"：是否启用登录、是否开放注册。 */
export interface AuthCapabilities {
  authEnabled: boolean
  signupEnabled: boolean
}

/**
 * 查询部署能力，用于决定要不要显示注册入口。
 *
 * 刻意不抛错：这是"锦上添花"的一次查询，失败时应当退回到"不显示注册入口"
 * （注册表单本来也提交不了），而不是把整个登录页变成错误页。
 */
export async function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  try {
    const response = await fetch('/auth/capabilities', { credentials: 'include', cache: 'no-store' })
    if (response.ok) {
      const data = (await response.json()) as Partial<AuthCapabilities>
      return { authEnabled: data.authEnabled === true, signupEnabled: data.signupEnabled === true }
    }
  } catch {
    // 网络不通：按最保守的答案处理
  }
  return { authEnabled: false, signupEnabled: false }
}

/**
 * 自助注册。成功后后端会直接下发会话（注册即登录），所以调用方拿到用户即已登录。
 *
 * 与登录一样，错误文案优先用后端返回的那一句：是否开放注册、用户名是否被占用、
 * 口令强度要求都由服务端判定，前端不重复维护一套口径。
 */
export async function signUp(input: {
  username: string
  password: string
  displayName?: string
}): Promise<AccountUser> {
  let response: Response
  try {
    response = await fetch('/auth/register', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: input.username.trim(),
        password: input.password,
        displayName: input.displayName?.trim() ?? '',
      }),
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.ok) return readUser(response)
  throw await readError(response, '注册失败')
}

// ------------------------------------------------------------------
// 账号资料：昵称 / 用户名 / 密码 / 头像
//
// 三条共同约定（与后端 auth_profile.go 一一对应）：
//   1. 改昵称、用户名、密码都必须带**当前密码** —— 会话 Cookie 被偷走也不该能改掉账号；
//   2. 服务端才是校验方：长度、字符白名单、用户名占用、头像类型与大小都在后端判定，
//      这里只做"明显不合法就别浪费一次请求"的前置提示；
//   3. 错误文案优先用后端返回的那一句，前端不重复维护一套状态码映射。
// ------------------------------------------------------------------

/** 修改昵称 / 用户名（需要当前密码）。 */
export async function updateProfile(input: {
  displayName?: string
  username?: string
  currentPassword: string
}): Promise<AccountUser> {
  let response: Response
  try {
    response = await fetch('/auth/profile', {
      method: 'PATCH', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.ok) return readUser(response)
  throw await readError(response, '保存资料失败')
}

/** 修改密码（需要当前密码）。成功时后端返回 204。 */
export async function changePassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<void> {
  let response: Response
  try {
    response = await fetch('/auth/password', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.status === 204) return
  throw await readError(response, '修改密码失败')
}

/** 上传头像（multipart，字段名 file）。 */
export async function uploadAvatar(file: File): Promise<AccountUser> {
  const form = new FormData()
  form.append('file', file)
  let response: Response
  try {
    // 不要手动设 Content-Type：必须让浏览器带上 multipart 的 boundary
    response = await fetch('/auth/avatar', {
      method: 'POST', credentials: 'include', cache: 'no-store', body: form,
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.ok) return readUser(response)
  throw await readError(response, '上传头像失败')
}

/** 移除头像，回落到首字母头像。 */
export async function removeAvatar(): Promise<void> {
  let response: Response
  try {
    response = await fetch('/auth/avatar', {
      method: 'DELETE', credentials: 'include', cache: 'no-store',
    })
  } catch {
    throw new Error('无法连接登录服务，请检查网络后重试。')
  }
  if (response.status === 204) return
  throw await readError(response, '移除头像失败')
}
