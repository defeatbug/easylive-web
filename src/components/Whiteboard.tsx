import { useEffect, useRef, useState } from 'react'
import type { WhiteboardOp, WhiteboardStroke, WhiteboardTool } from '../lib/protocol'
import { dotPath, freehandPath, simplify } from '../lib/stroke'

interface WhiteboardProps {
  /** 房间白板内容（来自入会快照 + 服务端广播） */
  ops: WhiteboardOp[]
  selfId: string | null
  /** 参与者 id → 昵称：底部要显示"谁在画"，直接显示 id 对用户没有意义 */
  nameOf: (participantId: string) => string
  /** 提交一笔（服务端校验/编号后广播） */
  onOp: (op: WhiteboardOp) => void
  onClose: () => void
}

const COLORS = ['#1b1d21', '#e5484d', '#f5a524', '#22c55e', '#0273fe', '#a855f7']
/**
 * 工具栏上的工具 = 绘制工具 + 抓手。
 * 抓手是纯本地视图模式（拖拽平移），永远不产生笔画、不过网——
 * 所以不进 protocol 的 WhiteboardTool，也就碰不到 Go 端的工具白名单。
 */
type WhiteboardUiTool = WhiteboardTool | 'hand'

const TOOLS: { id: WhiteboardUiTool; label: string }[] = [
  { id: 'hand', label: '抓手' },
  { id: 'pen', label: '画笔' },
  { id: 'eraser', label: '橡皮' },
  { id: 'line', label: '直线' },
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
]

/** 视图变换（本地状态，不广播：各人看各的缩放/平移）。世界→屏幕（归一化空间）：s = p * k + t */
interface ViewTransform {
  k: number
  tx: number
  ty: number
}

/**
 * 白板（会中共用）。
 *
 * 几个刻意的取舍：
 *  1. **坐标归一化 0..1**：各人窗口大小不同，用设备像素会让"我画的圆在别人那里变形"；
 *     width 约定为"画布宽按 1000 计"的像素值，渲染时按实际宽度缩放。
 *  2. **两层画布**：已提交内容画在离屏画布上（只在 ops 变化时重绘），可见画布每次只做
 *     "贴离屏 + 画当前这一笔"。600 笔的房间里这样才不会每移动一像素就重画全部。
 *  3. **一笔一条消息**：不做逐点上报，既省带宽也不会把信令队列打满。
 *  4. **乐观渲染**：本笔在本地立即显示，等服务端广播回来后再并入已提交层——
 *     所以不能"抬手就清掉本地这一笔"，否则会闪一下。
 *  5. 白板底色为白、橡皮用 destination-out 真正镂空（不是用白色覆盖）。
 */
export function Whiteboard({ ops, selfId, nameOf, onOp, onClose }: WhiteboardProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const committedRef = useRef<HTMLCanvasElement | null>(null)
  /**
   * 两个引用，**必须分开**：
   *   - liveRef：正在画的那一笔，只有按住鼠标期间存在，也只有它会接收新采样点；
   *   - pendingRef：已抬手、等广播回来的那一笔（乐观渲染用，避免笔画闪一下）。
   *
   * 曾经只用一个 ref 兼顾两者，结果抬手后它仍然"活着"：
   * 松开鼠标后移动仍会往这一笔里加点（看起来像"不用按住也能画"），
   * 等兜底超时把它清掉时笔画又**消失**了——真人反馈的正是这个现象。
   */
  const liveRef = useRef<WhiteboardStroke | null>(null)
  /**
   * 已抬手、等广播回来的笔画**队列**。
   *
   * 为什么必须是队列而不是单值：上一笔的回声还没到就开始画下一笔时（真实网络下必然发生），
   * 单值会被新的一笔**覆盖**，那一笔既不在本地待确认里、也还没进 ops——于是永久消失。
   * 用户看到的正是"画第二笔时第一笔不见了"。
   */
  const pendingRef = useRef<WhiteboardStroke[]>([])
  /** 已确认的"我方笔迹"数：用它精确地把队列里的待确认项出队 */
  const confirmedSelfRef = useRef(0)
  const drawRef = useRef<{ tool: WhiteboardUiTool; color: string; width: number; start: [number, number] | null }>({
    tool: 'pen',
    color: COLORS[0],
    width: 3,
    start: null,
  })
  const [tool, setTool] = useState<WhiteboardUiTool>('pen')
  /** 视图变换：本地状态。渲染时直接作为 canvas transform，所以 paintStroke / stroke.ts 一行不用改，
   *  线宽也会随缩放自然变化（和 Excalidraw / Miro 一致的世界坐标语义）。 */
  const [view, setView] = useState<ViewTransform>({ k: 1, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  /** 正在平移（光标切换 grabbing；与 panRef 区分：这个只管 UI） */
  const [panning, setPanning] = useState(false)
  /** 空格是否按住（按住空格拖拽也能平移，Figma 式） */
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceRef = useRef(false)
  /** 平移手势进行中：起点屏幕坐标 + 起点视图 */
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null)
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(3)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    drawRef.current.tool = tool
    drawRef.current.color = color
    drawRef.current.width = width
  }, [tool, color, width])

  /** 把容器尺寸同步到画布（按 devicePixelRatio 放大，避免线条发虚）。 */
  const syncSize = () => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const rect = wrap.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    if (!committedRef.current) committedRef.current = document.createElement('canvas')
    const off = committedRef.current
    if (off.width !== w || off.height !== h) {
      off.width = w
      off.height = h
    }
  }

  const paintStroke = (ctx: CanvasRenderingContext2D, s: WhiteboardStroke, w: number, h: number) => {
    // 抽稀后再画：本地渲染与上报用的是**同一份点**，所以服务端回声回来时笔迹不会跳变。
    // 顺带让笔迹更平滑（指针采样点比需要的密得多）。
    const pts = simplify(s.points)
    const px = pts.map(([x, y]) => [x * w, y * h] as [number, number])
    if (px.length === 0) return
    ctx.save()
    // 橡皮：真正镂空（destination-out），这样底下是"白板"而不是被涂白
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over'
    // width 约定：画布宽 1000 时的像素值
    ctx.lineWidth = Math.max(1, (s.width * w) / 1000)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color

    // 画笔：用 perfect-freehand 生成墨迹轮廓后填充（Excalidraw 同款做法）
    if (s.tool === 'pen') {
      const path = freehandPath({ points: pts, width: s.width, w, h })
      if (path) {
        ctx.fill(path)
      } else if (px.length === 1) {
        ctx.fill(dotPath(pts[0], s.width, w, h))
      } else {
        // 轮廓退化的兜底：仍然把点连起来，绝不把用户的一笔画丢
        ctx.beginPath()
        ctx.moveTo(px[0][0], px[0][1])
        for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1])
        ctx.stroke()
      }
      ctx.restore()
      return
    }

    ctx.beginPath()
    if ((s.tool === 'line' || s.tool === 'rect' || s.tool === 'ellipse') && px.length >= 2) {
      const [a, b] = [px[0], px[px.length - 1]]
      if (s.tool === 'line') {
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
      } else if (s.tool === 'rect') {
        ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))
      } else {
        const cx = (a[0] + b[0]) / 2
        const cy = (a[1] + b[1]) / 2
        ctx.ellipse(cx, cy, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2)
      }
      ctx.stroke()
    } else {
      ctx.moveTo(px[0][0], px[0][1])
      for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1])
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 重画"已提交层"（ops / 尺寸 / 视图变化时调用）。 */
  const repaintCommitted = () => {
    const off = committedRef.current
    if (!off) return
    const ctx = off.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, off.width, off.height)
    // 视图变换：世界(归一化)→设备像素。paintStroke 按原逻辑画"世界坐标"即可，
    // transform 会把它搬到屏幕正确位置，线宽也随缩放自然变化。
    const v = viewRef.current
    ctx.setTransform(v.k, 0, 0, v.k, v.tx * off.width, v.ty * off.height)
    for (const op of ops) if (op.kind === 'stroke' && op.stroke) paintStroke(ctx, op.stroke, off.width, off.height)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** 可见画布 = 已提交层 + 当前这一笔。 */
  const repaint = () => {
    const canvas = canvasRef.current
    const off = committedRef.current
    if (!canvas || !off) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(off, 0, 0)
    // 顺序：全部待确认的笔画 → 正在画的那一笔（同样走视图变换）
    const v = viewRef.current
    ctx.setTransform(v.k, 0, 0, v.k, v.tx * canvas.width, v.ty * canvas.height)
    for (const p of pendingRef.current) paintStroke(ctx, p, canvas.width, canvas.height)
    if (liveRef.current) paintStroke(ctx, liveRef.current, canvas.width, canvas.height)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** 设置视图并重绘（paintStroke 从 viewRef 读变换）。 */
  const setViewAndRepaint = (v: ViewTransform) => {
    viewRef.current = v
    setView(v)
    repaintCommitted()
    repaint()
  }

  /** 以屏幕上一点为中心缩放（滚轮 / 按钮共用）：光标下的世界点保持不动。 */
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = (clientX - rect.left) / Math.max(1, rect.width)
    const sy = (clientY - rect.top) / Math.max(1, rect.height)
    const v = viewRef.current
    const k2 = Math.min(8, Math.max(0.5, v.k * factor))
    if (k2 === v.k) return
    const wx = (sx - v.tx) / v.k
    const wy = (sy - v.ty) / v.k
    setViewAndRepaint({ k: k2, tx: sx - wx * k2, ty: sy - wy * k2 })
  }

  /** 以画布中心缩放（缩放按钮用）。 */
  const zoomCenter = (factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  /** 回到 100% / 无平移。 */
  const resetView = () => setViewAndRepaint({ k: 1, tx: 0, ty: 0 })

  // 尺寸与 ops 变化时重绘
  useEffect(() => {
    syncSize()
    repaintCommitted()
    repaint()
  }, [ops])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      syncSize()
      repaintCommitted()
      repaint()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [ops])

  // 滚轮缩放（以光标为中心）：必须用非 passive 监听才能 preventDefault 阻止页面滚动
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // 空格按住 → 拖拽平移（Figma 式）；输入框里按空格不受影响
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      spaceRef.current = true
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      spaceRef.current = false
    }
  }, [])

  // ops 变化时：重画已提交层，并把"已被服务端确认的我方笔迹"从待确认队列里出队。
  //
  // 用"我方笔迹数量"而不是"ops 长度"来判断：别人的笔迹也会让 ops 变长，
  // 按长度出队会错杀我们自己的待确认项。注意**不能**动 liveRef——那是用户正按住画的笔。
  useEffect(() => {
    repaintCommitted()
    const selfStrokes = ops.filter((o) => o.kind === 'stroke' && (!selfId || o.by === selfId)).length
    const delta = selfStrokes - confirmedSelfRef.current
    confirmedSelfRef.current = selfStrokes
    if (delta < 0) {
      // 清空/撤销：本地待确认的一并作废（服务端已经不认它们了）
      pendingRef.current = []
    } else {
      for (let i = 0; i < delta && pendingRef.current.length > 0; i++) pendingRef.current.shift()
    }
    repaint()
  }, [ops, selfId])

  // 到达服务端上限时提前告知：否则用户会看到"画上去又被服务端拒绝"，很困惑。
  // 上限与服务端 protocol.MaxWhiteboardOps 保持一致（600）。
  useEffect(() => {
    if (ops.length >= 600) setHint('白板内容已达上限，请清空后再继续绘制')
    else setHint(null)
  }, [ops.length])

  /** 屏幕坐标 → 世界坐标（归一化）。不裁剪到 [0,1]：平移后可以在原来的画布之外作画。 */
  const toWorld = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const v = viewRef.current
    const sx = (e.clientX - rect.left) / Math.max(1, rect.width)
    const sy = (e.clientY - rect.top) / Math.max(1, rect.height)
    return [(sx - v.tx) / v.k, (sy - v.ty) / v.k]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const d = drawRef.current
    const tool = d.tool
    // 抓手工具 / 空格+拖拽 / 中键拖拽 → 平移视图，不画画
    if (tool === 'hand' || spaceRef.current || e.button === 1) {
      const v = viewRef.current
      panRef.current = { startX: e.clientX, startY: e.clientY, tx: v.tx, ty: v.ty }
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      setPanning(true)
      return
    }
    const p = toWorld(e)
    d.start = p
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    // 只有按下才开始接收采样点（这里 tool 已收窄为 WhiteboardTool，抓手不会产生笔画）
    liveRef.current = { tool, color: d.color, width: d.width, points: [p] }
    repaint()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    // 平移中：屏幕位移直接换算成归一化位移（tx/ty 本来就是归一化单位）
    const pan = panRef.current
    if (pan) {
      const rect = canvasRef.current!.getBoundingClientRect()
      const v = viewRef.current
      setViewAndRepaint({
        ...v,
        tx: pan.tx + (e.clientX - pan.startX) / Math.max(1, rect.width),
        ty: pan.ty + (e.clientY - pan.startY) / Math.max(1, rect.height),
      })
      return
    }
    const live = liveRef.current
    const d = drawRef.current
    if (!live) return
    const p = toWorld(e)
    if (d.tool === 'pen' || d.tool === 'eraser') {
      // 距离阈值：太密的点既占带宽也占渲染；按缩放折算——放大后同样的世界距离
      // 对应更多屏幕像素，阈值要变小，否则线条在高缩放下会发折
      const last = live.points[live.points.length - 1]
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002 / viewRef.current.k) return
      if (live.points.length >= 400) return
      live.points.push(p)
    } else if (d.start) {
      // 形状只有起点和终点
      live.points = [d.start, p]
    }
    repaint()
  }

  /** 抬手：平移就结束平移，否则走原来的收笔流程。 */
  const onPointerUp = () => {
    if (panRef.current) {
      panRef.current = null
      setPanning(false)
      return
    }
    finishStroke()
  }

  const finishStroke = () => {
    const live = liveRef.current
    if (!live) return
    // 关键：抬手后立刻停止接收采样点（这是"按住才能画"的开关）
    liveRef.current = null
    if (live.points.length < 1) {
      repaint()
      return
    }
    // 上报抽稀后的点：与渲染用的是同一份（见 paintStroke），
    // 一是省带宽，二是保证自己的笔迹在回声到达时不跳变。
    const simplified: WhiteboardStroke = { ...live, points: simplify(live.points) }
    live.points = simplified.points
    pendingRef.current.push(live)
    if (import.meta.env.DEV) {
      // 探针钩子：用来断言确实做了抽稀（生产构建会被摇掉）
      ;(window as unknown as { __easyliveWhiteboardLastStroke?: number }).__easyliveWhiteboardLastStroke =
        simplified.points.length
    }
    onOp({ kind: 'stroke', stroke: simplified })
    // 兜底：万一服务端没广播回来（被限速或白板已满），2.5s 后把**这一笔**从队列里摘掉，
    // 否则它会永远留在画面上、看起来像"画上去了但其实没提交成功"。
    window.setTimeout(() => {
      const i = pendingRef.current.indexOf(live)
      if (i >= 0) {
        pendingRef.current.splice(i, 1)
        repaint()
      }
    }, 2500)
    repaint()
  }

  const savePng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 导出前把白底合成进去，否则透明区域在多数看图器里是黑的
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, 0, 0)
    const a = document.createElement('a')
    a.href = out.toDataURL('image/png')
    a.download = `whiteboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`
    a.click()
  }

  return (
    <div className="tm-anim-fade absolute inset-0 z-40 flex flex-col bg-black/55 p-3">
      <div className="tm-anim-pop theme-meeting flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)]">
        {/* 工具栏 */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-3 py-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">白板</h2>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTool(t.id)}
              className={`rounded-md px-2.5 py-1 text-[12px] transition ${
                tool === t.id ? 'bg-[var(--brand-tint)] text-[var(--brand)]' : 'text-[var(--text-dim)] hover:bg-[var(--surface-2)]'
              }`}
            >
              {t.label}
            </button>
          ))}

          <span className="mx-1 h-5 w-px bg-[var(--line)]" />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              title={`颜色 ${c}`}
              className={`h-5 w-5 rounded-full border-2 transition ${color === c ? 'border-[var(--brand)]' : 'border-transparent'}`}
              style={{ background: c }}
            />
          ))}
          <label className="ml-1 flex items-center gap-1.5 text-[11px] text-[var(--text-mute)]">
            粗细
            <input
              type="range"
              min={1}
              max={24}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="h-1 w-20 accent-[var(--brand)]"
            />
          </label>

          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" className="tm-btn px-2.5 py-1 text-[11px]" onClick={() => onOp({ kind: 'undo' })}>
              撤销
            </button>
            <button
              type="button"
              className="tm-btn px-2.5 py-1 text-[11px]"
              onClick={() => {
                if (window.confirm('清空所有人的白板内容？')) onOp({ kind: 'clear' })
              }}
            >
              清空
            </button>
            <button type="button" className="tm-btn px-2.5 py-1 text-[11px]" onClick={savePng} title="导出为 PNG 图片">
              保存图片
            </button>
            <button type="button" className="tm-btn px-2.5 py-1 text-[11px]" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        {/* 画布区：白纸隐喻——深色面板上的一张"纸"（圆角 + 投影），
            避免纯白画布与深色面板硬切。wrapRef 移到纸上，尺寸同步不受影响。 */}
        <div className="min-h-0 flex-1 p-3 sm:p-4">
          <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg bg-white shadow-[0_2px_18px_rgba(0,0,0,0.28)]">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full touch-none"
            style={{
              cursor:
                panning || spaceHeld ? 'grabbing'
                : tool === 'hand' ? 'grab'
                : tool === 'eraser' ? 'cell'
                : 'crosshair',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerUp}
          />
          {ops.length === 0 && !liveRef.current && pendingRef.current.length === 0 && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
              在这里画点什么——所有人都会实时看到
            </p>
          )}
          {hint && (
            <p className="tm-anim-fade pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-black/75 px-2.5 py-1 text-[11px] text-white">
              {hint}
            </p>
          )}
          {/* 缩放控件：右下角浮动（本地视图，不影响他人） */}
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--surface)]/92 px-1 py-0.5 text-[12px] text-[var(--text-dim)] shadow backdrop-blur">
            <button type="button" title="缩小" aria-label="缩小" className="rounded px-2 py-0.5 hover:bg-[var(--surface-2)]" onClick={() => zoomCenter(1 / 1.25)}>−</button>
            <button type="button" title="重置为 100%" className="min-w-11 rounded px-1 py-0.5 tabular-nums hover:bg-[var(--surface-2)]" onClick={resetView}>{Math.round(view.k * 100)}%</button>
            <button type="button" title="放大" aria-label="放大" className="rounded px-2 py-0.5 hover:bg-[var(--surface-2)]" onClick={() => zoomCenter(1.25)}>+</button>
          </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-[var(--line)] px-3 py-1.5 text-[11px] text-[var(--text-mute)]">
          <span>{ops.filter((o) => o.kind === 'stroke').length} 笔</span>
          {ops.length > 0 && ops[ops.length - 1].by && (
            <span>
              最后一位绘制者：
              {ops[ops.length - 1].by === selfId ? '我' : nameOf(ops[ops.length - 1].by ?? '')}
            </span>
          )}
          <span className="ml-auto">绘制会广播给房间内所有人；离开会议前可用"保存图片"留存</span>
        </footer>
      </div>
    </div>
  )
}
