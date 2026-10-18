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
  p.on('dialog', (d) => d.accept()) // 清空白板会弹 confirm：不处理会把流程卡住
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
// 差分测试：B 连按两次撤销——
//   正确实现：第 1 次删 B 自己那笔（1 笔），第 2 次 B 已无可撤销 → 被拒绝（仍是 1 笔）；
//   旧实现（盲删最后一笔）：第 2 次会把 A 那笔也删掉 → 变成 0 笔。
await B.locator('button', { hasText: '撤销' }).first().click()
await A.waitForTimeout(700); await B.waitForTimeout(700)
check('B 撤销一次后剩 1 笔（撤的是自己的）', (await strokes(A)) === 1 && (await strokes(B)) === 1, `A=${await strokes(A)} B=${await strokes(B)}`)
await B.locator('button', { hasText: '撤销' }).first().click()
await A.waitForTimeout(700); await B.waitForTimeout(700)
check('【关键】B 再撤销一次被拒绝，笔数仍是 1（A 的笔画被保住；盲删实现会变 0）',
  (await strokes(A)) === 1 && (await strokes(B)) === 1, `A=${await strokes(A)} B=${await strokes(B)}`)
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
// 缩放后仍能画（坐标变换没坏）：用相对断言，避免依赖前面累计的笔数
const beforeDraw = await strokes(A)
await draw(A, [500, 400], [800, 500])
check('缩放后仍能正常绘制（笔数 +1）', (await strokes(A)) === beforeDraw + 1, `${beforeDraw} → ${await strokes(A)}`)
check('缩放是本地视图，不影响对方（B 仍是 100%）', (await pct(B)) === '100%', `B=${await pct(B)}`)
await A.screenshot({ path: '/tmp/uishot/36-wb-zoom.png' })

// ---------- ③ 迟到者从入会快照恢复白板（原来由旧探针覆盖）----------
await B.reload({ waitUntil: 'domcontentloaded' })
// 刷新后应用会**自动回到会议**（sessionStorage 里存了入会信息），不需要再点"加入会议"
await B.waitForTimeout(9000)
check('刷新后自动回到会议', /离开/.test(await B.evaluate(() => document.body.innerText)))
await openBoard(B)
const beforeReload = await strokes(A)
check('迟到加入（刷新重进）后能看到已有笔迹', (await strokes(B)) === beforeReload, `刷新前 ${beforeReload} / 刷新后 B=${await strokes(B)}`)

// ---------- ④ 清空对所有人一致（原来由旧探针覆盖）----------
await A.locator('button', { hasText: '清空' }).first().click() // confirm 由上面的 dialog 处理器接受
await A.waitForTimeout(1500); await B.waitForTimeout(1500)
check('清空后双方都看到 0 笔', (await strokes(A)) === 0 && (await strokes(B)) === 0, `A=${await strokes(A)} B=${await strokes(B)}`)

await bA.close(); await bB.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 白板新行为（撤销归属/缩放）：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
