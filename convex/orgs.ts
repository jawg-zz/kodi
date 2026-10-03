import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
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
    v.literal("suspended"),
  ),
  subscription_period_end: v.optional(v.string()),
  invoice_due_day: v.number(),
  reversal_limit: v.optional(v.number()),
  logoStorageId: v.optional(v.string()),
});

const PLANS = ["starter", "growth", "pro"] as const;

/** Current caller's org + membership + tenant link (drives routing).
 * Pass orgId to pin multi-org staff to one org (the switcher); the id must
 * belong to the caller. Tenants resolve through their own link. */
export const myOrg = query({
  args: { orgId: v.optional(v.id("orgs")) },
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
          accountCode: v.string(),
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
  handler: async (ctx, args) => {
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
    const memberships = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let membership = memberships[0] ?? null;
    if (args.orgId !== undefined) {
      const pinned = memberships.find(
        (m) => m.orgId.toString() === (args.orgId as string).toString(),
      );
      if (pinned === undefined) throw new ConvexError("Not a member of this organization");
      membership = pinned;
    }
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

/** All orgs the caller belongs to — drives the org switcher. */
export const myOrgs = query({
  args: {},
  returns: v.array(
    v.object({
      orgId: v.id("orgs"),
      name: v.string(),
      role: v.union(v.literal("owner"), v.literal("manager")),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return [];
    const memberships = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
    const out: { orgId: (typeof memberships)[number]["orgId"]; name: string; role: "owner" | "manager" }[] = [];
    for (const m of memberships) {
      const org = await ctx.db.get(m.orgId);
      if (org === null) continue;
      out.push({ orgId: m.orgId, name: org.name, role: m.role });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
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
      // Name/phone come from the onboarding form (Logto holds the email).
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
    reversal_limit: v.optional(v.number()),
    logoStorageId: v.optional(v.union(v.string(), v.null())),
    subscription_status: v.optional(
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
    if (args.logoStorageId !== undefined && args.logoStorageId !== null) {
      patch.logoStorageId = args.logoStorageId;
    }
    if (args.reversal_limit !== undefined) {
      // Owner-only: the limit gates who may reverse big money.
      if (caller.role !== "owner") {
        throw new ConvexError("Only the business owner can change this.");
      }
      const limit = Math.round(args.reversal_limit);
      if (!Number.isFinite(limit) || limit < 0 || limit > 10_000_000) {
        throw new ConvexError("Reversal limit must be 0–10,000,000 KES (0 disables the gate).");
      }
      patch.reversal_limit = limit;
    }
    if (args.logoStorageId === null) {
      // Clear the logo. Convex patch() leaves absent keys alone rather
      // than deleting them, so rewrite the doc without the key, then
      // apply any remaining field updates on top.
      const row = (await ctx.db.get(args.orgId)) as unknown as Record<string, unknown> | null;
      if (row !== null && "logoStorageId" in row) {
        const cleaned = { ...row };
        delete cleaned.logoStorageId;
        delete (cleaned as Record<string, unknown>)._id;
        delete (cleaned as Record<string, unknown>)._creationTime;
        await ctx.db.replace(args.orgId, cleaned as never);
      }
      const { logoStorageId: _drop, ...rest } = patch as Record<string, unknown>;
      void _drop;
      if (Object.keys(rest).length > 0) {
        await ctx.db.patch(args.orgId, rest as never);
      }
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: caller.userId,
        action: "org.update",
        entityType: "org",
        entityId: args.orgId,
      });
    } else if (Object.keys(patch).length > 0) {
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

/**
 * Owner-only: how this landlord wants managed-paybill money forwarded —
 * their own paybill, till, Pochi wallet, or B2C to a personal number.
 * Targets are digit-sanitized (paybill/till: 5–12 digits, b2c/pochi:
 * 254XXXXXXXXXX) so the forwarder never re-interprets UI strings.
 */
export const setPayoutPreference = mutation({
  args: {
    orgId: v.id("orgs"),
    method: v.union(
      v.literal("paybill"),
      v.literal("till"),
      v.literal("pochi"),
      v.literal("b2c"),
    ),
    target: v.string(),
    autoForward: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    if (caller.role !== "owner") {
      throw new ConvexError("Only the business owner can change payout settings.");
    }
    const digits = args.target.replace(/\D/g, "");
    if (args.method === "paybill" || args.method === "till") {
      if (!/^\d{5,12}$/.test(digits)) {
        throw new ConvexError("Paybill/till must be 5–12 digits.");
      }
    } else {
      if (digits.length !== 12 || !digits.startsWith("254")) {
        throw new ConvexError("Pochi/B2C needs a 254XXXXXXXXXX number.");
      }
    }
    await ctx.db.patch(args.orgId, {
      payoutMethod: args.method,
      payoutTarget: digits,
      ...(args.autoForward === undefined ? {} : { autoForward: args.autoForward }),
    });
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "org.payout",
      entityType: "org",
      entityId: args.orgId,
    });
    return null;
  },
});

/** Storage id for /org-logo: own logo, else platform org's logo. */
export const logoStorageFor = internalQuery({
  args: { orgId: v.id("orgs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org?.logoStorageId) return org.logoStorageId;
    const creds = await ctx.db.query("mpesaCredentials").collect();
    const platform = creds.find((c) => c.platformPaybill === true);
    if (platform === undefined) return null;
    const platformOrg = await ctx.db.get(platform.orgId);
    return platformOrg?.logoStorageId ?? null;
  },
});

/** Signed upload URL for an org logo (owner/manager uploads, 5MB cap enforced client-side). */
export const logoUploadUrl = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Store the uploaded blob's id on the org (replaces any previous logo). */
export const setOrgLogo = mutation({
  args: { orgId: v.id("orgs"), storageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    if (caller.role !== "owner") {
      throw new ConvexError("Only the business owner can change the logo.");
    }
    const meta = await ctx.db.system.get(args.storageId as never);
    if (meta === null) throw new ConvexError("Upload not found — try again.");
    await ctx.db.patch(args.orgId, { logoStorageId: args.storageId } as never);
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "org.logo",
      entityType: "org",
      entityId: args.orgId,
    });
    return null;
  },
});

/** Remove the org logo (falls back to the platform logo). */
export const clearOrgLogo = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    if (caller.role !== "owner") {
      throw new ConvexError("Only the business owner can change the logo.");
    }
    const row = (await ctx.db.get(args.orgId)) as unknown as Record<string, unknown> | null;
    if (row !== null && "logoStorageId" in row) {
      const cleaned = { ...row };
      delete cleaned.logoStorageId;
      delete cleaned._id;
      delete cleaned._creationTime;
      await ctx.db.replace(args.orgId, cleaned as never);
    }
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "org.logo.clear",
      entityType: "org",
      entityId: args.orgId,
    });
    return null;
  },
});

/**
 * Resolve the display logo for an org: its own upload, else the platform
 * org's logo, else null. Returns a same-origin /org-logo redirect URL so
 * <img> tags never need storage credentials.
 */
export const getOrgLogo = query({
  args: { orgId: v.id("orgs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org?.logoStorageId) {
      return `/org-logo?orgId=${args.orgId}`;
    }
    const creds = await ctx.db.query("mpesaCredentials").collect();
    const platform = creds.find((c) => c.platformPaybill === true);
    if (platform === undefined) return null;
    const platformOrg = await ctx.db.get(platform.orgId);
    if (platformOrg?.logoStorageId) {
      return `/org-logo?orgId=${platform.orgId}`;
    }
    return null;
  },
});
