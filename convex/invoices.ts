import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, audit, dueDateFor, isMonthKey } from "./lib/auth";
import { consumeCreditInTx } from "./lib/credit";

const invoiceShape = v.object({
  _id: v.id("invoices"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  unitId: v.optional(v.id("units")),
  month: v.string(),
  lines: v.object({
    rent: v.number(),
    water: v.number(),
    garbage: v.number(),
    other: v.number(),
  }),
  total: v.number(),
  dueDate: v.string(),
  status: v.union(v.literal("unpaid"), v.literal("partial"), v.literal("paid")),
  balance: v.number(),
  notes: v.optional(v.string()),
});

const invoiceWithRefs = v.object({
  _id: v.id("invoices"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  unitId: v.optional(v.id("units")),
  month: v.string(),
  lines: v.object({
    rent: v.number(),
    water: v.number(),
    garbage: v.number(),
    other: v.number(),
  }),
  total: v.number(),
  dueDate: v.string(),
  status: v.union(v.literal("unpaid"), v.literal("partial"), v.literal("paid")),
  balance: v.number(),
  notes: v.optional(v.string()),
  tenant: v.union(
    v.object({
      _id: v.id("tenants"),
      full_name: v.string(),
      phone: v.string(),
    }),
    v.null(),
  ),
  unit: v.union(
    v.object({ _id: v.id("units"), label: v.string() }),
    v.null(),
  ),
});

type InvoiceDoc = {
  _id: Id<"invoices">;
  _creationTime: number;
  orgId: Id<"orgs">;
  tenantId: Id<"tenants">;
  unitId?: Id<"units">;
  month: string;
  lines: { rent: number; water: number; garbage: number; other: number };
  total: number;
  dueDate: string;
  status: "unpaid" | "partial" | "paid";
  balance: number;
  notes?: string;
};

/** Apply credit balance to open invoices oldest-first. Returns remainder. */
export async function applyCreditToInvoices(
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
      status: balance <= 0 ? "paid" : balance < inv.total ? "partial" : inv.status,
    });
    remaining -= applied;
  }
  return remaining;
}

async function withRefs(ctx: QueryCtx | MutationCtx, inv: InvoiceDoc) {
  const tenant = await ctx.db.get(inv.tenantId);
  const unit = inv.unitId === undefined ? null : await ctx.db.get(inv.unitId);
  return {
    ...inv,
    tenant:
      tenant === null
        ? null
        : { _id: tenant._id, full_name: tenant.full_name, phone: tenant.phone },
    unit: unit === null ? null : { _id: unit._id, label: unit.label },
  };
}

export const listInvoices = query({
  args: { orgId: v.id("orgs"), month: v.optional(v.string()) },
  returns: v.array(invoiceWithRefs),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const rows =
      args.month !== undefined
        ? await ctx.db
            .query("invoices")
            .withIndex("by_org_month", (q) =>
              q.eq("orgId", args.orgId).eq("month", args.month as string),
            )
            .collect()
        : await ctx.db
            .query("invoices")
            .withIndex("by_org_month", (q) => q.eq("orgId", args.orgId))
            .collect();
    rows.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    const out = [];
    for (const inv of rows) out.push(await withRefs(ctx, inv));
    return out as never;
  },
});

export const listTenantInvoices = query({
  args: { tenantId: v.id("tenants") },
  returns: v.array(invoiceWithRefs),
  handler: async (ctx, args) => {
    const first = await ctx.db.get(args.tenantId);
    if (first === null) return [];
    const caller = await assertOrgMember(ctx, first.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("Not found");
    }
    const rows = await ctx.db
      .query("invoices")
      .withIndex("by_tenant_month", (q) => q.eq("tenantId", args.tenantId))
      .collect();
    rows.sort((a, b) => b.month.localeCompare(a.month));
    const out = [];
    for (const inv of rows) out.push(await withRefs(ctx, inv));
    return out as never;
  },
});

export const getInvoice = query({
  args: { id: v.id("invoices") },
  returns: v.union(invoiceWithRefs, v.null()),
  handler: async (ctx, args) => {
    const inv = await ctx.db.get(args.id);
    if (inv === null) return null;
    const caller = await assertOrgMember(ctx, inv.orgId);
    if (caller.role === "tenant" && caller.tenantId !== inv.tenantId) {
      throw new ConvexError("Not found");
    }
    return (await withRefs(ctx, inv)) as never;
  },
});

/**
 * Idempotent monthly generation: only occupied/notice units whose current
 * tenant is active/notice with a positive total; skips existing org+tenant+month.
 * Consumes tenant credit oldest-first afterwards.
 */
export const generateInvoices = mutation({
  args: { orgId: v.id("orgs"), month: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    if (!isMonthKey(args.month)) {
      throw new ConvexError("Invalid month key, expected YYYY-MM");
    }
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new ConvexError("Organization not found");
    const dueDate = dueDateFor(args.month, org.invoice_due_day);

    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    let count = 0;
    for (const u of units) {
      if (u.status !== "occupied" && u.status !== "notice") continue;
      if (u.currentTenantId === undefined) continue;
      const tenant = await ctx.db.get(u.currentTenantId);
      if (
        tenant === null ||
        (tenant.status !== "active" && tenant.status !== "notice")
      ) {
        continue;
      }
      const total = u.rent_amount + u.water_charge + u.garbage_charge;
      if (total <= 0) continue;
      const existing = await ctx.db
        .query("invoices")
        .withIndex("by_tenant_month", (q) =>
          q.eq("tenantId", tenant._id).eq("month", args.month),
        )
        .first();
      if (existing !== null) continue;
      await ctx.db.insert("invoices", {
        orgId: args.orgId,
        tenantId: tenant._id,
        unitId: u._id,
        month: args.month,
        lines: {
          rent: u.rent_amount,
          water: u.water_charge,
          garbage: u.garbage_charge,
          other: 0,
        },
        total,
        dueDate,
        status: "unpaid",
        balance: total,
      });
      count += 1;
    }

    // Consume held credit against open invoices (oldest first), with a
    // ledger row per tenant so the sweep is traceable.
    const credits = await ctx.db
      .query("tenantCredits")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const c of credits) {
      if (c.balance <= 0) continue;
      await consumeCreditInTx(ctx, args.orgId, c.tenantId, c.balance, {
        note: `Applied on invoice generation (${args.month})`,
      });
    }

    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "invoices.generate",
      entityType: "invoice",
      metadata: JSON.stringify({ month: args.month, count }),
    });
    return count;
  },
});

export const updateInvoice = mutation({
  args: {
    id: v.id("invoices"),
    notes: v.optional(v.union(v.string(), v.null())),
    dueDate: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inv = await ctx.db.get(args.id);
    if (inv === null) throw new ConvexError("Invoice not found");
    const caller = await assertStaff(ctx, inv.orgId);
    const patch: Record<string, unknown> = {};
    if (args.notes !== undefined) patch.notes = args.notes?.trim() || undefined;
    if (args.dueDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)) {
        throw new ConvexError("Due date must be YYYY-MM-DD.");
      }
      patch.dueDate = args.dueDate;
    }
    // Totals, balances and statuses are ledger-owned: they move only via
    // payments (record/void/refund) and credit sweeps, so allocated money
    // always adds up. Correct a wrong invoice by voiding the payment, not
    // by editing the numbers here.
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch as never);
      await audit(ctx, {
        orgId: inv.orgId,
        actorUserId: caller.userId,
        action: "invoice.update",
        entityType: "invoice",
        entityId: args.id,
      });
    }
    return null;
  },
});

/**
 * Read-only dry run of the FIFO split for `amount` — used by the record
 * modals to show "this will clear Sep + leave KES X as credit" before commit.
 * No rows are touched.
 */
export const previewAllocation = query({
  args: { tenantId: v.id("tenants"), amount: v.number() },
  returns: v.object({
    allocations: v.array(
      v.object({
        invoiceId: v.id("invoices"),
        month: v.string(),
        total: v.number(),
        balance: v.number(),
        applied: v.number(),
      }),
    ),
    leftover: v.number(),
  }),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) throw new ConvexError("Tenant not found");
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("Not found");
    }
    const rounded = Math.round(args.amount);
    if (!Number.isFinite(rounded) || rounded <= 0) {
      return { allocations: [], leftover: 0 };
    }
    const open = await ctx.db
      .query("invoices")
      .withIndex("by_tenant_month", (q) => q.eq("tenantId", args.tenantId))
      .collect();
    open.sort((a, b) => a.month.localeCompare(b.month));
    let remaining = rounded;
    const allocations: {
      invoiceId: Id<"invoices">;
      month: string;
      total: number;
      balance: number;
      applied: number;
    }[] = [];
    for (const inv of open) {
      if (remaining <= 0) break;
      if (inv.orgId !== tenant.orgId || inv.balance <= 0) continue;
      const applied = Math.min(remaining, inv.balance);
      allocations.push({
        invoiceId: inv._id,
        month: inv.month,
        total: inv.total,
        balance: inv.balance,
        applied,
      });
      remaining -= applied;
    }
    return { allocations, leftover: remaining } as never;
  },
});

export { invoiceShape };
