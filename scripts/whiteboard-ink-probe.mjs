/**
 * 白板"笔画不丢"回归探针。
 *
 * 为什么单独一个探针而不是并进 whiteboard-probe：它需要在**回声未到的窗口内**检查画布，
 * 靠开发环境的延迟钩子（window.__easyliveWhiteboardDelay）把服务端回声拖慢 900ms，
 * 才能稳定复现"上一笔还在待确认时画下一笔"这条真实网络下必现、回环下必不现的路径。
 *
 * 红-绿对照（旧行为 = pending 只存一笔）：
 *   旧：回声未到  0 / 0 / 1722   ← 前两笔从画布上消失（用户报的就是这个）
 *   新：回声未到  1744 / 1752 / 1722
 */
import { chromium } from 'playwright-core'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
await p.goto('https://localhost:5174/', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(2000)
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill(`ink-${Date.now().toString(36)}`); await inputs[1].fill('墨迹复现')
await p.click('form button[type=submit]')
await p.waitForTimeout(5000)
await p.locator('button', { hasText: '白板' }).first().click()
await p.waitForTimeout(700)
// 让服务端回声慢 900ms：复现真实网络下"上一笔仍在待确认"的窗口
await p.evaluate(() => { window.__easyliveWhiteboardDelay = 900 })

// 画布上"有墨迹"的像素数（alpha > 20）
const ink = () => p.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return -1
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++
  return n
})
const ops = () => p.evaluate(() => window.__easyliveDebugSnapshot?.()?.whiteboardStrokes ?? -1)

async function draw(x1, y1, x2, y2, settle = 900) {
  await p.mouse.move(x1, y1); await p.mouse.down()
  for (let i = 1; i <= 8; i++) { await p.mouse.move(x1 + (x2-x1)*i/8, y1 + (y2-y1)*i/8); await p.waitForTimeout(25) }
  await p.mouse.up(); await p.waitForTimeout(settle)
}

// 分区域检查：三笔画在互不重叠的区域，各自都必须有墨迹。
// （只比"总墨迹翻倍"是不可靠的：笔画会重叠、长度也不同，计数不等于渲染正确。）
const inkIn = (x1, y1, x2, y2) =>
  p.evaluate(([a, b, c, d]) => {
    const cv = document.querySelector('canvas')
    const r = cv.getBoundingClientRect()
    const sx = cv.width / r.width
    const sy = cv.height / r.height
    const x = Math.max(0, Math.round((a - r.left) * sx))
    const y = Math.max(0, Math.round((b - r.top) * sy))
    const w = Math.max(1, Math.round((c - a) * sx))
    const h = Math.max(1, Math.round((d - b) * sy))
    const px = cv.getContext('2d').getImageData(x, y, w, h).data
    let n = 0
    for (let i = 3; i < px.length; i += 4) if (px[i] > 20) n++
    return n
  }, [x1, y1, x2, y2])

const regions = [
  [300, 250, 700, 320],
  [800, 250, 1200, 320],
  [300, 500, 700, 570],
]
console.log('  开始前 墨迹=%d 笔数=%d', await ink(), await ops())

// 连续三笔，每笔之间**不等回声**（回声被延迟 900ms）
await draw(320, 270, 680, 300, 0)
await draw(820, 270, 1180, 300, 0)
await draw(320, 520, 680, 550, 0)

// 关键：在"回声还没回来"的窗口内立即检查——上一笔此刻完全依赖本地待确认渲染。
// （等 2 秒再查是抓不到的：回声到了以后服务端内容会把它补齐，丢失只是暂时的。）
const during = []
for (const r of regions) during.push(await inkIn(...r))
console.log('  回声未到时的区域墨迹: %s', during.join(' / '))

await p.waitForTimeout(2500)
const after = []
for (const r of regions) after.push(await inkIn(...r))
console.log('  回声到齐后的区域墨迹: %s   笔数=%d', after.join(' / '), await ops())

const okDuring = during.every((n) => n > 50)
const okAfter = after.every((n) => n > 50)
console.log(okDuring ? '  → ✅ 待确认期间三笔都在（不会因下一笔而消失）' : '  → ❌ 待确认期间有笔画消失（pending 被覆盖）')
console.log(okAfter ? '  → ✅ 回声到齐后三笔都在' : '  → ❌ 回声到齐后仍有缺失')
// ---- 抽稀：上报的点数必须明显少于指针采样次数（否则"变宽墨迹"的平滑度也上不去）----
await p.evaluate(() => { window.__easyliveWhiteboardDelay = 0; window.__easyliveWhiteboardLastStroke = undefined })
await p.mouse.move(350, 750)
await p.mouse.down()
const moves = []
for (let i = 0; i <= 40; i++) {
  // 画一条带抖动的曲线，模拟真实手写（每个采样点都略有偏移）
  moves.push([350 + i * 12, 750 + Math.sin(i / 3) * 25])
}
for (const [x, y] of moves) { await p.mouse.move(x, y); await p.waitForTimeout(12) }
await p.mouse.up()
await p.waitForTimeout(900)
const sent = await p.evaluate(() => window.__easyliveWhiteboardLastStroke ?? -1)
console.log('  指针采样 %d 次 → 上报 %d 个点', moves.length + 1, sent)
check('上报前做了抽稀（点数明显少于采样次数）', sent > 1 && sent < (moves.length + 1) * 0.7, `上报 ${sent} 点`)

await p.screenshot({ path: '/tmp/uishot/18-ink-after-fix.png' })
await b.close()
const passed = results.filter(([ok]) => ok).length
console.log(`\n=== 白板笔迹/抽稀验证：${passed}/${results.length} 通过 ===`)
process.exit(okDuring && okAfter && passed === results.length ? 0 : 1)
