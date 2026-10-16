/**
 * 令牌获取与解析。
 *
 * 三个刻意的设计：
 *  1. **区分「未启用鉴权」与「真的失败了」**：服务端 AUTH_MODE=off 时 /token 返回 501，
 *     这是正常的"不需要令牌"，应当继续以无令牌方式入会；但 401/403/5xx/网络错误是**真失败**，
 *     以前一律返回 null，前端就把它当成"无需令牌"继续入会——用户看到一个没权限、
 *     也没有任何提示的会议。现在后者会带着可读原因上抛。
 */
import type { VideoGrant } from './protocol'

export interface TokenRequest {
  roomId: string
  identity: string
  name?: string
  /** 申请主持人权限（仅演示用；生产环境的 /token 应换成你自己的登录鉴权） */
  roomAdmin?: boolean
}

/**
 * 向服务端申请令牌的结果：
 *   - ok   ：拿到令牌
 *   - off  ：服务端未启用鉴权（501）——这是**正常状态**，继续无令牌入会
 *   - error：真失败（401/403/5xx/网络/空令牌）——必须让用户看到原因
 */
export type TokenResult =
  | { status: 'ok'; token: string }
  | { status: 'off' }
  | { status: 'error'; message: string }

export async function fetchToken(req: TokenRequest): Promise<TokenResult> {
  try {
    const resp = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: req.roomId, identity: req.identity, name: req.name, roomAdmin: req.roomAdmin }),
    })
    // 501 是服务端明确的"鉴权未启用"，不是错误
    if (resp.status === 501) return { status: 'off' }
    if (!resp.ok) {
      // 把服务端的说明读出来（例如"X-API-Key 无效"），这比"入会失败"有用得多
      const body = await resp.text().catch(() => '')
      const detail = body ? `：${body.slice(0, 200)}` : ''
      return { status: 'error', message: `获取访问令牌失败（HTTP ${resp.status}）${detail}` }
    }
    const data = (await resp.json()) as { token?: unknown }
    if (typeof data.token !== 'string' || data.token === '') {
      return { status: 'error', message: '令牌服务返回了空令牌' }
    }
    return { status: 'ok', token: data.token }
  } catch (e) {
    return { status: 'error', message: `无法连接令牌服务：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 从 JWT 载荷里取出 video grant（仅用于 UI）。
 * 注意用 TextDecoder 而不是 atob 直读：令牌里的 name 可能是中文，UTF-8 需要正确解码。
 */
export function decodeGrant(token: string | null): VideoGrant | null {
  if (!token) return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { video?: VideoGrant }
    return claims.video ?? null
  } catch {
    return null
  }
}
