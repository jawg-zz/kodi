import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { audit } from "./lib/auth";

/** Internal backing for ratiba.ts mandate rows. */

export const openMandate = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    mandateName: v.string(),
    amount: v.number(),
    frequency: v.string(),
  },
  returns: v.id("ratibaMandates"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("ratibaMandates", {
      orgId: args.orgId,
      tenantId: args.tenantId,
      mandateName: args.mandateName,
      amount: args.amount,
      frequency: args.frequency,
      status: "pending",
    });
  },
});

export const getMandate = internalQuery({
  args: { mandateId: v.id("ratibaMandates") },
  returns: v.union(
    v.object({
      orgId: v.id("orgs"),
      tenantId: v.id("tenants"),
      mandateName: v.string(),
      amount: v.number(),
      status: v.union(
        v.literal("pending"),
        v.literal("active"),
        v.literal("cancelled"),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.mandateId);
    if (m === null) return null;
    return {
      orgId: m.orgId,
      tenantId: m.tenantId,
      mandateName: m.mandateName,
      amount: m.amount,
      status: m.status,
    };
  },
});

export const linkMandateJob = internalMutation({
  args: {
    mandateId: v.id("ratibaMandates"),
    conversationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.mandateId);
    if (m === null) return null;
    await ctx.db.patch(m._id, { darajaRef: args.conversationId });
    await audit(ctx, {
      orgId: m.orgId,
      action: "ratiba.mandate_open",
      entityType: "ratibaMandate",
      entityId: String(m._id),
      metadata: `${m.mandateName} · ${m.amount} KES`,
    });
    return null;
  },
});

export const patchMandate = internalMutation({
  args: {
    mandateId: v.id("ratibaMandates"),
    amount: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("active"),
        v.literal("cancelled"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.mandateId);
    if (m === null) return null;
    const patch: { amount?: number; status?: typeof m.status } = {};
    if (args.amount !== undefined) {
      if (!Number.isFinite(args.amount) || args.amount <= 0) return null;
      patch.amount = Math.round(args.amount);
    }
    if (args.status !== undefined) patch.status = args.status;
    if (Object.keys(patch).length > 0) await ctx.db.patch(m._id, patch);
    return null;
  },
});
