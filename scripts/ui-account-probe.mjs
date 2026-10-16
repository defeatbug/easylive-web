#!/usr/bin/env node
/**
 * 账号中心与会前页身份入口的浏览器回归探针。
 *
 * 覆盖的是"只能在真实浏览器里复现"的部分：
 *   1. AUTH_MODE=required 时首页应当是**登录页**，而不是直接进会前页
 *   2. #/dev/login 开发预览路由在任何后端状态下都能显示登录页
 *   3. 登录成功后左下角头像 / 顶栏账号都能点开**居中弹窗**
 *   4. 弹窗里能改昵称、能上传头像（走真实的 multipart 上传）
 *   5. Escape 关闭、焦点不逃出弹窗、关闭后焦点归还
 *   6. 退出登录后回到登录页
 *   7. 窄屏下弹窗不溢出视口
 *   8. 注册：模式切换、前端校验、注册即登录、重复用户名被拒
 *
 * 注意：第 8 段会真的在数据库里建一个 `probe*` 账号（注册没有自助删除接口），
 * 每次运行都会新增一个。它只影响开发库，需要时按前缀清理 `users` 表即可。
 *
 * 用法（前后端都起好后）：
 *   node scripts/ui-account-probe.mjs
 *   PROBE_URL=https://localhost:5173 node scripts/ui-account-probe.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  console.error('缺少 playwright-core。先执行：pnpm add -D playwright-core')
  process.exit(2)
}

const PAGE_URL = process.env.PROBE_URL ?? 'https://localhost:5173/'
const USERNAME = process.env.PROBE_USER ?? 'teacher'
const PASSWORD = process.env.PROBE_PASS ?? 'easylive-demo-2026'

// 头像测试用的图片：探针自带一张 1×1 PNG（后端只校验 MIME 与大小，像素尺寸无关），
// 不依赖外部文件——否则 /tmp 被系统清理后，探针会以"文件不存在"这种难懂的方式失败。
const AVATAR = process.env.PROBE_AVATAR ?? join(tmpdir(), 'easylive-probe-avatar.png')
if (!existsSync(AVATAR)) {
  writeFileSync(AVATAR, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ))
}

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
  results.push({ name, ok })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const launch = async (viewport) => {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport })
  return { browser, page: await ctx.newPage() }
}

const signIn = async (page) => {
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 })
  await page.fill('input[autocomplete="username"]', USERNAME)
  await page.fill('input[autocomplete="current-password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.prejoin-shell', { timeout: 15000 })
}

// ---------- A. 首页应当是登录页 ----------
console.log('\n=== A. 未登录时首页 = 登录页 ===')
{
  const { browser, page } = await launch({ width: 1440, height: 900 })
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })

  await page.waitForSelector('#login-heading', { timeout: 15000 })
  const s = await page.evaluate(() => ({
    heading: document.querySelector('#login-heading')?.textContent ?? '',
    hasUserIcon: !!document.querySelector('.login-field .login-input-icon svg'),
    hasToggle: !!document.querySelector('.login-password-toggle svg'),
    hasRemember: !!document.querySelector('.login-remember input[type=checkbox]'),
    forgot: document.querySelector('.login-forgot')?.textContent?.trim() ?? '',
    // 正式登录页不该出现预览提示
    hasPreviewNotice: !!document.querySelector('.login-preview'),
    isJoinPage: !!document.querySelector('.prejoin-shell'),
  }))
  check('显示登录页而非会前页', s.heading === '欢迎回来' && !s.isJoinPage, `heading=${s.heading}`)
  check('用户名/密码框有图标', s.hasUserIcon && s.hasToggle)
  check('有"记住用户名"与"忘记密码"', s.hasRemember && s.forgot.includes('忘记密码'))
  check('正式登录页不显示预览提示', s.hasPreviewNotice === false)

  // ---------- B. 登录 → 会前页 ----------
  console.log('\n=== B. 登录进入会前页 ===')
  await signIn(page)
  // 先等左下角身份入口渲染出内容（首字母或头像）：只等 .prejoin-shell 会在文本提交前
  // 就读到空值，detail 里冒出"左下角文字="这种误导性输出（实测出现过）。
  await page.waitForFunction(() => {
    const b = document.querySelector('button.prejoin-rail-bottom')
    return !!b && (b.textContent?.trim().length ?? 0) > 0
  }, { timeout: 8000 }).catch(() => {})
  const afterLogin = await page.evaluate(() => ({
    railBottom: !!document.querySelector('button.prejoin-rail-bottom'),
    accountChip: !!document.querySelector('button.prejoin-account'),
    // 退出登录按钮已经从顶栏移进弹窗，顶栏不该再有它
    topbarLogout: !!document.querySelector('.prejoin-logout'),
    initial: document.querySelector('button.prejoin-rail-bottom')?.textContent?.trim() ?? '',
  }))
  check('左下角是"可点击"的按钮', afterLogin.railBottom)
  check('顶栏账号是按钮', afterLogin.accountChip)
  check('顶栏不再有独立退出按钮', afterLogin.topbarLogout === false, `左下角文字=${afterLogin.initial}`)

  // ---------- C. 点击左下角 → 居中弹窗 ----------
  console.log('\n=== C. 左下角点开居中账号弹窗 ===')
  await page.click('button.prejoin-rail-bottom')
  await page.waitForSelector('[role="dialog"][aria-labelledby="account-dialog-title"]', { timeout: 8000 })
  const dlg = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const r = dialog.getBoundingClientRect()
    return {
      title: document.querySelector('#account-dialog-title')?.textContent ?? '',
      handle: document.querySelector('.account-handle')?.textContent ?? '',
      role: document.querySelector('.account-role')?.textContent?.trim() ?? '',
      sections: [...document.querySelectorAll('.account-section h3')].map((h) => h.textContent.trim()),
      hasLogout: !!document.querySelector('.account-btn.is-danger'),
      hasFileInput: !!document.querySelector('.account-file'),
      // "居中"：左右留白大致相等
      centered: Math.abs(r.left - (window.innerWidth - r.right)) < 8,
      ariaModal: dialog.getAttribute('aria-modal'),
      focusInside: dialog.contains(document.activeElement),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1,
    }
  })
  check('弹窗标题是当前用户', dlg.title === 'teacher', `title=${dlg.title}`)
  check('显示用户名与角色', dlg.handle.includes('@teacher') && dlg.role.includes('主持人'), `${dlg.handle} ${dlg.role}`)
  check('包含头像/资料/密码三块', ['头像', '账号资料', '修改密码'].every((t) => dlg.sections.includes(t)), dlg.sections.join('/'))
  check('包含退出登录按钮', dlg.hasLogout)
  check('有隐藏的文件选择框', dlg.hasFileInput)
  check('水平居中', dlg.centered)
  check('aria-modal=true', dlg.ariaModal === 'true')
  check('打开后焦点在弹窗内', dlg.focusInside)
  check('弹窗完整落在视口内', dlg.inViewport)

  // ---------- D. 焦点困在弹窗内 + Escape 关闭 ----------
  console.log('\n=== D. 键盘可达性 ===')
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  const stillInside = await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement))
  check('Tab 循环不会跑出弹窗', stillInside)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const closed = await page.evaluate(() => ({
    gone: !document.querySelector('[role="dialog"]'),
    focusReturned: document.activeElement?.classList?.contains('prejoin-rail-bottom') ?? false,
  }))
  check('Escape 能关闭', closed.gone)
  check('关闭后焦点归还触发元素', closed.focusReturned)

  // ---------- E. 改昵称 + 上传头像 ----------
  console.log('\n=== E. 修改资料与上传头像 ===')
  await page.click('button.prejoin-account')
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 })

  // 昵称：改名但不填当前密码 → 必须被拦下
  const nameInput = page.locator('.account-section', { hasText: '账号资料' }).locator('input').first()
  await nameInput.fill('林老师')
  await page.locator('.account-section', { hasText: '账号资料' }).locator('button[type=submit]').click()
  await page.waitForSelector('.account-msg.is-error', { timeout: 6000 })
  const guard = await page.locator('.account-msg.is-error').textContent()
  check('改资料必须先填当前密码', guard.includes('当前密码'), guard)

  // 填上密码再保存
  await page.locator('.account-section', { hasText: '账号资料' }).locator('input[type=password]').fill(PASSWORD)
  await page.locator('.account-section', { hasText: '账号资料' }).locator('button[type=submit]').click()
  await page.waitForSelector('.account-msg.is-ok', { timeout: 10000 })
  const saved = await page.locator('.account-msg.is-ok').textContent()
  check('保存资料成功', saved.includes('资料已保存'), saved)
  const newTitle = await page.locator('#account-dialog-title').textContent()
  check('弹窗标题同步新昵称', newTitle === '林老师', `title=${newTitle}`)

  // 上传头像（走真实 multipart）
  await page.setInputFiles('.account-file', AVATAR)
  await page.waitForSelector('.account-avatar img', { timeout: 12000 })
  const av = await page.evaluate(() => {
    const img = document.querySelector('.account-avatar img')
    return { src: img.getAttribute('src'), complete: img.complete, w: img.naturalWidth }
  })
  check('头像上传后显示真实图片', av.src.startsWith('/auth/avatar/') && av.w > 0, `${av.src} w=${av.w}`)

  const railAvatar = await page.evaluate(() => !!document.querySelector('button.prejoin-rail-bottom img'))
  check('左下角头像同步', railAvatar)

  // 移除头像：既验证"移除"这条路，也顺手把测试数据清掉
  await page.locator('.account-btn.is-quiet').click()
  await page.waitForTimeout(1500)
  const removed = await page.evaluate(() => ({
    imgGone: !document.querySelector('.account-avatar img'),
    msg: document.querySelector('.account-msg.is-ok')?.textContent ?? '',
  }))
  check('移除头像后回落首字母', removed.imgGone, removed.msg)

  // 还原昵称，避免留下测试数据
  await nameInput.fill('teacher')
  await page.locator('.account-section', { hasText: '账号资料' }).locator('input[type=password]').fill(PASSWORD)
  await page.locator('.account-section', { hasText: '账号资料' }).locator('button[type=submit]').click()
  await page.waitForTimeout(1500)

  // ---------- F. 退出登录 ----------
  console.log('\n=== F. 退出登录 ===')
  await page.locator('.account-btn.is-danger').click()
  await page.waitForSelector('#login-heading', { timeout: 12000 })
  check('退出后回到登录页', true)
  await browser.close()
}

// ---------- G. 开发预览路由（后端不可用时也应在） ----------
console.log('\n=== G. #/dev/login 预览路由 ===')
{
  const { browser, page } = await launch({ width: 1440, height: 900 })
  await page.goto(`${PAGE_URL}#/dev/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-heading', { timeout: 15000 })
  const s = await page.evaluate(() => ({
    heading: document.querySelector('#login-heading')?.textContent ?? '',
    notice: document.querySelector('.login-preview')?.textContent ?? '',
  }))
  check('预览路由显示登录页', s.heading === '欢迎回来')
  check('预览页有明确提示', s.notice.includes('开发预览'), s.notice.slice(0, 30))
  await browser.close()
}

// ---------- H. 窄屏：弹窗不溢出 ----------
console.log('\n=== H. 窄屏（375×720） ===')
{
  const { browser, page } = await launch({ width: 375, height: 720 })
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await signIn(page)
  await page.click('button.prejoin-rail-bottom')
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 })
  const r = await page.evaluate(() => {
    const b = document.querySelector('[role="dialog"]').getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight }
  })
  check('弹窗未横向溢出', r.left >= -1 && r.right <= r.vw + 1, `left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${r.vw}`)
  check('弹窗未纵向溢出', r.top >= -1 && r.bottom <= r.vh + 1, `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} vh=${r.vh}`)
  await browser.close()
}

// ---------- I. 注册 ----------
console.log('\n=== I. 注册 ===')
{
  const newUser = `probe${Date.now().toString(36)}`
  const newPass = 'probe-pass-2026'
  const { browser, page } = await launch({ width: 1440, height: 900 })
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-heading', { timeout: 15000 })

  const modes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.login-mode')]
    return {
      labels: btns.map((b) => b.textContent.trim()),
      active: btns.find((b) => b.classList.contains('is-active'))?.textContent?.trim() ?? '',
      hasRemember: !!document.querySelector('.login-remember'),
    }
  })
  check('登录页有登录/注册切换', modes.labels.join('/') === '登录/注册', modes.labels.join('/'))
  check('默认停在登录模式', modes.active === '登录' && modes.hasRemember, `active=${modes.active}`)

  await page.locator('.login-mode').nth(1).click()
  await page.waitForTimeout(250)
  const signupFields = await page.evaluate(() => ({
    hasNickname: !!document.querySelector('input[autocomplete="nickname"]'),
    passwordCount: document.querySelectorAll('input[autocomplete="new-password"]').length,
    hasRemember: !!document.querySelector('.login-remember'),
    submit: document.querySelector('button[type="submit"]')?.textContent?.trim() ?? '',
  }))
  check('注册模式出现昵称与确认密码', signupFields.hasNickname && signupFields.passwordCount === 2,
    `昵称=${signupFields.hasNickname} 密码框=${signupFields.passwordCount}`)
  check('注册模式不显示"记住用户名"', signupFields.hasRemember === false)
  check('按钮文案变为创建账号', signupFields.submit.includes('创建账号'), signupFields.submit)

  const pw = page.locator('input[autocomplete="new-password"]')
  // 密码太短
  await page.fill('input[autocomplete="username"]', newUser)
  await pw.nth(0).fill('short')
  await pw.nth(1).fill('short')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(400)
  const shortErr = (await page.locator('#login-error').textContent()) ?? ''
  check('密码太短被拦下', shortErr.includes('至少'), shortErr)

  // 两次输入不一致
  await pw.nth(0).fill(newPass)
  await pw.nth(1).fill(`${newPass}x`)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(400)
  const mismatch = (await page.locator('#login-error').textContent()) ?? ''
  check('两次密码不一致被拦下', mismatch.includes('不一致'), mismatch)

  // 正常注册 → 应当直接进入会前页（注册即登录）
  await page.fill('input[autocomplete="nickname"]', '探针新用户')
  await pw.nth(1).fill(newPass)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.prejoin-shell', { timeout: 20000 })
  const landed = await page.evaluate(() => !!document.querySelector('.prejoin-shell'))
  check('注册成功后直接进入会前页（注册即登录）', landed)

  const role = (await page.locator('.prejoin-account small').textContent())?.trim() ?? ''
  check('新账号是普通成员', role === '成员', role)
  await browser.close()

  // 同一用户名再次注册 → 409
  const dup = await launch({ width: 1440, height: 900 })
  await dup.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await dup.page.waitForSelector('#login-heading', { timeout: 15000 })
  await dup.page.locator('.login-mode').nth(1).click()
  await dup.page.fill('input[autocomplete="username"]', newUser)
  const dpw = dup.page.locator('input[autocomplete="new-password"]')
  await dpw.nth(0).fill(newPass)
  await dpw.nth(1).fill(newPass)
  await dup.page.click('button[type="submit"]')
  await dup.page.waitForTimeout(1200)
  const dupErr = (await dup.page.locator('#login-error').textContent()) ?? ''
  check('重复用户名注册被拒（409）', dupErr.includes('已被占用'), dupErr)
  await dup.browser.close()

  console.log(`  ℹ️  本次注册的测试账号：${newUser}（探针不自动删除）`)
}

// ---------- J. 服务端关闭注册时，前端不该出现注册入口 ----------
console.log('\n=== J. 关闭注册时不显示注册入口 ===')
{
  const { browser, page } = await launch({ width: 1440, height: 900 })
  // 拦截能力查询来模拟"部署未开放注册"：比另起一套后端便宜得多，
  // 而且这里锁定的正是前端自己的行为（后端 403 已由接口层覆盖）。
  await page.route('**/auth/capabilities', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authEnabled: true, signupEnabled: false }),
  }))
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-heading', { timeout: 15000 })
  await page.waitForTimeout(900) // 等能力查询回填
  const s = await page.evaluate(() => ({
    modes: document.querySelectorAll('.login-mode').length,
    hasLoginForm: !!document.querySelector('input[autocomplete="username"]'),
    hasRemember: !!document.querySelector('.login-remember'),
  }))
  check('关闭注册时不渲染登录/注册切换', s.modes === 0, `切换按钮数=${s.modes}`)
  check('登录表单本身仍可用', s.hasLoginForm && s.hasRemember)
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
