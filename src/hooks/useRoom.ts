import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { RoomClient, type RoomSnapshot } from '../lib/RoomClient'
import { fetchICEServers } from '../lib/ice'
import { fetchToken } from '../lib/token'
import { buildConstraints, type DeviceSelection } from '../lib/devices'

const EMPTY: RoomSnapshot = {
  connection: 'idle',
  roomId: '',
  self: null,
  participants: [],
  tracks: [],
  remoteStreams: {},
  chat: [],
  speakers: [],
  hands: [],
  reactions: [],
  dataChannelReady: false,
  grants: null,
  notice: null,
  localStream: null,
  screenStream: null,
  micEnabled: true,
  camEnabled: true,
  virtualBackground: 'off',
  virtualBackgroundBusy: false,
  stats: null,
  error: null,
  reconnectAttempt: 0,
}

export interface JoinOptions {
  devices: DeviceSelection
  micOn: boolean
  camOn: boolean
  /** 会前页已经拿到的预览流：直接交接复用，不要停掉再重新申请（会撞设备释放竞态） */
  previewStream?: MediaStream | null
  /** 令牌身份；缺省用昵称（无鉴权模式下两者等价） */
  identity?: string
  /** 是否申请主持人权限。仅用于本地演示：生产环境应由登录系统决定，不能由前端申请 */
  asAdmin?: boolean
}

/**
 * 把 RoomClient 接到 React：客户端实例由 effect 创建/销毁，UI 只消费不可变快照。
 *
 * 注意：React 18+ StrictMode 在开发模式下会 effect 双调用（挂载→卸载→挂载），
 * 所以这里会看到一次"入会→离开→再入会"。生产构建只执行一次；这是有意的取舍——
 * WebRTC 生命周期放在 ref 里反而会掩盖资源泄漏。
 */
export function useRoom(active: boolean, roomId: string, displayName: string, join: JoinOptions) {
  const [client, setClient] = useState<RoomClient | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const { devices, micOn, camOn, previewStream, identity, asAdmin } = join

  useEffect(() => {
    if (!active || !roomId || !displayName) return

    let cancelled = false
    let client: RoomClient | null = null

    // 关键：延后一拍再真正启动。
    //
    // React StrictMode 在开发模式下会「挂载 → 卸载 → 重新挂载」。如果不延后，
    // 第一个 RoomClient 会真的连上信令并接管会前页交接过来的预览流，紧接着被 leave() 销毁——
    // 那条流的轨道被 stop 掉，第二个 client 只能回退去重新申请设备，
    // 于是撞上"设备释放是异步的"竞态（表现就是自己的卡片不显示）。
    // 延后一拍后，首次挂载的启动会被 cleanup 直接取消，等于什么都没发生。
    const timer = window.setTimeout(() => {
      if (cancelled) return

      void (async () => {
        try {
          // 先申请令牌：服务端 AUTH_MODE=off 时 /token 返回 501，这里拿到 null，
          // 照常以无令牌方式入会（保证本地演示开箱可用）。
          const who = identity ?? displayName
          const token = await fetchToken({ roomId, identity: who, name: displayName, roomAdmin: asAdmin })
          // ICE 配置与令牌并行取（两者互不依赖），减少入会前的等待
          const iceServers = await fetchICEServers(who)
          // 关键：await 之后必须重新检查 cancelled，否则 StrictMode 下会留下"僵尸连接"
          if (cancelled) return

          const c = new RoomClient({ roomId, displayName, token, iceServers, onError: (m) => setLocalError(m) })
          client = c
          setClient(c)

          await c.connect()
          // 一律先把音视频都发布出去，再按会前页的选择静音/关闭——
          // 否则关掉摄像头入会后就再也无法"打开摄像头"（本地根本没有轨道可启用）。
          await c.publishLocalMedia(buildConstraints(devices, { audio: true, video: true }), previewStream)
          if (!micOn) c.setMicEnabled(false)
          if (!camOn) c.setCamEnabled(false)
          // 成功走到这里说明媒体已经就绪，之前那次失败的错误提示必须消失
          if (!cancelled) setLocalError(null)
        } catch (e) {
          if (!cancelled) setLocalError(e instanceof Error ? e.message : String(e))
          // 媒体打不开不代表参会能力全废：举手/表情依赖的数据通道建在发布连接上，
          // 这里补一次不带媒体的协商，让它们照常可用。
          // 用外层变量：c 是 try 块内的 const，catch 里看不到
          await client?.ensureDataPlane()
        }
      })()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      client?.leave()
      setClient(null)
    }
    // devices 是对象，用字段级依赖避免每次渲染都重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roomId, displayName, devices.micId, devices.camId, micOn, camOn, previewStream, identity, asAdmin])

  /**
   * 重试打开设备。
   *
   * 为什么要有这层包装而不是让界面直接调 client：这个 hook 自己也会用 localError
   * 记住失败原因，而 client 的重试成功时并不知道要清它——结果就是"重试成功了，
   * 红字'Permission denied'还挂在那里"。新的一次尝试开始，旧错误就应当立即作废。
   */
  const retryMedia = useCallback(async () => {
    const c = client
    if (!c) return
    setLocalError(null)
    try {
      await c.retryLocalMedia()
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    }
  }, [client])

  /** 重连信令（同样先清掉上一次的错误，避免成功后面板仍显示红字） */
  const retryConnect = useCallback(() => {
    setLocalError(null)
    void client?.retryConnect()
  }, [client])

  const subscribe = useCallback((cb: () => void) => (client ? client.subscribe(cb) : () => {}), [client])
  const getSnapshot = useCallback(() => (client ? client.getSnapshot() : EMPTY), [client])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  return { client, snapshot, error: snapshot.error ?? localError, retryMedia, retryConnect }
}
