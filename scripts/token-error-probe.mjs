import { chromium } from 'playwright-core'
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1200, height: 800 } })
const p = await ctx.newPage()
await p.goto('https://localhost:5174/', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(2500)
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill('tokerr-room'); await inputs[1].fill('令牌失败验证')
await p.click('form button[type=submit]')
await p.waitForTimeout(5000)
const text = await p.evaluate(() => document.body.innerText)
// 断言真正重要的两件事：
//  1. 用户能看到**明确原因**（以前是静默当成"无需令牌"，什么都看不到）；
//  2. 连接**没有建立**（房间停在"待连接/0 人在线"）——安全上这是关键，
//     令牌拿不到就不该进入房间的媒体。
// 至于"界面此刻停在会前页还是会中框架"，当前仍会切到会中框架（房间显示待连接）：
// 彻底修需要重构 App 的入会流转，属于"正式登录后签令牌流程"那件事，不在这里草率改。
const showsError = /获取访问令牌失败|无法连接令牌服务|令牌服务返回|401/.test(text)
const notConnected = /待连接|0 人在线/.test(text)
console.log('  显示明确错误:', showsError)
console.log('  未建立连接（房间待连接/0 人）:', notConnected)
const m = text.match(/(获取访问令牌失败[^\n]*|无法连接令牌服务[^\n]*|令牌服务返回[^\n]*)/)
console.log('  错误文案:', m ? m[0].slice(0, 120) : '(未找到)')
await p.screenshot({ path: '/tmp/uishot/21-token-error.png' })
await b.close()
process.exit(showsError && notConnected ? 0 : 1)
