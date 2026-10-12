import { chromium } from 'playwright-core'
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
await p.goto('https://localhost:5174/', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(3500)              // 等预览出画面
await p.screenshot({ path: '/tmp/uishot/1-join.png' })
console.log('✓ 会前页已截图')
// 入会 → 会中页
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill('ui-demo'); await inputs[1].fill('张同学')
await p.click('form button[type=submit]')
await p.waitForTimeout(6000)
await p.screenshot({ path: '/tmp/uishot/2-meeting.png' })
console.log('✓ 会中页已截图')
// 打开成员面板 + 更多菜单，多截两张
const chatBtn = p.locator('button', { hasText: '聊天' }).first()
if (await chatBtn.count()) { await chatBtn.click(); await p.waitForTimeout(1200); await p.screenshot({ path: '/tmp/uishot/3-panel.png' }); console.log('✓ 侧栏已截图') }
const moreBtn = p.locator('button', { hasText: '更多' }).first()
if (await moreBtn.count()) { await moreBtn.click(); await p.waitForTimeout(600); await p.screenshot({ path: '/tmp/uishot/4-more.png' }); console.log('✓ 更多菜单已截图') }
await b.close()
