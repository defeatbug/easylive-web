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

Vite 把 `/ws`、`/auth`、`/rooms`、`/admin`、`/token`、`/ice`、`/graphql`、`/healthz`、`/recordings`、`/metrics`
全部代理到 `http://localhost:8080`（可用 `DSH_API_TARGET` 覆盖），所以**前端只有一个源**：
既没有 CORS 问题，也不会有 https 页面连 `ws://` 的混合内容问题。
漏配某个前缀的表现是前端拿到 `index.html`，控制台报 `Unexpected token '<' ... is not valid JSON`。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/lib/protocol.ts` | 信令协议类型定义，**必须与 `easylive-api/protocol/protocol.go` 1:1 对齐** |
| `src/lib/RoomClient.ts` | WebRTC + 信令的唯一持有者（普通 TS 类）：两条 PeerConnection、请求响应匹配、ICE 候选缓存、订阅串行化、指标采集、**断线重连（指数退避 + resumeToken）** |
| `src/hooks/useRoom.ts` | 用 `useSyncExternalStore` 把 `RoomClient` 接到 React，UI 只消费不可变快照 |
| `src/pages/LoginPage.tsx` | 登录 / 注册（`AUTH_MODE=off` 时整页不出现，直接以访客身份入会） |
| `src/pages/JoinPage.tsx` | 会前页：会议号 / 创建会议 + 昵称 + 设备选择与实时预览 |
| `src/pages/MeetingRoom.tsx` | 会议主界面：顶栏 / 视频宫格（或侧栏布局）/ 右侧面板 / 底部控制栏 |
| `src/pages/MetricsPage.tsx` | `#/metrics` 指标报表（数据来自 `/metrics/overview`，需要数据库里有采样） |
| `src/pages/AdminUsersPage.tsx` | `#/admin/users` 用户管理（仅管理员） |
| `src/components/*` | `VideoTile`（瓦片）、`ControlBar`（控制栏）、`SidePanel`（聊天 / 成员 / 指标）、`Whiteboard`、`AISummaryPanel`、`RecordingsPanel`、`ShareDialog`、`DevicePicker`、`ReactionDock`、`AccountDialog` |
| `src/lib/rooms.ts` `auth.ts` `recordings.ts` `admin.ts` | 业务接口封装（REST：会议 / 账号 / 录制 / 管理） |
| `src/lib/stroke.ts` `virtualBackground.ts` `multiWindow.ts` | 白板笔画几何、MediaPipe 虚拟背景、独立窗口（多显示器） |

> 前端**不用 GraphQL**：业务走 REST（`/rooms`、`/auth`、`/admin`、`/recordings`、`/metrics`）。
> `/graphql` 是给运维脚本与评测用的，生产环境还要 `X-API-Key`。

## 四个设计决定（踩过坑才这么写）

1. **WebRTC 状态不进 React state。** React 18+ 的 StrictMode 在开发模式下 effect 会双调用，
   若把 `RTCPeerConnection` 建在 `useEffect` 里就会建两条连接（表现为重复发信令、幽灵参与者）。
   所以 `RoomClient` 独占浏览器 API，React 只读快照。
2. **ICE 候选要缓存。** 浏览器在 `setRemoteDescription` 之前调用 `addIceCandidate` 会抛错；
   服务端候选往往先于 SDP 到达，因此按 `pub`/`sub` 分别缓存，设置远端描述后再 flush。
3. **订阅必须串行。** 订阅者连接上服务端是 offerer，并发订阅会在 `have-local-offer` 状态下再创建
   offer 而失败。`RoomClient` 用一条 Promise 队列把订阅串起来。
4. **断线恢复的身份标识必须由客户端持久化。** 页面刷新时浏览器直接杀掉进程，`leave` 发不出去，
   服务端只能把参与者标记为"重连中"并进入 30s 宽限期。重连时若不带 `resumeToken`，
   服务端会当成**新参与者**：刷新几次就会出现一屏"重连中"的幽灵（还会占满人数上限）。
   所以令牌存进 `sessionStorage`（超 25s 直接丢弃），刷新与自动重连都带上它，
   刷新前后的瓦片才是同一个人。

## 常用脚本

```bash
pnpm dev         # 开发服务器（HTTPS，host: true 便于手机局域网访问）
pnpm build       # tsc --noEmit && vite build
pnpm preview     # 预览构建产物
pnpm typecheck   # 只做类型检查
```

## 浏览器回归探针（唯一能测真实浏览器行为的接缝）

类型检查与构建抓不到"点了没反应""红字不消失"这类问题，而用户报过来的 bug 大多是这一类。
`scripts/*-probe.mjs` 用**真实 Chrome + 假摄像头**驱动界面，并断言**对方/用户真正看到的东西**
（DOM、可见控件、计数），不依赖内部字段，也不相信"我发出去就代表成功"。

共 18 个脚本（17 个探针 + 1 个截图工具），逐条口径见 **[docs/verification.md](docs/verification.md)**：

| 关注点 | 脚本 |
|---|---|
| 会前页与设备权限 | `ui-probe.mjs`、`token-error-probe.mjs` |
| 会中控件与布局 | `dock-probe.mjs`（弹幕/互动，**断言在接收方**）、`layout-probe.mjs`、`polish-probe.mjs`（动效/独立窗口）、`avatar-probe.mjs` |
| 共享状态 | `whiteboard-ink-probe.mjs`（回声未到时的笔画不丢）、`wb-new-probe.mjs`（撤销归属/缩放/迟到者/清空） |
| 媒体与编码 | `codec-probe.mjs`（从 `/metrics/tracks` 读**协商到**的编码）、`screen-audio-probe.mjs`（共享系统音频）、`vb-probe.mjs`（虚拟背景） |
| 录制与授权 | `rec-probe.mjs`（启停/落盘/清单）、`rec-auth-probe.mjs`（按房间归属鉴权：主持人 200 / 成员 403 / 管理员全可见 / 未登录 401） |
| 账号与安全 | `ui-account-probe.mjs`（42 项：登录页、焦点锁、Tab、Escape、改资料、头像、退出）、`ws-flood-probe.mjs`（单连接洪水会被断开） |
| 报表与 AI | `metrics-page-probe.mjs`、`ai-probe.mjs` |
| 截图（不断言） | `ui-shot.mjs` |

```bash
pnpm add -D playwright-core      # 只需一次；用本机已装的 Chrome，不下载浏览器
node scripts/dock-probe.mjs      # 默认打 https://localhost:5173 + http://localhost:8080
# 要换地址：PROBE_URL=... PROBE_API=... CHROME_PATH=... node scripts/dock-probe.mjs
```

它以退出码表示结果（全绿 0，有失败非 0）。
如果后端要指向另一套实例，起 dev server 时用 `DSH_API_TARGET=http://host:port` 覆盖代理目标。

> 探针**没有接 CI**（两个仓库都没有 workflow 文件）：它们是提交前的手工检查。
> 录制、账号、白板这几组需要 `AUTH_MODE=required` + 数据库，启动参数见 `docs/verification.md`。
> 不带鉴权跑那些脚本会失败在"找不到登录页"上，不是功能坏了。

## 局域网 / 手机测试

1. `pnpm dev` 后，用 `ipconfig getifaddr en0` 拿到本机 IP；
2. 手机访问 `https://<该IP>:5173`，手动信任自签证书；
3. **后端要显式设置 `SFU_ADVERTISE_IP=<该IP>`**，否则服务端广播的是容器/内网地址，手机连不上媒体面。

## 已知限制（下一步）

> 核实于 2026-10-19。**断线重连**（指数退避 8 次、配合服务端 30s 宽限期）与**业务接口**
> （REST `/rooms` / `/auth` / `/admin`，前端已全部接上）都已交付，不再列在这里。

- **宫格没有分页/虚拟滚动**：`MeetingRoom.tsx` 的 `GridView` 只有固定断点（1 / 2 / 3 列），
  超过 9 路会一路往下排。实测 20 路时浏览器的解码能力会先成为瓶颈，所以暂时够用。
- **屏幕共享在 Safari 上受系统限制**：建议用 Chrome 演示（这条未在 Safari 上做过回归）。
- **不内置录制播放器**：产物是 IVF/Ogg，`<video>` 读不了 IVF。面板给的是本机零转码 ffmpeg 命令
  （`-c copy` 转成 WebM），不在服务端转码——见 easylive-api README 的「会议录制」。
- **AI 功能依赖本机配置**：本地 whisper 模型与 `DEEPSEEK_API_KEY` 缺任意一个，界面只会显示"未配置"。
  配置步骤与两个真实踩过的 `.env` 坑见 `easylive-api/docs/ai-setup.md`。
- **后端的媒体面缺口不在前端可补范围**：GOP 缓存、simulcast/自适应码率、容量隔离等，
  见 `easylive-api/README.md` 的「尚未实现 / 已知限制」。
