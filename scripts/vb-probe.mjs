import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
const mediapipeReqs = []
p.on('request', (r) => { const u = r.url(); if (u.includes('/mediapipe/')) mediapipeReqs.push(u) })
const consoleErrors = []
const badStatus = []
p.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/token')) badStatus.push(`${r.status()} ${r.url().split('/').slice(-1)[0] || r.url()}`) })
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })

const results = []
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(2500)
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill('vb-room'); await inputs[1].fill('特效验证')
await p.click('form button[type=submit]')
await p.waitForTimeout(5000)
check('已进入会中页', (await p.locator('button', { hasText: '离开' }).count()) > 0)

// 打开"特效"菜单并启用背景虚化
const fx = p.locator('button', { hasText: '特效' }).first()
check('工具栏出现"特效"入口（AI 功能）', (await fx.count()) > 0)
await fx.click(); await p.waitForTimeout(400)
await p.screenshot({ path: '/tmp/uishot/5-fx-menu.png' })
const blur = p.locator('button', { hasText: '背景虚化' }).first()
check('特效菜单里有"背景虚化"', (await blur.count()) > 0)
await blur.click()

// 等模型 + wasm 加载完成（懒加载 13MB，给足时间）
let ok = false
for (let i = 0; i < 60; i++) {
  const snap = await p.evaluate(() => (window.__easyliveDebugSnapshot?.() ?? null))
  if (snap && snap.virtualBackground === 'blur') { ok = true; break }
  await p.waitForTimeout(1000)
}
check('虚拟背景已启用（状态变为 blur）', ok)
check('模型/wasm 从本站加载（不是外部 CDN）', mediapipeReqs.length > 0 && mediapipeReqs.every((u) => u.startsWith(URL) || u.includes('localhost:5174')),
  `${mediapipeReqs.length} 个请求，例：${mediapipeReqs.filter(u => u.endsWith('.wasm') || u.endsWith('.tflite')).slice(0,2).map(u => u.split('/').slice(-1)[0]).join(', ')}`)
const wasm = mediapipeReqs.find((u) => u.endsWith('.wasm'))
const model = mediapipeReqs.find((u) => u.endsWith('.tflite'))
check('确实加载了 wasm 运行时', !!wasm, wasm ? wasm.split('/').slice(-1)[0] : '未加载')
check('确实加载了分割模型', !!model, model ? model.split('/').slice(-1)[0] : '未加载')

// 画面仍在走（本地瓦片有画面）+ 没有报错横幅
await p.waitForTimeout(2500)
const state = await p.evaluate(() => {
  const v = document.querySelector('video')
  return { w: v?.videoWidth ?? 0, hasError: !!document.body.innerText.match(/虚拟背景启用失败|无法访问/) }
})
check('开启后本机画面仍在播放', state.w > 0, `videoWidth=${state.w}`)
check('没有出现失败提示', state.hasError === false)
check('没有 4xx/5xx 资源请求', badStatus.length === 0, badStatus.slice(0,3).join(' | ') || '无')
await p.screenshot({ path: '/tmp/uishot/6-vb-on.png' })

// ---- 弹层互斥回归：点开另一个浮层时，前一个必须自动关闭 ----
const countMenus = () => p.$$eval('.tm-menu', (els) => els.filter((e) => e.getBoundingClientRect().height > 0).length)
const moreBtn = p.locator('button', { hasText: '更多' }).first()
const emojiBtn = p.locator('button', { hasText: '表情' }).first()
await emojiBtn.click(); await p.waitForTimeout(350)
const afterEmoji = await countMenus()
await moreBtn.click(); await p.waitForTimeout(350)
const afterMore = await countMenus()
check('打开表情浮层时只有一个浮层', afterEmoji === 1, `可见浮层=${afterEmoji}`)
check('再点"更多"时表情浮层已自动关闭（不再互相覆盖）', afterMore === 1, `可见浮层=${afterMore}`)
// 点空白处应关闭
await p.mouse.click(700, 400); await p.waitForTimeout(350)
const afterOutside = await countMenus()
check('点击空白处浮层关闭', afterOutside === 0, `可见浮层=${afterOutside}`)
// 特效浮层里不应该再有"纯色背景"
const fxBtn2 = p.locator('button', { hasText: /特效|已开启/ }).first()
await fxBtn2.click(); await p.waitForTimeout(350)
const fxItems = await p.$$eval('.tm-menu', (els) => els.map((e) => e.innerText).join('|'))
check('特效菜单只剩"关闭/背景虚化"（纯色已移除）', fxItems.includes('背景虚化') && !fxItems.includes('纯色'), fxItems.replace(/\s+/g, ' ').slice(0, 40))
await p.mouse.click(700, 400); await p.waitForTimeout(250)

// 关掉特效，确认能恢复
const fxOn = p.locator('button', { hasText: '已开启' }).first()
if (await fxOn.count()) {
  await fxOn.click(); await p.waitForTimeout(400)
  await p.locator('button', { hasText: '关闭' }).first().click()
  await p.waitForTimeout(1500)
  const off = await p.evaluate(() => (window.__easyliveDebugSnapshot?.() ?? null))
  check('可以关闭并恢复原画面', off?.virtualBackground === 'off', `当前=${off?.virtualBackground}`)
  // 回归：关闭特效后必须**仍能看到摄像头画面**。
  // 真人实测踩过：就地在同一个 MediaStream 上增删轨，<video> 不会重新绑定，
  // 结果画面停在已停止的画布轨上 = 一直黑屏。这里把"关闭后还有画面"钉死。
  let after = { w: 0, fromCanvas: true }
  for (let i = 0; i < 25; i++) {
    after = await p.evaluate(() => {
      const snap = window.__easyliveDebugSnapshot?.() ?? {}
      const v = document.querySelector('video')
      return { w: v?.videoWidth ?? 0, fromCanvas: !!snap.localVideoFromCanvas }
    })
    if (after.w > 0 && !after.fromCanvas) break
    await p.waitForTimeout(400)
  }
  check('关闭特效后摄像头画面恢复（不再黑屏）', after.w > 0 && !after.fromCanvas,
    `videoWidth=${after.w} 仍为画布轨=${after.fromCanvas}`)
}
await b.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 虚拟背景验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
