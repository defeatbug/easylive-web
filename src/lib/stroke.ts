import { getStroke } from 'perfect-freehand'

/**
 * 自由笔迹的抽稀与轮廓化。
 *
 * 两个来自 Excalidraw 的做法（看它的依赖清单发现的，都是它自己在用的开源项目）：
 *  1. **perfect-freehand**：把折线变成"速度越快要细、转弯要圆"的墨迹轮廓，
 *     而不是等宽折线——这是白板"像真笔迹"的关键。它零依赖。
 *  2. **发送前抽稀**：指针事件的采样点密得多余（120Hz 的鼠标一秒能产生上百个点），
 *     抽稀后既让笔迹更平滑，也把上报体积降下来。
 *
 * 一个必须守住的约束：**本地渲染和服务端回声用同一份点**。
 * 所以本文件既负责渲染，也负责"将要上报的点"，Whiteboard 里两处调用的输入完全一致——
 * 否则自己的笔画在回声到达的那一刻会轻微跳变（本地按原始点画、回声按抽稀点画）。
 */

export type NormPoints = [number, number][]

/**
 * Ramer–Douglas–Peucker 抽稀。
 *
 * @param points    归一化坐标（0..1）
 * @param tolerance 允许的最大偏离（归一化单位）。0.0015 ≈ 画布宽 1000px 时 1.5px，视觉无损。
 *
 * 用迭代而不是递归：一笔最多 400 个点，最坏情况递归深度会很深，迭代版更稳。
 */
export function simplify(points: NormPoints, tolerance = 0.0015): NormPoints {
  const n = points.length
  if (n <= 2) return points.slice()

  const keep = new Array<boolean>(n).fill(false)
  keep[0] = true
  keep[n - 1] = true
  const tol2 = tolerance * tolerance
  const stack: [number, number][] = [[0, n - 1]]

  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number]
    const [x1, y1] = points[s]
    const [x2, y2] = points[e]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy

    let maxD = 0
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i]
      let d: number
      if (len2 === 0) {
        const ex = px - x1
        const ey = py - y1
        d = ex * ex + ey * ey
      } else {
        // 点到线段的距离平方（先投影到 [0,1] 再算垂距）
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
        const ex = px - (x1 + t * dx)
        const ey = py - (y1 + t * dy)
        d = ex * ex + ey * ey
      }
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = true
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** perfect-freehand 的轮廓点 → SVG 路径串（官方示例的最小实现）。 */
function outlineToPath(outline: number[][], closed = true): string {
  const len = outline.length
  if (len < 4) return ''
  const average = (a: number, b: number) => (a + b) / 2
  let a = outline[0]
  let b = outline[1]
  const c = outline[2]
  let result =
    `M${a[0].toFixed(2)},${a[1].toFixed(2)} ` +
    `Q${b[0].toFixed(2)},${b[1].toFixed(2)} ` +
    `${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`
  for (let i = 2, max = len - 1; i < max; i++) {
    a = outline[i]
    b = outline[i + 1]
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `
  }
  if (closed) result += 'Z'
  return result
}

export interface StrokePaintOptions {
  /** 归一化点列 */
  points: NormPoints
  /** 线宽（约定：画布宽按 1000 计时的像素值） */
  width: number
  /** 画布尺寸（设备像素） */
  w: number
  h: number
}

/**
 * 生成自由笔迹的填充轮廓（Path2D）。返回 null 表示退化情形（例如只有一个点），
 * 由调用方画一个圆点。
 *
 * 注意 `simulatePressure: false`：笔迹宽度只由**点列本身**（速度）决定，
 * 不依赖 pointer 的 pressure——这样服务端回声回来的同一份点能画出**一模一样**的笔迹，
 * 自己的笔画不会在确认那一刻跳变。
 */
export function freehandPath({ points, width, w, h }: StrokePaintOptions): Path2D | null {
  if (points.length === 0) return null
  // perfect-freehand 的点与 size 必须在同一坐标系里：这里统一用设备像素
  const input = points.map(([x, y]) => [x * w, y * h] as number[])
  const size = Math.max(1, (width * w) / 1000)
  const outline = getStroke(input, {
    size,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false,
    last: true,
  })
  if (outline.length < 4) return null
  const d = outlineToPath(outline)
  return d ? new Path2D(d) : null
}

/** 单点笔迹（点击一下）：画一个实心圆点。 */
export function dotPath(p: [number, number], width: number, w: number, h: number): Path2D {
  const r = Math.max(1, (width * w) / 1000 / 2)
  const path = new Path2D()
  path.arc(p[0] * w, p[1] * h, r, 0, Math.PI * 2)
  return path
}
