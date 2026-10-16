import { v } from 'convex/values'
import { query, mutation } from './_generated/server'

export const CHANNELS = ['STK Push', 'Paybill', 'Till', 'USSD', 'B2C'] as const
export const STATUSES = ['success', 'pending', 'failed', 'reversed'] as const

export const list = query({
  args: {
    limit: v.optional(v.number()),
    channel: v.optional(v.union(...CHANNELS.map((c) => v.literal(c)) as [any, ...any[]])),
    status: v.optional(v.union(...STATUSES.map((s) => v.literal(s)) as [any, ...any[]])),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let txs = await ctx.db.query('transactions').order('desc').take(args.limit ?? 200)
    if (args.channel) txs = txs.filter((t) => t.channel === args.channel)
    if (args.status) txs = txs.filter((t) => t.status === args.status)
    if (args.search) {
      const q = args.search.toLowerCase()
      txs = txs.filter(
        (t) =>
          t.code.toLowerCase().includes(q) ||
          t.reference.toLowerCase().includes(q) ||
          (t.payerName?.toLowerCase().includes(q) ?? false) ||
          (t.msisdn?.includes(q) ?? false),
      )
    }
    return txs
  },
})

/** Live feed: newest N, used by the table + live ticker. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    ctx.db.query('transactions').order('desc').take(args.limit ?? 20),
})

/** Everything the KPI cards, donut and trend chart need, computed server-side. */
export const kpis = query({
  args: {},
  handler: async (ctx) => {
    const txs = await ctx.db.query('transactions').order('desc').take(5000)
    const success = txs.filter((t) => t.status === 'success')
    const gross = success.reduce((s, t) => s + t.amount, 0)
    const fees = success.reduce((s, t) => s + t.fee, 0)

    const byChannel = CHANNELS.map((c) => {
      const rows = success.filter((t) => t.channel === c)
      return {
        channel: c,
        txCount: rows.length,
        total: rows.reduce((s, t) => s + t.amount, 0),
      }
    })

    // hourly buckets over the last 24h
    const now = Date.now()
    const hours: { hour: string; collections: number; txCount: number; failures: number }[] = []
    for (let i = 23; i >= 0; i--) {
      const start = now - (i + 1) * 3_600_000
      const end = now - i * 3_600_000
      const rows = txs.filter((t) => t._creationTime > start && t._creationTime <= end)
      const ok = rows.filter((t) => t.status === 'success')
      hours.push({
        hour: new Date(end).toISOString().slice(11, 16),
        collections: ok.reduce((s, t) => s + t.amount, 0),
        txCount: rows.length,
        failures: rows.filter((t) => t.status === 'failed').length,
      })
    }

    return {
      grossCollections: gross,
      txCount: txs.length,
      successRate: txs.length ? (success.length / txs.length) * 100 : 0,
      avgTicket: success.length ? gross / success.length : 0,
      totalFees: fees,
      byChannel,
      hourly: hours,
    }
  },
})

/** Daraja callbacks insert here — idempotent on TransID. */
export const ingest = mutation({
  args: {
    code: v.string(),
    reference: v.string(),
    channel: v.string(),
    direction: v.union(v.literal('CR'), v.literal('DR')),
    msisdn: v.optional(v.string()),
    payerName: v.optional(v.string()),
    amount: v.number(),
    fee: v.number(),
    status: v.union(
      v.literal('success'),
      v.literal('pending'),
      v.literal('failed'),
      v.literal('reversed'),
    ),
    failureReason: v.optional(v.string()),
    raw: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('transactions')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .first()
    if (existing) {
      // a later callback (e.g. STK result) upgrades the row instead of duplicating
      if (existing.status !== args.status || existing.amount !== args.amount) {
        await ctx.db.patch(existing._id, {
          status: args.status,
          amount: args.amount,
          failureReason: args.failureReason,
          raw: args.raw,
        })
      }
      return { id: existing._id, deduped: true }
    }
    const channel = (CHANNELS as readonly string[]).includes(args.channel)
      ? (args.channel as (typeof CHANNELS)[number])
      : 'STK Push'
    const id = await ctx.db.insert('transactions', { ...args, channel, source: 'daraja' })
    return { id, deduped: false }
  },
})
