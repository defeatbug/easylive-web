import { useCallback, useEffect, useState } from 'react'

/** 摄像头 / 麦克风的选择结果，会随会话一起持久化。 */
export interface DeviceSelection {
  micId?: string
  camId?: string
}

export interface DeviceOption {
  deviceId: string
  label: string
}

/**
 * 枚举设备。
 *
 * 注意：在用户授权之前，label 是空字符串（浏览器隐私策略），
 * 所以会前页必须先 getUserMedia 拿到预览，再枚举才能显示可读的设备名。
 */
export async function listDevices(kind: 'audioinput' | 'videoinput'): Promise<DeviceOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === kind)
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `${kind === 'audioinput' ? '麦克风' : '摄像头'} ${i + 1}`,
    }))
}

/** 监听设备插拔（插上耳机后列表要跟着变）。 */
export function useDevices() {
  const [mics, setMics] = useState<DeviceOption[]>([])
  const [cams, setCams] = useState<DeviceOption[]>([])

  const refresh = useCallback(() => {
    void listDevices('audioinput').then(setMics)
    void listDevices('videoinput').then(setCams)
  }, [])

  useEffect(() => {
    refresh()
    const md = navigator.mediaDevices
    if (!md?.addEventListener) return
    md.addEventListener('devicechange', refresh)
    return () => md.removeEventListener('devicechange', refresh)
  }, [refresh])

  return { mics, cams, refresh }
}

/**
 * 把 getUserMedia 的错误翻译成中文：浏览器抛出的 message 是英文
 * （如 "Requested device not found"），直接展示会让中文用户困惑。
 * 按 name 匹配（各浏览器 message 文案不一，name 是稳定的）。
 */
export function describeDeviceError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : ''
  switch (name) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未找到摄像头/麦克风设备'
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头/麦克风权限被拒绝，请在浏览器地址栏允许访问后重试'
    case 'NotReadableError':
    case 'TrackStartError':
      return '设备被其他应用占用，请关闭占用设备的应用后重试'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '所选设备不支持当前配置，请换个设备试试'
    case 'AbortError':
      return '设备启动被中断，请重试'
    case 'TypeError':
      return '当前环境不支持访问摄像头/麦克风（需要 HTTPS 或 localhost）'
    default:
      return '无法访问摄像头/麦克风，请检查设备后重试'
  }
}

/** 按用户选择拼出 getUserMedia 约束（设备不存在时回退到默认设备，避免直接报错）。 */
export function buildConstraints(
  sel: DeviceSelection,
  opts: { audio?: boolean; video?: boolean } = {},
): MediaStreamConstraints {
  const { audio = true, video = true } = opts
  return {
    audio: !audio ? false : sel.micId ? { deviceId: { ideal: sel.micId } } : true,
    video: !video
      ? false
      : {
          ...(sel.camId ? { deviceId: { ideal: sel.camId } } : {}),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
  }
}
