/**
 * 编码偏好 A/B 探针：加入会议发布一路摄像头，然后从服务端的 /metrics/tracks
 * 读出**实际协商到**的视频编码。编码这件事，协商结果才是真相，配置只是意图。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const API = process.env.PROBE_API ?? 'http://127.0.0.1:18081'
const EXPECT = process.env.EXPECT_CODEC ?? 'video/VP8'

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], viewport: { width: 1200, height: 800 } })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(2000)
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill(`codec-${Date.now().toString(36)}`); await inputs[1].fill('编码验证')
await p.click('form button[type=submit]')
await p.waitForTimeout(6000)

const data = await (await fetch(`${API}/metrics/tracks`)).json()
const video = (data.tracks ?? []).filter((t) => t.kind === 'video' && t.packets > 0)
const codecs = [...new Set(video.map((t) => t.codec))]
console.log(`  发布中的视频轨: ${video.length} 条，协商编码: ${JSON.stringify(codecs)}`)
const ok = codecs.length > 0 && codecs.every((c) => c === EXPECT)
console.log(ok ? `  ✅ 协商编码为 ${EXPECT}（符合预期）` : `  ❌ 期望 ${EXPECT}，实际 ${JSON.stringify(codecs)}`)

await b.close()
process.exit(ok ? 0 : 1)
