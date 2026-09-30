import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { decryptSecret } from "./lib/mpesaCrypto";

/** Bonga operator credential storage (separate SHA256 user/pass scheme). */

export const getBongaCreds = internalQuery({
  args: { orgId: v.id("orgs") },
  returns: v.union(
    v.object({ username: v.string(), password: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (
      row === null ||
      row.bongaUsernameEnc === undefined ||
      row.bongaPasswordEnc === undefined
    ) {
      return null;
    }
    try {
      const [username, password] = await Promise.all([
        decryptSecret(row.bongaUsernameEnc),
        decryptSecret(row.bongaPasswordEnc),
      ]);
      if (!username || !password) return null;
      return { username, password };
    } catch {
      return null;
    }
  },
});

export const storeBongaCreds = internalMutation({
  args: {
    orgId: v.id("orgs"),
    usernameEnc: v.string(),
    passwordEnc: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      bongaUsernameEnc: args.usernameEnc,
      bongaPasswordEnc: args.passwordEnc,
    });
    return null;
  },
});
