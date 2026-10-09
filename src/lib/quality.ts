import type { LinkStats } from './RoomClient'

export type QualityLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

export interface Quality {
  level: QualityLevel
  /** 0—100，用于色条宽度 */
  score: number
  label: string
  text: string
  bar: string
  dot: string
}

/**
 * 把 getStats 指标折算成一个"网络质量"评分，用于顶栏/指标面板的绿黄红色条。
 *
 * 评分口径（与评测章节保持一致，写论文时可直接引用这段逻辑）：
 *   - RTT：≤80ms 满分，≥400ms 归零
 *   - 丢包率：≤0.5% 满分，≥8% 归零
 *   - 抖动：≤20ms 满分，≥150ms 归零
 *   加权：RTT 0.4 + 丢包 0.4 + 抖动 0.2（丢包对音视频体验影响最大，与 RTT 同权）
 *
 * 注意：这是**主观体验的工程近似**，不是 MOS；论文里要说明它是启发式指标，
 * 真正的质量结论仍以 freezeCount / 端到端延迟等原始数据为准。
 */
export function evaluateQuality(stats: LinkStats | null): Quality {
  if (!stats) {
    return {
      level: 'unknown',
      score: 0,
      label: '等待数据',
      text: 'text-neutral-400',
      bar: 'bg-neutral-600',
      dot: 'bg-neutral-500',
    }
  }

  const norm = (v: number, good: number, bad: number) => {
    if (v <= good) return 1
    if (v >= bad) return 0
    return 1 - (v - good) / (bad - good)
  }

  const score = Math.round(
    (norm(stats.rttMs, 80, 400) * 0.4 + norm(stats.lossRate, 0.5, 8) * 0.4 + norm(stats.jitterMs, 20, 150) * 0.2) * 100,
  )

  if (score >= 85) {
    return { level: 'excellent', score, label: '优秀', text: 'text-emerald-400', bar: 'bg-emerald-500', dot: 'bg-emerald-400' }
  }
  if (score >= 65) {
    return { level: 'good', score, label: '良好', text: 'text-sky-400', bar: 'bg-sky-500', dot: 'bg-sky-400' }
  }
  if (score >= 40) {
    return { level: 'fair', score, label: '一般', text: 'text-amber-400', bar: 'bg-amber-500', dot: 'bg-amber-400' }
  }
  return { level: 'poor', score, label: '较差', text: 'text-red-400', bar: 'bg-red-500', dot: 'bg-red-400' }
}
