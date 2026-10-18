/** 底部一行三块的布局验证：左中右、同高、不压视频、整体比之前矮。 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--ignore-certificate-errors','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] })
const p = await (await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1280, height: 800 } })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
await p.locator('input[autocomplete="username"]').fill('alice')
await p.locator('input[type="password"]').fill('AlicePass123!')
await p.locator('form button[type=submit]').first().click(); await p.waitForTimeout(4000)
await p.locator('button', { hasText: '创建会议' }).first().click(); await p.waitForTimeout(7000)

const box = async (sel) => await p.locator(sel).first().boundingBox()
const dock = await box('.reaction-dock')
const bar = await box('.meeting-toolbar-inner')
const leave = await p.locator('button', { hasText: '离开' }).first().boundingBox()
const stage = await box('.meeting-stage')
const tiles = await p.evaluate(() => {
  const els = [...document.querySelectorAll('.meeting-stage > div > *')]
  const vids = [...document.querySelectorAll('video')].map((v) => v.getBoundingClientRect())
  return vids.length ? Math.max(...vids.map((r) => r.bottom)) : null
})
check('三块都存在', !!dock && !!bar && !!leave)
check('三块在同一行（竖直方向中心基本重合）',
  !!dock && !!bar && !!leave && Math.abs((dock.y + dock.height / 2) - (bar.y + bar.height / 2)) < 3 &&
  Math.abs((leave.y + leave.height / 2) - (bar.y + bar.height / 2)) < 3,
  dock && bar && leave ? `dock.c=${Math.round(dock.y + dock.height / 2)} bar.c=${Math.round(bar.y + bar.height / 2)} leave.c=${Math.round(leave.y + leave.height / 2)}` : '')
check('三块高度一致（±1px）',
  !!dock && !!bar && !!leave && Math.abs(dock.height - bar.height) <= 1 && Math.abs(leave.height - bar.height) <= 1,
  dock && bar && leave ? `h=${Math.round(dock.height)}/${Math.round(bar.height)}/${Math.round(leave.height)}` : '')
check('位置是左中右',
  !!dock && !!bar && !!leave && dock.x < bar.x && leave.x > bar.x + bar.width - 1,
  dock && bar && leave ? `dock.x=${Math.round(dock.x)} bar=[${Math.round(bar.x)},${Math.round(bar.x + bar.width)}] leave.x=${Math.round(leave.x)}` : '')
check('导航条整体比改造前矮（≤60px）', !!bar && bar.height + 12 <= 60, bar ? `条高=${Math.round(bar.height)}px` : '')
check('不压在视频画面上（按钮组顶边在最后一排视频之下）',
  !!dock && tiles !== null && dock.y >= tiles - 2,
  dock && tiles !== null ? `dock.y=${Math.round(dock.y)} 视频底=${Math.round(tiles)}` : '取不到视频位置')

// 表情面板仍然向上弹出、且不被裁掉
await p.locator('.reaction-dock-btn').first().click(); await p.waitForTimeout(400)
const panel = await box('.reaction-dock-panel')
check('表情面板向上弹出且完整在视口内', !!panel && panel.y >= 0 && panel.y + panel.height <= 800, panel ? `panel.y=${Math.round(panel.y)}` : '')
await p.screenshot({ path: '/tmp/uishot/32-bottom-bar.png' })
await b.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 底部布局：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
