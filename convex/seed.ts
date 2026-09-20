import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Seed platform plans (idempotent). */
export const seedPlans = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const existing = await ctx.db.query("plans").take(10);
    if (existing.length > 0) return existing.length;
    const plans = [
      { code: "starter", name: "Starter", max_units: 10, price_kes: 0, sort_order: 1 },
      { code: "growth", name: "Growth", max_units: 50, price_kes: 1500, sort_order: 2 },
      { code: "pro", name: "Pro", max_units: 200, price_kes: 4000, sort_order: 3 },
    ];
    for (const p of plans) await ctx.db.insert("plans", p);
    return plans.length;
  },
});
