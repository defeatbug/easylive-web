# 行为验证（探针）

> 这个项目的核心结论——"媒体真的通了""弹幕对方真的能看到""主持人真的能下载自己会议的录制"——
> 都不是靠读代码确认的，而是靠**在真实浏览器里跑一遍并断言用户看得见的结果**。
> 每个探针都是可重复执行的脚本，失败会以非零退出码返回。

## 为什么每项都要"断言行为"而不是"断言存在"

项目里踩过好几次"看起来通过"的坑：
- 断言了**发送方**看到弹幕，却没人验证**接收方** → 结果是"自己看得见、别人看不到"，功能等于没做；
- 用 `element.focus()` 测聚焦样式，但 `:focus-visible` 的语义**恰好排除**程序化聚焦 → 测的是假东西；
- 白板"撤销归属"用页脚的"最后一位绘制者"判断，而页脚取的是**最后一个操作**（撤销本身也是操作）→ 误判。

所以现在的原则是：**断言必须落在对方/用户真正看到的东西上**（DOM、可见控件、计数），
不依赖内部字段，也不依赖"我发出去就代表成功"。

## 运行方式

```bash
# 1) 后端（生产模式 + 鉴权 + 录制，另开一个终端）
APP_ENV=production AUTH_MODE=required JWT_SECRET=<≥16字符> \
ADMIN_USERNAME=admin ADMIN_PASSWORD='AdminPass123!' \
RECORD_ENABLED=true RECORD_DIR=/tmp/rec \
DATABASE_URL='postgres://easylive:test@127.0.0.1:5433/easylive?sslmode=disable' \
APP_PORT=8080 go run .

# 2) 前端（另开一个终端）
DSH_API_TARGET=http://localhost:8080 pnpm dev --port 5174

# 3) 跑探针（每个都可以单独跑）
PROBE_URL=https://localhost:5174 PROBE_API=http://localhost:8080 node scripts/dock-probe.mjs
```

测试账号：`alice/AlicePass123!`（主持人）、`bob/BobPass12345!`（成员）、`admin/AdminPass123!`（管理员）。
**必须用不同账号**：同一账号在两处登录会被单点登录规则踢掉。

## 核心探针

| 探针 | 验证什么 | 条数 |
|---|---|---|
| `dock-probe.mjs` | 左下角表情/互动按钮组；弹幕格式`我：内容`；**接收方**也看到弹幕与互动动效；花朵横向随机；弹幕同时进聊天 | 14 |
| `wb-new-probe.mjs` | 白板：撤销**只删自己的笔画**（连按两次第二次被拒）；缩放 100→125→80→重置；缩放是本地视图（对方仍 100%）；刷新后自动回会；迟到者从入会快照恢复；清空对所有人一致 | 14 |
| `rec-auth-probe.mjs` | 录制授权按**房间归属**：主持人能看能下自己会议的录制；普通成员看不到（403）；管理员全部可见；未登录 401 | 9 |
| `avatar-probe.mjs` | 会议内头像：开摄像头显示画面；关摄像头瓦片回落头像图片；**对方**也看到我的头像 | 5 |
| `layout-probe.mjs` | 底部一行三块（左中右）、同高 48px、不压视频、表情面板向上弹出 | 7 |
| `ui-account-probe.mjs` | 登录/注册/账号弹窗：焦点锁、Tab 不跑出、Escape、焦点归还、改资料、头像上传/移除、退出、窄屏不溢出 | 42 |
| `rec-probe.mjs` | 录制启停、文件落盘、清单 | 17 |
| `screen-audio-probe.mjs` | 屏幕共享系统音频 + 文字优先 | 13 |
| `polish-probe.mjs` | 动效/多窗口 | 8 |
| `metrics-page-probe.mjs` | 报表页（需要数据库里有采样） | 8 |

## 后端测试

```bash
go test ./...        # 10 个包，含 signaling 的 e2e（会起真实 Pion 客户端）
```

其中 `signaling/e2e_datachannel_test.go` 断言数据通道的双向中继——**这条测试曾经证明过我的判断是错的**
（我以为反向通道不可用，改了 `SendData`，测试立刻变红）。保留它是为了让下一个人不要再"修"一遍。
