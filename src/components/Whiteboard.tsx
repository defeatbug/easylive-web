import { useEffect, useRef, useState } from 'react'
import type { WhiteboardOp, WhiteboardStroke, WhiteboardTool } from '../lib/protocol'

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
const TOOLS: { id: WhiteboardTool; label: string }[] = [
  { id: 'pen', label: '画笔' },
  { id: 'eraser', label: '橡皮' },
  { id: 'line', label: '直线' },
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
]

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
  const pendingRef = useRef<WhiteboardStroke | null>(null)
  const drawRef = useRef<{ tool: WhiteboardTool; color: string; width: number; start: [number, number] | null }>({
    tool: 'pen',
    color: COLORS[0],
    width: 3,
    start: null,
  })
  const [tool, setTool] = useState<WhiteboardTool>('pen')
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
    const px = s.points.map(([x, y]) => [x * w, y * h] as [number, number])
    if (px.length === 0) return
    ctx.save()
    // 橡皮：真正镂空（destination-out），这样底下是"白板"而不是被涂白
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over'
    // width 约定：画布宽 1000 时的像素值
    ctx.lineWidth = Math.max(1, (s.width * w) / 1000)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = s.color
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

  /** 重画"已提交层"（只在 ops 变化或尺寸变化时调用）。 */
  const repaintCommitted = () => {
    const off = committedRef.current
    if (!off) return
    const ctx = off.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, off.width, off.height)
    for (const op of ops) if (op.kind === 'stroke' && op.stroke) paintStroke(ctx, op.stroke, off.width, off.height)
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
    // 先画"已抬手待确认"的那一笔，再画"正在画"的这一笔
    if (pendingRef.current) paintStroke(ctx, pendingRef.current, canvas.width, canvas.height)
    if (liveRef.current) paintStroke(ctx, liveRef.current, canvas.width, canvas.height)
  }

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

  // 服务端广播回来（ops 变长）后，清掉"待确认"的那一笔——它的副本已经在 ops 里了。
  // 注意**不能**动 liveRef：那是用户此刻正按住画的笔，清掉会让正在画的一笔断掉。
  useEffect(() => {
    pendingRef.current = null
    repaint()
  }, [ops.length])

  // 到达服务端上限时提前告知：否则用户会看到"画上去又被服务端拒绝"，很困惑。
  // 上限与服务端 protocol.MaxWhiteboardOps 保持一致（600）。
  useEffect(() => {
    if (ops.length >= 600) setHint('白板内容已达上限，请清空后再继续绘制')
    else setHint(null)
  }, [ops.length])

  /** 画布坐标 → 归一化 0..1。 */
  const toNorm = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / Math.max(1, rect.width)
    const y = (e.clientY - rect.top) / Math.max(1, rect.height)
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const d = drawRef.current
    const p = toNorm(e)
    d.start = p
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    // 只有按下才开始接收采样点
    liveRef.current = { tool: d.tool, color: d.color, width: d.width, points: [p] }
    repaint()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const live = liveRef.current
    const d = drawRef.current
    if (!live) return
    const p = toNorm(e)
    if (d.tool === 'pen' || d.tool === 'eraser') {
      // 距离阈值：太密的点既占带宽也占渲染，2px 归一化后约等于视觉无损
      const last = live.points[live.points.length - 1]
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return
      if (live.points.length >= 400) return
      live.points.push(p)
    } else if (d.start) {
      // 形状只有起点和终点
      live.points = [d.start, p]
    }
    repaint()
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
    pendingRef.current = live
    onOp({ kind: 'stroke', stroke: live })
    // 兜底：万一服务端没广播回来（被限速或白板已满），2.5s 后清掉"待确认"的那一笔，
    // 否则它会永远留在画面上、看起来像"画上去了但其实没提交成功"。
    window.setTimeout(() => {
      if (pendingRef.current === live) {
        pendingRef.current = null
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

        {/* 画布区 */}
        <div ref={wrapRef} className="relative min-h-0 flex-1 bg-white">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            onPointerLeave={finishStroke}
          />
          {ops.length === 0 && !liveRef.current && !pendingRef.current && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
              在这里画点什么——所有人都会实时看到
            </p>
          )}
          {hint && (
            <p className="tm-anim-fade pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-black/75 px-2.5 py-1 text-[11px] text-white">
              {hint}
            </p>
          )}
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
