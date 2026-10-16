/**
 * 管理员接口：分页查看全部用户。
 *
 * 只有唯一的管理员账号能用；普通用户会拿到 403（前端据此隐藏入口，
 * 但真正的判定在服务端——前端隐藏只是体验）。
 */

export interface AdminUser {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'member'
  avatarUrl?: string
  hasAvatar: boolean
}

export interface AdminUserPage {
  users: AdminUser[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export async function fetchUsers(page: number, pageSize = 20): Promise<AdminUserPage> {
  const response = await fetch(`/admin/users?page=${page}&pageSize=${pageSize}`, {
    credentials: 'include', cache: 'no-store',
  })
  if (!response.ok) {
    let message = `查询失败（HTTP ${response.status}）`
    try {
      const data = (await response.json()) as { error?: unknown }
      if (typeof data?.error === 'string' && data.error) message = data.error
    } catch {
      // 非 JSON 响应
    }
    throw new Error(message)
  }
  return (await response.json()) as AdminUserPage
}
