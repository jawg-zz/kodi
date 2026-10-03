import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * SaaS operator guard: platform admins are OIDC subjects in the
 * platformAdmins allowlist — NOT members of the platform org. This keeps
 * "George the landlord" and "George the SaaS operator" as separate hats.
 */
export async function requirePlatformAdmin(
  ctx: QueryCtx,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated");
  const row = await ctx.db
    .query("platformAdmins")
    .withIndex("by_user", (q) => q.eq("userId", identity.subject))
    .first();
  if (row === null) throw new ConvexError("Not a platform admin");
  return identity.subject;
}

export async function isPlatformAdmin(
  ctx: QueryCtx,
): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return false;
  const row = await ctx.db
    .query("platformAdmins")
    .withIndex("by_user", (q) => q.eq("userId", identity.subject))
    .first();
  return row !== null;
}

/** Client check: does the current identity hold the operator hat? */
export const amPlatformAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => isPlatformAdmin(ctx),
});

/** Operator-only: list every org with the fields the console needs. */
export const orgOverview = query({
  args: {},
  returns: v.array(
    v.object({
      orgId: v.id("orgs"),
      name: v.string(),
      plan: v.string(),
      status: v.string(),
      units: v.number(),
      tenants: v.number(),
      collection: v.union(
        v.literal("own"),
        v.literal("platform"),
        v.literal("none"),
      ),
      unsettled: v.number(),
      lastPaymentAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const orgs = await ctx.db.query("orgs").collect();
    const creds = await ctx.db.query("mpesaCredentials").collect();
    const cols = await ctx.db.query("platformCollections").collect();
    const out: {
      orgId: Id<"orgs">;
      name: string;
      plan: string;
      status: string;
      units: number;
      tenants: number;
      collection: "own" | "platform" | "none";
      unsettled: number;
      lastPaymentAt?: number;
    }[] = [];
    for (const o of orgs) {
      const ownCreds = creds.find(
        (c) => c.orgId.toString() === o._id.toString() && c.consumerKeyEnc,
      );
      const platform = ownCreds
        ? undefined
        : creds.find((c) => c.platformPaybill === true);
      const units = await ctx.db
        .query("units")
        .withIndex("by_org", (q) => q.eq("orgId", o._id))
        .collect();
      const tenants = await ctx.db
        .query("tenants")
        .withIndex("by_org", (q) => q.eq("orgId", o._id))
        .collect();
      const mine = cols.filter((c) => c.orgId.toString() === o._id.toString());
      // Last ledger payment as an activity signal (org index, bounded).
      const recent = await ctx.db
        .query("payments")
        .withIndex("by_org_paidAt", (q) => q.eq("orgId", o._id))
        .order("desc")
        .take(1);
      const last = recent.length > 0 ? recent[0].paidAt : undefined;
      out.push({
        orgId: o._id,
        name: o.name,
        plan: o.plan_code,
        status: o.subscription_status,
        units: units.length,
        tenants: tenants.length,
        collection: ownCreds ? "own" : platform ? "platform" : "none",
        unsettled: mine
          .filter((c) => c.settledAt === undefined)
          .reduce((s, c) => s + c.amount, 0),
        ...(last === undefined ? {} : { lastPaymentAt: last }),
      });
    }
    out.sort((a, b) => b.unsettled - a.unsettled);
    return out as never;
  },
});

/** Operator-only: change an org's plan or subscription status. */
export const setOrgPlanStatus = mutation({
  args: {
    orgId: v.id("orgs"),
    plan: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("trialing"),
        v.literal("active"),
        v.literal("past_due"),
        v.literal("suspended"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePlatformAdmin(ctx);
    const patch: { plan_code?: string; subscription_status?: typeof args.status } = {};
    if (args.plan !== undefined) patch.plan_code = args.plan;
    if (args.status !== undefined) patch.subscription_status = args.status;
    if (Object.keys(patch).length === 0) return null;
    await ctx.db.patch(args.orgId, patch as never);
    return null;
  },
});

/**
 * Operator-only: record a manual settlement to a landlord. Marks the
 * oldest unsettled rows up to `amount` as settled with the payout ref.
 */
export const recordSettlement = mutation({
  args: {
    orgId: v.id("orgs"),
    amount: v.number(),
    payoutRef: v.string(),
  },
  returns: v.object({ rows: v.number(), settled: v.number() }),
  handler: async (ctx, args) => {
    await requirePlatformAdmin(ctx);
    const target = Math.round(args.amount);
    if (!Number.isFinite(target) || target <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    if (args.payoutRef.trim() === "") {
      throw new ConvexError("A payout reference is required");
    }
    const rows = (
      await ctx.db
        .query("platformCollections")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    )
      .filter((r) => r.settledAt === undefined)
      .sort((a, b) => a._creationTime - b._creationTime);
    let remaining = target;
    let count = 0;
    let settled = 0;
    for (const r of rows) {
      if (remaining <= 0) break;
      if (r.amount > remaining) break; // whole rows only — remainder rolls over
      await ctx.db.patch(r._id, {
        settledAt: Date.now(),
        payoutRef: args.payoutRef.trim(),
        settleKind: "manual",
      });
      remaining -= r.amount;
      settled += r.amount;
      count += 1;
    }
    return { rows: count, settled };
  },
});

/** Operator-only: platform fee settings (the single global doc). */
export const getFeeSettings = query({
  args: {},
  returns: v.union(
    v.object({ feePct: v.number(), feeCapKes: v.number() }),
    v.null(),
  ),
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const row = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .first();
    if (row === null) return null;
    return { feePct: row.feePct, feeCapKes: row.feeCapKes };
  },
});

export const setFeeSettings = mutation({
  args: { feePct: v.number(), feeCapKes: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePlatformAdmin(ctx);
    if (!(args.feePct >= 0 && args.feePct <= 25)) {
      throw new ConvexError("Fee must be between 0 and 25 percent");
    }
    if (!(args.feeCapKes >= 0)) {
      throw new ConvexError("Fee cap must be non-negative");
    }
    const row = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .first();
    if (row === null) {
      await ctx.db.insert("platformSettings", {
        key: "global",
        feePct: args.feePct,
        feeCapKes: Math.round(args.feeCapKes),
        forwardHoldHours: 24,
        forwardMinKes: 500,
      });
    } else {
      await ctx.db.patch(row._id, {
        feePct: args.feePct,
        feeCapKes: Math.round(args.feeCapKes),
      });
    }
    return null;
  },
});

/** Operator bootstrap for the CLI: add an OIDC subject to the allowlist. */
export const addPlatformAdmin = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("platformAdmins")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existing === null) {
      await ctx.db.insert("platformAdmins", {
        userId: args.userId,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

export async function isSuspendedOrg(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<boolean> {
  const org = await ctx.db.get(orgId);
  return org?.subscription_status === "suspended";
}

/**
 * Operator-only: recent forward/settle ledger rows across all orgs —
 * the per-day view of what the platform collected, forwarded, and earned.
 */
export const forwardLedger = query({
  args: { take: v.optional(v.number()) },
  returns: v.array(
    v.object({
      at: v.number(),
      orgName: v.string(),
      amount: v.number(),
      fee: v.optional(v.number()),
      kind: v.union(v.literal("manual"), v.literal("auto"), v.null()),
      payoutRef: v.optional(v.string()),
      pending: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requirePlatformAdmin(ctx);
    const take = Math.min(Math.max(args.take ?? 30, 1), 100);
    const rows = await ctx.db.query("platformCollections").order("desc").take(take);
    const out: {
      at: number;
      orgName: string;
      amount: number;
      fee?: number;
      kind: "manual" | "auto" | null;
      payoutRef?: string;
      pending: boolean;
    }[] = [];
    for (const r of rows) {
      const org = await ctx.db.get(r.orgId);
      out.push({
        at: r._creationTime,
        orgName: org?.name ?? "Unknown org",
        amount: r.amount,
        ...(r.fee === undefined ? {} : { fee: r.fee }),
        kind: r.settleKind ?? null,
        ...(r.payoutRef === undefined ? {} : { payoutRef: r.payoutRef }),
        pending: r.settledAt === undefined,
      });
    }
    return out;
  },
});
