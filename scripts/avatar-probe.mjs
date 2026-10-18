/** 会议内显示真实头像：关闭摄像头时瓦片里应出现头像图片，且对方也能看到我的头像。 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const launch = () => chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--ignore-certificate-errors','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] })
const bA = await launch(), bB = await launch()
const open = async (b, user, pass, url = URL) => {
  const p = await (await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1280, height: 860 } })).newPage()
  await p.goto(url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
  await p.locator('input[autocomplete="username"]').fill(user)
  await p.locator('input[type="password"]').fill(pass)
  await p.locator('form button[type=submit]').first().click(); await p.waitForTimeout(4000)
  return p
}
const avatarImgs = (p) => p.evaluate(() => [...document.querySelectorAll('.meeting-stage img')].map((i) => i.getAttribute('src') ?? '').filter((s) => s.includes('/auth/avatar/')))
const A = await open(bA, 'alice', 'AlicePass123!')
const me = await A.evaluate(async () => (await (await fetch('/auth/me', { credentials: 'include' })).json()).user)
check('alice 账号已设置头像（前置条件）', !!me?.avatarUrl, me?.avatarUrl ?? '无')
await A.locator('button', { hasText: '创建会议' }).first().click(); await A.waitForTimeout(7000)
const code = ((await A.evaluate(() => document.body.innerText)).match(/\b[A-Z0-9]{8}\b/) ?? [''])[0]
const B = await open(bB, 'bob', 'BobPass12345!', `${URL}/?room=${code}`)
await B.locator('form button[type=submit]').first().click(); await B.waitForTimeout(7000)
check('两人在同一会议', /离开/.test(await B.evaluate(() => document.body.innerText)), `code=${code}`)
check('摄像头开着时不显示头像图片（显示画面）', (await avatarImgs(A)).length === 0)

// 关掉摄像头 → 瓦片回落成头像
await A.locator('button[title*="关闭摄像头"]').first().click()
await A.waitForTimeout(2500)
const own = await avatarImgs(A)
check('关闭摄像头后自己的瓦片显示头像图片', own.length > 0, own[0] ?? '未出现')
await B.waitForTimeout(2500)
const peer = await avatarImgs(B)
check('【关键】对方也看到我的头像（服务端下发的 avatarUrl）', peer.length > 0, peer[0] ?? '未出现')
await A.screenshot({ path: '/tmp/uishot/37-avatar.png' })
await bA.close(); await bB.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 会议内头像：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
