import { useCallback, useEffect, useState } from 'react'
import { fetchUsers, type AdminUserPage } from '../lib/admin'
import { initialsOf } from '../lib/avatar'

/**
 * 管理员：分页查看全部用户。
 *
 * 说明：这里只**查看**。改别人的口令、删账号属于账号生命周期管理，
 * 需要单独设计（审计、二次确认、防止把自己锁在外面），不顺手塞进这个页面。
 *
 * 服务端才是权限判定方：普通用户打开这个页面会拿到 403，页面据实显示。
 */
export function AdminUsersPage({ onBack }: { onBack: () => void }) {
  const [page, setPage] = useState(1)
  const [pageSize] = useState(10)
  const [data, setData] = useState<AdminUserPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (target: number) => {
    setBusy(true)
    setError(null)
    try {
      setData(await fetchUsers(target, pageSize))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '查询失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }, [pageSize])

  useEffect(() => { void load(page) }, [load, page])

  const totalPages = data?.totalPages ?? 1

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">用户管理</h1>
          <p className="mt-0.5 text-[11px] text-[var(--text-mute)]">
            共 {data?.total ?? '—'} 个账号 · 第 {page} / {totalPages} 页
            {data ? ` · 每页 ${data.pageSize} 条` : ''}
          </p>
        </div>
        <button type="button" onClick={onBack} className="tm-btn px-3 py-1.5 text-xs">返回</button>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
      )}

      <div className="tm-card overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <tr>
              <th className="px-4 py-2 font-medium">用户</th>
              <th className="px-4 py-2 font-medium">用户名</th>
              <th className="px-4 py-2 font-medium">角色</th>
              <th className="px-4 py-2 font-medium">头像</th>
            </tr>
          </thead>
          <tbody>
            {(data?.users ?? []).map((u) => (
              <tr key={u.id} className="border-t border-[var(--line)]">
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-[var(--surface-3)] text-[11px] text-[var(--text-dim)]">
                      {u.avatarUrl
                        ? <img src={u.avatarUrl} alt="" className="h-full w-full object-cover" />
                        : initialsOf(u.displayName || u.username)}
                    </span>
                    <span className="text-[var(--text)]">{u.displayName || '—'}</span>
                  </span>
                </td>
                <td className="px-4 py-2 text-[var(--text-dim)]">{u.username}</td>
                <td className="px-4 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                    u.role === 'admin'
                      ? 'bg-[var(--brand-tint)] text-[var(--brand)]'
                      : 'bg-[var(--surface-3)] text-[var(--text-dim)]'
                  }`}>{u.role === 'admin' ? '管理员' : '成员'}</span>
                </td>
                <td className="px-4 py-2 text-[var(--text-mute)]">{u.hasAvatar ? '已设置' : '默认'}</td>
              </tr>
            ))}
            {!busy && data && data.users.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-[var(--text-mute)]">没有用户</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-center gap-2 text-xs">
        <button
          type="button" className="tm-btn px-3 py-1.5"
          disabled={busy || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
        >上一页</button>
        <span className="text-[var(--text-mute)]">{page} / {totalPages}</span>
        <button
          type="button" className="tm-btn px-3 py-1.5"
          disabled={busy || page >= totalPages} onClick={() => setPage((p) => p + 1)}
        >下一页</button>
      </div>
    </div>
  )
}
