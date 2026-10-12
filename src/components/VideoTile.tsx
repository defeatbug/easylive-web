import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

type Quality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

interface VideoTileProps {
  stream: MediaStream | null
  label: string
  /** 本地画面需要镜像（自拍视角） */
  mirrored?: boolean
  /** 该参与者当前是否静音 */
  muted?: boolean
  /** 屏幕共享瓦片：不镜像、按 contain 显示，避免文字被裁切 */
  screen?: boolean
  /** 网络质量（右下角柱子），不传则不显示 */
  quality?: Quality
  badge?: ReactNode
  /**
   * 主画面右上角的"布局切换"按钮：把访客卡片摆到左侧竖排（再点还原）。
   * 不传则不显示该按钮。
   */
  onToggleSidebar?: () => void
  /** 左侧访客栏是否已展开（用于按钮的选中态） */
  sidebarOpen?: boolean
  /**
   * 尺寸模式（默认 tile，保持不变的是宫格观感）：
   *   - tile：固定 16:9、由宽度决定高度；摄像头 cover、屏幕共享 contain —— 宫格与左栏缩略图用；
   *   - stage：填满父容器，画面等比居中（contain）—— 只有"主舞台"用，
   *     这样单独看一个人的时候不会在下方留一大片空白。
   */
  fit?: 'tile' | 'stage'
  /** 该参与者正在说话（服务端 active_speakers 判定，非本地猜测） */
  speaking?: boolean
}

/**
 * 单个视频瓦片。
 *
 * 视觉上向 LiveKit Meet 靠：无边框、深色底、左下角小名字条、右下角质量柱、右上角全屏。
 * 关键实现点：<video> 的 srcObject 只能用 ref 赋值（React 不支持该属性）。
 */
export function VideoTile({
  stream,
  label,
  mirrored,
  muted,
  screen,
  quality,
  badge,
  onToggleSidebar,
  sidebarOpen,
  fit = 'tile',
  speaking = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream) {
      // 播放失败不能静默吞掉：那会让远端瓦片永远空白、且没有任何提示
      // （典型原因：自动播放策略拦下了带声音的媒体）。
      // 这里重试一次，并在 canplay 时再试一次；仍然失败就记日志便于排查。
      const tryPlay = () => {
        el.play().catch((err) => {
          console.warn('[VideoTile] 播放被拒绝，等待用户交互后重试', err)
          const once = () => {
            void el.play().catch(() => {})
            document.removeEventListener('click', once)
          }
          document.addEventListener('click', once, { once: true })
        })
      }
      tryPlay()
    }
  }, [stream])

  const hasVideo = !!stream && stream.getVideoTracks().length > 0

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapRef.current?.requestFullscreen()
  }

  return (
    <div
      ref={wrapRef}
      className={`group relative w-full overflow-hidden rounded-lg ${
        fit === 'stage' ? 'h-full bg-black' : 'aspect-video bg-[var(--surface)]'
      } ${speaking ? 'ring-2 ring-emerald-400' : ''}`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onDoubleClick={toggleFullscreen}
          title="双击全屏"
          className={`h-full w-full bg-black ${mirrored ? '-scale-x-100' : ''} ${
            // 舞台模式一律 contain（宁可留黑边也不裁画面）；宫格里摄像头用 cover 填满、屏幕共享用 contain
            screen || fit === 'stage' ? 'object-contain' : 'object-cover'
          }`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[var(--surface-2)]">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-xl font-medium text-neutral-300 sm:h-24 sm:w-24 sm:text-3xl">
            {label.slice(0, 1).toUpperCase()}
          </div>
        </div>
      )}

      {/* 左下角名字条 */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white/90">
          {muted && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 5a3 3 0 0 1 6 0v4M9 11a3 3 0 0 0 4.5 2.6M5 11a7 7 0 0 0 10 6.2M12 18v3M4 4l16 16" />
            </svg>
          )}
          {label}
        </span>
        {screen && (
          <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-sky-300">屏幕共享</span>
        )}
        {badge}
      </div>

      {/* 右下角网络质量柱 */}
      {quality && <QualityBars quality={quality} />}

      {/* 右上角：切换"左侧访客栏"布局（悬停才出现，不干扰画面） */}
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          title={sidebarOpen ? '收起左侧访客（还原布局）' : '访客卡片竖排到左侧'}
          className={`absolute right-2 top-2 rounded bg-black/50 p-1.5 opacity-0 transition hover:bg-black/70 group-hover:opacity-100 ${
            sidebarOpen ? 'text-[var(--brand)] opacity-100' : 'text-white/80'
          }`}
        >
          <SidebarIcon open={!!sidebarOpen} />
        </button>
      )}
    </div>
  )
}

const QUALITY_COLOR: Record<Quality, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-emerald-400',
  fair: 'bg-amber-400',
  poor: 'bg-red-500',
  unknown: 'bg-neutral-500',
}

function QualityBars({ quality }: { quality: Quality }) {
  // 三根柱子，按质量决定点亮根数（LiveKit Meet 右下角就是这个样式）
  const level = quality === 'excellent' ? 3 : quality === 'good' ? 3 : quality === 'fair' ? 2 : quality === 'poor' ? 1 : 0
  const color = QUALITY_COLOR[quality]
  const title = { excellent: '网络优秀', good: '网络良好', fair: '网络一般', poor: '网络较差', unknown: '网络未知' }[quality]

  return (
    <div className="absolute bottom-2 right-2 flex items-end gap-0.5 rounded bg-black/50 px-1.5 py-1" title={title}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-sm ${i <= level ? color : 'bg-white/25'}`}
          style={{ height: `${i * 3 + 3}px` }}
        />
      ))}
    </div>
  )
}

/** 布局图标：左列高亮表示"访客在左侧竖排"，收起态则是一整个大画面 */
function SidebarIcon({ open }: { open: boolean }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const }
  return open ? (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M5.5 8h1.5M5.5 12h1.5M5.5 16h1.5" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14h18" opacity="0.5" />
      <path d="M15 4v16" opacity="0" />
      <path d="M15 4v16" />
    </svg>
  )
}
