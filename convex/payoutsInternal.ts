import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { audit } from "./lib/auth";

/**
 * Internal backing for payouts.ts actions (actions cannot touch ctx.db):
 * org-scoped payment/tenant reads, B2C job↔settlement linking, and
 * settlement payout-state flips driven by the async-result callbacks.
 */

export const getPaymentForReversal = internalQuery({
  args: { paymentId: v.id("payments"), orgId: v.id("orgs") },
  returns: v.union(
    v.object({
      status: v.optional(
        v.union(
          v.literal("active"),
          v.literal("voided"),
          v.literal("refunded"),
        ),
      ),
      mpesaCode: v.optional(v.string()),
      amount: v.number(),
      tenantId: v.id("tenants"),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null || p.orgId !== args.orgId) return null;
    return {
      status: p.status,
      mpesaCode: p.mpesaCode,
      amount: p.amount,
      tenantId: p.tenantId,
    };
  },
});

export const getTenantForPayout = internalQuery({
  args: { tenantId: v.id("tenants"), orgId: v.id("orgs") },
  returns: v.union(
    v.object({ fullName: v.string(), phone: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.tenantId);
    if (t === null || t.orgId !== args.orgId) return null;
    return { fullName: t.full_name, phone: t.phone };
  },
});

export const linkB2cJob = internalMutation({
  args: {
    jobId: v.id("darajaJobs"),
    settlementId: v.optional(v.id("depositSettlements")),
    actorUserId: v.string(),
    orgId: v.id("orgs"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    if (args.settlementId !== undefined) {
      const s = await ctx.db.get(args.settlementId);
      if (s !== null && s.orgId === args.orgId) {
        await ctx.db.patch(s._id, {
          b2cConversationId: job.conversationId,
          b2cStatus: "pending",
        });
      }
    }
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: args.actorUserId,
      action: "b2c.payout_fired",
      entityType: "darajaJobs",
      entityId: String(args.jobId),
      metadata: job.conversationId,
    });
    return null;
  },
});

/**
 * Flip settlement payout state from a B2C result callback. Called from
 * the async-result dispatch path (see http.ts handleAsync extension in
 * the payouts wiring step): done → sent (+receipt when Daraja echoes
 * one in rawResult), failed/timeout → failed.
 */
export const settleB2cResult = internalMutation({
  args: {
    originatorConversationId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    ok: v.boolean(),
    receipt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ids = [args.originatorConversationId, args.conversationId].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    let job = null;
    for (const id of ids) {
      job = await ctx.db
        .query("darajaJobs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", id))
        .first();
      if (job !== null) break;
    }
    if (job === null || job.kind !== "b2c") return null;
    const settlements = await ctx.db
      .query("depositSettlements")
      .withIndex("by_org", (q) => q.eq("orgId", job.orgId))
      .collect();
    const hit = settlements.find(
      (s) => s.b2cConversationId === job.conversationId,
    );
    if (hit === null || hit === undefined) return null;
    await ctx.db.patch(hit._id, {
      b2cStatus: args.ok ? "sent" : "failed",
      b2cReceipt: args.receipt ?? hit.b2cReceipt,
    });
    return null;
  },
});
