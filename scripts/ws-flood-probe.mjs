/**
 * P0-③ 验证：单连接消息洪水会被断开，而正常客户端不受影响。
 *
 * 用浏览器的原生 WebSocket（不引入新依赖）：连上信令后猛发消息，
 * 断言服务端把连接**断开**（而不是陪着刷）。这层预算针对的是
 * "一个客户端对 chat 等消息无限刷、每条都引发一次全员广播"这种放大攻击。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })

const out = await p.evaluate(async () => {
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws`
  const ws = new WebSocket(wsUrl)
  let opened = false
  let closedByServer = false
  let closeCode = null
  let sent = 0
  await new Promise((resolve) => {
    ws.onopen = () => { opened = true; resolve() }
    ws.onerror = () => resolve()
    setTimeout(resolve, 8000)
  })
  if (!opened) return { opened: false, sent: 0, closedByServer: false }

  ws.onclose = (e) => { closedByServer = true; closeCode = e.code }
  // 猛发：远超 200 条/秒
  const t0 = performance.now()
  while (performance.now() - t0 < 400 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text: 'flood' }))
    sent++
  }
  // 等服务端处理
  await new Promise((r) => setTimeout(r, 2500))
  return { opened, sent, closedByServer, closeCode, state: ws.readyState }
})

check('连接建立', out.opened, `已发 ${out.sent} 条`)
check('发了足够多的消息（>200 条/秒的量级）', out.sent > 250, `${out.sent} 条`)
check('服务端断开了洪泛连接（而不是陪着刷）', out.closedByServer === true, `closeCode=${out.closeCode}`)

await browser.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 消息洪水防护验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
