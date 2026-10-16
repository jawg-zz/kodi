import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const log = mutation({
  args: {
    event: v.string(),
    endpoint: v.string(),
    resultCode: v.number(),
    resultDesc: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    transId: v.optional(v.string()),
    ok: v.boolean(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('webhookLogs', args)
  },
})

export const recentLogs = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const logs = await ctx.db.query('webhookLogs').order('desc').take(args.limit ?? 12)
    const all = await ctx.db.query('webhookLogs').collect()
    const okCount = all.filter((l) => l.ok).length
    return {
      logs,
      successRate: all.length ? (okCount / all.length) * 100 : 100,
      p95: percentile(all.map((l) => l.latencyMs ?? 0), 0.95),
    }
  },
})

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
