/**
 * 报表页验证：页面能打开、能读到真实数据、图表有数据点。
 * 数据来自 /metrics/overview（服务端从 metric_samples 聚合）。
 */
import { chromium } from 'playwright-core'
const URL = process.env.PROBE_URL ?? 'https://localhost:5174'
const results = []
const check = (n, ok, extra = '') => { results.push([ok, n]); console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`) }

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors'],
})
const p = await (await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })).newPage()
const apiErrors = []
p.on('response', (r) => { if (r.url().includes('/metrics') && !r.ok()) apiErrors.push(`${r.status()} ${r.url()}`) })

await p.goto(`${URL}/#/metrics`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(4000)

check('报表页打开（标题渲染）', (await p.locator('text=会议指标报表').count()) > 0)
check('/metrics 请求没有报错（代理已配置）', apiErrors.length === 0, apiErrors.join(', '))

const kpis = await p.evaluate(() => {
  const out = {}
  document.querySelectorAll('.tm-card').forEach((c) => {
    const label = c.querySelector('p')?.textContent?.trim() ?? ''
    const value = c.querySelectorAll('p')[1]?.textContent?.trim() ?? ''
    if (label) out[label] = value
  })
  return out
})
check('KPI 卡片渲染并有数值', Object.keys(kpis).length >= 8, `样例: 房间数=${kpis['房间数']} 参会人数=${kpis['参会人数']} 发布轨道=${kpis['发布轨道']}`)
check('KPI 显示真实实时值（非占位）', kpis['房间数'] !== '—' && kpis['发布轨道'] !== '—')

const charts = await p.evaluate(() => document.querySelectorAll('svg polyline').length)
check('历史曲线有绘制的折线', charts >= 2, `${charts} 条`)
const points = await p.evaluate(() => {
  const el = document.querySelector('svg polyline')
  return el ? (el.getAttribute('points') ?? '').trim().split(/\s+/).length : 0
})
check('曲线包含多个采样点（数据真的入库了）', points >= 2, `${points} 个点`)

const rows = await p.evaluate(() => document.querySelectorAll('table tbody tr').length)
check('逐轨道表格有数据行', rows >= 1, `${rows} 行`)

const hasCsv = await p.locator('a[href*="format=csv"]').count()
check('提供 CSV 导出入口', hasCsv > 0)

await p.screenshot({ path: '/tmp/uishot/20-metrics-page.png', fullPage: true })
await b.close()
const pass = results.filter(([ok]) => ok).length
console.log(`\n=== 报表页验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
