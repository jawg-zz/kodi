import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, siteBaseUrl } from "./lib/auth";
import { fireAsyncJob, initiatorBundle } from "./lib/initiatorJobs";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Ratiba standing orders: tenant PIN-consents once, debits recur
 * (Frequency 5 = Monthly). Commercial API (signed agreement; ~5% capped
 * 5 KES/execution + C2B tariffs). Executions arrive as C2B hits against
 * the mandate's account reference — matching/ledger reuse the existing
 * path, so this module only tracks mandates (create/amend/cancel).
 */

const RATIBA_CANDIDATES = [
  "standingorder/v1/createStandingOrderExternal",
  "mpesa/standingorder/v1/createStandingOrderExternal",
];

const RATIBA_AMEND_CANDIDATES = [
  "standingorder/v1/amendStandingOrderExternal",
  "mpesa/standingorder/v1/amendStandingOrderExternal",
];

const RATIBA_CANCEL_CANDIDATES = [
  "standingorder/v1/cancelStandingOrderExternal",
  "mpesa/standingorder/v1/cancelStandingOrderExternal",
];

const mandateShape = v.object({
  _id: v.id("ratibaMandates"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  tenantName: v.optional(v.string()),
  mandateName: v.string(),
  amount: v.number(),
  frequency: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("cancelled"),
  ),
  darajaRef: v.optional(v.string()),
});

/** Staff: mandates for a tenant (autopay status on the detail page). */
export const listMandates = query({
  args: { tenantId: v.id("tenants") },
  returns: v.array(mandateShape),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return [];
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("You can only view your own mandates");
    }
    const rows = await ctx.db
      .query("ratibaMandates")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .order("desc")
      .take(20);
    const out = [];
    for (const r of rows) {
      out.push({ ...r, tenantName: tenant.full_name });
    }
    return out;
  },
});

/**
 * Staff: create a mandate (tenant PIN-consents on their handset; Daraja
 * accepts async → job row tracks it; the mandate flips active on the
 * result callback via confirmMandate below).
 */
export const createMandate = action({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    mandateName: v.string(),
    amount: v.number(),
    phone: v.string(),
    frequency: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
  },
  returns: v.object({
    mandateId: v.id("ratibaMandates"),
    conversationId: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const name = args.mandateName.trim();
    if (name === "" || name.length > 32) {
      throw new ConvexError("Mandate name is required (≤32 chars, unique per customer)");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 250_000) {
      throw new ConvexError("Mandate amount must be KES 1 – 250,000");
    }
    const digits = args.phone.replace(/\D/g, "");
    if (digits.length !== 12 || !digits.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX consent number is required");
    }
    const tenant = await ctx.runQuery(internal.payoutsInternal.getTenantForPayout, {
      tenantId: args.tenantId,
      orgId: args.orgId,
    });
    if (tenant === null) throw new ConvexError("Tenant not found in this organization");
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    const mandateId: Id<"ratibaMandates"> = await ctx.runMutation(
      internal.ratibaInternal.openMandate,
      {
        orgId: args.orgId,
        tenantId: args.tenantId,
        mandateName: name,
        amount,
        frequency: args.frequency ?? "5",
      },
    );
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: RATIBA_CANDIDATES,
      label: "Ratiba mandate",
      summary: `Autopay ${amount} KES/mo · ${name}`.slice(0, 120),
      tenantId: args.tenantId,
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        StandingOrderName: name,
        StartDate: args.startDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        EndDate:
          args.endDate ??
          new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10).replace(/-/g, ""),
        BusinessShortCode: bundle.shortcode,
        TransactionType: "CustomerPayBillOnline",
        AccountReference: tenant.fullName.slice(0, 12) || name.slice(0, 12),
        Amount: amount,
        PhoneNumber: digits,
        Frequency: args.frequency ?? "5",
      },
    });
    await ctx.runMutation(internal.ratibaInternal.linkMandateJob, {
      mandateId,
      conversationId: res.conversationId,
    });
    return { mandateId, conversationId: res.conversationId };
  },
});

/**
 * Staff: amend amount/dates on a mandate (Daraja async; local row updates
 * immediately, job tracks the remote call).
 */
export const amendMandate = action({
  args: {
    mandateId: v.id("ratibaMandates"),
    amount: v.optional(v.number()),
    endDate: v.optional(v.string()),
  },
  returns: v.object({ conversationId: v.string() }),
  handler: async (ctx, args) => {
    const m = await ctx.runQuery(internal.ratibaInternal.getMandate, {
      mandateId: args.mandateId,
    });
    if (m === null) throw new ConvexError("Mandate not found");
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== m.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    if (m.status === "cancelled") throw new ConvexError("Mandate is cancelled");
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, m.orgId, siteBase);
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: RATIBA_AMEND_CANDIDATES,
      label: "Ratiba amend",
      summary: `Amend ${m.mandateName}`.slice(0, 120),
      tenantId: m.tenantId,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        StandingOrderName: m.mandateName,
        Amount: args.amount === undefined ? m.amount : Math.round(args.amount),
        EndDate: args.endDate,
      },
    });
    if (args.amount !== undefined) {
      await ctx.runMutation(internal.ratibaInternal.patchMandate, {
        mandateId: args.mandateId,
        amount: Math.round(args.amount),
      });
    }
    return { conversationId: res.conversationId };
  },
});

/**
 * Staff: cancel a mandate (local row flips immediately; remote cancel
 * tracked on the job — a failed remote cancel raises a job failure staff
 * can see and retry).
 */
export const cancelMandate = action({
  args: { mandateId: v.id("ratibaMandates") },
  returns: v.object({ conversationId: v.string() }),
  handler: async (ctx, args) => {
    const m = await ctx.runQuery(internal.ratibaInternal.getMandate, {
      mandateId: args.mandateId,
    });
    if (m === null) throw new ConvexError("Mandate not found");
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== m.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, m.orgId, siteBase);
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: RATIBA_CANCEL_CANDIDATES,
      label: "Ratiba cancel",
      summary: `Cancel ${m.mandateName}`.slice(0, 120),
      tenantId: m.tenantId,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        StandingOrderName: m.mandateName,
      },
    });
    await ctx.runMutation(internal.ratibaInternal.patchMandate, {
      mandateId: args.mandateId,
      status: "cancelled",
    });
    return { conversationId: res.conversationId };
  },
});

/** Staff: flip a mandate active once Daraja confirms (job watcher / manual). */
export const confirmMandate = mutation({
  args: { mandateId: v.id("ratibaMandates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.mandateId);
    if (m === null) throw new ConvexError("Mandate not found");
    await assertStaff(ctx, m.orgId);
    if (m.status === "pending") await ctx.db.patch(m._id, { status: "active" });
    return null;
  },
});

export { mandateShape };
