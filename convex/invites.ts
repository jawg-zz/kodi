import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Invite-link flow. Convex Auth has no admin-create-user API (unlike
 * Supabase auth.admin), so staff create an invite record with a random
 * token; the invitee signs up with email+password, then claims the token,
 * which links them as manager or tenant portal user.
 */

const inviteShape = v.object({
  _id: v.id("invites"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  email: v.string(),
  fullName: v.string(),
  phone: v.string(),
  kind: v.union(v.literal("tenant"), v.literal("manager")),
  tenantId: v.optional(v.id("tenants")),
  token: v.string(),
  expiresAt: v.number(),
  claimedBy: v.optional(v.string()),
});

function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

export const createInviteInternal = internalMutation({
  args: {
    orgId: v.id("orgs"),
    email: v.string(),
    fullName: v.string(),
    phone: v.string(),
    kind: v.union(v.literal("tenant"), v.literal("manager")),
    tenantId: v.optional(v.id("tenants")),
  },
  returns: v.object({
    email: v.string(),
    tempPassword: v.null(),
    invited: v.boolean(),
    inviteToken: v.string(),
  }),
  handler: async (ctx, args) => {
    // 20 invites / hour / org throttle.
    const hourAgo = Date.now() - 3600_000;
    const recent = await ctx.db
      .query("invites")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    if (recent.filter((r) => r._creationTime > hourAgo).length >= 20) {
      throw new ConvexError("Too many invites — try again later");
    }
    const email = args.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConvexError("A valid email is required");
    }
    if (args.fullName.trim() === "") {
      throw new ConvexError("Full name is required");
    }
    if (args.kind === "tenant") {
      if (args.tenantId === undefined) {
        throw new ConvexError("tenantId is required for tenant invites");
      }
      const tenant = await ctx.db.get(args.tenantId);
      if (tenant === null || tenant.orgId !== args.orgId) {
        throw new ConvexError("Tenant not found in your organization");
      }
      const already = await ctx.db
        .query("tenantUsers")
        .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId as Id<"tenants">))
        .first();
      if (already !== null) {
        throw new ConvexError("This tenant already has a portal login");
      }
    }
    const token = randomToken();
    await ctx.db.insert("invites", {
      orgId: args.orgId,
      email,
      fullName: args.fullName.trim(),
      phone: args.phone.trim(),
      kind: args.kind,
      tenantId: args.tenantId,
      token,
      expiresAt: Date.now() + 7 * 24 * 3600_000,
    });
    return { email, tempPassword: null, invited: false, inviteToken: token };
  },
});

export const inviteUser = action({
  args: {
    email: v.string(),
    fullName: v.string(),
    phone: v.string(),
    kind: v.union(v.literal("tenant"), v.literal("manager")),
    tenantId: v.optional(v.id("tenants")),
  },
  returns: v.object({
    email: v.string(),
    tempPassword: v.null(),
    invited: v.boolean(),
    inviteToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller: { userId: string; orgId: Id<"orgs">; role: string } =
      await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role !== "owner" && caller.role !== "manager") {
      throw new ConvexError("Only staff can invite users");
    }
    return await ctx.runMutation(internal.invites.createInviteInternal, {
      orgId: caller.orgId,
      email: args.email,
      fullName: args.fullName,
      phone: args.phone,
      kind: args.kind,
      tenantId: args.tenantId,
    });
  },
});

export const claimInviteInternal = internalMutation({
  args: { token: v.string(), userId: v.string() },
  returns: v.object({ orgId: v.id("orgs"), kind: v.string() }),
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (invite === null) throw new ConvexError("Invite not found");
    if (invite.expiresAt < Date.now()) {
      throw new ConvexError("This invite has expired");
    }
    if (invite.claimedBy !== undefined) {
      throw new ConvexError("This invite was already used");
    }
    if (invite.kind === "manager") {
      const existing = await ctx.db
        .query("orgMembers")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first();
      if (existing === null) {
        await ctx.db.insert("orgMembers", {
          orgId: invite.orgId,
          userId: args.userId,
          role: "manager",
        });
      }
    } else {
      if (invite.tenantId === undefined) {
        throw new ConvexError("Invite is missing its tenant");
      }
      const existing = await ctx.db
        .query("tenantUsers")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first();
      if (existing === null) {
        await ctx.db.insert("tenantUsers", {
          tenantId: invite.tenantId,
          userId: args.userId,
        });
      }
    }
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (profile === null) {
      await ctx.db.insert("profiles", {
        userId: args.userId,
        full_name: invite.fullName,
        phone: invite.phone || undefined,
      });
    }
    await ctx.db.patch(invite._id, { claimedBy: args.userId });
    return { orgId: invite.orgId, kind: invite.kind };
  },
});

export const claimInvite = action({
  args: { token: v.string() },
  returns: v.object({ orgId: v.id("orgs"), kind: v.string() }),
  handler: async (ctx, args) => {
    // Any authenticated user may claim (invite token is the capability).
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new ConvexError("Not authenticated");
    return await ctx.runMutation(internal.invites.claimInviteInternal, {
      token: args.token,
      userId: identity.subject,
    });
  },
});

export const getInvite = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({
      email: v.string(),
      fullName: v.string(),
      kind: v.union(v.literal("tenant"), v.literal("manager")),
      expired: v.boolean(),
      claimed: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (invite === null) return null;
    return {
      email: invite.email,
      fullName: invite.fullName,
      kind: invite.kind,
      expired: invite.expiresAt < Date.now(),
      claimed: invite.claimedBy !== undefined,
    };
  },
});

export { inviteShape };
