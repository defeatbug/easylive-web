# easylive-web（前端）

React 19 + TypeScript + Vite 8 + TailwindCSS 4。**不使用 devcontainer**：前端依赖 Node 生态，直接在宿主机跑最省事。

## 快速开始

```bash
pnpm install
pnpm dev        # https://localhost:5173（自签证书，浏览器需点"继续访问"）
```

同时把后端跑起来（另开一个终端）：

```bash
cd ../easylive-api
cp .env.example .env        # 首次
go run .                    # 监听 :8080，媒体 UDP :7881
```

Vite 已把 `/ws`、`/graphql`、`/healthz` 代理到 `http://localhost:8080`，所以**前端只有一个源**：
既没有 CORS 问题，也不会有 https 页面连 `ws://` 的混合内容问题。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/lib/protocol.ts` | 信令协议类型定义，**必须与 `easylive-api/protocol/protocol.go` 1:1 对齐** |
| `src/lib/RoomClient.ts` | WebRTC + 信令的唯一持有者（普通 TS 类）：两条 PeerConnection、请求响应匹配、ICE 候选缓存、订阅串行化、指标采集 |
| `src/hooks/useRoom.ts` | 用 `useSyncExternalStore` 把 `RoomClient` 接到 React，UI 只消费不可变快照 |
| `src/pages/JoinPage.tsx` | 入会页（房间号 + 昵称） |
| `src/pages/MeetingRoom.tsx` | 会议主界面：顶栏 / 视频宫格 / 右侧面板 / 底部控制栏 |
| `src/components/*` | `VideoTile`（视频瓦片）、`ControlBar`（控制栏）、`SidePanel`（聊天/成员/指标） |

## 三个设计决定（踩过坑才这么写）

1. **WebRTC 状态不进 React state。** React 18+ 的 StrictMode 在开发模式下 effect 会双调用，
   若把 `RTCPeerConnection` 建在 `useEffect` 里就会建两条连接（表现为重复发信令、幽灵参与者）。
   所以 `RoomClient` 独占浏览器 API，React 只读快照。
2. **ICE 候选要缓存。** 浏览器在 `setRemoteDescription` 之前调用 `addIceCandidate` 会抛错；
   服务端候选往往先于 SDP 到达，因此按 `pub`/`sub` 分别缓存，设置远端描述后再 flush。
3. **订阅必须串行。** 订阅者连接上服务端是 offerer，并发订阅会在 `have-local-offer` 状态下再创建
   offer 而失败。`RoomClient` 用一条 Promise 队列把订阅串起来。

## 常用脚本

```bash
pnpm dev         # 开发服务器（HTTPS，host: true 便于手机局域网访问）
pnpm build       # tsc --noEmit && vite build
pnpm preview     # 预览构建产物
pnpm typecheck   # 只做类型检查
```

## 浏览器回归探针（唯一能测真实浏览器行为的接缝）

类型检查与构建抓不到"点了没反应""红字不消失"这类问题，而用户报过来的 bug 大多是这一类。
`scripts/ui-probe.mjs` 用**真实 Chrome + 假摄像头**驱动界面，覆盖：

- 会前页点麦克风/摄像头**不会**提交表单（`<button>` 在 `<form>` 内默认是 `submit`）
- 摄像头开关能真正切换预览显隐
- 权限被拒 → 授权后点「重试打开设备」：画面恢复，**且过期的错误提示会消失**
- 会前页关摄像头入会 → 会中能重新打开

```bash
pnpm add -D playwright-core      # 只需一次；用本机已装的 Chrome，不下载浏览器
node scripts/ui-probe.mjs        # 默认打 https://localhost:5173 + http://localhost:8080
# 要换地址：PROBE_URL=... PROBE_API=... CHROME_PATH=... node scripts/ui-probe.mjs
```

它以退出码表示结果（全绿 0，有失败非 0），适合放进提交前的手工检查。
如果后端要指向另一套实例，起 dev server 时用 `DSH_API_TARGET=http://host:port` 覆盖代理目标。

## 局域网 / 手机测试

1. `pnpm dev` 后，用 `ipconfig getifaddr en0` 拿到本机 IP；
2. 手机访问 `https://<该IP>:5173`，手动信任自签证书；
3. **后端要显式设置 `SFU_ADVERTISE_IP=<该IP>`**，否则服务端广播的是容器/内网地址，手机连不上媒体面。

## 已知未完成项（下一步）

- 断线重连（当前 WebSocket 断开只更新状态，不自动重连；对应后端 M4）
- 业务后端 GraphQL 接口（创建房间 / 房间列表），前端目前用 URL 参数传房间号
- 屏幕共享在 Safari 上受系统限制，建议用 Chrome 演示
- 多人网格在超过 9 路时的分页/虚拟滚动（实测 20 路浏览器解码会先成为瓶颈）
