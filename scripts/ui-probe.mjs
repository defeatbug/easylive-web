#!/usr/bin/env node
/**
 * 浏览器回归探针：用真实 Chrome + 假摄像头驱动界面，覆盖几个"只能在浏览器里复现"的坑。
 *
 * 为什么需要它：前端的其它测试都是类型检查与构建，抓不到"点了没反应""红字不消失"
 * 这类问题。这些 bug 全是用户实际报过来的，所以固化成可重复运行的检查。
 *
 * 用法：
 *   pnpm add -D playwright-core          # 只需一次（用本机已装的 Chrome，不下载浏览器）
 *   # 另开一个终端跑前后端，然后：
 *   node scripts/ui-probe.mjs
 *   PROBE_URL=https://localhost:5173 PROBE_API=http://localhost:8080 node scripts/ui-probe.mjs
 *
 * 覆盖的回归点：
 *   1. 会前页点麦克风/摄像头**不会**提交表单（<button> 在 form 内默认是 submit）
 *   2. 摄像头开关能真正切换预览显隐
 *   3. 权限被拒时给出提示且仍能入会；授权后点「重试打开设备」能恢复画面，
 *      并且**过期的错误提示会消失**（曾经红字会一直挂着，看起来像摄像头坏了）
 *   4. 会前页关掉摄像头入会，之后能在会中打开摄像头
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  console.error('缺少 playwright-core。先执行：pnpm add -D playwright-core')
  process.exit(2)
}

const PAGE_URL = process.env.PROBE_URL ?? 'https://localhost:5173/'
const API = process.env.PROBE_API ?? 'http://localhost:8080'
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)
const executablePath = CHROME_PATHS.find((p) => existsSync(p))
if (!executablePath) {
  console.error(`找不到 Chrome，可设 CHROME_PATH 指定。已尝试：${CHROME_PATHS.join(', ')}`)
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const launch = (extraArgs, permissions) =>
  chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream', // 确定性假摄像头/麦克风
      '--ignore-certificate-errors',        // Vite 自签证书
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
  }).then(async (browser) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions })
    return { browser, ctx, page: await ctx.newPage() }
  })

const fillJoinForm = async (page, room, name) => {
  await page.waitForSelector('form', { timeout: 15000 })
  const inputs = await page.$$('form input[type="text"], form input:not([type])')
  await inputs[0].fill(room)
  await inputs[1].fill(name)
}

const probe = async (label, url) => {
  const s = await url.evaluate(() => {
    const v = document.querySelector('video')
    // 会中的按钮 title 带快捷键后缀（如"开启摄像头（v）"），所以用前缀匹配
    const byTitle = (prefix) => document.querySelector(`button[title^="${prefix}"]`)
    const btn = (t) => byTitle(t)
    return {
      href: location.href,
      hasJoinForm: !!document.querySelector('form button[type=submit]'),
      videoWidth: v?.videoWidth ?? 0,
      videoVisible: v ? !v.className.includes('opacity-0') : null,
      liveVideoTracks: v?.srcObject
        ? v.srcObject.getTracks().filter((t) => t.kind === 'video' && t.readyState === 'live').length
        : 0,
      camTitle: btn('关闭摄像头') ? '关闭摄像头' : btn('开启摄像头') ? '开启摄像头' : null,
      bodyText: document.body.innerText.replace(/\n+/g, ' | '),
    }
  })
  console.log(`\n[${label}] videoWidth=${s.videoWidth} camBtn=${s.camTitle} 仍在会前页=${s.hasJoinForm}`)
  return s
}

// ---------- A. 会前页：开关不应提交表单 ----------
console.log('\n=== A. 会前页设备开关 ===')
{
  const { browser, page } = await launch(['--use-fake-ui-for-media-stream'], ['camera', 'microphone'])
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await fillJoinForm(page, 'probe-ui', '探针A')
  await page.waitForTimeout(2000)
  const s0 = await probe('初始', page)
  check('会前页能拿到实时预览', s0.videoWidth > 0 && s0.liveVideoTracks > 0, `videoWidth=${s0.videoWidth}`)

  await page.click('button[title="关闭摄像头"]')
  await page.waitForTimeout(500)
  const s1 = await probe('关闭摄像头后', page)
  check('点摄像头只切换状态（未入会）', s1.href === s0.href && s1.hasJoinForm, `href=${s1.href}`)
  check('关闭后预览隐藏', s1.videoVisible === false)
  check('再次可打开', s1.camTitle === '开启摄像头')

  await page.click('button[title="开启摄像头"]')
  await page.waitForTimeout(500)
  const s2 = await probe('再次开启后', page)
  check('打开后预览恢复', s2.videoVisible === true && s2.camTitle === '关闭摄像头')

  await page.click('button[title="关闭麦克风"]')
  await page.waitForTimeout(400)
  const s3 = await probe('关麦克风后', page)
  check('点麦克风只切换状态（未入会）', s3.href === s0.href && s3.hasJoinForm)
  await browser.close()
}

// ---------- B. 权限被拒 → 授权后重试 ----------
console.log('\n=== B. 权限被拒后重试打开设备 ===')
{
  // 不加 --use-fake-ui-for-media-stream，也不授予权限 → 复现"Permission denied"
  const { browser, ctx, page } = await launch([], [])
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await fillJoinForm(page, 'probe-denied', '探针B')
  await page.waitForTimeout(2000)
  const s0 = await page.evaluate(() => ({
    // 用显式钩子定位会前提示，不再依赖"表单里第一个 p"这种隐式约定
    hint:
      document.querySelector('[data-testid="prejoin-hint"]')?.textContent ??
      document.querySelector('form p')?.textContent ??
      '',
  }))
  check('无权限时会前页给出提示', s0.hint.includes('无法访问'), s0.hint.trim().slice(0, 60))

  await page.click('form button[type=submit]')
  await page.waitForTimeout(5000)
  const denied = await page.evaluate(() => ({
    hasRetry: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('重试打开设备')),
    bodyText: document.body.innerText.replace(/\n+/g, ' | '),
  }))
  check('无权限时仍能入会并给出重试按钮', denied.hasRetry)

  await ctx.grantPermissions(['camera', 'microphone'], { origin: new URL(PAGE_URL).origin })
  await page.locator('button', { hasText: '重试打开设备' }).first().click()
  await page.waitForTimeout(6000)
  const after = await probe('重试后', page)
  check('重试后摄像头恢复', after.videoWidth > 0 && after.liveVideoTracks > 0, `videoWidth=${after.videoWidth}`)
  check(
    '重试成功后过期的错误提示消失',
    !after.bodyText.includes('Permission denied'),
    after.bodyText.includes('Permission denied') ? '红字仍在（会让人以为摄像头还是坏的）' : '',
  )
  await browser.close()

  await fetch(`${API}/healthz`).catch(() => {})
}

// ---------- C. 会前页关摄像头入会 → 会中再打开 ----------
console.log('\n=== C. 关摄像头入会，会中打开 ===')
{
  const { browser, page } = await launch(['--use-fake-ui-for-media-stream'], ['camera', 'microphone'])
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await fillJoinForm(page, 'probe-offcam', '探针C')
  await page.waitForTimeout(2000)

  // 先确定摄像头按钮的当前标题（可能是"关闭摄像头"或"开启摄像头"）
  const title = await page.evaluate(() => {
    if (document.querySelector('button[title^="关闭摄像头"]')) return '关闭摄像头'
    return '开启摄像头'
  })
  if (title === '关闭摄像头') {
    await page.click('button[title^="关闭摄像头"]')
    await page.waitForTimeout(400)
  }
  await page.click('form button[type=submit]')
  await page.waitForTimeout(6000)
  const inRoomOff = await probe('会中（摄像头关）', page)
  check('关摄像头入会：自己的画面是占位而不是黑屏', inRoomOff.videoWidth === 0 || inRoomOff.liveVideoTracks === 0)

  // 会中打开摄像头
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('button[title^="开启摄像头"]')
    if (!btn) return '找不到"开启摄像头"按钮'
    btn.click()
    return 'clicked'
  })
  await page.waitForTimeout(5000)
  const inRoomOn = await probe('会中（摄像头开）', page)
  check('会中能重新打开摄像头', inRoomOn.liveVideoTracks > 0 && inRoomOn.videoWidth > 0, `videoWidth=${inRoomOn.videoWidth} (${opened})`)
  await browser.close()
}

// ---------- D. 双人：远端画面必须真的在播（本次遗漏的测试） ----------
//
// 为什么必须有这一段：之前的浏览器探针**只测单人**（本地预览 + 本地瓦片），
// 于是"转发出去的包在 RTP 层被对端静默丢弃"这类问题完全测不到——
// 真实症状是"别人看不到我的摄像头/屏幕共享/麦克风"，而服务端与信令看起来一切正常。
console.log('\n=== D. 双人远端画面 ===')
{
  const room = 'probe-pair-' + Date.now()
  const launchPair = async (name) => {
    const { browser, page } = await launch(['--use-fake-ui-for-media-stream'], ['camera', 'microphone'])
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('form', { timeout: 20000 })
    const inputs = await page.$$('form input[type="text"], form input:not([type])')
    await inputs[0].fill(room)
    await inputs[1].fill(name)
    await page.waitForTimeout(2000)
    await page.click('form button[type=submit]')
    return { browser, page }
  }

  const first = await launchPair('探针甲')
  await first.page.waitForTimeout(5000)
  const second = await launchPair('探针乙')
  await second.page.waitForTimeout(15000)

  // 远端瓦片 = 页面上第二个 <video>（第一个是本地）；用 readyState 与尺寸判断是否真在播
  const remotePlaying = async (page) =>
    page.evaluate(() => {
      const vids = [...document.querySelectorAll('video')]
      const remote = vids.find((v) => !v.closest('[data-local-tile]')) ?? vids[vids.length - 1]
      return { count: vids.length, w: remote?.videoWidth ?? 0, readyState: remote?.readyState ?? 0 }
    })

  const a1 = await remotePlaying(first.page)
  await first.page.waitForTimeout(4000)
  const a2 = await remotePlaying(first.page)
  check('甲 能看到 乙 的画面（远端瓦片在播）', a2.w > 0 && a2.readyState >= 2, `w=${a2.w} readyState=${a2.readyState}`)
  check('远端画面持续在播（不是只播了开头一小段就冻结）', a2.readyState >= 2 && a1.count === a2.count)

  const b = await remotePlaying(second.page)
  check('乙 能看到 甲 的画面（远端瓦片在播）', b.w > 0 && b.readyState >= 2, `w=${b.w} readyState=${b.readyState}`)

  await first.browser.close()
  await second.browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
process.exit(failed.length ? 1 : 0)
