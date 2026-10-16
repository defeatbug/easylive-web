import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const API = process.env.PROBE_API ?? 'http://localhost:18081'
const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors','--autoplay-policy=no-user-gesture-required'],
})
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['camera','microphone'], viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
const results = []
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('form', { timeout: 20000 })
await p.waitForTimeout(2500)
const inputs = await p.$$('form input[type="text"], form input:not([type])')
await inputs[0].fill('rec-e2e-room'); await inputs[1].fill('录制验证')
// 勾选"以主持人身份加入"（录制需要 roomAdmin）
const adminBox = p.locator('form input[type="checkbox"]').first()
if (await adminBox.count()) await adminBox.check()
await p.click('form button[type=submit]')
await p.waitForTimeout(6000)
check('以主持人身份进入会中', (await p.locator('button', { hasText: '离开' }).count()) > 0)

const recordBtn = p.locator('button', { hasText: /^录制$/ }).first()
check('工具栏出现"录制"按钮（主持人可见）', (await recordBtn.count()) > 0)
await recordBtn.click()
await p.waitForTimeout(1500)
const indicator = await p.locator('text=录制中').count()
check('开始后全员可见"录制中"红点', indicator > 0, `匹配到 ${indicator} 处`)
await p.screenshot({ path: '/tmp/uishot/11-recording.png' })

// 让媒体跑一会儿，确保录到内容
await p.waitForTimeout(7000)
const during = await (await fetch(`${API}/recordings`)).json()
check('录制中服务端报告 active', during.recording?.active === true, `session=${during.recording?.sessionId ?? '-'}`)
check('录制中已登记轨道文件', (during.recording?.files ?? 0) >= 1, `${during.recording?.files ?? 0} 路`)

// 停止录制
await p.locator('button', { hasText: /^录制中$/ }).first().click()
await p.waitForTimeout(2500)
check('停止后红点消失', (await p.locator('text=录制中').count()) === 0)

const after = await (await fetch(`${API}/recordings`)).json()
const sess = after.sessions?.[0]
check('列表里出现一次已结束的会话', !!sess && !!sess.endedAt, sess ? `${sess.id}` : '无')
check('会话里有画面与声音两个文件', !!sess && sess.files.some((f) => f.kind === 'video') && sess.files.some((f) => f.kind === 'audio'),
  sess ? sess.files.map((f) => `${f.kind}:${f.sizeBytes}B/${f.durationMs}ms`).join(' ') : '')
check('文件有真实大小与时长', !!sess && sess.files.every((f) => f.sizeBytes > 0 && f.durationMs > 0))
check('给出了零转码转 mp4 的命令', !!sess && sess.files.every((f) => (f.ffmpegHint ?? '').includes('ffmpeg')))

// 通过 API 下载其中一个文件
if (sess) {
  const f = sess.files[0]
  const r = await fetch(`${API}/recordings/${encodeURIComponent(sess.id)}/${encodeURIComponent(f.name)}`)
  const buf = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0)
  check('文件可通过 API 下载', r.ok && buf.byteLength === f.sizeBytes, `HTTP ${r.status} ${buf.byteLength}B`)
  // 路径穿越必须被拒绝
  const bad = await fetch(`${API}/recordings/${encodeURIComponent(sess.id)}/${encodeURIComponent('../manifest.json')}`)
  check('路径穿越被拒绝', bad.status >= 400, `HTTP ${bad.status}`)
}

// UI 里的录制列表
await p.locator('button', { hasText: '更多' }).first().click()
await p.waitForTimeout(300)
const listEntry = p.locator('button', { hasText: '录制列表' }).first()
check('"更多"里有录制列表入口', (await listEntry.count()) > 0)
await listEntry.click()
await p.waitForTimeout(1500)
const panelText = await p.locator('.theme-meeting').last().innerText().catch(() => '')
check('面板列出会话与文件（含大小/时长）', /画面|声音/.test(panelText) && /(KB|MB|B)/.test(panelText), panelText.replace(/\s+/g, ' ').slice(0, 90))
check('面板给出转码命令入口', panelText.includes('复制转码命令'))
await p.screenshot({ path: '/tmp/uishot/12-recording-list.png' })

// ---- 回归：刷新后主持人身份不能丢 ----
// 以前 loadSession() 没有恢复 asAdmin，刷新会把主持人悄悄降级成普通参会者，
// 表现是"录制按钮消失了"，很难联想到是刷新导致的。
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForTimeout(6000)
const afterReload = await p.locator('button', { hasText: /^录制$/ }).count()
check('刷新后主持人身份保留（录制按钮仍在）', afterReload > 0, `按钮数 ${afterReload}`)
const grants = await p.evaluate(() => window.__easyliveDebugSnapshot?.()?.grants ?? null)
check('刷新后权限来自服务端（roomAdmin=true）', grants?.roomAdmin === true, JSON.stringify(grants))

await b.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 录制验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
