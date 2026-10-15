/**
 * 多窗口能力：画中画、独立窗口、全屏。
 *
 * 对齐腾讯会议那套"视频可以脱离主窗口"的做法（它的窗口/渲染层同样支持把某一路画面
 * 单独拎出来——这在大屏或双屏场景下很实用：主窗口看宫格，副屏盯一个人）。
 *
 * 这里刻意全部用**浏览器原生 API**，不引入任何依赖：
 *   - 画中画：document.pictureInPicture（Chrome/Safari 支持，Firefox 部分版本没有）
 *   - 独立窗口：window.open + 同源窗口之间直接传 MediaStream
 *   - 全屏：element.requestFullscreen
 */

/** 画中画开关。返回实际结果，调用方据此提示用户（不要静默失败）。 */
export async function togglePictureInPicture(
  video: HTMLVideoElement,
): Promise<'entered' | 'exited' | 'unsupported'> {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture()
      return 'exited'
    }
    if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
      return 'unsupported'
    }
    await video.requestPictureInPicture()
    return 'entered'
  } catch {
    // 用户手势缺失、视频未就绪等都会走到这里；交给上层给出可读提示
    return 'unsupported'
  }
}

/** 已打开的独立窗口：key -> Window。用于去重与离开会议时统一关闭。 */
const detachedWindows = new Map<string, Window>()

export interface DetachResult {
  ok: boolean
  /** 失败原因（直接展示给用户，因此是可读中文） */
  reason?: string
  /** true 表示复用了已经打开的窗口 */
  reused?: boolean
}

/**
 * 把一路画面弹到独立窗口。
 *
 * 同源窗口之间可以直接把 MediaStream 赋给对方的 <video>.srcObject——不需要任何信令或转发，
 * 也不复制码流。若浏览器拦截了弹窗（没有用户手势或被策略拦截），返回可读原因让界面提示，
 * 而不是让用户以为"点了没反应"。
 */
export function openDetachedWindow(stream: MediaStream, label: string, key: string): DetachResult {
  const existing = detachedWindows.get(key)
  if (existing && !existing.closed) {
    existing.focus()
    return { ok: true, reused: true }
  }

  const w = window.open('', `easylive-tile-${key}`, 'width=960,height=600,menubar=no,toolbar=no,location=no,status=no')
  if (!w) {
    return { ok: false, reason: '浏览器拦截了弹出窗口，请允许本站弹窗后重试' }
  }

  // 独立窗口是一张极简页面：顶部一条信息栏 + 铺满的画面。
  // 用 document.write 一次性写入，避免为了一个窗口再引入模板或路由。
  const safeLabel = label.replace(/[<>&]/g, '')
  w.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${safeLabel} · Easylive</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d0f12; color: #e9ebee;
    font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif; }
  .bar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    background: #1f2227; border-bottom: 1px solid rgba(255,255,255,.1); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 9999px; background: #22c55e; }
  .hint { margin-left: auto; color: #7d848f; }
  video { width: 100%; height: calc(100% - 36px); object-fit: contain; background: #000; }
</style>
</head>
<body>
  <div class="bar"><span class="dot"></span><strong>${safeLabel}</strong>
    <span class="hint">独立窗口 · 关闭本窗口即可</span></div>
  <video autoplay playsinline></video>
</body>
</html>`)
  w.document.close()

  const v = w.document.querySelector('video')
  if (!v) {
    w.close()
    return { ok: false, reason: '独立窗口创建失败' }
  }
  v.srcObject = stream
  void v.play().catch(() => {
    /* 自动播放被拦时用户点一下即可，不算失败 */
  })

  detachedWindows.set(key, w)
  w.addEventListener('beforeunload', () => detachedWindows.delete(key))
  return { ok: true }
}

/** 离开会议时关闭所有独立窗口（否则会留下一堆播放已结束流的空窗口）。 */
export function closeAllDetachedWindows(): void {
  for (const w of detachedWindows.values()) {
    try {
      w.close()
    } catch {
      /* 忽略：窗口可能已被用户关掉 */
    }
  }
  detachedWindows.clear()
}

/** 供 UI 显示"已弹出几个窗口"。 */
export function detachedWindowCount(): number {
  let n = 0
  for (const w of detachedWindows.values()) if (!w.closed) n++
  return n
}

/** 全屏切换（双击瓦片或点按钮都会用到）。 */
export async function toggleFullscreen(el: HTMLElement | null): Promise<void> {
  if (!el) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  } catch {
    /* 用户拒绝或浏览器不支持：不打断会议 */
  }
}
