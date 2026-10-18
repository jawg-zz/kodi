import { useEffect } from 'react'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { Copy, X } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import { CONVEX_ENABLED } from '../data/useDashboardData'
import type { Tx } from '../data/types'
import { formatKES } from '../data/generate'

type Detail = FunctionReturnType<typeof api.console.transactionDetail>

const SOURCE_LABEL: Record<string, string> = {
  rent: 'Rent allocation',
  c2b: 'C2B (Paybill orphan)',
  stk: 'STK attempt',
  feed: 'Daraja webhook feed',
}

/** Mock builds have no Convex provider — the hook must stay hook-shaped. */
const useTxDetailLive = (tx: Tx | null): Detail | undefined =>
  useQuery(
    api.console.transactionDetail,
    tx?.source ? { source: tx.source, id: tx.id } : 'skip',
  )

/** Seeded mock rows have no backend to join — synthesize a plausible trail. */
function mockDetail(tx: Tx): Detail {
  const failed = tx.status === 'failed'
  const out: Detail = {
    webhooks: [
      {
        at: tx.at,
        event: '/hooks/mpesa',
        ok: !failed,
        detail: failed ? 'Daraja result code 1 (insufficient funds)' : 'accepted',
        latencyMs: 120 + (tx.code.charCodeAt(3) % 400),
        kind: 'mirror',
      },
    ],
    feed: {
      code: tx.code,
      reference: tx.reference,
      direction: tx.channel === 'B2C' ? 'DR' : 'CR',
      source: 'daraja',
      at: tx.at,
      failureReason: failed ? 'Insufficient funds (result code 1)' : undefined,
      raw: {
        TransID: tx.code,
        TransAmount: tx.amount,
        MSISDN: tx.msisdn,
        BusinessShortCode: '247247',
        TransactionType: tx.channel === 'B2C' ? 'BusinessPayment' : 'Pay Bill',
      },
    },
    tenant: { name: tx.name, phone: tx.msisdn },
  }
  if (tx.status === 'success') {
    out.payment = {
      amount: tx.amount,
      method: 'mpesa_c2b',
      mpesaCode: tx.code,
      receiptNo: tx.reference,
      paidAt: tx.at,
      status: 'active',
      allocations: [],
    }
    if (tx.fee > 0) {
      out.collection = {
        amount: tx.amount,
        fee: tx.fee,
        settledAt: tx.at + 3_600_000,
        payoutRef: `PO-${tx.code}`,
        settleKind: 'auto',
      }
    }
  }
  return out
}

const useTxDetailMock = (tx: Tx | null): Detail | undefined => (tx ? mockDetail(tx) : undefined)

const useTxDetail: (tx: Tx | null) => Detail | undefined = CONVEX_ENABLED
  ? useTxDetailLive
  : useTxDetailMock

const absTime = (at: number) =>
  new Date(at).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

function CopyBtn({ text }: { text: string }) {
  return (
    <button
      className="copy-btn"
      title="Copy code"
      onClick={() => void navigator.clipboard?.writeText(text)}
    >
      <Copy size={12} />
    </button>
  )
}

function Step({ label, at, detail }: { label: string; at?: number; detail?: string }) {
  return (
    <li>
      <span className="lc-dot" />
      <div>
        <div className="lc-label">{label}{at ? <span className="lc-at"> · {absTime(at)}</span> : null}</div>
        {detail && <div className="lc-detail">{detail}</div>}
      </div>
    </li>
  )
}

function pretty(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return null
  }
}

export default function TransactionDrawer({ tx, onClose }: { tx: Tx | null; onClose: () => void }) {
  const detail = useTxDetail(tx)

  useEffect(() => {
    if (!tx) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tx, onClose])

  if (!tx) return null

  const raw = pretty(detail?.c2b?.rawPayload ?? detail?.feed?.raw)
  const src = tx.source ?? 'feed'

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Transaction ${tx.code}`}>
        <div className="drawer-head">
          <div>
            <div className="drawer-code">
              <span className="mono">{tx.code}</span>
              <CopyBtn text={tx.code} />
            </div>
            <div className="drawer-sub">{SOURCE_LABEL[src] ?? src}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="drawer-amount">
          {tx.status === 'failed' ? '—' : formatKES(tx.amount)}
          <span className={`badge ${tx.status}`} style={{ marginLeft: 10 }}>{tx.status}</span>
        </div>

        <dl className="dl-grid">
          <dt>Channel</dt><dd><span className="chan">{tx.channel}</span></dd>
          <dt>Payer</dt><dd>{tx.name}</dd>
          <dt>MSISDN</dt><dd className="mono">{tx.msisdn}</dd>
          <dt>Reference</dt><dd className="mono">{tx.reference}</dd>
          <dt>Time</dt><dd>{absTime(tx.at)}</dd>
          <dt>Fee</dt><dd>{tx.fee ? `KES ${tx.fee}` : '—'}</dd>
        </dl>

        {detail === undefined && CONVEX_ENABLED && (
          <div className="drawer-note">Loading lifecycle…</div>
        )}

        {detail && (
          <>
            {(detail.checkout || detail.c2b || detail.payment || detail.feed) && (
              <section>
                <div className="drawer-sec">Lifecycle</div>
                <ul className="lifecycle">
                  {src === 'stk' && detail.checkout && (
                    <Step label="STK push initiated" at={detail.checkout.at}
                      detail={detail.checkout.initiatedBy ? `by ${detail.checkout.initiatedBy}` : detail.checkout.checkoutRequestId} />
                  )}
                  {src === 'stk' && detail.checkout && (
                    <Step label={`Result: ${detail.checkout.status}`}
                      detail={[detail.checkout.resultDesc, detail.checkout.resultCode != null ? `(code ${detail.checkout.resultCode})` : null]
                        .filter(Boolean).join(' ') || undefined} />
                  )}
                  {src === 'c2b' && detail.c2b && (
                    <Step label="C2B received" at={detail.c2b.at}
                      detail={detail.c2b.billRef ? `Bill ref ${detail.c2b.billRef}` : undefined} />
                  )}
                  {src === 'c2b' && detail.c2b && (
                    <Step label={`Review: ${detail.c2b.status}`} detail={detail.c2b.matchReason} />
                  )}
                  {src === 'feed' && detail.feed && (
                    <Step label="Webhook received" at={detail.feed.at}
                      detail={`Direction ${detail.feed.direction} · source ${detail.feed.source}`} />
                  )}
                  {src === 'feed' && detail.feed?.failureReason && (
                    <Step label="Failure reason" detail={detail.feed.failureReason} />
                  )}
                  {detail.payment && (
                    <Step label="Recognized as payment" at={detail.payment.paidAt}
                      detail={`${detail.payment.method} · receipt ${detail.payment.receiptNo}${detail.payment.status !== 'active' ? ` · ${detail.payment.status}` : ''}`} />
                  )}
                  {detail.collection?.settledAt && (
                    <Step label="Platform fee settled" at={detail.collection.settledAt}
                      detail={`fee KES ${detail.collection.fee ?? 0}${detail.collection.payoutRef ? ` · payout ${detail.collection.payoutRef}` : ''}${detail.collection.settleKind ? ` (${detail.collection.settleKind})` : ''}`} />
                  )}
                  {detail.payment && !detail.collection?.settledAt && (
                    <li>
                      <span className="lc-dot warn" />
                      <div>
                        <div className="lc-label">Platform settlement</div>
                        <div className="lc-detail">No platform collection recorded yet</div>
                      </div>
                    </li>
                  )}
                </ul>
              </section>
            )}

            {detail.tenant && (
              <section>
                <div className="drawer-sec">Tenant{detail.org ? ` · ${detail.org.name}` : ''}</div>
                <dl className="dl-grid">
                  <dt>Name</dt><dd>{detail.tenant.name}</dd>
                  <dt>Phone</dt><dd className="mono">{detail.tenant.phone}</dd>
                </dl>
              </section>
            )}

            {detail.payment && detail.payment.allocations.length > 0 && (
              <section>
                <div className="drawer-sec">Invoice allocations</div>
                <dl className="dl-grid">
                  {detail.payment.allocations.map((a, i) => (
                    <div key={i} style={{ display: 'contents' }}>
                      <dt>{a.month ?? `#${i + 1}`}</dt>
                      <dd className="num">{formatKES(a.amount)}</dd>
                    </div>
                  ))}
                  {detail.payment.leftoverCredit ? (
                    <div style={{ display: 'contents' }}>
                      <dt>Leftover credit</dt>
                      <dd className="num">{formatKES(detail.payment.leftoverCredit)}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            )}

            {detail.checkout?.mpesaReceipt && (
              <section>
                <div className="drawer-sec">M-Pesa receipt</div>
                <div className="drawer-code">
                  <span className="mono">{detail.checkout.mpesaReceipt}</span>
                  <CopyBtn text={detail.checkout.mpesaReceipt} />
                </div>
              </section>
            )}

            <section>
              <div className="drawer-sec">Webhook evidence</div>
              {detail.webhooks.length === 0 ? (
                <div className="drawer-note">No webhook deliveries recorded for this code.</div>
              ) : (
                <ul className="hook-list">
                  {detail.webhooks.map((h, i) => (
                    <li key={i}>
                      <span className={`dot-sm ${h.ok ? 'ok' : 'bad'}`} />
                      <span className="hook-event">{h.event}</span>
                      <span className="hook-meta">
                        {h.latencyMs != null ? `${h.latencyMs}ms · ` : ''}{absTime(h.at)}
                      </span>
                      {h.detail && <div className="lc-detail">{h.detail}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {raw && (
              <section>
                <div className="drawer-sec">Raw payload</div>
                <pre className="raw-payload">{raw}</pre>
              </section>
            )}
          </>
        )}
      </aside>
    </>
  )
}
