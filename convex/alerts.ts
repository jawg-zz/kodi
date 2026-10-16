import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const list = query({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query('alerts')
      .filter((q) => q.eq(q.field('acked'), false))
      .order('desc')
      .take(8),
})

export const ack = mutation({
  args: { id: v.id('alerts') },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { acked: true })
  },
})
