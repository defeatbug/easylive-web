import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface ShareDialogProps {
  roomId: string
  onClose: () => void
}

/**
 * 入会链接分享：二维码 + 复制按钮。
 * 用途很具体 —— 答辩现场用手机扫码入会，比开两个浏览器窗口更能说明"多人实时互通"。
 */
export function ShareDialog({ roomId, onClose }: ShareDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const feedbackTimer = useRef<number | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 白底深色码，保证任何手机都能扫；二维码区域不参与玻璃拟态
    void QRCode.toCanvas(canvas, url, {
      width: 232,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0c10', light: '#ffffff' },
    })
  }, [url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => () => {
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setCopyState('idle'), 2500)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-heading"
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[var(--surface-2)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="share-dialog-heading" className="text-base font-semibold text-neutral-100">邀请他人入会</h2>
            <p className="mt-0.5 text-xs text-neutral-400">房间：{roomId}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-200"
            aria-label="关闭"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex justify-center rounded-xl bg-white p-3">
          <canvas ref={canvasRef} />
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg bg-black/30 p-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent px-1 text-xs text-neutral-300 outline-none"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="shrink-0 rounded-md bg-[var(--brand)] px-2.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110"
          >
            {copyState === 'copied' ? '已复制' : '复制'}
          </button>
        </div>
        <p role="status" aria-live="polite" className={`mt-2 min-h-4 text-xs ${copyState === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
          {copyState === 'error' ? '复制失败，请选中上方链接手动复制。' : copyState === 'copied' ? '邀请链接已复制，可以发给参会者。' : ''}
        </p>

        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          手机扫码后如提示证书不受信任，选择"继续访问"即可（开发环境用的是自签证书）。
          后端还需把 <code className="text-neutral-400">SFU_ADVERTISE_IP</code> 设为本机局域网 IP，否则手机连不上媒体面。
        </p>
      </div>
    </div>
  )
}
