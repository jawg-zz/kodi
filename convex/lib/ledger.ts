import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  addCreditInTx,
  consumeCreditInTx,
  reverseCreditInTx,
} from "./credit";

/**
 * Payment ledger core — plain helpers shared by payments.ts (manual
 * record / void / refund mutations) and mpesaInternal.ts (STK success
 * reconciliation). Everything runs in the caller's transaction: no
 * runMutation hops, so the STK checkout claim + allocation + credit moves
 * commit atomically and the callback-vs-poll race cannot double-record.
 */

export type Allocation = {
  invoiceId: Id<"invoices">;
  amount: number;
  month?: string;
};

const MAX_RECEIPT_RETRIES = 5;

function checkAmount(amount: number): number {
  const r = Math.round(amount);
  if (!Number.isFinite(r) || r <= 0) {
    throw new ConvexError("Payment amount must be a positive number of KES");
  }
  return r;
}

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

async function receiptNoTaken(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  receiptNo: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return rows.some((r) => r.receiptNo === receiptNo);
}

/**
 * Counter bump + collision scan. Two concurrent writers can read the same
 * counter value, so the winner's receiptNo is re-checked before insert and
 * we retry; the timestamp fallback makes a silent duplicate effectively
 * impossible.
 */
async function nextFreeReceiptNo(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<string> {
  for (let i = 0; i < MAX_RECEIPT_RETRIES; i += 1) {
    const candidate = await nextReceiptNo(ctx, orgId);
    if (!(await receiptNoTaken(ctx, orgId, candidate))) return candidate;
  }
  for (let i = 0; i < MAX_RECEIPT_RETRIES; i += 1) {
    const candidate = `RCP-${Date.now().toString(36).toUpperCase()}${i > 0 ? `-${i}` : ""}`;
    if (!(await receiptNoTaken(ctx, orgId, candidate))) return candidate;
  }
  throw new ConvexError("Could not mint a unique receipt number — try again");
}

async function applyFifoInTx(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  amount: number,
): Promise<{ allocations: Allocation[]; leftover: number }> {
  const open = await ctx.db
    .query("invoices")
    .withIndex("by_tenant_month", (q) => q.eq("tenantId", tenantId))
    .collect();
  open.sort((a, b) => a.month.localeCompare(b.month));
  let remaining = amount;
  const allocations: Allocation[] = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    if (inv.orgId !== orgId || inv.balance <= 0) continue;
    const applied = Math.min(remaining, inv.balance);
    const balance = inv.balance - applied;
    await ctx.db.patch(inv._id, {
      balance,
      status:
        balance <= 0 ? "paid" : balance < inv.total ? "partial" : inv.status,
    });
    allocations.push({ invoiceId: inv._id, amount: applied, month: inv.month });
    remaining -= applied;
  }
  return { allocations, leftover: remaining };
}

function applyOneInvoice(
  balance: number,
  total: number,
  prev: "unpaid" | "partial" | "paid",
): "unpaid" | "partial" | "paid" {
  if (balance <= 0) return "paid";
  if (balance < total) return "partial";
  return prev;
}

/**
 * Core ledger write. Settles in this order:
 *  1. held prepaid credit (oldest invoices first) when `useCredit` is set;
 *  2. the cash `amount` across `targets` first (when given), then FIFO;
 *  3. any remainder becomes new prepaid credit with a ledger entry.
 *
 * When `checkoutRequestId` is given (STK path) the checkout row is claimed
 * first inside the same transaction: a racing writer sees paymentId already
 * set and the existing row is returned — no double payment, ever.
 */
export async function recordPaymentCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<"orgs">;
    tenantId: Id<"tenants">;
    amount: number;
    method: "mpesa_stk" | "mpesa_manual" | "mpesa_c2b" | "cash" | "bank";
    mpesaCode?: string;
    paidAt?: number;
    note?: string;
    recordedBy?: string;
    checkoutRequestId?: string;
    targets?: Id<"invoices">[];
    useCredit?: boolean;
    /** Money landed in the platform paybill — track it for landlord settlement. */
    viaPlatform?: boolean;
  },
): Promise<{
  id: Id<"payments">;
  allocations: Allocation[];
  leftoverCredit: number;
  creditUsed: number;
}> {
  const amount = checkAmount(args.amount);
  const tenant = await ctx.db.get(args.tenantId);
  if (tenant === null || tenant.orgId !== args.orgId) {
    throw new ConvexError("Tenant not found in this organization");
  }

  // 0) Claim the STK checkout first: if another writer (callback vs poll)
  //    already linked a payment, hand back the existing row — no dupes.
  if (args.checkoutRequestId !== undefined) {
    const tx = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId as string),
      )
      .first();
    if (tx === null) {
      throw new ConvexError("Unknown M-Pesa transaction");
    }
    if (tx.paymentId !== undefined) {
      const existing = await ctx.db.get(tx.paymentId);
      if (existing !== null) {
        return {
          id: existing._id,
          allocations: existing.allocations as Allocation[],
          leftoverCredit: existing.leftoverCredit ?? 0,
          creditUsed: 0,
        };
      }
    }
  }

  // M-Pesa money (STK receipt, C2B TransID, or hand-typed code) dedupes
  // across ALL entry paths: a TransID already recorded by C2B cannot be
  // re-recorded manually or by STK, and vice versa.
  if (args.mpesaCode) {
    const dup = await ctx.db
      .query("payments")
      .withIndex("by_org_code", (q) =>
        q.eq("orgId", args.orgId).eq("mpesaCode", args.mpesaCode as string),
      )
      .first();
    if (
      dup !== null &&
      (dup.status ?? "active") === "active" &&
      (dup.method === "mpesa_manual" ||
        dup.method === "mpesa_stk" ||
        dup.method === "mpesa_c2b")
    ) {
      throw new ConvexError("This M-Pesa code was already recorded.");
    }
  }

  // 1) Spend held credit first when asked.
  let creditUsed = 0;
  if (args.useCredit === true) {
    creditUsed = await consumeCreditInTx(
      ctx,
      args.orgId,
      args.tenantId,
      Number.MAX_SAFE_INTEGER,
      { note: "Spent at payment time" },
    );
  }

  // 2) Apply the cash: targets first, then FIFO over the rest.
  let allocations: Allocation[] = [];
  let remaining = amount;
  const seen = new Set<string>();
  for (const targetId of args.targets ?? []) {
    if (remaining <= 0) break;
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    const inv = await ctx.db.get(targetId);
    if (
      inv === null ||
      inv.orgId !== args.orgId ||
      inv.tenantId !== args.tenantId ||
      inv.balance <= 0
    ) {
      continue;
    }
    const applied = Math.min(remaining, inv.balance);
    const balance = inv.balance - applied;
    await ctx.db.patch(inv._id, {
      balance,
      status: applyOneInvoice(balance, inv.total, inv.status),
    });
    allocations.push({ invoiceId: inv._id, amount: applied, month: inv.month });
    remaining -= applied;
  }
  if (remaining > 0) {
    const rest = await applyFifoInTx(ctx, args.orgId, args.tenantId, remaining);
    allocations = allocations.concat(
      rest.allocations.filter((a) => !seen.has(a.invoiceId)),
    );
    remaining = rest.leftover;
  }

  const receiptNo = await nextFreeReceiptNo(ctx, args.orgId);
  const id = await ctx.db.insert("payments", {
    orgId: args.orgId,
    tenantId: args.tenantId,
    amount,
    method: args.method,
    mpesaCode: args.mpesaCode,
    paidAt: args.paidAt ?? Date.now(),
    allocations,
    receiptNo,
    recordedBy: args.recordedBy,
    note: args.note?.trim() || undefined,
    status: "active",
    checkoutRequestId: args.checkoutRequestId,
    leftoverCredit: remaining,
  });

  // Platform-paybill collections are owed to the landlord until the
  // platform operator settles them out — one ledger row per payment.
  if (args.viaPlatform === true) {
    await ctx.db.insert("platformCollections", {
      orgId: args.orgId,
      paymentId: id,
      amount,
    });
  }

  // 3) Leftover becomes prepaid credit, with a ledger entry pointing back
  //    at this payment so staff can trace it later.
  if (remaining > 0) {
    await addCreditInTx(ctx, args.orgId, args.tenantId, remaining, {
      paymentId: id,
      note: `Overpayment on ${receiptNo}`,
    });
  } else {
    await ctx.db.patch(id, { leftoverCredit: 0 });
  }

  // Link the STK row to the payment in the same transaction.
  if (args.checkoutRequestId !== undefined) {
    const tx = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId as string),
      )
      .first();
    if (tx !== null && tx.paymentId === undefined) {
      await ctx.db.patch(tx._id, {
        status: "success",
        resultCode: 0,
        resultDesc: tx.resultDesc ?? "Confirmed by M-Pesa",
        mpesaReceipt: args.mpesaCode ?? tx.mpesaReceipt,
        paymentId: id,
      });
    }
  }
  return { id, allocations, leftoverCredit: remaining, creditUsed };
}

function reverseAllocations(
  allocations: { invoiceId: Id<"invoices">; amount: number }[],
): Map<string, number> {
  const byInvoice = new Map<string, number>();
  for (const a of allocations) {
    byInvoice.set(a.invoiceId, (byInvoice.get(a.invoiceId) ?? 0) + a.amount);
  }
  return byInvoice;
}

/**
 * Shared reversal: restores each touched invoice's balance (capped at its
 * total so later corrections can't push it over), backs out the leftover
 * credit the payment created, marks the row, and returns the credit
 * shortfall for the audit trail. Called by voidPayment (wrong entry) and
 * refundPayment (money returned to the tenant).
 */
export async function reversePaymentInTx(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
  reversedStatus: "voided" | "refunded",
  reason: string,
  reversedBy?: string,
): Promise<{ creditShortfall: number }> {
  const payment = await ctx.db.get(paymentId);
  if (payment === null) throw new ConvexError("Payment not found");
  if ((payment.status ?? "active") !== "active") {
    throw new ConvexError("This payment was already reversed.");
  }
  for (const [invoiceId, amount] of reverseAllocations(
    payment.allocations as { invoiceId: Id<"invoices">; amount: number }[],
  )) {
    const inv = await ctx.db.get(invoiceId as Id<"invoices">);
    if (inv === null || inv.orgId !== payment.orgId) continue;
    const balance = Math.min(inv.total, inv.balance + amount);
    await ctx.db.patch(inv._id, {
      balance,
      status: applyOneInvoice(balance, inv.total, inv.status),
    });
  }
  // The created credit may already be spent on later invoices — floor at
  // zero and report the shortfall instead of going negative.
  let creditShortfall = 0;
  const created = payment.leftoverCredit ?? 0;
  if (created > 0) {
    const res = await reverseCreditInTx(
      ctx,
      payment.orgId,
      payment.tenantId,
      created,
      {
        paymentId,
        note: `${reversedStatus === "voided" ? "Void" : "Refund"} of ${payment.receiptNo}`,
      },
    );
    creditShortfall = res.shortfall;
  }
  await ctx.db.patch(paymentId, {
    status: reversedStatus,
    reversedAt: Date.now(),
    reversedBy,
    reverseReason: reason,
  });
  // Money already forwarded to the landlord can't be clawed back
  // automatically — net it as a negative adjustment row so the next sweep
  // deducts it from what that org is owed. Only a landlord with no further
  // collections and a negative balance needs manual intervention.
  const fwd = await ctx.db
    .query("platformCollections")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .first();
  if (fwd !== undefined && fwd !== null && fwd.settledAt !== undefined) {
    const feeBack = fwd.fee ?? 0;
    await ctx.db.insert("platformCollections", {
      orgId: payment.orgId,
      paymentId,
      amount: -(payment.amount - feeBack),
      fee: -feeBack,
      payoutRef: `adjustment: ${reversedStatus} ${payment.receiptNo}`,
      settleKind: "manual",
    });
  }
  return { creditShortfall };
}
