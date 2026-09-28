import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";
import { recordPaymentCore, reversePaymentInTx } from "./lib/ledger";

const paymentMethod = v.union(
  v.literal("mpesa_stk"),
  v.literal("mpesa_manual"),
  v.literal("mpesa_c2b"),
  v.literal("cash"),
  v.literal("bank"),
);

const paymentStatus = v.union(
  v.literal("active"),
  v.literal("voided"),
  v.literal("refunded"),
);

const allocationShape = v.object({
  invoiceId: v.id("invoices"),
  amount: v.number(),
  month: v.optional(v.string()),
});

const paymentShape = v.object({
  _id: v.id("payments"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  amount: v.number(),
  method: paymentMethod,
  mpesaCode: v.optional(v.string()),
  paidAt: v.number(),
  allocations: v.array(allocationShape),
  receiptNo: v.string(),
  recordedBy: v.optional(v.string()),
  note: v.optional(v.string()),
  status: v.optional(paymentStatus),
  checkoutRequestId: v.optional(v.string()),
  leftoverCredit: v.optional(v.number()),
  reversedAt: v.optional(v.number()),
  reversedBy: v.optional(v.string()),
  reverseReason: v.optional(v.string()),
});

const paymentWithRefs = v.object({
  _id: v.id("payments"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  amount: v.number(),
  method: paymentMethod,
  mpesaCode: v.optional(v.string()),
  paidAt: v.number(),
  allocations: v.array(allocationShape),
  receiptNo: v.string(),
  recordedBy: v.optional(v.string()),
  note: v.optional(v.string()),
  status: v.optional(paymentStatus),
  checkoutRequestId: v.optional(v.string()),
  leftoverCredit: v.optional(v.number()),
  reversedAt: v.optional(v.number()),
  reversedBy: v.optional(v.string()),
  reverseReason: v.optional(v.string()),
  tenant: v.union(
    v.object({ _id: v.id("tenants"), full_name: v.string() }),
    v.null(),
  ),
});

const paymentResult = v.object({
  id: v.id("payments"),
  allocations: v.array(allocationShape),
  leftoverCredit: v.number(),
  creditUsed: v.number(),
});

export const listPayments = query({
  args: { orgId: v.id("orgs"), tenantId: v.optional(v.id("tenants")) },
  returns: v.array(paymentWithRefs),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    let rows;
    if (args.tenantId !== undefined) {
      if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
        throw new ConvexError("Not found");
      }
      rows = await ctx.db
        .query("payments")
        .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId as Id<"tenants">))
        .order("desc")
        .take(500);
    } else {
      if (caller.role === "tenant") throw new ConvexError("Staff only");
      rows = await ctx.db
        .query("payments")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(500);
    }
    rows.sort((a, b) => b.paidAt - a.paidAt);
    const out = [];
    for (const p of rows) {
      const t = await ctx.db.get(p.tenantId);
      out.push({
        ...p,
        tenant: t === null ? null : { _id: t._id, full_name: t.full_name },
      });
    }
    return out as never;
  },
});

export const listTenantPayments = query({
  args: { tenantId: v.id("tenants") },
  returns: v.array(paymentWithRefs),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return [];
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("Not found");
    }
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .collect();
    rows.sort((a, b) => b.paidAt - a.paidAt);
    const out = [];
    for (const p of rows) {
      out.push({
        ...p,
        tenant: { _id: tenant._id, full_name: tenant.full_name },
      });
    }
    return out as never;
  },
});

export const recordManualPayment = mutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    amount: v.number(),
    method: v.union(
      v.literal("mpesa_manual"),
      v.literal("mpesa_c2b"),
      v.literal("cash"),
      v.literal("bank"),
    ),
    mpesaCode: v.optional(v.union(v.string(), v.null())),
    paidAt: v.number(),
    note: v.optional(v.union(v.string(), v.null())),
    targets: v.optional(v.array(v.id("invoices"))),
    useCredit: v.optional(v.boolean()),
  },
  returns: paymentResult,
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const res = await recordPaymentCore(ctx, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: args.amount,
      method: args.method,
      mpesaCode: args.mpesaCode ?? undefined,
      paidAt: args.paidAt,
      note: args.note ?? undefined,
      recordedBy: caller.userId,
      targets: args.targets,
      useCredit: args.useCredit ?? false,
    });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "payment.record",
      entityType: "payment",
      entityId: res.id,
    });
    return res;
  },
});

export const getPayment = query({
  args: { id: v.id("payments") },
  returns: v.union(
    v.object({
      _id: v.id("payments"),
      _creationTime: v.number(),
      orgId: v.id("orgs"),
      tenantId: v.id("tenants"),
      amount: v.number(),
      method: paymentMethod,
      mpesaCode: v.optional(v.string()),
      paidAt: v.number(),
      allocations: v.array(allocationShape),
      receiptNo: v.string(),
      recordedBy: v.optional(v.string()),
      note: v.optional(v.string()),
      status: v.optional(paymentStatus),
      checkoutRequestId: v.optional(v.string()),
      leftoverCredit: v.optional(v.number()),
      reversedAt: v.optional(v.number()),
      reversedBy: v.optional(v.string()),
      reverseReason: v.optional(v.string()),
      tenant: v.union(
        v.object({
          _id: v.id("tenants"),
          full_name: v.string(),
          phone: v.string(),
          unitId: v.optional(v.id("units")),
        }),
        v.null(),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (p === null) return null;
    const caller = await assertOrgMember(ctx, p.orgId);
    if (caller.role === "tenant" && caller.tenantId !== p.tenantId) {
      throw new ConvexError("Not found");
    }
    const t = await ctx.db.get(p.tenantId);
    return {
      ...p,
      tenant:
        t === null
          ? null
          : { _id: t._id, full_name: t.full_name, phone: t.phone, unitId: t.unitId },
    } as never;
  },
});

/**
 * STK success path — internal only. The CheckoutRequestID capability is
 * checked by the caller (http.ts / stkStatus action); the duplicate claim
 * inside recordPaymentCore makes callback-vs-poll retries safe.
 */
export const internalRecordStkPayment = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    amount: v.number(),
    mpesaCode: v.optional(v.string()),
    paidAt: v.optional(v.number()),
    note: v.optional(v.string()),
    checkoutRequestId: v.optional(v.string()),
  },
  returns: v.id("payments"),
  handler: async (ctx, args) => {
    const res = await recordPaymentCore(ctx, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: args.amount,
      method: "mpesa_stk",
      mpesaCode: args.mpesaCode,
      paidAt: args.paidAt,
      note: args.note ?? "M-Pesa STK Push",
      checkoutRequestId: args.checkoutRequestId,
    });
    return res.id;
  },
});

/**
 * Staff: void a wrongly-recorded payment (wrong tenant, wrong amount, test
 * entry). Reverses allocations + created credit; the row stays for the
 * audit trail but drops out of totals. At or above the org's reversal
 * limit only the owner may void.
 */
export const voidPayment = mutation({
  args: { id: v.id("payments"), reason: v.string() },
  returns: v.object({ creditShortfall: v.number() }),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.id);
    if (payment === null) throw new ConvexError("Payment not found");
    const caller = await assertStaff(ctx, payment.orgId);
    await assertReversalAllowed(ctx, payment.orgId, payment.amount, caller);
    const reason = args.reason.trim();
    if (reason === "") throw new ConvexError("Give a reason for the void.");
    const res = await reversePaymentInTx(ctx, args.id, "voided", reason, caller.userId);
    await audit(ctx, {
      orgId: payment.orgId,
      actorUserId: caller.userId,
      action: "payment.void",
      entityType: "payment",
      entityId: args.id,
      metadata: JSON.stringify({
        amount: payment.amount,
        receiptNo: payment.receiptNo,
        reason,
        creditShortfall: res.creditShortfall,
      }),
    });
    return res;
  },
});

/**
 * Staff: record that money from a payment was returned to the tenant
 * (duplicate charge, STK double-debit settled off-platform). Same ledger
 * reversal as a void, tracked under its own audit action. Same owner
 * threshold as voids.
 */
export const refundPayment = mutation({
  args: { id: v.id("payments"), reason: v.string() },
  returns: v.object({ creditShortfall: v.number() }),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.id);
    if (payment === null) throw new ConvexError("Payment not found");
    const caller = await assertStaff(ctx, payment.orgId);
    await assertReversalAllowed(ctx, payment.orgId, payment.amount, caller);
    const reason = args.reason.trim();
    if (reason === "") throw new ConvexError("Describe how the refund was made.");
    const res = await reversePaymentInTx(ctx, args.id, "refunded", reason, caller.userId);
    await audit(ctx, {
      orgId: payment.orgId,
      actorUserId: caller.userId,
      action: "payment.refund",
      entityType: "payment",
      entityId: args.id,
      metadata: JSON.stringify({
        amount: payment.amount,
        receiptNo: payment.receiptNo,
        reason,
        creditShortfall: res.creditShortfall,
      }),
    });
    return res;
  },
});

const DEFAULT_REVERSAL_LIMIT = 50_000;

/**
 * Owner gate for large reversals: at or above the org's limit (default
 * KES 50,000) only the owner may void/refund. Prevents a compromised or
 * careless manager account from unwinding big money alone.
 */
async function assertReversalAllowed(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  amount: number,
  caller: { userId: string; role: "owner" | "manager" },
): Promise<void> {
  const org = await ctx.db.get(orgId);
  const limit = org?.reversal_limit ?? DEFAULT_REVERSAL_LIMIT;
  if (limit > 0 && amount >= limit && caller.role !== "owner") {
    throw new ConvexError(
      `Reversals of ${amount.toLocaleString("en-US")} KES or more need the business owner.`,
    );
  }
}

export { paymentShape };
