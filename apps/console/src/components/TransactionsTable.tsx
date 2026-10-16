import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Search } from 'lucide-react'
import type { Tx } from '../data/types'
import { formatKES } from '../data/generate'

type StatusFilter = 'all' | Tx['status']
type SortKey = 'at' | 'amount'

const CHANNEL_COLORS: Record<string, string> = {
  'STK Push': '#43b02a',
  Paybill: '#4f8cff',
  Till: '#35c2d6',
  USSD: '#9b7bff',
  B2C: '#f5a524',
}

const initials = (name: string) => name.split(' ').map((p) => p[0]).join('').slice(0, 2)
const time = (at: number) =>
  new Date(at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const PAGE_SIZE = 9

export default function TransactionsTable({ txs, live, id }: { txs: Tx[]; live: boolean; id?: string }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [channel, setChannel] = useState('all')
  const [sort, setSort] = useState<SortKey>('at')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = txs.filter((t) => {
      if (status !== 'all' && t.status !== status) return false
      if (channel !== 'all' && t.channel !== channel) return false
      if (!needle) return true
      return (
        t.code.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle) ||
        t.msisdn.includes(needle) ||
        t.reference.toLowerCase().includes(needle)
      )
    })
    out.sort((a, b) => (dir === 'desc' ? b[sort] - a[sort] : a[sort] - b[sort]))
    return out
  }, [txs, q, status, channel, sort, dir])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, pages)
  const view = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else { setSort(key); setDir('desc') }
    setPage(1)
  }

  const arrow = (key: SortKey) =>
    sort === key ? (dir === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />) : null

  return (
    <div className="card panel" id={id}>
      <div className="panel-head">
        <div>
          <div className="panel-title">
            Transactions {live && <span className="tag-live" style={{ marginLeft: 8 }}><span className="dot" />live</span>}
          </div>
          <div className="panel-sub">C2B and B2C flows across all shortcodes · {rows.length.toLocaleString()} matching</div>
        </div>
        <div className="table-tools">
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-3)' }} />
            <input
              className="input"
              style={{ paddingLeft: 28, width: 190 }}
              placeholder="Code, name, ref…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
            />
          </div>
          <select className="select" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1) }}>
            <option value="all">All channels</option>
            {Object.keys(CHANNEL_COLORS).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1) }}>
            <option value="all">Any status</option>
            <option value="success">Success</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="reversed">Reversed</option>
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('at')}>Time {arrow('at')}</th>
              <th>Customer</th>
              <th>Transaction code</th>
              <th>Reference</th>
              <th>Channel</th>
              <th className="num">Fee</th>
              <th className="num sortable" onClick={() => toggleSort('amount')}>Amount {arrow('amount')}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={8} className="empty">No transactions match these filters.</td></tr>
            )}
            {view.map((t) => (
              <tr key={t.id}>
                <td className="mono">{time(t.at)}</td>
                <td>
                  <div className="cell-user">
                    <span className="mini" style={{ background: CHANNEL_COLORS[t.channel] }}>{initials(t.name)}</span>
                    <span>
                      <div className="nm">{t.name}</div>
                      <div className="ph">{t.msisdn}</div>
                    </span>
                  </div>
                </td>
                <td className="mono">
                  {t.code}
                  {t.source && <span className="src-tag" data-src={t.source}>{t.source}</span>}
                </td>
                <td className="mono">{t.reference}</td>
                <td><span className="chan">{t.channel}</span></td>
                <td className="num" style={{ color: 'var(--text-3)', fontWeight: 500 }}>
                  {t.fee ? `KES ${t.fee}` : '—'}
                </td>
                <td className="num">{t.status === 'failed' ? '—' : formatKES(t.amount)}</td>
                <td><span className={`badge ${t.status}`}>{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-foot">
        <span>
          Showing {view.length ? (safePage - 1) * PAGE_SIZE + 1 : 0}–{(safePage - 1) * PAGE_SIZE + view.length} of {rows.length.toLocaleString()}
        </span>
        <div className="pager">
          <button disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>‹</button>
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((p) => Math.abs(p - safePage) <= 1 || p === 1 || p === pages)
            .map((p, i, arr) => (
              <span key={p} style={{ display: 'contents' }}>
                {i > 0 && arr[i - 1] !== p - 1 && <button disabled>…</button>}
                <button className={p === safePage ? 'on' : ''} onClick={() => setPage(p)}>{p}</button>
              </span>
            ))}
          <button disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>›</button>
        </div>
      </div>
    </div>
  )
}
