import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { assertOwner as assertOwnerFn, getCaller } from "./lib/auth";

/**
 * Internal helpers for actions (which cannot touch ctx.db directly).
 * Auth propagates from the calling client into ctx.runQuery.
 */

export const assertCaller = internalQuery({
  args: {},
  returns: v.object({
    userId: v.string(),
    orgId: v.id("orgs"),
    role: v.union(
      v.literal("owner"),
      v.literal("manager"),
      v.literal("tenant"),
    ),
    tenantId: v.union(v.id("tenants"), v.null()),
  }),
  handler: async (ctx) => {
    const caller = await getCaller(ctx);
    return {
      userId: caller.userId,
      orgId: caller.orgId,
      role: caller.role,
      tenantId: caller.tenantId,
    };
  },
});

export const assertOwner = internalQuery({
  args: {},
  returns: v.object({ userId: v.string(), orgId: v.id("orgs") }),
  handler: async (ctx) => {
    const caller = await assertOwnerFn(ctx);
    return { userId: caller.userId, orgId: caller.orgId };
  },
});

export const getTenantOrg = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(v.object({ orgId: v.id("orgs") }), v.null()),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    return tenant === null ? null : { orgId: tenant.orgId };
  },
});

export const findPendingByIdem = internalQuery({
  args: { orgId: v.id("orgs"), idempotencyKey: v.string() },
  returns: v.union(
    v.object({ checkoutRequestId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tx = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_org_idem", (q) =>
        q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey),
      )
      .first();
    if (tx === null || tx.status !== "pending") return null;
    return { checkoutRequestId: tx.checkoutRequestId };
  },
});
