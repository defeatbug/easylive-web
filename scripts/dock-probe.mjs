/**
 * 左下角弹幕/互动 + 跨端送达 的端到端验证。
 *
 * 关键断言在**接收方**（B）的 DOM 上：发送方自己看到不算数，
 * 之前那版就是只断言了发送方，才让"对方收不到"漏了过去。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const launch = () => chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--ignore-certificate-errors','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] })
const bA = await launch(), bB = await launch()
const open = async (b, user, pass, url = URL) => {
  const p = await (await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1180, height: 800 } })).newPage()
  await p.goto(url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
  await p.locator('input[autocomplete="username"]').fill(user)
  await p.locator('input[type="password"]').fill(pass)
  await p.locator('form button[type=submit]').first().click(); await p.waitForTimeout(4000)
  return p
}
const A = await open(bA, 'alice', 'AlicePass123!')
await A.locator('button', { hasText: '创建会议' }).first().click(); await A.waitForTimeout(7000)
const code = ((await A.evaluate(() => document.body.innerText)).match(/\b[A-Z0-9]{8}\b/) ?? [''])[0]
const B = await open(bB, 'bob', 'BobPass12345!', `${URL}/?room=${code}`)
await B.locator('form button[type=submit]').first().click(); await B.waitForTimeout(7000)
check('两人在同一会议', /离开/.test(await B.evaluate(() => document.body.innerText)) && code.length === 8, `code=${code}`)

// ① 左下角独立按钮组
const dock = A.locator('.reaction-dock')
check('左下角有独立的弹幕/互动按钮组（不在底部导航条里）', await dock.count() > 0)
const dockBox = await dock.boundingBox()
const barBox = await A.locator('.meeting-toolbar-inner').boundingBox()
// 现在是"与导航条**同一行**"的左块（原来的断言是"在导航条上方"，已过时）
check('它在导航条同一行的左侧、且不与导航条重叠',
  !!dockBox && !!barBox &&
  Math.abs((dockBox.y + dockBox.height / 2) - (barBox.y + barBox.height / 2)) < 3 &&
  dockBox.x + dockBox.width <= barBox.x + 1,
  dockBox && barBox ? `dock=(x${Math.round(dockBox.x)},y${Math.round(dockBox.y)},h${Math.round(dockBox.height)}) bar=(x${Math.round(barBox.x)},y${Math.round(barBox.y)},h${Math.round(barBox.height)})` : '未取到')
check('两个按钮水平排列', (await A.locator('.reaction-dock-row .reaction-dock-btn').count()) === 2)

// ② 点表情 → 填进输入框（不直接发送）；输入框无 placeholder
await A.locator('.reaction-dock-btn').first().click(); await A.waitForTimeout(400)
check('点表情后输入框没有 placeholder', (await A.locator('.reaction-dock-input').getAttribute('placeholder')) === null)
await A.locator('.reaction-dock-emoji').first().click(); await A.waitForTimeout(300)
const draft = await A.locator('.reaction-dock-input').inputValue()
check('选中表情会填进输入框（而不是直接发出）', draft.length > 0, `输入框=${draft}`)
check('此时还没有任何弹幕/动效产生', (await A.locator('.action-pop').count()) === 0)

// 发一条弹幕
await A.locator('.reaction-dock-input').fill(draft + '大家好')
await A.locator('.reaction-dock-send').click(); await A.waitForTimeout(1200)
const aFlash = await A.locator('.danmaku-item').allInnerTexts()
check('发送方看到弹幕，格式为「我：内容」', aFlash.some((t) => /^我：/.test(t.trim())), aFlash.join(' | ').slice(0, 80))
await B.waitForTimeout(1500)
const bFlash = await B.locator('.danmaku-item').allInnerTexts()
check('【关键】接收方也看到同一条弹幕', bFlash.some((t) => t.includes('大家好')), bFlash.join(' | ').slice(0, 90))
check('接收方看到的是发送者名字而不是"我"', bFlash.every((t) => !t.trim().startsWith('我：')), bFlash.join(' | ').slice(0, 60))

// ③ 互动：随机位置 + 双方可见
await A.locator('.reaction-dock-btn').nth(1).click(); await A.waitForTimeout(700)
const aPos = await A.locator('.action-pop').evaluateAll((els) => els.map((e) => e.style.left))
check('发送方出现互动动效', aPos.length > 0, aPos.join(','))
await B.waitForTimeout(1500)
const bPos = await B.locator('.action-pop').evaluateAll((els) => els.map((e) => e.style.left))
check('【关键】接收方也看到互动动效', bPos.length > 0, bPos.join(','))
// 连发几次，位置应当出现差异（随机）
for (let i = 0; i < 4; i++) { await A.locator('.reaction-dock-btn').nth(1).click(); await A.waitForTimeout(250) }
const many = await A.locator('.action-pop').evaluateAll((els) => els.map((e) => e.style.left))
check('多朵花的横向位置是随机的', new Set(many).size > 1, `${new Set(many).size} 种位置 / ${many.length} 朵`)

// ④ 带文字的弹幕应当**同时出现在聊天里**（聊天是历史，弹幕是瞬时）
await A.locator('button', { hasText: '聊天' }).first().click()
await A.waitForTimeout(1200)
const chatText = await A.evaluate(() => document.body.innerText)
check('弹幕内容同时出现在聊天面板里', chatText.includes('大家好'), chatText.replace(/\s+/g, ' ').slice(-90))
await A.locator('button', { hasText: '聊天' }).first().click() // 关掉聊天面板

// 说明：左下角按钮组**总是**带文字发送（输入框里已经是选中的表情）→ 产生的是弹幕，
// 不会产生"纯表情浮层"。那个路径只由手机端「更多→表情」触发，桌面宽度下不可达，
// 所以这里不再断言它；它的居中样式已在 index.css/MeetingRoom 里改好并留了注释。

await A.screenshot({ path: '/tmp/uishot/31-dock.png' })
await bA.close(); await bB.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 弹幕/互动/跨端：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
