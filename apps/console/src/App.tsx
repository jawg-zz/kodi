import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConvexAuth as useConvexAuthState } from 'convex/react'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import KpiCards, { KPI_ICONS, type Kpi } from './components/KpiCards'
import { ChannelDonut, CollectionsChart } from './components/Charts'
import TransactionsTable from './components/TransactionsTable'
import { AlertsPanel, LiveFeed, ReconCard, SettlementPanel, WebhookHealth } from './components/Panels'
import { useDashboardData, CONVEX_ENABLED } from './data/useDashboardData'
import { formatKES } from './data/generate'
import { useOptionalAuth } from './lib/auth'
import { logtoConfigured } from './lib/logto'
import { useTxUrlState } from './lib/urlState'
import { countNewer, watermark } from './lib/liveView'

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

/** Login gate: mock mode renders directly; live mode needs a Logto session. */
export default function App() {
  const auth = useOptionalAuth()
  if (CONVEX_ENABLED) {
    if (auth === null || auth.loading) return <AuthSplash />
    if (!auth.isAuthenticated) return <SignInScreen />
  }
  return <DashboardApp />
}

function AuthSplash() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-logo" style={{ margin: '0 auto' }}>K</div>
        <div className="brand-name" style={{ marginTop: 14 }}>KenyaPay</div>
        <div className="login-sub">Restoring session…</div>
      </div>
    </div>
  )
}

/**
 * Live-mode gate on Convex's own auth state: children (which run useQuery)
 * mount only after the backend has accepted the token, and unmount the
 * moment renewal fails — scoped queries can never fire unauthenticated.
 */
export function ConvexAuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuthState()
  if (isLoading) return <AuthSplash />
  if (!isAuthenticated) {
    return (
      <SignInScreen hint="Your session could not be renewed. Sign in again to continue." />
    )
  }
  return <AuthErrorBoundary>{children}</AuthErrorBoundary>
}

/** Last-resort guard so a stray server error can't blank the console. */
class AuthErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="login-wrap">
          <div className="login-card">
            <div className="brand-logo" style={{ margin: '0 auto' }}>K</div>
            <div className="login-sub" style={{ maxWidth: 360 }}>
              Something went wrong: {this.state.error.message}
            </div>
            <button className="login-btn" onClick={() => window.location.reload()}>
              Reload console
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function SignInScreen({ hint }: { hint?: string }) {
  const auth = useOptionalAuth()
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-logo" style={{ margin: '0 auto' }}>K</div>
        <div className="brand-name" style={{ marginTop: 14 }}>KenyaPay</div>
        <div className="brand-sub" style={{ marginTop: 2 }}>Merchant Ops Console</div>
        <p className="login-sub">
          {hint ?? 'Platform staff and operators sign in with their Kodi account.'}
        </p>
        <button
          className="login-btn"
          onClick={() => void auth?.signIn()}
          disabled={!logtoConfigured}
        >
          Sign in with Kodi
        </button>
        {!logtoConfigured && (
          <p className="login-err">Auth is not configured (VITE_LOGTO_ISSUER / VITE_LOGTO_APP_ID).</p>
        )}
      </div>
    </div>
  )
}

function DashboardApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [menuOpen, setMenuOpen] = useState(false)
  const [url, setUrl] = useTxUrlState()
  const range = url.range
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === 'qtd' ? 45 : 0

  const { txs, settlements, webhooks, alerts, series } = useDashboardData(days)

  // Live-update ergonomics: while paused the table holds a frozen snapshot
  // (reading stability); arrivals are counted, not rendered, until resume.
  const [paused, setPaused] = useState(false)
  const frozenRef = useRef<typeof txs>([])
  const [frozenAt, setFrozenAt] = useState(0)
  const togglePause = () => {
    if (paused) {
      setPaused(false)
    } else {
      frozenRef.current = txs
      setFrozenAt(watermark(txs))
      setPaused(true)
    }
  }
  const tableTxs = paused ? frozenRef.current : txs
  const newCount = paused ? countNewer(txs, frozenAt) : 0

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
      <Sidebar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        counts={{ transactions: txs.length, settlements: settlements.length, alerts: alerts.length }}
      />
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
          onRange={(v) => setUrl({ range: v })}
          search={url.q}
          onSearch={(q) => setUrl({ q })}
          onOpenMenu={() => setMenuOpen(true)}
        />

        <main className="content">
          <div id="sec-overview">
            <KpiCards kpis={kpis} />
          </div>

          <section className="grid-2" id="sec-charts">
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

          <TransactionsTable
            txs={tableTxs}
            live
            id="sec-transactions"
            q={url.q}
            onQ={(q) => setUrl({ q })}
            paused={paused}
            newCount={newCount}
            onTogglePause={togglePause}
          />

          <section className="grid-3">
            <SettlementPanel settlements={settlements} id="sec-settlements" />
            <WebhookHealth logs={webhooks} id="sec-webhooks" />
            <AlertsPanel alerts={alerts} id="sec-alerts" />
          </section>

          <section className="grid-2">
            <ReconCard matched={matched} unmatched={unmatched} value={txs.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0)} id="sec-recon" />
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
