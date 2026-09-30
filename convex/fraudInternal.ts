import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Internal backing for fraud.ts (identity reads + check cache writes). */

export const getTenantIdentity = internalQuery({
  args: { tenantId: v.id("tenants"), orgId: v.id("orgs") },
  returns: v.union(
    v.object({
      phone: v.string(),
      nationalId: v.string(),
      fullName: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.tenantId);
    if (t === null || t.orgId !== args.orgId) return null;
    return { phone: t.phone, nationalId: t.national_id, fullName: t.full_name };
  },
});

export const storeCheck = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    checkType: v.union(
      v.literal("mobile_validation"),
      v.literal("sim_swap"),
      v.literal("sim_age"),
      v.literal("imsi"),
    ),
    result: v.string(),
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("kycChecks", {
      orgId: args.orgId,
      tenantId: args.tenantId,
      checkType: args.checkType,
      result: args.result.slice(0, 120),
      detail: args.detail?.slice(0, 500),
      checkedAt: Date.now(),
    });
    return null;
  },
});
