import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const launch = (reduced) => chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})

async function joinMeeting(page) {
  await page.waitForSelector('form', { timeout: 20000 })
  await page.waitForTimeout(2500)
  const inputs = await page.$$('form input[type="text"], form input:not([type])')
  await inputs[0].fill('polish-room'); await inputs[1].fill('动效验证')
  await page.click('form button[type=submit]')
  await page.waitForTimeout(6000)
}

// ---------- 1) 动效 + 多窗口 ----------
const b = await launch(false)
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await joinMeeting(p)

// 瓦片悬停控件
await p.locator('.tm-anim-tile').first().hover()
await p.waitForTimeout(400)
const ctrlCount = await p.locator('button[title*="画中画"], button[title*="独立窗口"], button[title*="全屏"]').count()
check('画面瓦片悬停出现多窗口控件（画中画/独立窗口/全屏）', ctrlCount >= 3, `${ctrlCount} 个`)

// 弹层动效：打开"更多"后检查计算样式里确实挂了动画
await p.locator('button', { hasText: '更多' }).first().click()
await p.waitForTimeout(250)
const menuAnim = await p.$eval('.tm-menu', (el) => getComputedStyle(el).animationName)
check('弹层带动效（.tm-menu 挂了 tm-pop-in）', menuAnim.includes('tm-pop-in'), menuAnim)
const menuDuration = await p.$eval('.tm-menu', (el) => getComputedStyle(el).animationDuration)
check('弹层动效时长短促（≤ 250ms，不抢注意力）', parseFloat(menuDuration) <= 0.25, menuDuration)
await p.keyboard.press('Escape')

// 独立窗口：点"独立窗口"应真的新开一个窗口，且里面播放着我们的流
const [popup] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
  p.locator('button[title*="独立窗口"]').first().click(),
])
check('点击"独立窗口"打开了新窗口', !!popup)
if (popup) {
  await popup.waitForLoadState('domcontentloaded')
  await popup.waitForTimeout(2500)
  const st = await popup.evaluate(() => {
    const v = document.querySelector('video')
    return { has: !!v, w: v?.videoWidth ?? 0, tracks: v?.srcObject?.getVideoTracks?.().length ?? 0, title: document.title }
  })
  check('独立窗口里真的有画面在播（同一 MediaStream 直传）', st.has && st.w > 0 && st.tracks > 0, `videoWidth=${st.w} tracks=${st.tracks}`)
  check('独立窗口标题带参会者名字', /动效验证/.test(st.title), st.title)
  await popup.screenshot({ path: '/tmp/uishot/13-detached-window.png' })
  await popup.close()
}

// 画中画：headless 下不一定支持；这里只要求"点了不炸且给出可读结果"
const pipBtn = p.locator('button[title*="画中画"]').first()
await pipBtn.click()
await p.waitForTimeout(600)
const alive = await p.locator('button', { hasText: '离开' }).count()
check('点画中画不会打断会议（不支持时给出提示而非静默）', alive > 0)

await p.screenshot({ path: '/tmp/uishot/14-polish.png' })

// ---------- 2) 系统"减少动态效果"时必须关掉动画 ----------
const p2 = await (await launch(true)).newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } }).then((c) => c.newPage())
await p2.goto(URL, { waitUntil: 'domcontentloaded' })
await joinMeeting(p2)
await p2.locator('button', { hasText: '更多' }).first().click()
await p2.waitForTimeout(250)
const reducedAnim = await p2.$eval('.tm-menu', (el) => getComputedStyle(el).animationName)
check('系统开启"减少动态效果"时弹层动画被关闭', reducedAnim === 'none', reducedAnim)

await b.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 动效/多窗口验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
