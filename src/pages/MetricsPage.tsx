import { useCallback, useEffect, useState } from 'react'
import { fetchRecordings, formatBytes, type RecordingsResponse } from '../lib/recordings'

/**
 * 指标报表页（论文/答辩用）。
 *
 * 数据来源：`/metrics/overview`（实时状态 + 数据库里的历史曲线）、`/metrics/tracks`（逐轨道）、
 * `/recordings`（录制产物）。其中历史曲线来自 `metric_samples` 表——服务端按 METRICS_INTERVAL
 * 周期采样入库，所以这条曲线是**真实采集**的，不是前端编出来的。
 *
 * 两点刻意为之：
 *  1. **图表自己画**（SVG），不引图表库：体积小、无依赖，而且论文里说得清每条线怎么来的。
 *  2. 没有数据的字段**明说"未采样"**，不画一条看起来像真的平线——例如 rtt_ms/loss_rate
 *     这两列当前采样器根本没写，恒为 0。
 */

interface HistoryPoint {
  bucket: string
  avgParticipants: number
  avgTracks: number
  avgRttMs: number
  avgLossRate: number
  totalBytes: number
  kbps: number
}
interface Overview {
  sampledAt: string
  windowMin: number
  bucketSec: number
  dbAvailable: boolean
  history: HistoryPoint[]
  global?: { sampleCount: number; peakParticipants: number; peakTracks: number; totalBytes: number }
  live: {
    rooms: number
    participants: number
    tracks: number
    goroutines: number
    heapAllocMB: number
    cpuSeconds: number
    goroutinePanics: number
    messageFloods: number
    malformedRTCP: number
    pliForwarded: number
    pliSuppressed: number
  }
}
interface TrackRow {
  roomId: string
  id: string
  publisherId: string
  kind: string
  source: string
  codec: string
  payloadType: number
  packets: number
  bytes: number
  dropped: number
  writeFails: number
  subscribers: number
  recording: boolean
}

// 实时指标 5 秒一次（原来 3 秒）；录制列表**不参与轮询**——它几乎不变，
// 每 3 秒拉一次纯属浪费（录制文件目录可能很大）。改为进入时加载 + 手动刷新。
const REFRESH_MS = 5000

export function MetricsPage({ onBack }: { onBack: () => void }) {
  const [minutes, setMinutes] = useState(30)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [tracks, setTracks] = useState<TrackRow[]>([])
  const [recs, setRecs] = useState<RecordingsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const [o, t] = await Promise.all([
          fetch(`/metrics/overview?minutes=${minutes}&bucket=5`).then((x) => x.json()),
          fetch('/metrics/tracks').then((x) => x.json()),
        ])
        if (!alive) return
        setOverview(o as Overview)
        setTracks(((t as { tracks?: TrackRow[] }).tracks ?? []) as TrackRow[])
        setErr(null)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const id = window.setInterval(tick, REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [minutes])

  // 录制列表独立加载：它几乎不变，不参与高频轮询（录制目录可能很大，
  // 每几秒拉一次纯属浪费）。进入页面时加载一次，需要时点"刷新"。
  const loadRecordings = useCallback(async () => {
    try {
      setRecs(await fetchRecordings())
    } catch {
      /* 录制能力未开启时接口会报错，报表页不该因此整体失败 */
    }
  }, [])

  useEffect(() => {
    void loadRecordings()
  }, [loadRecordings])

  const live = overview?.live
  const history = overview?.history ?? []
  const recFiles = (recs?.sessions ?? []).flatMap((s) => s.files)

  return (
    <div className="theme-meeting min-h-screen bg-[var(--bg)] px-5 py-5 text-[var(--text)]">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">会议指标报表</h1>
        <span className="text-xs text-[var(--text-mute)]">
          {overview ? `采样于 ${new Date(overview.sampledAt).toLocaleTimeString()} · 每 ${REFRESH_MS / 1000}s 自动刷新` : '加载中…'}
        </span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {[15, 30, 60, 180].map((m) => (
            <button
              key={m}
              onClick={() => setMinutes(m)}
              className={`rounded-md px-2 py-1 transition ${minutes === m ? 'bg-[var(--brand-tint)] text-[var(--brand)]' : 'text-[var(--text-dim)] hover:bg-[var(--surface-2)]'}`}
            >
              近 {m} 分钟
            </button>
          ))}
          <button className="tm-btn px-2.5 py-1" onClick={onBack}>
            返回
          </button>
        </div>
      </header>

      {err && <p className="mx-auto mt-3 max-w-6xl rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">读取指标失败：{err}</p>}

      {/* KPI */}
      <section className="mx-auto mt-4 grid max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="房间数" value={live?.rooms ?? '—'} />
        <Kpi label="参会人数" value={live?.participants ?? '—'} />
        <Kpi label="发布轨道" value={live?.tracks ?? '—'} />
        <Kpi label="内存" value={live ? `${live.heapAllocMB.toFixed(0)} MB` : '—'} />
        <Kpi label="goroutine" value={live?.goroutines ?? '—'} />
        <Kpi label="CPU 时间" value={live ? `${live.cpuSeconds.toFixed(1)} s` : '—'} />
      </section>

      {/* 历史曲线 */}
      <section className="mx-auto mt-4 max-w-6xl space-y-3">
        {!overview?.dbAvailable ? (
          <div className="tm-card p-4 text-xs text-[var(--text-mute)]">
            数据层不可用（未配置数据库）——实时指标仍可用，历史曲线需要 <code>metric_samples</code>。
          </div>
        ) : (
          <>
            <ChartCard title="参会人数 / 发布轨道（跨房间求和）" note={`每个点是一个 ${overview.bucketSec}s 采样桶`}>
              <LineChart
                points={history}
                series={[
                  { name: '参会人数', color: '#0273fe', get: (p) => p.avgParticipants },
                  { name: '发布轨道', color: '#22c55e', get: (p) => p.avgTracks },
                ]}
              />
            </ChartCard>
            <ChartCard title="转发带宽（kbps）" note="按房间先算速率再求和：metric_samples 存的是累计字节，速率才是可比的量">
              <LineChart
                points={history}
                series={[{ name: 'kbps', color: '#f5a524', get: (p) => p.kbps }]}
                formatValue={(v) => `${v.toFixed(0)} kbps`}
              />
            </ChartCard>
            <ChartCard title="RTT / 丢包率" note="⚠ 这两列当前**未被采样**（采样器只写累计包数与字节），因此恒为 0；不画成「看起来正常」的平线">
              <LineChart
                points={history}
                series={[
                  { name: 'RTT(ms)', color: '#a855f7', get: (p) => p.avgRttMs },
                  { name: '丢包率', color: '#e5484d', get: (p) => p.avgLossRate * 100 },
                ]}
                formatValue={(v) => v.toFixed(2)}
              />
            </ChartCard>
          </>
        )}
      </section>

      {/* 防护计数 */}
      <section className="mx-auto mt-4 max-w-6xl">
        <h2 className="mb-2 text-sm font-semibold">健壮性计数（期望恒为 0）</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi label="协程 panic 已隔离" value={live?.goroutinePanics ?? '—'} />
          <Kpi label="超速断开连接" value={live?.messageFloods ?? '—'} />
          <Kpi label="畸形 RTCP 丢弃" value={live?.malformedRTCP ?? '—'} />
          <Kpi label="关键帧转发" value={live?.pliForwarded ?? '—'} />
          <Kpi label="关键帧限流" value={live?.pliSuppressed ?? '—'} />
        </div>
        <p className="mt-2 text-[11px] text-[var(--text-mute)]">
          前三个长期增长说明有客户端异常或存在 bug；"关键帧转发"增长说明弱网恢复在起作用（干净链路下为 0 是正常的）。
        </p>
      </section>

      {/* 逐轨道 */}
      <section className="mx-auto mt-4 max-w-6xl">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          逐轨道指标
          <a href="/metrics/tracks?format=csv" className="text-[11px] font-normal text-[var(--brand)] underline">
            下载 CSV
          </a>
          <span className="text-[11px] font-normal text-[var(--text-mute)]">（字段名对齐浏览器 getStats 口径）</span>
        </h2>
        <div className="tm-card overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-[var(--text-mute)]">
              <tr>
                {['房间', '类型/来源', '编码', 'PT', '包数', '字节', '丢包', '写失败', '订阅者', '录制'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tracks.length === 0 && (
                <tr><td colSpan={10} className="px-2 py-3 text-[var(--text-mute)]">当前没有发布中的轨道</td></tr>
              )}
              {tracks.map((t) => (
                <tr key={t.id} className="border-t border-[var(--line)]">
                  <td className="px-2 py-1.5">{t.roomId}</td>
                  <td className="px-2 py-1.5">{t.kind}/{t.source}</td>
                  <td className="px-2 py-1.5">{t.codec}</td>
                  <td className="px-2 py-1.5">{t.payloadType}</td>
                  <td className="px-2 py-1.5">{t.packets}</td>
                  <td className="px-2 py-1.5">{formatBytes(t.bytes)}</td>
                  <td className="px-2 py-1.5">{t.dropped}</td>
                  <td className={`px-2 py-1.5 ${t.writeFails > 0 ? 'text-amber-400' : ''}`}>{t.writeFails}</td>
                  <td className={`px-2 py-1.5 ${t.subscribers === 0 ? 'text-[var(--text-mute)]' : ''}`}>{t.subscribers}</td>
                  <td className="px-2 py-1.5">{t.recording ? '录制中' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 录制 */}
      <section className="mx-auto mt-4 max-w-6xl pb-8">
        <h2 className="mb-2 text-sm font-semibold">录制产物  <button className="text-[11px] font-normal text-[var(--brand)] underline" onClick={() => void loadRecordings()}>刷新</button>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="录制会话" value={recs?.sessions?.length ?? '—'} />
          <Kpi label="文件数" value={recFiles.length || '—'} />
          <Kpi label="总大小" value={recFiles.length ? formatBytes(recFiles.reduce((a, f) => a + f.sizeBytes, 0)) : '—'} />
          <Kpi label="录制能力" value={recs?.enabled ? '已开启' : '未开启'} />
        </div>
        {overview?.global && (
          <p className="mt-3 text-[11px] text-[var(--text-mute)]">
            数据库累计：{overview.global.sampleCount} 条样本 · 峰值 {overview.global.peakParticipants} 人 /{' '}
            {overview.global.peakTracks} 轨 · 累计转发 {formatBytes(overview.global.totalBytes)}
          </p>
        )}
      </section>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="tm-card px-3 py-2">
      <p className="text-[11px] text-[var(--text-mute)]">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function ChartCard({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="tm-card p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[11px] text-[var(--text-mute)]">{note}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * 极简折线图（纯 SVG）。
 * 说明：图表自己画，坐标轴只标最大值与时间范围——够读趋势，也便于论文里讲清楚口径。
 */
function LineChart<T extends { bucket: string }>({
  points,
  series,
  formatValue,
}: {
  points: T[]
  series: { name: string; color: string; get: (p: T) => number }[]
  formatValue?: (v: number) => string
}) {
  const W = 900
  const H = 160
  if (points.length < 2) {
    return <p className="py-6 text-center text-xs text-[var(--text-mute)]">数据点不足（至少需要 2 个采样桶）</p>
  }
  const max = Math.max(1, ...series.flatMap((s) => points.map((p) => s.get(p))))
  const x = (i: number) => (i / (points.length - 1)) * (W - 60) + 50
  const y = (v: number) => H - 24 - (v / max) * (H - 48)
  const t0 = new Date(points[0].bucket).toLocaleTimeString()
  const t1 = new Date(points[points.length - 1].bucket).toLocaleTimeString()

  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-3 text-[11px]">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.name}
            <span className="tabular-nums text-[var(--text-mute)]">
              {formatValue ? formatValue(s.get(points[points.length - 1])) : s.get(points[points.length - 1]).toFixed(0)}
            </span>
          </span>
        ))}
        <span className="ml-auto text-[var(--text-mute)]">峰值 {max.toFixed(max < 10 ? 2 : 0)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full">
        <line x1="50" y1={H - 24} x2={W - 10} y2={H - 24} stroke="var(--line)" strokeWidth="1" />
        <line x1="50" y1="10" x2="50" y2={H - 24} stroke="var(--line)" strokeWidth="1" />
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            points={points.map((p, i) => `${x(i)},${y(s.get(p))}`).join(' ')}
          />
        ))}
        <text x="50" y={H - 8} fontSize="10" fill="var(--text-mute)">{t0}</text>
        <text x={W - 10} y={H - 8} fontSize="10" fill="var(--text-mute)" textAnchor="end">{t1}</text>
      </svg>
    </div>
  )
}
