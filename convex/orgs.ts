import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";

const orgShape = v.object({
  _id: v.id("orgs"),
  _creationTime: v.number(),
  name: v.string(),
  plan_code: v.string(),
  subscription_status: v.union(
    v.literal("trialing"),
    v.literal("active"),
    v.literal("past_due"),
  ),
  subscription_period_end: v.optional(v.string()),
  invoice_due_day: v.number(),
});

const PLANS = ["starter", "growth", "pro"] as const;

/** Current caller's org + membership + tenant link (drives routing). */
export const myOrg = query({
  args: {},
  returns: v.union(
    v.object({
      org: orgShape,
      role: v.union(
        v.literal("owner"),
        v.literal("manager"),
        v.literal("tenant"),
      ),
      profile: v.union(
        v.object({ full_name: v.string(), phone: v.optional(v.string()) }),
        v.null(),
      ),
      tenant: v.union(
        v.object({
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
        }),
        v.null(),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;
    const userId = identity.subject;
    const profileRow = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const profile =
      profileRow === null
        ? null
        : { full_name: profileRow.full_name, phone: profileRow.phone };
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (membership !== null) {
      const org = await ctx.db.get(membership.orgId);
      if (org === null) return null;
      return { org, role: membership.role, profile, tenant: null };
    }
    const link = await ctx.db
      .query("tenantUsers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (link === null) return null;
    const tenant = await ctx.db.get(link.tenantId);
    if (tenant === null) return null;
    const org = await ctx.db.get(tenant.orgId);
    if (org === null) return null;
    return { org, role: "tenant" as const, profile, tenant };
  },
});

/** Atomic onboarding: org + owner membership + profile upsert. */
export const createOrg = mutation({
  args: {
    name: v.string(),
    planCode: v.string(),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  returns: orgShape,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new ConvexError("Not authenticated");
    const userId = identity.subject;
    const name = args.name.trim();
    if (name === "") throw new ConvexError("Give your rental business a name.");
    if (!(PLANS as readonly string[]).includes(args.planCode)) {
      throw new ConvexError("Invalid plan.");
    }
    const existing = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing !== null) throw new ConvexError("You already have a business.");

    const orgId = await ctx.db.insert("orgs", {
      name,
      plan_code: args.planCode,
      subscription_status: "trialing",
      invoice_due_day: 5,
    });
    await ctx.db.insert("orgMembers", {
      orgId,
      userId,
      role: "owner",
    });
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const fullName = (args.fullName ?? "").trim();
    const phone = (args.phone ?? "").trim() || undefined;
    if (profile === null) {
      // Name/phone come from the onboarding form (Zitadel holds the email).
      await ctx.db.insert("profiles", {
        userId,
        full_name: fullName,
        phone: phone,
      });
    } else {
      await ctx.db.patch(profile._id, {
        full_name: profile.full_name || fullName || profile.full_name,
        phone: profile.phone ?? phone,
      });
    }
    await audit(ctx, {
      orgId,
      actorUserId: userId,
      action: "org.create",
      entityType: "org",
      entityId: orgId,
    });
    const org = await ctx.db.get(orgId);
    if (org === null) throw new ConvexError("Organization not found");
    return org;
  },
});

export const updateOrg = mutation({
  args: {
    orgId: v.id("orgs"),
    name: v.optional(v.string()),
    invoice_due_day: v.optional(v.number()),
    plan_code: v.optional(v.string()),
    subscription_status: v.optional(
      v.union(
        v.literal("trialing"),
        v.literal("active"),
        v.literal("past_due"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name === "") throw new ConvexError("Name cannot be empty.");
      patch.name = name;
    }
    if (args.invoice_due_day !== undefined) {
      const d = Math.floor(args.invoice_due_day);
      if (!Number.isFinite(d) || d < 1 || d > 28) {
        throw new ConvexError("Due day must be between 1 and 28.");
      }
      patch.invoice_due_day = d;
    }
    if (args.plan_code !== undefined) {
      if (!(PLANS as readonly string[]).includes(args.plan_code)) {
        throw new ConvexError("Invalid plan.");
      }
      patch.plan_code = args.plan_code;
    }
    if (args.subscription_status !== undefined) {
      patch.subscription_status = args.subscription_status;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.orgId, patch as never);
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: caller.userId,
        action: "org.update",
        entityType: "org",
        entityId: args.orgId,
      });
    }
    return null;
  },
});

/** Staff list with profile names (one server-side join). */
export const listStaff = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(
    v.object({
      user_id: v.string(),
      role: v.union(v.literal("owner"), v.literal("manager")),
      name: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOrgMember(ctx, args.orgId);
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const out: { user_id: string; role: "owner" | "manager"; name: string }[] = [];
    for (const m of members) {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", m.userId))
        .first();
      out.push({
        user_id: m.userId,
        role: m.role,
        name: p?.full_name || "(no profile)",
      });
    }
    return out;
  },
});
