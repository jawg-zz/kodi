import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { audit } from "./lib/auth";

/**
 * Internal mutation backing for verify.ts actions (actions cannot touch
 * ctx.db directly): pull registration flags, nightly cursors, audit rows.
 */

export const setPullRegistered = internalMutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row !== null) await ctx.db.patch(row._id, { pullRegistered: true });
    return null;
  },
});

export const markPullCursor = internalMutation({
  args: {
    orgId: v.id("orgs"),
    actorUserId: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row !== null) await ctx.db.patch(row._id, { lastPullAt: Date.now() });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: args.actorUserId,
      action: "pull.window",
      entityType: "mpesaCredentials",
      metadata: args.summary,
    });
    return null;
  },
});

export const markBalanceCursor = internalMutation({
  args: {
    orgId: v.id("orgs"),
    actorUserId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row !== null) await ctx.db.patch(row._id, { lastBalanceAt: Date.now() });
    return null;
  },
});
