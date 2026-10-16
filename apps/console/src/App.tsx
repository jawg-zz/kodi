import { useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import KpiCards, { KPI_ICONS, type Kpi } from './components/KpiCards'
import { ChannelDonut, CollectionsChart } from './components/Charts'
import TransactionsTable from './components/TransactionsTable'
import { AlertsPanel, LiveFeed, ReconCard, SettlementPanel, WebhookHealth } from './components/Panels'
import { useDashboardData } from './data/useDashboardData'
import { formatKES } from './data/generate'

const CHANNEL_COLORS: Record<string, string> = {
  'STK Push': '#43b02a',
  Paybill: '#4f8cff',
  Till: '#35c2d6',
  USSD: '#9b7bff',
  B2C: '#f5a524',
}

const SPARK_A = [12, 18, 15, 22, 19, 26, 24, 31, 28, 36, 33, 41]
const SPARK_B = [40, 44, 42, 49, 47, 53, 51, 58, 56, 61, 59, 66]

/** Syncs the active theme to <html data-theme>, for both live and mock modes. */
function useEffectDocumentTheme(theme: 'dark' | 'light') {
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [range, setRange] = useState('today')
  const [menuOpen, setMenuOpen] = useState(false)
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === 'qtd' ? 45 : 0

  const { txs, settlements, webhooks, alerts, series } = useDashboardData(days)

  useEffectDocumentTheme(theme)

  const kpis: Kpi[] = useMemo(() => {
    const gross = txs.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0)
    const ok = txs.filter((t) => t.status === 'success').length
    const failed = txs.filter((t) => t.status === 'failed').length
    const pending = txs.filter((t) => t.status === 'pending').reduce((s, t) => s + t.amount, 0)
    const settled = settlements.filter((s) => s.status === 'settled').reduce((s, x) => s + x.amount, 0)
    const successRate = txs.length ? (ok / txs.length) * 100 : 100
    const avg = ok ? gross / ok : 0
    const { Receipt, Activity, Percent, Timer, TrendingUp } = KPI_ICONS

    return [
      { label: 'Gross collections', value: formatKES(gross, true), delta: 12.4, foot: 'vs. yesterday', icon: Receipt, accent: '#43b02a', spark: SPARK_A },
      { label: 'Transactions', value: txs.length.toLocaleString(), delta: 8.1, foot: 'vs. yesterday', icon: Activity, accent: '#35c2d6', spark: SPARK_B },
      { label: 'Success rate', value: `${successRate.toFixed(1)}%`, delta: -0.6, foot: `${failed} failed`, icon: Percent, accent: '#4f8cff', spark: SPARK_A.slice(2) },
      { label: 'Avg. ticket', value: formatKES(avg), delta: 3.2, foot: 'per success tx', icon: TrendingUp, accent: '#9b7bff', spark: SPARK_B.slice(3) },
      { label: 'Settled to bank', value: formatKES(settled, true), delta: -2.1, foot: `${formatKES(pending, true)} pending`, icon: Timer, accent: '#f5a524', spark: SPARK_A.slice(4) },
    ]
  }, [txs, settlements])

  const slices = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of txs) counts[t.channel] = (counts[t.channel] ?? 0) + 1
    return Object.entries(CHANNEL_COLORS).map(([name, color]) => ({ name, color, value: counts[name] ?? 0 }))
  }, [txs])

  const matched = txs.filter((t) => t.status !== 'pending').length
  const unmatched = txs.filter((t) => t.status === 'pending').length

  return (
    <div className="app">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50 }}
        />
      )}

      <div className="main">
        <Topbar
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          range={range}
          onRange={setRange}
          onOpenMenu={() => setMenuOpen(true)}
        />

        <main className="content">
          <KpiCards kpis={kpis} />

          <section className="grid-2">
            <div className="card panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Collections trend</div>
                  <div className="panel-sub">
                    {days ? `Last ${days} days` : 'Today · hourly'} · dashed line = tx volume · bars = failures
                  </div>
                </div>
                <span className="badge plain">KES</span>
              </div>
              <div className="panel-body">
                <CollectionsChart data={series} />
              </div>
            </div>

            <div className="card panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Channel mix</div>
                  <div className="panel-sub">Share of transactions in window</div>
                </div>
              </div>
              <div className="panel-body">
                <ChannelDonut slices={slices} totalLabel="Total transactions" />
              </div>
            </div>
          </section>

          <TransactionsTable txs={txs} live />

          <section className="grid-3">
            <SettlementPanel settlements={settlements} />
            <WebhookHealth logs={webhooks} />
            <AlertsPanel alerts={alerts} />
          </section>

          <section className="grid-2">
            <ReconCard matched={matched} unmatched={unmatched} value={txs.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0)} />
            <div className="card panel">
              <div className="panel-head">
                <div>
                  <div className="panel-title">Live money movement <span className="tag-live" style={{ marginLeft: 6 }}><span className="dot" />streaming</span></div>
                  <div className="panel-sub">Instant push from C2B confirmation callbacks</div>
                </div>
              </div>
              <div className="panel-body" style={{ marginTop: 10 }}>
                <LiveFeed txs={txs} />
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
