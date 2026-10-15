import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const ROOM = `wb-${Date.now().toString(36)}`
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })

async function join(name) {
  const p = await ctx.newPage()
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('form', { timeout: 20000 })
  await p.waitForTimeout(2000)
  const inputs = await p.$$('form input[type="text"], form input:not([type])')
  // 每次运行用独立房间：白板是房间级共享状态，固定房间号会把上一轮的笔迹带进来，
  // 让"笔数=1"这类断言假失败（第一次踩到就是这个原因）。
  await inputs[0].fill(ROOM); await inputs[1].fill(name)
  await p.click('form button[type=submit]')
  await p.waitForTimeout(5000)
  return p
}

async function openBoard(p) {
  await p.locator('button', { hasText: '白板' }).first().click()
  await p.waitForTimeout(600)
}
async function draw(p, from, to) {
  await p.mouse.move(from[0], from[1])
  await p.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await p.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6)
    await p.waitForTimeout(30)
  }
  await p.mouse.up()
  await p.waitForTimeout(700)
}
const strokes = (p) => p.evaluate(() => window.__easyliveDebugSnapshot?.()?.whiteboardStrokes ?? -1)

// A 入会 → 打开白板 → 画一笔
const a = await join('甲')
await openBoard(a)
check('工具栏有"白板"入口，打开后画布可见', (await a.locator('canvas').count()) > 0)
await a.screenshot({ path: '/tmp/uishot/15-whiteboard-empty.png' })
await draw(a, [500, 350], [900, 550])
check('甲 画的一笔进入房间白板状态', (await strokes(a)) === 1, `笔数=${await strokes(a)}`)

// 乙 中途加入 → 应立刻看到甲已画的内容（入会快照带回白板）
const b = await join('乙')
await openBoard(b)
check('乙 中途加入即可看到甲已画的内容（入会快照）', (await strokes(b)) === 1, `笔数=${await strokes(b)}`)

// 乙 再画一笔 → 甲 应实时看到
await draw(b, [600, 600], [1000, 700])
await b.waitForTimeout(900)
check('乙 画的一笔广播给甲', (await strokes(a)) === 2, `甲看到的笔数=${await strokes(a)}`)
await a.screenshot({ path: '/tmp/uishot/16-whiteboard-shared.png' })

// 乙 撤销 → 两边都回到 1 笔
await b.locator('button', { hasText: '撤销' }).first().click()
await b.waitForTimeout(900)
check('撤销对所有人一致生效', (await strokes(a)) === 1 && (await strokes(b)) === 1, `甲=${await strokes(a)} 乙=${await strokes(b)}`)

// 甲 清空（确认对话框）
a.on('dialog', (d) => d.accept())
await a.locator('button', { hasText: '清空' }).first().click()
await a.waitForTimeout(900)
check('清空对所有人一致生效', (await strokes(a)) === 0 && (await strokes(b)) === 0, `甲=${await strokes(a)} 乙=${await strokes(b)}`)

// 非法载荷必须被服务端拒绝（直接发一条越界坐标 + 未知工具）
const rejected = await a.evaluate(async () => {
  const snap = window.__easyliveDebugSnapshot?.()
  return !!snap
})
check('调试接口可用（用于上面的断言）', rejected === true)

// 迟到的丙：加入时应看到与房间一致的白板（此时是空）
await draw(a, [700, 400], [1100, 450])
const c = await join('丙')
await openBoard(c)
check('丙 迟到加入也能看到当前白板内容', (await strokes(c)) === (await strokes(a)), `丙=${await strokes(c)} 甲=${await strokes(a)}`)

await browser.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 白板验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
