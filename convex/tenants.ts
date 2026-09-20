import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";

const tenantStatus = v.union(
  v.literal("active"),
  v.literal("notice"),
  v.literal("moved_out"),
);

const tenantShape = v.object({
  _id: v.id("tenants"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  full_name: v.string(),
  phone: v.string(),
  national_id: v.string(),
  unitId: v.optional(v.id("units")),
  move_in_date: v.optional(v.string()),
  deposit_held: v.number(),
  status: tenantStatus,
  notes: v.optional(v.string()),
});

const settlementShape = v.object({
  _id: v.id("depositSettlements"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  depositHeld: v.number(),
  deductions: v.array(
    v.object({ label: v.string(), amount: v.number() }),
  ),
  totalDeductions: v.number(),
  refundAmount: v.number(),
  notes: v.optional(v.string()),
  settledBy: v.optional(v.string()),
});

/**
 * Mirror of the Postgres sync_unit_tenant trigger: tenant writes own
 * units.status / units.currentTenantId, never the client.
 */
async function syncUnitForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<void> {
  const tenant = await ctx.db.get(tenantId);
  if (tenant === null) return;
  const allUnits = await ctx.db
    .query("units")
    .withIndex("by_org", (q) => q.eq("orgId", tenant.orgId))
    .collect();
  for (const u of allUnits) {
    if (u.currentTenantId === tenantId) {
      const shouldHold =
        tenant.unitId === u._id && tenant.status !== "moved_out";
      if (!shouldHold) {
        await ctx.db.patch(u._id, {
          status: "vacant",
          currentTenantId: undefined,
        });
      }
    }
  }
  if (tenant.unitId !== undefined && tenant.status !== "moved_out") {
    const unit = await ctx.db.get(tenant.unitId);
    if (unit !== null) {
      await ctx.db.patch(unit._id, {
        status: tenant.status === "notice" ? "notice" : "occupied",
        currentTenantId: tenantId,
      });
    }
  }
}

async function assertUnitFree(
  ctx: MutationCtx,
  unitId: Id<"units">,
  exceptTenant?: Id<"tenants">,
): Promise<void> {
  const unit = await ctx.db.get(unitId);
  if (unit === null) throw new ConvexError("Unit not found");
  if (
    unit.currentTenantId !== undefined &&
    unit.currentTenantId !== exceptTenant
  ) {
    throw new ConvexError(
      "That unit already has an active tenant. Move them out first, or pick a vacant unit.",
    );
  }
  const others = await ctx.db
    .query("tenants")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  if (
    others.some(
      (t) =>
        t._id !== exceptTenant &&
        (t.status === "active" || t.status === "notice"),
    )
  ) {
    throw new ConvexError(
      "That unit already has an active tenant. Move them out first, or pick a vacant unit.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listTenants = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(tenantShape),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const rows = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
    return rows;
  },
});

export const getTenant = query({
  args: { id: v.id("tenants") },
  returns: v.union(tenantShape, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    const caller = await assertOrgMember(ctx, row.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.id) {
      throw new ConvexError("Not found");
    }
    return row;
  },
});

export const getTenantPortalLink = query({
  args: { tenantId: v.id("tenants") },
  returns: v.union(
    v.object({ tenantId: v.id("tenants"), userId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return null;
    await assertStaff(ctx, tenant.orgId);
    const link = await ctx.db
      .query("tenantUsers")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    return link === null
      ? null
      : { tenantId: link.tenantId, userId: link.userId };
  },
});

export const listSettlements = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(settlementShape),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const rows = await ctx.db
      .query("depositSettlements")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(200);
    return rows;
  },
});

export const getSettlement = query({
  args: { id: v.id("depositSettlements") },
  returns: v.union(
    v.object({
      _id: v.id("depositSettlements"),
      _creationTime: v.number(),
      orgId: v.id("orgs"),
      tenantId: v.id("tenants"),
      depositHeld: v.number(),
      deductions: v.array(
        v.object({ label: v.string(), amount: v.number() }),
      ),
      totalDeductions: v.number(),
      refundAmount: v.number(),
      notes: v.optional(v.string()),
      settledBy: v.optional(v.string()),
      tenant: v.union(
        v.object({
          _id: v.id("tenants"),
          full_name: v.string(),
          phone: v.string(),
        }),
        v.null(),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    const caller = await assertOrgMember(ctx, row.orgId);
    if (caller.role === "tenant" && caller.tenantId !== row.tenantId) {
      throw new ConvexError("Not found");
    }
    const t = await ctx.db.get(row.tenantId);
    return {
      ...row,
      tenant:
        t === null
          ? null
          : { _id: t._id, full_name: t.full_name, phone: t.phone },
    };
  },
});

export const getTenantCredit = query({
  args: { tenantId: v.id("tenants") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return 0;
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("Not found");
    }
    const credit = await ctx.db
      .query("tenantCredits")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    return credit?.balance ?? 0;
  },
});

// ---------------------------------------------------------------------------
// Writes (staff)
// ---------------------------------------------------------------------------

export const createTenant = mutation({
  args: {
    orgId: v.id("orgs"),
    full_name: v.string(),
    phone: v.string(),
    national_id: v.optional(v.string()),
    unitId: v.optional(v.id("units")),
    move_in_date: v.optional(v.string()),
    deposit_held: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: tenantShape,
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const name = args.full_name.trim();
    if (name === "") throw new ConvexError("Tenant name is required.");
    const phone = args.phone.trim();
    if (phone === "") throw new ConvexError("Tenant phone is required.");
    const dup = await ctx.db
      .query("tenants")
      .withIndex("by_org_phone", (q) =>
        q.eq("orgId", args.orgId).eq("phone", phone),
      )
      .first();
    if (dup !== null) {
      throw new ConvexError(
        "A tenant with this phone number already exists in your business.",
      );
    }
    if (args.unitId !== undefined) {
      const unit = await ctx.db.get(args.unitId);
      if (unit === null || unit.orgId !== args.orgId) {
        throw new ConvexError("Unit not found in this organization");
      }
      await assertUnitFree(ctx, args.unitId);
    }
    const deposit = Math.round(args.deposit_held ?? 0);
    if (!Number.isFinite(deposit) || deposit < 0) {
      throw new ConvexError("Deposit must be a non-negative amount.");
    }
    const id = await ctx.db.insert("tenants", {
      orgId: args.orgId,
      full_name: name,
      phone,
      national_id: (args.national_id ?? "").trim(),
      unitId: args.unitId,
      move_in_date: args.move_in_date,
      deposit_held: deposit,
      status: "active",
      notes: args.notes?.trim() || undefined,
    });
    await syncUnitForTenant(ctx, id);
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "tenant.create",
      entityType: "tenant",
      entityId: id,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new ConvexError("Tenant not found");
    return row;
  },
});

export const updateTenant = mutation({
  args: {
    id: v.id("tenants"),
    full_name: v.optional(v.string()),
    phone: v.optional(v.string()),
    national_id: v.optional(v.string()),
    unitId: v.optional(v.union(v.id("units"), v.null())),
    move_in_date: v.optional(v.union(v.string(), v.null())),
    deposit_held: v.optional(v.number()),
    status: v.optional(tenantStatus),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Tenant not found");
    const caller = await assertStaff(ctx, row.orgId);
    const patch: Record<string, unknown> = {};
    if (args.full_name !== undefined) {
      const name = args.full_name.trim();
      if (name === "") throw new ConvexError("Tenant name cannot be empty.");
      patch.full_name = name;
    }
    if (args.phone !== undefined) {
      const phone = args.phone.trim();
      if (phone === "") throw new ConvexError("Tenant phone cannot be empty.");
      const dup = await ctx.db
        .query("tenants")
        .withIndex("by_org_phone", (q) =>
          q.eq("orgId", row.orgId).eq("phone", phone),
        )
        .first();
      if (dup !== null && dup._id !== args.id) {
        throw new ConvexError(
          "A tenant with this phone number already exists in your business.",
        );
      }
      patch.phone = phone;
    }
    if (args.national_id !== undefined) patch.national_id = args.national_id.trim();
    if (args.deposit_held !== undefined) {
      const d = Math.round(args.deposit_held);
      if (!Number.isFinite(d) || d < 0) {
        throw new ConvexError("Deposit must be a non-negative amount.");
      }
      patch.deposit_held = d;
    }
    const nextStatus = args.status ?? row.status;
    if (args.unitId !== undefined) {
      if (args.unitId === null) {
        patch.unitId = undefined;
      } else {
        const unit = await ctx.db.get(args.unitId);
        if (unit === null || unit.orgId !== row.orgId) {
          throw new ConvexError("Unit not found in this organization");
        }
        if (nextStatus !== "moved_out") {
          await assertUnitFree(ctx, args.unitId, args.id);
        }
        patch.unitId = args.unitId;
      }
    }
    if (args.status !== undefined) patch.status = args.status;
    if (args.move_in_date !== undefined) {
      patch.move_in_date = args.move_in_date ?? undefined;
    }
    if (args.notes !== undefined) {
      patch.notes = args.notes?.trim() || undefined;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch as never);
      await syncUnitForTenant(ctx, args.id);
      await audit(ctx, {
        orgId: row.orgId,
        actorUserId: caller.userId,
        action: "tenant.update",
        entityType: "tenant",
        entityId: args.id,
      });
    }
    return null;
  },
});

export const deleteTenant = mutation({
  args: { id: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Tenant not found");
    const caller = await assertStaff(ctx, row.orgId);
    const link = await ctx.db
      .query("tenantUsers")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.id))
      .first();
    if (link !== null) await ctx.db.delete(link._id);
    await ctx.db.delete(args.id);
    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", row.orgId))
      .collect();
    for (const u of units) {
      if (u.currentTenantId === args.id) {
        await ctx.db.patch(u._id, {
          status: "vacant",
          currentTenantId: undefined,
        });
      }
    }
    await audit(ctx, {
      orgId: row.orgId,
      actorUserId: caller.userId,
      action: "tenant.delete",
      entityType: "tenant",
      entityId: args.id,
    });
    return null;
  },
});

export const settleDeposit = mutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    deductions: v.array(
      v.object({ label: v.string(), amount: v.number() }),
    ),
    refundAmount: v.number(),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  returns: settlementShape,
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null || tenant.orgId !== args.orgId) {
      throw new ConvexError("Tenant not found in this organization");
    }
    const totalDeductions = args.deductions.reduce((s, d) => {
      const a = Math.round(d.amount);
      if (!Number.isFinite(a) || a < 0) {
        throw new ConvexError("Deduction amounts must be non-negative.");
      }
      return s + a;
    }, 0);
    const refund = Math.round(args.refundAmount);
    if (!Number.isFinite(refund) || refund < 0) {
      throw new ConvexError("Refund must be a non-negative amount.");
    }
    const id = await ctx.db.insert("depositSettlements", {
      orgId: args.orgId,
      tenantId: args.tenantId,
      depositHeld: tenant.deposit_held,
      deductions: args.deductions.map((d) => ({
        label: d.label.trim(),
        amount: Math.round(d.amount),
      })),
      totalDeductions,
      refundAmount: refund,
      notes: args.notes?.trim() || undefined,
      settledBy: caller.userId,
    });
    await ctx.db.patch(args.tenantId, { status: "moved_out" });
    await syncUnitForTenant(ctx, args.tenantId);
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "deposit.settle",
      entityType: "depositSettlement",
      entityId: id,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new ConvexError("Settlement not found");
    return row;
  },
});

/** Internal: credit leftover / add credit (called from payments + invoices). */
export const addCreditInternal = internalMutation({
  args: { orgId: v.id("orgs"), tenantId: v.id("tenants"), amount: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rounded = Math.round(args.amount);
    if (!Number.isFinite(rounded) || rounded <= 0) return null;
    const existing = await ctx.db
      .query("tenantCredits")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    if (existing === null) {
      await ctx.db.insert("tenantCredits", {
        orgId: args.orgId,
        tenantId: args.tenantId,
        balance: rounded,
      });
    } else {
      await ctx.db.patch(existing._id, {
        balance: existing.balance + rounded,
      });
    }
    return null;
  },
});
