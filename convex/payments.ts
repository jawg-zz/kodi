import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";

const paymentMethod = v.union(
  v.literal("mpesa_stk"),
  v.literal("mpesa_manual"),
  v.literal("cash"),
  v.literal("bank"),
);

const paymentShape = v.object({
  _id: v.id("payments"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  amount: v.number(),
  method: paymentMethod,
  mpesaCode: v.optional(v.string()),
  paidAt: v.number(),
  allocations: v.array(
    v.object({ invoiceId: v.id("invoices"), amount: v.number() }),
  ),
  receiptNo: v.string(),
  recordedBy: v.optional(v.string()),
  note: v.optional(v.string()),
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
  allocations: v.array(
    v.object({ invoiceId: v.id("invoices"), amount: v.number() }),
  ),
  receiptNo: v.string(),
  recordedBy: v.optional(v.string()),
  note: v.optional(v.string()),
  tenant: v.union(
    v.object({ _id: v.id("tenants"), full_name: v.string() }),
    v.null(),
  ),
});

/** RCP-0001, RCP-0002, ... per org. */
async function nextReceiptNo(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<string> {
  const existing = await ctx.db
    .query("receiptCounters")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  if (existing === null) {
    await ctx.db.insert("receiptCounters", { orgId, lastNo: 1 });
    return "RCP-0001";
  }
  const n = existing.lastNo + 1;
  await ctx.db.patch(existing._id, { lastNo: n });
  return `RCP-${String(n).padStart(4, "0")}`;
}

function checkAmount(amount: number): number {
  const r = Math.round(amount);
  if (!Number.isFinite(r) || r <= 0) {
    throw new ConvexError("Payment amount must be a positive number of KES");
  }
  return r;
}

/**
 * Core ledger write shared by manual payments and the STK callback path:
 * receipt number + FIFO allocation + ledger row + credit carryover.
 */
export async function recordPaymentCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<"orgs">;
    tenantId: Id<"tenants">;
    amount: number;
    method: "mpesa_stk" | "mpesa_manual" | "cash" | "bank";
    mpesaCode?: string;
    paidAt?: number;
    note?: string;
    recordedBy?: string;
  },
): Promise<Id<"payments">> {
  const amount = checkAmount(args.amount);
  const tenant = await ctx.db.get(args.tenantId);
  if (tenant === null || tenant.orgId !== args.orgId) {
    throw new ConvexError("Tenant not found in this organization");
  }
  if (args.method === "mpesa_manual" && args.mpesaCode) {
    const dup = await ctx.db
      .query("payments")
      .withIndex("by_org_code", (q) =>
        q.eq("orgId", args.orgId).eq("mpesaCode", args.mpesaCode as string),
      )
      .first();
    if (dup !== null && dup.method === "mpesa_manual") {
      throw new ConvexError("This M-Pesa code was already recorded.");
    }
  }
  const receiptNo = await nextReceiptNo(ctx, args.orgId);
  const fifo: {
    allocations: { invoiceId: Id<"invoices">; amount: number }[];
    leftover: number;
  } = await ctx.runMutation(internal.invoices.allocateFifoInternal, {
    orgId: args.orgId,
    tenantId: args.tenantId,
    amount,
  });
  const id = await ctx.db.insert("payments", {
    orgId: args.orgId,
    tenantId: args.tenantId,
    amount,
    method: args.method,
    mpesaCode: args.mpesaCode,
    paidAt: args.paidAt ?? Date.now(),
    allocations: fifo.allocations,
    receiptNo,
    recordedBy: args.recordedBy,
    note: args.note?.trim() || undefined,
  });
  if (fifo.leftover > 0) {
    await ctx.runMutation(internal.tenants.addCreditInternal, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: fifo.leftover,
    });
  }
  return id;
}

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
      v.literal("cash"),
      v.literal("bank"),
    ),
    mpesaCode: v.optional(v.union(v.string(), v.null())),
    paidAt: v.number(),
    note: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.id("payments"),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const id = await recordPaymentCore(ctx, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: args.amount,
      method: args.method,
      mpesaCode: args.mpesaCode ?? undefined,
      paidAt: args.paidAt,
      note: args.note ?? undefined,
      recordedBy: caller.userId,
    });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "payment.record",
      entityType: "payment",
      entityId: id,
    });
    return id;
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
      allocations: v.array(
        v.object({ invoiceId: v.id("invoices"), amount: v.number() }),
      ),
      receiptNo: v.string(),
      recordedBy: v.optional(v.string()),
      note: v.optional(v.string()),
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
 * STK callback path — internal only. The CheckoutRequestID capability is
 * checked by the caller (http.ts / stkStatus action), not here.
 */
export const internalRecordStkPayment = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    amount: v.number(),
    mpesaCode: v.optional(v.string()),
    paidAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  returns: v.id("payments"),
  handler: async (ctx, args) => {
    return await recordPaymentCore(ctx, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: args.amount,
      method: "mpesa_stk",
      mpesaCode: args.mpesaCode,
      paidAt: args.paidAt,
      note: args.note ?? "M-Pesa STK Push",
    });
  },
});

export { paymentShape };
