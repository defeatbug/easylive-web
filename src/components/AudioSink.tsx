import { useEffect, useRef } from 'react'

/**
 * 远端音频的播放器。
 *
 * 为什么单独做一个组件：音频轨和视频轨在服务端是**各自独立的轨道**（各有自己的 trackId），
 * 而视频瓦片只挂了视频轨那条流。结果就是——麦克风的声音从来没有被任何元素播放过：
 * 界面能看、不能听，而"muted"图标还显示正常。这类缺陷不会自己暴露，必须有人从
 * "用户到底听到了没有"这个角度去查。
 *
 * 所以：为每一条远端音频轨挂一个隐藏的 <audio>，与视频瓦片解耦
 * （LiveKit 的 AudioRenderer 也是同样的思路）。屏幕共享的系统声音同样走这里。
 */
export function AudioSink({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (!stream) return
    // 播放失败不能静默吞掉（自动播放策略）：重试一次，并在首次点击时再试。
    const tryPlay = () => {
      void el.play().catch(() => {
        const once = () => {
          void el.play().catch(() => {})
          document.removeEventListener('click', once)
        }
        document.addEventListener('click', once, { once: true })
      })
    }
    tryPlay()
  }, [stream])

  if (!stream) return null
  // 隐藏但**必须在 DOM 里**：display:none 在部分浏览器会连带停掉音频输出；
  // 这里用 0 尺寸 + aria-hidden，既不占位也不被读屏读到。
  return (
    <audio
      ref={ref}
      autoPlay
      playsInline
      aria-hidden="true"
      title={`${label} 的声音`}
      style={{ width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
    />
  )
}
