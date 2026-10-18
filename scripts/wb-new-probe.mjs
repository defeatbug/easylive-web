/**
 * 针对 PR #2（撤销按绘制者归属）与 PR #6（白板缩放/平移）的聚焦验证。
 *
 * 两个参与者**必须是不同账号**：单选登录下同账号两处会被踢，
 * 而且必须各有独立 context（Cookie 不共享）。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const launch = () => chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--ignore-certificate-errors','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] })
const bA = await launch(), bB = await launch()
const open = async (b, user, pass, url = URL) => {
  const p = await (await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1280, height: 860 } })).newPage()
  p.on('dialog', (d) => d.accept())
  await p.goto(url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
  await p.locator('input[autocomplete="username"]').fill(user)
  await p.locator('input[type="password"]').fill(pass)
  await p.locator('form button[type=submit]').first().click(); await p.waitForTimeout(4000)
  return p
}
const openBoard = async (p) => { await p.locator('button', { hasText: '白板' }).first().click(); await p.waitForTimeout(800) }
const strokes = (p) => p.evaluate(() => window.__easyliveDebugSnapshot?.()?.whiteboardStrokes ?? -1)
const footerBy = async (p) => (await p.evaluate(() => document.body.innerText)).match(/最后一位绘制者：\s*(\S+)/)?.[1] ?? ''
const draw = async (p, from, to) => {
  await p.mouse.move(from[0], from[1]); await p.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await p.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6)
    await p.waitForTimeout(25)
  }
  await p.mouse.up(); await p.waitForTimeout(700)
}

const A = await open(bA, 'alice', 'AlicePass123!')
await A.locator('button', { hasText: '创建会议' }).first().click(); await A.waitForTimeout(7000)
const code = ((await A.evaluate(() => document.body.innerText)).match(/\b[A-Z0-9]{8}\b/) ?? [''])[0]
const B = await open(bB, 'bob', 'BobPass12345!', `${URL}/?room=${code}`)
await B.locator('form button[type=submit]').first().click(); await B.waitForTimeout(7000)
check('两人在同一会议', /离开/.test(await B.evaluate(() => document.body.innerText)), `code=${code}`)

// ---------- ① 撤销按绘制者归属 ----------
await openBoard(A); await A.waitForTimeout(500)
await draw(A, [420, 300], [760, 420])
check('A 画一笔后笔数=1', (await strokes(A)) === 1, `笔数=${await strokes(A)}`)
await openBoard(B); await B.waitForTimeout(500)
await draw(B, [420, 560], [760, 680])
check('B 画一笔后两人都看到 2 笔', (await strokes(A)) === 2 && (await strokes(B)) === 2, `A=${await strokes(A)} B=${await strokes(B)}`)
await B.waitForTimeout(400)
// A 点撤销：只能撤掉 A 自己的那一笔，B 的必须留下
await A.locator('button', { hasText: '撤销' }).first().click()
await A.waitForTimeout(900); await B.waitForTimeout(900)
check('A 撤销后只剩 1 笔', (await strokes(A)) === 1 && (await strokes(B)) === 1, `A=${await strokes(A)} B=${await strokes(B)}`)
// 从 **A 的视角**看：剩下那一笔应当是 B 的（显示对方的名字）；
// 在 B 自己的页面上它显示"我"——那是正确行为，不能拿它当反例
check('【关键】留下的那一笔是 B 的（撤销没有误删别人的）', (await footerBy(A)).includes('鲍勃'),
  `A 看到最后绘制者=${await footerBy(A)} / B 自己看到=${await footerBy(B)}`)
await A.screenshot({ path: '/tmp/uishot/35-wb-undo.png' })

// ---------- ② 缩放 ----------
const pct = async (p) => (await p.locator('button[title="重置为 100%"]').innerText()).trim()
check('初始缩放 100%', (await pct(A)) === '100%', await pct(A))
await A.locator('button[title="放大"]').click(); await A.waitForTimeout(300)
check('点放大 → 125%', (await pct(A)) === '125%', await pct(A))
await A.locator('button[title="缩小"]').click(); await A.locator('button[title="缩小"]').click(); await A.waitForTimeout(300)
check('点两次缩小 → 80%', (await pct(A)) === '80%', await pct(A))
await A.locator('button[title="重置为 100%"]').click(); await A.waitForTimeout(300)
check('点百分比重置回 100%', (await pct(A)) === '100%', await pct(A))
// 缩放后仍能画（坐标变换没坏）
await draw(A, [500, 400], [800, 500])
check('缩放后仍能正常绘制（笔数 +1）', (await strokes(A)) === 2, `笔数=${await strokes(A)}`)
check('缩放是本地视图，不影响对方（B 仍是 100%）', (await pct(B)) === '100%', `B=${await pct(B)}`)
await A.screenshot({ path: '/tmp/uishot/36-wb-zoom.png' })

await bA.close(); await bB.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 白板新行为（撤销归属/缩放）：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
