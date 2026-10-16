import { AlertTriangle, CheckCircle2, Clock, Info, RefreshCw, Zap } from 'lucide-react'
import type { Alert, Settlement, Tx, WebhookLog } from '../data/types'
import { formatKES } from '../data/generate'

export const ago = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function LiveFeed({ txs }: { txs: Tx[] }) {
  const tone = (t: Tx) => (t.status === 'success' ? 'ok' : t.status === 'failed' ? 'bad' : 'wait')
  return (
    <div className="feed">
      {txs.slice(0, 14).map((t) => (
        <div className="feed-item" key={t.id}>
          <span className={`badge ${t.status}`} style={{ padding: '4px 7px' }}>{t.status[0].toUpperCase()}</span>
          <div className="fi-body">
            <div className="fi-name">{t.name} · {t.channel}</div>
            <div className="fi-sub">{t.code} · {ago(t.at)}</div>
          </div>
          <div className={`fi-amt ${tone(t)}`}>{t.status === 'failed' ? 'failed' : formatKES(t.amount)}</div>
        </div>
      ))}
    </div>
  )
}

export function SettlementPanel({ settlements }: { settlements: Settlement[] }) {
  const inbound = settlements.reduce((s, x) => s + x.amount, 0)
  const pending = settlements.filter((s) => s.status !== 'settled')
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Settlements</div>
          <div className="panel-sub">{formatKES(inbound)} across {settlements.length} batches</div>
        </div>
        <span className="badge plain">{pending.length} in flight</span>
      </div>
      <div className="list" style={{ marginTop: 12 }}>
        {settlements.map((s) => (
          <div className="list-row" key={s.id}>
            <div className="lr-main">
              <div className="lr-t">
                {s.batch}
                <span className={`badge ${s.status.replace(' ', '-')}`}>{s.status}</span>
              </div>
              <div className="lr-s">{s.bank} · {s.txCount.toLocaleString()} txs · {s.eta}</div>
            </div>
            <div className="lr-v">{formatKES(s.amount)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function WebhookHealth({ logs }: { logs: WebhookLog[] }) {
  const okRate = (logs.filter((l) => l.ok).length / logs.length) * 100
  const p95 = [...logs].map((l) => l.ms).sort((a, b) => a - b)[Math.floor(logs.length * 0.9)] ?? 0
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Webhook delivery</div>
          <div className="panel-sub">Callback endpoint /hooks/mpesa</div>
        </div>
        <span className={`badge ${okRate > 90 ? 'success' : 'pending'}`}>{okRate.toFixed(0)}% OK</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="meter"><span>Last 20 deliveries · p95 latency</span><b>{p95} ms</b></div>
        <div className="bar"><i style={{ width: `${okRate}%` }} /></div>
      </div>

      <div className="list" style={{ marginTop: 13 }}>
        {logs.slice(0, 5).map((l) => (
          <div className="list-row" key={l.id}>
            {l.ok
              ? <CheckCircle2 size={15} color="var(--green-2)" />
              : <AlertTriangle size={15} color="var(--red)" />}
            <div className="lr-main">
              <div className="lr-t" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{l.event}</div>
              <div className="lr-s">HTTP {l.httpStatus} · {l.ms} ms · {ago(l.at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  const Icon = { critical: AlertTriangle, warning: Clock, info: Info }
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Risk & alerts</div>
          <div className="panel-sub">Rule engine · 3 open incidents</div>
        </div>
        <RefreshCw size={14} color="var(--text-3)" />
      </div>
      <div className="list" style={{ marginTop: 12 }}>
        {alerts.map((a) => {
          const I = Icon[a.level]
          return (
            <div className={`alert-row ${a.level}`} key={a.id}>
              <span className="a-ico"><I size={15} /></span>
              <div>
                <div className="a-t">{a.title}</div>
                <div className="a-d">{a.detail}</div>
                <div className="a-time">{ago(a.at)}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ReconCard({ matched, unmatched, value }: { matched: number; unmatched: number; value: number }) {
  const pct = (matched / (matched + unmatched)) * 100
  return (
    <div className="card panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Auto-reconciliation</div>
          <div className="panel-sub">Statement vs. M-Pesa ledger (bank feed 15-min cadence)</div>
        </div>
        <span className="kpi-ico" style={{ ['--accent' as string]: 'var(--cyan)' }}><Zap size={15} /></span>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="meter">
          <span>Matched today</span>
          <b>{pct.toFixed(2)}%</b>
        </div>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="grid-3" style={{ marginTop: 14, gap: 10 }}>
        {[
          { k: 'Matched', v: matched.toLocaleString(), c: 'var(--green-2)' },
          { k: 'Unmatched', v: unmatched.toLocaleString(), c: 'var(--amber)' },
          { k: 'Value reconciled', v: formatKES(value, true), c: 'var(--cyan)' },
        ].map((s) => (
          <div key={s.k} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: '10px 11px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700 }}>{s.k}</div>
            <div style={{ fontSize: 16, fontWeight: 750, marginTop: 4, color: s.c, fontVariantNumeric: 'tabular-nums' }}>{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
