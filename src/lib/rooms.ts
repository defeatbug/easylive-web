/**
 * 会议：创建与查询。
 *
 * 权限模型（与后端 server/rooms.go 对应）：
 *  · 角色只有两种：admin（全站唯一，权限最高）与 member；
 *  · "主持人"是**会议内**的身份——谁创建会议，谁就是这个会议的主持人；
 *  · 管理员在任何会议里都是主持人。
 *
 * 所以普通用户也能开会，创建成功后返回的 8 位编码就是会议号，别人用它加入。
 */

export interface CreatedRoom {
  roomId: string
  code: string
  title: string
  isHost: boolean
}

export interface MyRoom {
  roomId: string
  title: string
  createdAt: number
}

async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = (await response.json()) as { error?: unknown }
    if (typeof data?.error === 'string' && data.error) return new Error(data.error)
  } catch {
    // 响应不是 JSON：用兜底文案
  }
  return new Error(`${fallback}（HTTP ${response.status}）`)
}

/** 创建一个会议。需要已登录——租户归属必须有账号，否则"谁创建谁主持"无从谈起。 */
export async function createRoom(title?: string): Promise<CreatedRoom> {
  let response: Response
  try {
    response = await fetch('/rooms', {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title?.trim() ?? '' }),
    })
  } catch {
    throw new Error('无法连接服务器，请检查网络后重试。')
  }
  if (response.ok) return (await response.json()) as CreatedRoom
  throw await readError(response, '创建会议失败')
}

/** 我创建的会议（新的在前）。 */
export async function fetchMyRooms(): Promise<MyRoom[]> {
  const response = await fetch('/rooms/mine', { credentials: 'include', cache: 'no-store' })
  if (!response.ok) throw await readError(response, '查询我的会议失败')
  const data = (await response.json()) as { rooms?: MyRoom[] }
  return data.rooms ?? []
}

/** 会议编码格式：8 位、只含大写字母与数字（与服务端 roomCodeAlphabet 一致）。 */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{8}$/
