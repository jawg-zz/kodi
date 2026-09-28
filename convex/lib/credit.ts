import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Prepaid-credit ledger helpers (same-transaction writers).
 *
 * tenantCredits holds the live balance; creditLedger is the append-only
 * history (created / applied / reversed) so staff can trace every shilling
 * of overpayment. Both tables are written together — never one without the
 * other. Imported by payments, invoices and tenants; imports nothing from
 * them (no cycles).
 */

function statusAfter(total: number, balance: number, prev: "unpaid" | "partial" | "paid") {
  if (balance <= 0) return "paid" as const;
  if (balance < total) return "partial" as const;
  return prev;
}

/** Sweep `amount` of held credit onto open invoices, oldest month first. */
async function sweepOntoInvoices(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  amount: number,
): Promise<number> {
  let remaining = Math.round(amount);
  if (!Number.isFinite(remaining) || remaining <= 0) return Math.max(0, remaining);
  const open = await ctx.db
    .query("invoices")
    .withIndex("by_tenant_month", (q) => q.eq("tenantId", tenantId))
    .collect();
  open.sort((a, b) => a.month.localeCompare(b.month));
  for (const inv of open) {
    if (remaining <= 0) break;
    if (inv.orgId !== orgId || inv.balance <= 0) continue;
    const applied = Math.min(remaining, inv.balance);
    const balance = inv.balance - applied;
    await ctx.db.patch(inv._id, {
      balance,
      status: statusAfter(inv.total, balance, inv.status),
    });
    remaining -= applied;
  }
  return remaining;
}

async function currentBalance(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<{ rowId: Id<"tenantCredits"> | null; balance: number }> {
  const row = await ctx.db
    .query("tenantCredits")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .first();
  return row === null
    ? { rowId: null, balance: 0 }
    : { rowId: row._id, balance: row.balance };
}

async function writeBalance(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  rowId: Id<"tenantCredits"> | null,
  after: number,
  entry: {
    kind: "created" | "applied" | "reversed";
    amount: number;
    paymentId?: Id<"payments">;
    note?: string;
  },
): Promise<number> {
  if (rowId === null) {
    await ctx.db.insert("tenantCredits", { orgId, tenantId, balance: after });
  } else {
    await ctx.db.patch(rowId, { balance: after });
  }
  await ctx.db.insert("creditLedger", {
    orgId,
    tenantId,
    paymentId: entry.paymentId,
    kind: entry.kind,
    amount: entry.amount,
    balanceAfter: after,
    note: entry.note,
  });
  return after;
}

/**
 * Add credit (positive `amount`) to a tenant's balance with a "created"
 * ledger entry. Non-positive amounts are a no-op returning the balance.
 */
export async function addCreditInTx(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  amount: number,
  opts: { paymentId?: Id<"payments">; note?: string } = {},
): Promise<number> {
  const rounded = Math.round(amount);
  const { rowId, balance } = await currentBalance(ctx, tenantId);
  if (!Number.isFinite(rounded) || rounded <= 0) return balance;
  return await writeBalance(ctx, orgId, tenantId, rowId, balance + rounded, {
    kind: "created",
    amount: rounded,
    paymentId: opts.paymentId,
    note: opts.note,
  });
}

/**
 * Consume up to `amount` of held credit against open invoices (oldest
 * first). Returns the consumed total; writes one "applied" ledger row when
 * anything moves.
 */
export async function consumeCreditInTx(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  amount: number,
  opts: { paymentId?: Id<"payments">; note?: string } = {},
): Promise<number> {
  const wanted = Math.round(amount);
  if (!Number.isFinite(wanted) || wanted <= 0) return 0;
  const { rowId, balance } = await currentBalance(ctx, tenantId);
  if (balance <= 0) return 0;
  const remainder = await sweepOntoInvoices(
    ctx,
    orgId,
    tenantId,
    Math.min(wanted, balance),
  );
  const consumed = Math.min(wanted, balance) - remainder;
  if (consumed <= 0) return 0;
  await writeBalance(ctx, orgId, tenantId, rowId, balance - consumed, {
    kind: "applied",
    amount: -consumed,
    paymentId: opts.paymentId,
    note: opts.note ?? "Applied to open invoices",
  });
  return consumed;
}

/**
 * Back out `amount` of credit previously created by a payment that is now
 * being voided/refunded. The credit may already have been consumed by later
 * invoices, so the balance floors at zero — the shortfall is reported in the
 * returned value for the audit trail.
 */
export async function reverseCreditInTx(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  amount: number,
  opts: { paymentId?: Id<"payments">; note?: string } = {},
): Promise<{ reversed: number; shortfall: number }> {
  const wanted = Math.round(amount);
  const { rowId, balance } = await currentBalance(ctx, tenantId);
  if (!Number.isFinite(wanted) || wanted <= 0 || balance <= 0) {
    return { reversed: 0, shortfall: wanted > 0 ? wanted : 0 };
  }
  const reversed = Math.min(wanted, balance);
  await writeBalance(ctx, orgId, tenantId, rowId, balance - reversed, {
    kind: "reversed",
    amount: -reversed,
    paymentId: opts.paymentId,
    note: opts.note ?? "Reversed with payment",
  });
  return { reversed, shortfall: wanted - reversed };
}
