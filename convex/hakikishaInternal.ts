import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

/**
 * C2B Hakikisha account-name lookup: shortcode → org, account code →
 * tenant full name. Null when either side is unknown (route answers 404
 * with an empty name, and the payer retries).
 */

export const lookupAccountName = internalQuery({
  args: { shortcode: v.string(), account: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("mpesaCredentials").collect();
    const orgRow = rows.find((r) => r.shortcode === args.shortcode);
    if (orgRow === undefined) return null;
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_account", (q) => q.eq("accountCode", args.account))
      .first();
    if (tenant === null || tenant.orgId !== orgRow.orgId) return null;
    return tenant.full_name;
  },
});
