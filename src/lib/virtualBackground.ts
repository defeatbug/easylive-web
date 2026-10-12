import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

/**
 * 端侧虚拟背景（人像分割）。
 *
 * 设计要点（对齐腾讯会议那套端侧 AI 的做法：模型在本地跑、不上传画面）：
 *  1. **模型与 wasm 自托管**在 /mediapipe 下，运行时不访问任何外部地址——
 *     答辩现场网络不可控，这一点比"省几 MB 仓库"重要得多；
 *  2. **懒加载**：只有用户点开特效时才下载 13MB 的 wasm，正常开会不受影响；
 *  3. **分割约 15fps、合成 30fps**：分割是大头，降频后 CPU 占用明显下降，
 *     而画面依旧是流畅的（背景虚化本身对时延不敏感）；
 *  4. 换轨用 `sender.replaceTrack()`——m-line 与 SSRC 都不变，SFU 侧完全无感，
 *     不需要任何信令改动。
 */
export type VirtualBackgroundMode = 'off' | 'blur' | 'color'

export interface VirtualBackgroundHandle {
  /** 处理后的视频轨（喂给 RTCRtpSender 与本地预览） */
  track: MediaStreamTrack
  /** 停止处理；**不会**停止原始摄像头轨（它属于 localStream） */
  stop: () => void
}

const BASE = '/mediapipe'

let segmenterPromise: Promise<ImageSegmenter> | null = null

/** 加载分割模型（全页共享一个实例；失败后允许重试）。 */
function loadSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`)
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${BASE}/models/selfie_segmenter.tflite`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      })
    })().catch((e: unknown) => {
      // 失败要清掉缓存，否则一次网络抖动会让这个功能永久失效
      segmenterPromise = null
      throw e
    })
  }
  return segmenterPromise
}

/** 合成用：把 categoryMask 写进一张 canvas 的 alpha 通道（人=不透明）。 */
function maskToCanvas(maskCanvas: HTMLCanvasElement, data: Uint8Array, w: number, h: number) {
  const ctx = maskCanvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(w, h)
  const px = img.data
  for (let i = 0; i < w * h; i++) {
    // 模型给出的取值可能是 0/1（类别）或 0/255（已映射），统一成"非 0 即人"
    const person = data[i] > 0
    const o = i * 4
    px[o] = 255
    px[o + 1] = 255
    px[o + 2] = 255
    px[o + 3] = person ? 255 : 0
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * 启动虚拟背景。source 必须是**摄像头的视频轨**（屏幕共享不做人像分割）。
 */
export async function startVirtualBackground(
  source: MediaStreamTrack,
  mode: Exclude<VirtualBackgroundMode, 'off'>,
): Promise<VirtualBackgroundHandle> {
  const segmenter = await loadSegmenter()

  const video = document.createElement('video')
  video.srcObject = new MediaStream([source])
  video.muted = true
  video.playsInline = true
  await video.play()

  // 等首帧，否则拿不到真实分辨率
  for (let i = 0; i < 40 && video.videoWidth === 0; i++) {
    await new Promise((r) => window.setTimeout(r, 50))
  }
  const rawW = video.videoWidth || 640
  const rawH = video.videoHeight || 360
  // 上限 1280 宽：再高对分割质量几乎没有提升，但 CPU/显存吃紧
  const scale = rawW > 1280 ? 1280 / rawW : 1
  const w = Math.max(2, Math.round(rawW * scale))
  const h = Math.max(2, Math.round(rawH * scale))

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const outCtx = out.getContext('2d')

  const fg = document.createElement('canvas')
  fg.width = w
  fg.height = h
  const fgCtx = fg.getContext('2d')

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = w
  maskCanvas.height = h

  if (!outCtx || !fgCtx) throw new Error('无法创建画布上下文')

  let running = true
  let raf = 0
  let lastSeg = 0
  let hasMask = false

  const compose = () => {
    // ---- 背景层 ----
    if (mode === 'blur') {
      outCtx.save()
      outCtx.filter = 'blur(16px)'
      // 放大一点再画，避免模糊后边缘出现半透明缝
      outCtx.drawImage(video, -8, -8, w + 16, h + 16)
      outCtx.restore()
    } else {
      outCtx.fillStyle = '#12161c'
      outCtx.fillRect(0, 0, w, h)
    }

    // ---- 人像层：原图 + 遮罩 destination-in ----
    if (hasMask) {
      fgCtx.globalCompositeOperation = 'source-over'
      fgCtx.clearRect(0, 0, w, h)
      fgCtx.drawImage(video, 0, 0, w, h)
      fgCtx.globalCompositeOperation = 'destination-in'
      fgCtx.drawImage(maskCanvas, 0, 0, w, h)
      fgCtx.globalCompositeOperation = 'source-over'
      outCtx.drawImage(fg, 0, 0)
    } else {
      // 还没拿到遮罩时先原样输出，避免用户看到一块空背景
      outCtx.drawImage(video, 0, 0, w, h)
    }
  }

  const loop = () => {
    if (!running) return
    raf = window.requestAnimationFrame(loop)
    const now = performance.now()
    if (now - lastSeg >= 66) {
      // 约 15fps 做分割；回调里拿到遮罩后再合成
      lastSeg = now
      try {
        segmenter.segmentForVideo(video, now, (result) => {
          const mask = result.categoryMask
          if (mask) {
            maskToCanvas(maskCanvas, mask.getAsUint8Array(), w, h)
            hasMask = true
          }
          mask?.close?.()
          compose()
        })
      } catch {
        // 单帧失败不影响整体：保持上一帧输出
      }
    } else {
      compose()
    }
  }
  compose()
  raf = window.requestAnimationFrame(loop)

  const captured = out.captureStream(30)
  const track = captured.getVideoTracks()[0]

  return {
    track,
    stop: () => {
      running = false
      window.cancelAnimationFrame(raf)
      try {
        video.pause()
      } catch {
        /* 忽略 */
      }
      // 只是断开引用：原始摄像头轨属于 localStream，绝不能在这里 stop()
      video.srcObject = null
      track.stop()
    },
  }
}
