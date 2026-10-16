import { internalMutation, query } from './_generated/server'

export const list = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query('settlements').order('desc').take(6),
})

/** Marks transactions pending > 2h as failed (cron). */
export const expireStuckPendings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 2 * 3_600_000
    const stuck = await ctx.db
      .query('transactions')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .collect()
    let n = 0
    for (const t of stuck) {
      if (t._creationTime < cutoff) {
        await ctx.db.patch(t._id, {
          status: 'failed',
          failureReason: 'timeout: no callback received',
        })
        n++
      }
    }
    return { expired: n }
  },
})

/** Creates today's expected settlement batch from success volume (cron). */
export const rollUpBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const today = await ctx.db
      .query('transactions')
      .filter((q) => q.gte(q.field('_creationTime'), startOfDay.getTime()))
      .collect()
    const ok = today.filter((t) => t.status === 'success' && t.direction === 'CR')
    if (!ok.length) return { skipped: true }
    const amount = ok.reduce((s, t) => s + t.amount, 0)
    const batch = `BATCH-${new Date().toISOString().slice(0, 10)}`
    await ctx.db.insert('settlements', {
      batch,
      bank: 'KCB ••4471',
      amount,
      txCount: ok.length,
      status: 'expected',
      eta: 'T+1 09:00 EAT',
    })
    return { batch, amount, txCount: ok.length }
  },
})
