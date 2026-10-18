/**
 * AI 会议总结：验证前端发的 ai_summary 消息能被后端识别（评审前的自检）。
 *
 * 这里**不验证**总结质量——那需要 DEEPSEEK_API_KEY 与本地 whisper 模型。
 * 要验证的是：消息类型不再被当成"未知"。
 *   · 若配置齐全 → 面板启动，出现"运行中"
 *   · 若配置缺失 → 服务端返回**明确的**配置提示（如"需要 DEEPSEEK_API_KEY"）
 * 两者的共同点是：都不再是 "未知消息类型: ai_summary"。
 */
import { chromium } from 'playwright-core'

const URL = process.env.PROBE_URL ?? 'https://localhost:5175'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 860 } })).newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
await page.locator('input[autocomplete="username"]').fill(process.env.PROBE_USER ?? 'alice')
await page.locator('input[type="password"]').fill(process.env.PROBE_PASS ?? 'AlicePass123!')
await page.locator('form button[type=submit]').first().click()
await page.waitForTimeout(4000)
await page.locator('button', { hasText: '创建会议' }).first().click()
await page.waitForTimeout(7000)

const inMeeting = /离开/.test(await page.evaluate(() => document.body.innerText))
check('进入会议', inMeeting)
const aiBtn = page.locator('button', { hasText: 'AI 总结' }).first()
check('工具栏有「AI 总结」入口', (await aiBtn.count()) > 0)
await aiBtn.click()
await page.waitForTimeout(4000)
const text = await page.evaluate(() => document.body.innerText)

// 关键断言：不再是"未知消息类型"
check('【关键】后端不再报"未知消息类型: ai_summary"', !/未知消息类型/.test(text),
  (text.match(/未知消息类型[^\n]*/) ?? [''])[0])
const started = /运行中|AI 总结中|纪要/.test(text)
const configMissing = /DEEPSEEK_API_KEY|WHISPER_MODEL_PATH|OPENAI_API_KEY|未就绪|需要/.test(text)
check('后端识别了该类型：要么启动成功，要么给出明确的配置提示',
  started || configMissing,
  started ? '面板显示运行中/纪要' : (text.match(/(启动 AI 总结失败[^\n]*|需要 [A-Z_]+[^\n]*)/) ?? [''])[0])
check('错误信息是可理解的（不是 bad_request 原始码）', !/bad_request:/.test(text),
  (text.match(/bad_request[^\n]*/) ?? [''])[0])

await page.screenshot({ path: '/tmp/uishot/38-ai-summary.png' })
await browser.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== AI 总结消息类型：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
