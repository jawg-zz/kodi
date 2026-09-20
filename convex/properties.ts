import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";

const propertyType = v.union(
  v.literal("apartments"),
  v.literal("bedsitters"),
  v.literal("single_rooms"),
  v.literal("mixed"),
  v.literal("commercial"),
);

const unitType = v.union(
  v.literal("bedsitter"),
  v.literal("single"),
  v.literal("one_br"),
  v.literal("two_br"),
  v.literal("three_br"),
  v.literal("shop"),
  v.literal("other"),
);

const unitStatus = v.union(
  v.literal("vacant"),
  v.literal("occupied"),
  v.literal("notice"),
);

const propertyShape = v.object({
  _id: v.id("properties"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  name: v.string(),
  property_type: propertyType,
  location: v.string(),
  notes: v.optional(v.string()),
});

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
  status: v.union(
    v.literal("active"),
    v.literal("notice"),
    v.literal("moved_out"),
  ),
  notes: v.optional(v.string()),
});

const unitWithTenant = v.object({
  _id: v.id("units"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  propertyId: v.id("properties"),
  label: v.string(),
  unit_type: unitType,
  rent_amount: v.number(),
  water_charge: v.number(),
  garbage_charge: v.number(),
  status: unitStatus,
  currentTenantId: v.optional(v.id("tenants")),
  tenant: v.union(
    tenantShape,
    v.object({
      _id: v.id("tenants"),
      full_name: v.string(),
      phone: v.string(),
      status: v.union(
        v.literal("active"),
        v.literal("notice"),
        v.literal("moved_out"),
      ),
      deposit_held: v.number(),
    }),
    v.null(),
  ),
});

const unitShape = v.object({
  _id: v.id("units"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  propertyId: v.id("properties"),
  label: v.string(),
  unit_type: unitType,
  rent_amount: v.number(),
  water_charge: v.number(),
  garbage_charge: v.number(),
  status: unitStatus,
  currentTenantId: v.optional(v.id("tenants")),
});

const PLAN_LIMITS: Record<string, number> = {
  starter: 10,
  growth: 50,
  pro: 200,
};

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export const listProperties = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(propertyShape),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    return await ctx.db
      .query("properties")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

export const createProperty = mutation({
  args: {
    orgId: v.id("orgs"),
    name: v.string(),
    property_type: propertyType,
    location: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: propertyShape,
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const name = args.name.trim();
    if (name === "") throw new ConvexError("Property name is required.");
    const id = await ctx.db.insert("properties", {
      orgId: args.orgId,
      name,
      property_type: args.property_type,
      location: (args.location ?? "").trim(),
      notes: args.notes?.trim() || undefined,
    });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "property.create",
      entityType: "property",
      entityId: id,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new ConvexError("Property not found");
    return row;
  },
});

export const updateProperty = mutation({
  args: {
    id: v.id("properties"),
    name: v.optional(v.string()),
    property_type: v.optional(propertyType),
    location: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Property not found");
    const caller = await assertStaff(ctx, row.orgId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name === "") throw new ConvexError("Property name cannot be empty.");
      patch.name = name;
    }
    if (args.property_type !== undefined) patch.property_type = args.property_type;
    if (args.location !== undefined) patch.location = args.location.trim();
    if (args.notes !== undefined) patch.notes = args.notes.trim() || undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch as never);
      await audit(ctx, {
        orgId: row.orgId,
        actorUserId: caller.userId,
        action: "property.update",
        entityType: "property",
        entityId: args.id,
      });
    }
    return null;
  },
});

export const deleteProperty = mutation({
  args: { id: v.id("properties") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Property not found");
    const caller = await assertStaff(ctx, row.orgId);
    const units = await ctx.db
      .query("units")
      .withIndex("by_property", (q) => q.eq("propertyId", args.id))
      .collect();
    for (const u of units) {
      await ctx.db.delete(u._id);
    }
    await ctx.db.delete(args.id);
    await audit(ctx, {
      orgId: row.orgId,
      actorUserId: caller.userId,
      action: "property.delete",
      entityType: "property",
      entityId: args.id,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const listUnits = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(unitWithTenant),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    units.sort((a, b) => a.label.localeCompare(b.label));
    const out: (typeof units[number] & { tenant: unknown })[] = [];
    for (const u of units) {
      let tenant: unknown = null;
      if (u.currentTenantId !== undefined) {
        const t = await ctx.db.get(u.currentTenantId);
        tenant =
          t === null
            ? null
            : {
                _id: t._id,
                full_name: t.full_name,
                phone: t.phone,
                status: t.status,
                deposit_held: t.deposit_held,
              };
      }
      out.push({ ...u, tenant });
    }
    return out as never;
  },
});

export const countUnits = query({
  args: { orgId: v.id("orgs") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return units.length;
  },
});

function nonNegative(n: number, label: string): number {
  const r = Math.round(n);
  if (!Number.isFinite(r) || r < 0) {
    throw new ConvexError(`${label} must be a non-negative amount.`);
  }
  return r;
}

export const createUnit = mutation({
  args: {
    orgId: v.id("orgs"),
    propertyId: v.id("properties"),
    label: v.string(),
    unit_type: unitType,
    rent_amount: v.number(),
    water_charge: v.number(),
    garbage_charge: v.number(),
  },
  returns: unitShape,
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const property = await ctx.db.get(args.propertyId);
    if (property === null || property.orgId !== args.orgId) {
      throw new ConvexError("Property not found in this organization");
    }
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new ConvexError("Organization not found");
    const limit = PLAN_LIMITS[org.plan_code] ?? 10;
    const existing = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    if (existing.length >= limit) {
      throw new ConvexError(`Unit limit reached for this plan (${limit})`);
    }
    const label = args.label.trim();
    if (label === "") throw new ConvexError("Unit label is required.");
    if (
      existing.some(
        (u) => u.propertyId === args.propertyId && u.label === label,
      )
    ) {
      throw new ConvexError("A unit with this label already exists in this property.");
    }
    const id = await ctx.db.insert("units", {
      orgId: args.orgId,
      propertyId: args.propertyId,
      label,
      unit_type: args.unit_type,
      rent_amount: nonNegative(args.rent_amount, "Rent"),
      water_charge: nonNegative(args.water_charge, "Water charge"),
      garbage_charge: nonNegative(args.garbage_charge, "Garbage charge"),
      status: "vacant",
    });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "unit.create",
      entityType: "unit",
      entityId: id,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new ConvexError("Unit not found");
    return row;
  },
});

export const updateUnit = mutation({
  args: {
    id: v.id("units"),
    label: v.optional(v.string()),
    unit_type: v.optional(unitType),
    rent_amount: v.optional(v.number()),
    water_charge: v.optional(v.number()),
    garbage_charge: v.optional(v.number()),
    propertyId: v.optional(v.id("properties")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Unit not found");
    const caller = await assertStaff(ctx, row.orgId);
    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) {
      const label = args.label.trim();
      if (label === "") throw new ConvexError("Unit label cannot be empty.");
      const siblings = await ctx.db
        .query("units")
        .withIndex("by_property", (q) => q.eq("propertyId", row.propertyId))
        .collect();
      if (siblings.some((u) => u._id !== args.id && u.label === label)) {
        throw new ConvexError(
          "A unit with this label already exists in this property.",
        );
      }
      patch.label = label;
    }
    if (args.unit_type !== undefined) patch.unit_type = args.unit_type;
    if (args.rent_amount !== undefined) {
      patch.rent_amount = nonNegative(args.rent_amount, "Rent");
    }
    if (args.water_charge !== undefined) {
      patch.water_charge = nonNegative(args.water_charge, "Water charge");
    }
    if (args.garbage_charge !== undefined) {
      patch.garbage_charge = nonNegative(args.garbage_charge, "Garbage charge");
    }
    if (args.propertyId !== undefined) {
      const p = await ctx.db.get(args.propertyId);
      if (p === null || p.orgId !== row.orgId) {
        throw new ConvexError("Property not found in this organization");
      }
      patch.propertyId = args.propertyId;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch as never);
      await audit(ctx, {
        orgId: row.orgId,
        actorUserId: caller.userId,
        action: "unit.update",
        entityType: "unit",
        entityId: args.id,
      });
    }
    return null;
  },
});

export const deleteUnit = mutation({
  args: { id: v.id("units") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Unit not found");
    const caller = await assertStaff(ctx, row.orgId);
    if (row.currentTenantId !== undefined) {
      throw new ConvexError("Cannot delete an occupied unit. Move the tenant out first.");
    }
    await ctx.db.delete(args.id);
    await audit(ctx, {
      orgId: row.orgId,
      actorUserId: caller.userId,
      action: "unit.delete",
      entityType: "unit",
      entityId: args.id,
    });
    return null;
  },
});
