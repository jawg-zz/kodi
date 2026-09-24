import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { decryptSecret } from "./lib/mpesaCrypto";

/**
 * Internal M-Pesa row helpers. Split out of mpesa.ts so the public actions
 * there can call internal.mpesaInternal.* without a same-module circular
 * type reference.
 */

const txStatus = v.union(
  v.literal("pending"),
  v.literal("success"),
  v.literal("failed"),
  v.literal("timeout"),
);

const txShape = v.object({
  _id: v.id("mpesaTransactions"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.id("tenants"),
  checkoutRequestId: v.string(),
  merchantRequestId: v.optional(v.string()),
  phone: v.string(),
  amount: v.number(),
  status: txStatus,
  resultCode: v.optional(v.number()),
  resultDesc: v.optional(v.string()),
  mpesaReceipt: v.optional(v.string()),
  paymentId: v.optional(v.id("payments")),
  initiatedBy: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
});

/** Fetch tx by CheckoutRequestID for actions / HTTP. */
export const getTxByCheckout = internalMutation({
  args: { checkoutRequestId: v.string() },
  returns: v.union(txShape, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId),
      )
      .first();
  },
});

export const insertTx = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    checkoutRequestId: v.string(),
    merchantRequestId: v.optional(v.string()),
    phone: v.string(),
    amount: v.number(),
    initiatedBy: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.id("mpesaTransactions"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("mpesaTransactions", {
      ...args,
      status: "pending",
    });
  },
});

export const updateTx = internalMutation({
  args: {
    checkoutRequestId: v.string(),
    status: v.optional(txStatus),
    resultCode: v.optional(v.union(v.number(), v.null())),
    resultDesc: v.optional(v.union(v.string(), v.null())),
    mpesaReceipt: v.optional(v.union(v.string(), v.null())),
    paymentId: v.optional(v.id("payments")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const tx = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId),
      )
      .first();
    if (tx === null) return null;
    const patch: Record<string, unknown> = {};
    if (args.status !== undefined) patch.status = args.status;
    if (args.resultCode !== undefined) {
      patch.resultCode = args.resultCode ?? undefined;
    }
    if (args.resultDesc !== undefined) {
      patch.resultDesc = args.resultDesc ?? undefined;
    }
    if (args.mpesaReceipt !== undefined) {
      patch.mpesaReceipt = args.mpesaReceipt ?? undefined;
    }
    if (args.paymentId !== undefined) patch.paymentId = args.paymentId;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(tx._id, patch as never);
    }
    return null;
  },
});

/** Internal: read decrypted creds inside actions only (never to clients). */
export const getDecryptedCreds = internalMutation({
  args: { orgId: v.id("orgs") },
  returns: v.union(
    v.object({
      environment: v.union(v.literal("sandbox"), v.literal("production")),
      consumerKey: v.string(),
      consumerSecret: v.string(),
      shortcode: v.string(),
      passkey: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row === null || !row.consumerKeyEnc) return null;
    const [consumerKey, consumerSecret, passkey] = await Promise.all([
      decryptSecret(row.consumerKeyEnc),
      decryptSecret(row.consumerSecretEnc),
      decryptSecret(row.passkeyEnc),
    ]);
    return {
      environment: row.environment,
      consumerKey,
      consumerSecret,
      shortcode: row.shortcode,
      passkey,
    };
  },
});

export const storeCreds = internalMutation({
  args: {
    orgId: v.id("orgs"),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    consumerKeyEnc: v.string(),
    consumerSecretEnc: v.string(),
    shortcode: v.string(),
    passkeyEnc: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (existing === null) {
      await ctx.db.insert("mpesaCredentials", args);
    } else {
      await ctx.db.patch(existing._id, args);
    }
    return null;
  },
});

/** 30-minute sweep of stale pendings (cron + every stk-status poll). */
export const expirePending = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 60_000;
    const pendings = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    let count = 0;
    for (const tx of pendings) {
      if (tx._creationTime < cutoff) {
        await ctx.db.patch(tx._id, {
          status: "timeout",
          resultDesc:
            tx.resultDesc ?? "No confirmation received within 30 minutes.",
        });
        count += 1;
      }
    }
    return count;
  },
});

export { txStatus, txShape };
void ConvexError;
