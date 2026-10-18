/**
 * 录制授权（评审 P0-2）的端到端验证。
 *
 * 旧行为：录制列表与下载**只认 X-API-Key**——主持人录完了自己也看不到、下不了。
 * 新行为分三层：运维密钥 / 管理员（全部）、普通用户（只看自己创建的会议）。
 *
 * 这个探针必须是**三个真实账号 + 真实录一段**，因为要证明的正是"按房间归属"——
 * 空库、假数据都证明不了任何东西。
 *
 * 运行前提：后端以 APP_ENV=production、AUTH_MODE=required、RECORD_ENABLED=true 启动，
 * 且数据库里已注册 alice / bob / admin 三个账号（口令见下方常量）。
 */
import { chromium } from 'playwright-core'

const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const API = process.env.PROBE_API ?? 'http://127.0.0.1:18081'
const ACCOUNTS = {
  host: { user: 'alice', pass: 'AlicePass123!' },
  member: { user: 'bob', pass: 'BobPass12345!' },
  admin: { user: 'admin', pass: 'AdminPass123!' },
}
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const login = async ({ user, pass }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 860 } })
  const p = await ctx.newPage()
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(3000)
  await p.locator('input[autocomplete="username"]').fill(user)
  await p.locator('input[type="password"]').fill(pass)
  await p.locator('form button[type=submit]').first().click()
  await p.waitForTimeout(4000)
  return p
}
const api = (p, path) => p.evaluate(async (path) => {
  const r = await fetch(path, { credentials: 'include' })
  let body = null
  try { body = await r.json() } catch { /* 可能是二进制或空 */ }
  return { status: r.status, body }
}, path)
const download = (p, path) => p.evaluate(async (path) => {
  const r = await fetch(path, { credentials: 'include' })
  const buf = await r.arrayBuffer()
  return { status: r.status, bytes: buf.byteLength }
}, path)

// 主持人在自己创建的会议里录一段
const host = await login(ACCOUNTS.host)
await host.locator('button', { hasText: '创建会议' }).first().click()
await host.waitForTimeout(7000)
const roomId = ((await host.evaluate(() => document.body.innerText)).match(/\b[A-Z0-9]{8}\b/) ?? [''])[0]
check('主持人进入自己创建的会议', /离开/.test(await host.evaluate(() => document.body.innerText)), `room=${roomId}`)
await host.locator('button', { hasText: '录制' }).first().click()
await host.waitForTimeout(6000)
await host.locator('button', { hasText: /录制/ }).first().click()
await host.waitForTimeout(3000)

// ① 主持人：能看到、能下载自己会议的录制
let r = await api(host, '/recordings')
const sessions = r.body?.sessions ?? []
const mine = sessions.filter((s) => s.roomId === roomId)
check('主持人能拉到录制列表', r.status === 200 && r.body?.enabled === true, `HTTP ${r.status}`)
check('列表包含自己会议的录制会话', mine.length > 0, `共 ${sessions.length} 条，本会议 ${mine.length} 条`)
check('普通用户视角不返回服务端目录（dir）', r.body?.dir === undefined)
const file = mine[0]?.files?.[0]
if (file) {
  const dl = await download(host, `/recordings/${encodeURIComponent(mine[0].id)}/${encodeURIComponent(file.name)}`)
  check('主持人能下载自己会议的录制文件', dl.status === 200 && dl.bytes > 0, `HTTP ${dl.status}，${dl.bytes} 字节`)
} else {
  check('主持人能下载自己会议的录制文件', false, '没有文件可下（录制可能未产生帧）')
}

// ② 普通成员：看不到、也下不了别人的会议
const member = await login(ACCOUNTS.member)
r = await api(member, '/recordings')
check('普通成员能登录并拉到列表', r.status === 200)
check('普通成员看不到别人会议的录制', (r.body?.sessions ?? []).every((s) => s.roomId !== roomId), `共 ${(r.body?.sessions ?? []).length} 条`)
if (file) {
  const denied = await download(member, `/recordings/${encodeURIComponent(mine[0].id)}/${encodeURIComponent(file.name)}`)
  check('普通成员下载别人会议录制被拒（403）', denied.status === 403, `HTTP ${denied.status}`)
}

// ③ 管理员：全部可见（含 dir）
const admin = await login(ACCOUNTS.admin)
r = await api(admin, '/recordings')
check('管理员能看到全部（含 dir）',
  r.status === 200 && r.body?.dir !== undefined && (r.body?.sessions ?? []).some((s) => s.roomId === roomId),
  `共 ${(r.body?.sessions ?? []).length} 条，dir=${r.body?.dir ? '有' : '无'}`)

// ④ 未登录：401
const anon = await browser.newContext({ ignoreHTTPSErrors: true })
const anonPage = await anon.newPage()
await anonPage.goto(URL, { waitUntil: 'domcontentloaded' })
const anonList = await api(anonPage, '/recordings')
check('未登录访问录制列表被拒（401）', anonList.status === 401, `HTTP ${anonList.status}`)

await browser.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 录制授权（P0-2）：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
