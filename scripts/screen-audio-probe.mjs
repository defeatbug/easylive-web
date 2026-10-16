/**
 * P0-② 验证：屏幕共享的系统声音 + 文字优先编码 + 远端音频真的在播。
 *
 * 说明：无头 Chrome 无法真正弹出"选择共享内容"的系统对话框，所以这里用
 * addInitScript 把 getDisplayMedia **替换成合成源**（画布视频 + 振荡器音频）。
 * 换句话说：这条探针验证的是我们自己的代码路径（请求音频、降级回退、contentHint、
 * 发送参数、发布与转发），**不**验证操作系统级别的采集是否可用——那需要人工点一次。
 *
 * 另外还补了一个此前的盲区：远端音频到底有没有被播放。之前只验了视频，
 * 结果是"能看不能听"这种缺陷一直没被发现。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
// 两个页面必须在**同一个房间**，否则永远不会互相订阅。
// （第一版每页各生成一次房间号，表现为 remoteStreams 恒为空，
//   而服务端日志里两人的 roomId 根本不同——日志是定位这个问题最快的地方。）
const ROOM = `sa-${Date.now().toString(36)}`
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
})
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } })

// 合成"屏幕+系统声音"
await ctx.addInitScript(() => {
  const orig = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices)
  navigator.mediaDevices.getDisplayMedia = async (constraints) => {
    const wantAudio = !!constraints?.audio
    ;(window).__probeAskedAudio = wantAudio
    const canvas = document.createElement('canvas')
    canvas.width = 1280; canvas.height = 720
    const g = canvas.getContext('2d')
    let i = 0
    const timer = setInterval(() => {
      g.fillStyle = '#0b1220'; g.fillRect(0, 0, 1280, 720)
      g.fillStyle = '#e6edf3'; g.font = '48px sans-serif'
      g.fillText(`PROBE SLIDE ${i++}`, 80, 200)
      g.fillText('文字优先：分辨率不掉、帧率可掉', 80, 300)
    }, 66)
    const stream = canvas.captureStream(15)
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
    if (wantAudio) {
      // 合成一段正弦波作为"系统声音"
      const ac = new AudioContext()
      const osc = ac.createOscillator()
      const dst = ac.createMediaStreamDestination()
      osc.frequency.value = 440
      osc.connect(dst)
      osc.start()
      for (const t of dst.stream.getAudioTracks()) stream.addTrack(t)
    }
    return stream
  }
  void orig
})

async function join(name) {
  const p = await ctx.newPage()
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('form', { timeout: 20000 })
  await p.waitForTimeout(2000)
  const inputs = await p.$$('form input[type="text"], form input:not([type])')
  await inputs[0].fill(ROOM); await inputs[1].fill(name)
  await p.click('form button[type=submit]')
  await p.waitForTimeout(6000)
  return p
}

// 等待订阅完成：remoteStreams 里出现条目才说明真正订阅上了。
// 之前固定等 6 秒会偶发太早（音频元素还没渲染），轮询既稳又快。
async function waitForSubscription(p, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const n = await p.evaluate(() => Object.keys(window.__easyliveDebugSnapshot?.()?.remoteStreams ?? {}).length)
    if (n > 0) return n
    await p.waitForTimeout(500)
  }
  return 0
}

const a = await join('发言人')
const b = await join('听众')
const subCount = await waitForSubscription(b)
check('听众完成订阅（remoteStreams 有条目）', subCount > 0, `${subCount} 条`)

// ---------- 1) 远端音频真的在播（此前完全没播）----------
const audioState = await b.evaluate(async () => {
  const els = [...document.querySelectorAll('audio')]
  const out = []
  for (const el of els) {
    const kinds = (el.srcObject?.getTracks?.() ?? []).map((t) => t.kind)
    // currentTime 前进才是真的在播（paused=false 只说明"没被暂停"）
    const t0 = el.currentTime
    await new Promise((r) => setTimeout(r, 700))
    out.push({ kinds, muted: el.muted, paused: el.paused, advanced: el.currentTime > t0, tracks: kinds.length })
  }
  return out
})
const diag = await b.evaluate(() => {
  const snap = window.__easyliveDebugSnapshot?.() ?? {}
  return {
    audioEls: document.querySelectorAll('audio').length,
    tracks: (snap.tracks ?? []).map((t) => `${t.kind}/${t.source}/muted=${t.muted}`),
    streamKeys: Object.keys(snap.remoteStreams ?? {}).length,
    localTracks: (snap.localTracks ?? []).length,
  }
})
console.log('  诊断:', JSON.stringify(diag))
check('远端页面存在音频播放器（<audio>）', audioState.length > 0, `${audioState.length} 个`)
check('音频播放器挂着音频轨且未被静音', audioState.some((s) => s.kinds.includes('audio') && !s.muted), JSON.stringify(audioState[0] ?? null))
check('远端音频确实在播放（currentTime 前进）', audioState.some((s) => s.advanced), `advanced=${audioState.map((s) => s.advanced).join(',')}`)

const audioElsBefore = await b.evaluate(() => document.querySelectorAll('audio').length)
check('听众端麦克风音频已被播放（有音频播放器）', audioElsBefore >= 1, `${audioElsBefore} 个`)

// ---------- 2) 屏幕共享：请求系统声音 + 文字优先 ----------
await a.locator('button', { hasText: '共享屏幕' }).first().click()
await a.waitForTimeout(3500)
const askedAudio = await a.evaluate(() => window.__probeAskedAudio === true)
check('屏幕共享请求了系统声音（getDisplayMedia 带 audio）', askedAudio)

const screenInfo = await a.evaluate(async () => {
  const info = await window.__easyliveDebugScreen?.()
  const v = document.querySelector('video')
  return { ...(info ?? { video: 0, audio: 0, contentHint: null, degradation: null, maxFramerate: null }), localPreviewMuted: v ? v.muted : null }
})
check('屏幕共享的视频轨设了 contentHint=text（文字优先编码）', screenInfo.contentHint === 'text', String(screenInfo.contentHint))
check('发送参数为 maintain-resolution（弱网保清晰度、宁可掉帧）', screenInfo.degradation === 'maintain-resolution', String(screenInfo.degradation))
check('屏幕共享帧率上限 15（省下码率给分辨率）', screenInfo.maxFramerate === 15, String(screenInfo.maxFramerate))
check('本地画面元素保持静音（避免自己的系统声音绕回来）', screenInfo.localPreviewMuted === true, String(screenInfo.localPreviewMuted))
check('系统声音被发布出去（发布端有额外的音频轨）', screenInfo.audio >= 2, `${screenInfo.audio} 条音频轨`)

// ---------- 3) 听众收到屏幕 + 屏幕声音 ----------
await b.waitForTimeout(4000)
// 用元素层面的证据，而不是统计行：听众端应当同时具备
//   - 一块在播的**屏幕画面**（来自屏幕共享的视频轨）
//   - 多出来的那个音频播放器（屏幕共享的系统声音）
const bState = await b.evaluate(() => {
  const videos = [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, h: v.videoHeight, paused: v.paused }))
  const big = videos.find((v) => v.w >= 1000)
  return { videos, screenPlaying: !!big && big.w > 0 && !big.paused, audioEls: document.querySelectorAll('audio').length }
})
check('听众看到屏幕共享画面在播（≥1000px 宽）', bState.screenPlaying, JSON.stringify(bState.videos))
check('听众端的系统声音播放器已出现（音频播放器数量增加）', bState.audioEls > audioElsBefore, `${audioElsBefore} → ${bState.audioEls}`)
await b.screenshot({ path: '/tmp/uishot/19-screen-audio.png' })

await browser.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 屏幕共享声音/文字优先验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
