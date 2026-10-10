/**
 * 客户端 ICE 配置。
 *
 * 为什么不由前端硬编码：STUN 只能做地址发现，双方都在对称 NAT 后必须走 TURN 中继，
 * 而 TURN 需要**服务端现签的临时凭证**（长期密钥绝不能下发到浏览器）。
 * 所以这里向 /ice 要一份配置。
 *
 * 回退策略：空列表或请求失败都退回内置 STUN。没有 STUN 的 ICE 只能靠 host 候选，
 * 局域网能用、跨 NAT 必失败——"给个公网 STUN"比"什么都不给"安全得多。
 */
const FALLBACK_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  // 国内网络访问上面这个可能不稳，备用一个
  { urls: 'stun:stun.qq.com:3478' },
]

interface ICEResponse {
  iceServers?: RTCIceServer[]
  turnEnabled?: boolean
  ttlSeconds?: number
}

/** 取服务端下发的 ICE 配置（含 TURN 临时凭证）。永不抛错。 */
export async function fetchICEServers(identity: string): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`/ice?identity=${encodeURIComponent(identity)}`)
    if (!resp.ok) return FALLBACK_ICE
    const data = (await resp.json()) as ICEResponse
    const list = (data.iceServers ?? []).filter((s) => {
      if (!s || !s.urls) return false
      return Array.isArray(s.urls) ? s.urls.length > 0 : String(s.urls) !== ''
    })
    return list.length > 0 ? list : FALLBACK_ICE
  } catch {
    return FALLBACK_ICE
  }
}
