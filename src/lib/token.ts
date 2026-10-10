/**
 * 令牌获取与解析。
 *
 * 两个刻意的设计：
 *  1. **获取令牌失败不算错**：服务端 AUTH_MODE=off 时 /token 返回 501，
 *     此时应当继续以无令牌方式入会（本地演示开箱可用）。所以这里返回 null 而不是抛错。
 *  2. **前端解析令牌只为 UI**（按权限隐藏/禁用按钮）。真正的安全边界在服务端——
 *     前端解析出来的权限被改掉也没用，所有信令都会在服务端重新校验。
 */
import type { VideoGrant } from './protocol'

export interface TokenRequest {
  roomId: string
  identity: string
  name?: string
  /** 申请主持人权限（仅演示用；生产环境的 /token 应换成你自己的登录鉴权） */
  roomAdmin?: boolean
}

/** 向服务端申请令牌；未启用鉴权或失败时返回 null（表示"不需要/拿不到"）。 */
export async function fetchToken(req: TokenRequest): Promise<string | null> {
  try {
    const resp = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: req.roomId, identity: req.identity, name: req.name, roomAdmin: req.roomAdmin }),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { token?: unknown }
    return typeof data.token === 'string' && data.token !== '' ? data.token : null
  } catch {
    return null
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
