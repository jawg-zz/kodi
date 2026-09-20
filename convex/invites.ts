import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Invite-link flow. Convex Auth has no admin-create-user API (unlike
 * Supabase auth.admin), so staff create an invite record with a random
 * token; the invitee signs up with email+password, then claims the token,
 * which links them as manager or tenant portal user.
 *
 * Writes live in invitesInternal.ts (avoids same-module circular refs).
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
  handler: async (
    ctx: ActionCtx,
    args: {
      email: string;
      fullName: string;
      phone: string;
      kind: "tenant" | "manager";
      tenantId?: Id<"tenants">;
    },
  ): Promise<{
    email: string;
    tempPassword: null;
    invited: boolean;
    inviteToken: string;
  }> => {
    const caller: { userId: string; orgId: Id<"orgs">; role: string } =
      await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role !== "owner" && caller.role !== "manager") {
      throw new ConvexError("Only staff can invite users");
    }
    return await ctx.runMutation(internal.invitesInternal.createInvite, {
      orgId: caller.orgId,
      email: args.email,
      fullName: args.fullName,
      phone: args.phone,
      kind: args.kind,
      tenantId: args.tenantId,
    });
  },
});

export const claimInvite = action({
  args: { token: v.string() },
  returns: v.object({ orgId: v.id("orgs"), kind: v.string() }),
  handler: async (
    ctx: ActionCtx,
    args: { token: string },
  ): Promise<{ orgId: Id<"orgs">; kind: string }> => {
    // Any authenticated user may claim (invite token is the capability).
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new ConvexError("Not authenticated");
    return await ctx.runMutation(internal.invitesInternal.claimInvite, {
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
