import { v } from 'convex/values'
import { query } from './_generated/server'
import type { Id } from './_generated/dataModel'

/**
 * KenyaPay ops-console read model over kodi's REAL flow tables merged with
 * the /hooks/mpesa mirror feed. Read-only, public (see AGENTS.md: console
 * auth via Logto is a planned follow-up).
 *
 * Money-safety rule: a source row only appears if its money is NOT already
 * represented by another source:
 *  - `payments` (mpesa_* methods)  = recognized collections
 *  - `c2bPayments` with paymentId  = excluded (allocated -> already payments)
 *  - `mpesaTransactions` w/ paymentId = excluded (recorded -> already payments)
 *  - mirror `transactions`         = simulator/webhook feed (own lane)
 */

type Channel = 'STK Push' | 'Paybill' | 'Till' | 'USSD' | 'B2C'
type Status = 'success' | 'pending' | 'failed' | 'reversed'

interface StreamRow {
  _id: string
  code: string
  reference: string
  msisdn: string
  payerName: string
  amount: number
  fee: number
  channel: Channel
  status: Status
  source: 'rent' | 'c2b' | 'stk' | 'feed'
  at: number
}

const MESA_METHODS = new Set(['mpesa_stk', 'mpesa_manual', 'mpesa_c2b'])

const METHOD_CHANNEL: Record<string, Channel> = {
  mpesa_stk: 'STK Push',
  mpesa_manual: 'Paybill',
  mpesa_c2b: 'Paybill',
}

/** Daraja wall-clock "YYYYMMDDHHmmss" in EAT (UTC+3) -> epoch ms. */
function darajaTime(s: string): number | null {
  if (!/^\d{14}$/.test(s)) return null
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8)
  const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14)
  return Date.UTC(y, mo - 1, d, h - 3, mi, se)
}

export const transactions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 500, 1000)
    const rows: StreamRow[] = []

    const tenants = new Map<Id<'tenants'>, { name: string; phone: string }>()
    for (const t of await ctx.db.query('tenants').collect()) {
      tenants.set(t._id, { name: t.full_name || '—', phone: t.phone ?? '—' })
    }
    const fees = new Map<string, number>()
    for (const p of await ctx.db.query('platformCollections').collect()) {
      fees.set(p.paymentId, p.fee ?? 0)
    }

    for (const p of await ctx.db.query('payments').collect()) {
      if (!MESA_METHODS.has(p.method)) continue
      const t = tenants.get(p.tenantId)
      rows.push({
        _id: p._id,
        code: p.mpesaCode ?? p.receiptNo,
        reference: p.receiptNo,
        msisdn: t?.phone ?? '—',
        payerName: t?.name ?? '—',
        amount: p.amount,
        fee: fees.get(p._id) ?? 0,
        channel: METHOD_CHANNEL[p.method],
        status: p.status === 'voided' ? 'failed' : p.status === 'refunded' ? 'reversed' : 'success',
        source: 'rent',
        at: p.paidAt,
      })
    }

    for (const c of await ctx.db.query('c2bPayments').collect()) {
      if (c.paymentId) continue
      rows.push({
        _id: c._id,
        code: c.transId,
        reference: c.billRef ?? '—',
        msisdn: c.msisdn ?? '—',
        payerName: [c.firstName, c.lastName].filter(Boolean).join(' ') || '—',
        amount: c.transAmount,
        fee: 0,
        channel: 'Paybill',
        status: c.status === 'matched' ? 'success' : c.status === 'rejected' ? 'failed' : 'pending',
        source: 'c2b',
        at: (c.transTime && darajaTime(c.transTime)) || c._creationTime,
      })
    }

    for (const m of await ctx.db.query('mpesaTransactions').collect()) {
      if (m.paymentId) continue
      const t = m.tenantId ? tenants.get(m.tenantId) : undefined
      rows.push({
        _id: m._id,
        code: m.mpesaReceipt ?? m.checkoutRequestId,
        reference: m.checkoutRequestId,
        msisdn: m.phone ?? '—',
        payerName: t?.name ?? '—',
        amount: m.amount,
        fee: 0,
        channel: 'STK Push',
        status: m.status === 'timeout' ? 'failed' : m.status,
        source: 'stk',
        at: m._creationTime,
      })
    }

    for (const d of await ctx.db.query('transactions').order('desc').take(limit)) {
      rows.push({
        _id: d._id,
        code: d.code,
        reference: d.reference ?? '—',
        msisdn: d.msisdn ?? '—',
        payerName: d.payerName ?? '—',
        amount: d.amount,
        fee: d.fee,
        channel: d.channel,
        status: d.status,
        source: 'feed',
        at: d._creationTime,
      })
    }

    rows.sort((a, b) => b.at - a.at)
    return rows.slice(0, limit)
  },
})

export const settlements = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 24, 100)
    interface Row {
      _id: string
      batch: string
      amount: number
      txCount: number
      bank: string
      status: 'sent' | 'processing' | 'expected'
      eta: string
      at: number
    }
    const rows: Row[] = []

    // Platform fee shares, grouped by sweep/payout reference.
    const groups = new Map<string, Row>()
    for (const p of await ctx.db.query('platformCollections').collect()) {
      const key = p.payoutRef ?? 'platform-hold'
      const at = p.settledAt ?? p._creationTime
      const g = groups.get(key)
      if (g) {
        g.amount += p.amount
        g.txCount += 1
        g.at = Math.max(g.at, at)
      } else {
        groups.set(key, {
          _id: `pc-${key}`,
          batch: p.payoutRef ? `Sweep ${p.payoutRef.slice(0, 8)}` : 'Platform hold',
          amount: p.amount,
          txCount: 1,
          bank: p.settleKind === 'auto' ? 'M-Pesa forwarder' : 'Operator payout',
          status: p.settledAt ? 'sent' : 'expected',
          eta: p.settledAt ? '—' : 'hold window',
          at,
        })
      }
    }
    rows.push(...groups.values())

    const deposits = await ctx.db.query('depositSettlements').collect()
    if (deposits.length) {
      rows.push({
        _id: 'ds-hold',
        batch: 'Deposit refunds',
        amount: deposits.reduce((s, d) => s + (d.refundAmount || d.depositHeld), 0),
        txCount: deposits.length,
        bank: 'Tenant refunds',
        status: deposits.every((d) => d.settledBy) ? 'sent' : 'expected',
        eta: '—',
        at: Math.max(...deposits.map((d) => d._creationTime)),
      })
    }

    // Mirror batches (simulator roll-ups) pass through untouched.
    for (const s of await ctx.db.query('settlements').order('desc').take(limit)) {
      rows.push({
        _id: s._id,
        batch: s.batch,
        amount: s.amount,
        txCount: s.txCount,
        bank: s.bank,
        status: s.status,
        eta: s.eta ?? '—',
        at: s._creationTime,
      })
    }

    rows.sort((a, b) => b.at - a.at)
    return rows.slice(0, limit)
  },
})

interface LogRow {
  _id: string
  event: string
  ok: boolean
  latencyMs?: number
  _creationTime: number
}

const FAILED_OUTCOME = /(fail|error|reject|timeout|\b5\d\d)/i
const FAILED_JOB = /(fail|error|timeout)/i

export const webhookHealth = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows: LogRow[] = []

    for (const w of await ctx.db.query('webhookLog').order('desc').take(200)) {
      rows.push({
        _id: w._id,
        event: w.route,
        ok: !FAILED_OUTCOME.test(w.outcome),
        latencyMs: w.latencyMs,
        _creationTime: w._creationTime,
      })
    }

    for (const j of await ctx.db.query('darajaJobs').order('desc').take(100)) {
      rows.push({
        _id: j._id,
        event: `daraja ${j.kind}`,
        ok: !FAILED_JOB.test(j.status),
        _creationTime: j._creationTime,
      })
    }

    for (const l of await ctx.db.query('webhookLogs').order('desc').take(100)) {
      rows.push({
        _id: l._id,
        event: l.event,
        ok: l.ok,
        latencyMs: l.latencyMs,
        _creationTime: l._creationTime,
      })
    }

    rows.sort((a, b) => b._creationTime - a._creationTime)
    const timed = rows.map((r) => r.latencyMs).filter((ms): ms is number => ms != null)
    const sorted = [...timed].sort((a, b) => a - b)
    return {
      logs: rows.slice(0, Math.min(args.limit ?? 8, 50)),
      successRate: rows.length ? (rows.filter((r) => r.ok).length / rows.length) * 100 : 100,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
    }
  },
})

export const alerts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    interface AlertRow {
      _id: string
      severity: 'high' | 'medium' | 'low'
      title: string
      detail?: string
      acknowledged?: boolean
      _creationTime: number
    }
    const rows: AlertRow[] = []

    for (const a of await ctx.db.query('paymentAlerts').order('desc').take(200)) {
      const severity = /fail|error|stuck|blocked/i.test(a.kind)
        ? 'high'
        : /orphan|unmatched|duplicate|review|pending|hold|mismatch|forward/i.test(a.kind)
          ? 'medium'
          : 'low'
      rows.push({
        _id: a._id,
        severity: severity as AlertRow['severity'],
        title: a.title,
        detail: a.detail,
        acknowledged: a.acknowledged,
        _creationTime: a._creationTime,
      })
    }

    for (const a of await ctx.db.query('alerts').order('desc').take(200)) {
      rows.push({
        _id: a._id,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        _creationTime: a._creationTime,
      })
    }

    rows.sort((a, b) => b._creationTime - a._creationTime)
    return rows.slice(0, Math.min(args.limit ?? 40, 100))
  },
})
