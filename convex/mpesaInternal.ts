import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { decryptSecret, encryptSecret } from "./lib/mpesaCrypto";
import { recordPaymentCore } from "./lib/ledger";

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
    paidAmount: v.optional(v.union(v.number(), v.null())),
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
    if (args.paidAmount !== undefined && args.paidAmount !== null) {
      patch.amount = args.paidAmount;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(tx._id, patch as never);
    }
    return null;
  },
});

/**
 * Shared success reconciliation for one checkout: if a payment is already
 * linked, return its id (idempotent retry); otherwise record the ledger
 * payment (which atomically claims the checkout) and return the new id.
 * The canonical amount/receipt come from the caller (callback metadata
 * wins over the initiated amount because partial debits happen).
 */
export const reconcileSuccessInternal = internalMutation({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    checkoutRequestId: v.string(),
    amount: v.number(),
    mpesaReceipt: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ paymentId: v.id("payments"), deduplicated: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tx = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId),
      )
      .first();
    if (tx === null) return null;
    if (tx.paymentId !== undefined) {
      return { paymentId: tx.paymentId, deduplicated: true };
    }
    const rounded = Math.round(args.amount);
    if (!Number.isFinite(rounded) || rounded <= 0) return null;
    const res = await recordPaymentCore(ctx, {
      orgId: args.orgId,
      tenantId: args.tenantId,
      amount: rounded,
      method: "mpesa_stk",
      mpesaCode: args.mpesaReceipt,
      checkoutRequestId: args.checkoutRequestId,
      note: "M-Pesa STK Push",
    });
    // Mirror the Daraja-reported amount on the tx row so the STK list
    // matches the ledger even when it differs from the initiated amount.
    const fresh = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) =>
        q.eq("checkoutRequestId", args.checkoutRequestId),
      )
      .first();
    if (fresh !== null && fresh.amount !== rounded) {
      await ctx.db.patch(fresh._id, { amount: rounded });
    }
    return { paymentId: res.id, deduplicated: false };
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
    initiatorName: v.optional(v.string()),
    initiatorPasswordEnc: v.optional(v.string()),
    initiatorCertPem: v.optional(v.string()),
    bongaUsernameEnc: v.optional(v.string()),
    bongaPasswordEnc: v.optional(v.string()),
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

/**
 * Internal: read the decrypted initiator name/password/cert for actions
 * that need a SecurityCredential. Null when the owner never set them —
 * callers must fail with a Settings-pointer error, never a bare null deref.
 * Never exposed to clients.
 */
export const getDecryptedInitiator = internalMutation({
  args: { orgId: v.id("orgs") },
  returns: v.union(
    v.object({
      environment: v.union(v.literal("sandbox"), v.literal("production")),
      shortcode: v.string(),
      initiatorName: v.string(),
      initiatorPassword: v.string(),
      initiatorCertPem: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (
      row === null ||
      row.initiatorName === undefined ||
      row.initiatorPasswordEnc === undefined ||
      row.initiatorCertPem === undefined
    ) {
      return null;
    }
    return {
      environment: row.environment,
      shortcode: row.shortcode,
      initiatorName: row.initiatorName,
      initiatorPassword: await decryptSecret(row.initiatorPasswordEnc),
      initiatorCertPem: row.initiatorCertPem,
    };
  },
});

/**
 * Token cache backing (see lib/daraja.ts): read the decrypted cached
 * token, or null when no fresh-enough value exists. Encryption matches
 * the credential blobs (AES-GCM via CREDENTIALS_KEY).
 */
export const getCachedDarajaToken = internalQuery({
  args: { orgId: v.id("orgs") },
  returns: v.union(
    v.object({ token: v.string(), expiresAt: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (
      row === null ||
      row.darajaTokenEnc === undefined ||
      row.darajaTokenExpiresAt === undefined
    ) {
      return null;
    }
    try {
      const token = await decryptSecret(row.darajaTokenEnc);
      if (!token) return null;
      return { token, expiresAt: row.darajaTokenExpiresAt };
    } catch {
      // Re-keyed CREDENTIALS_KEY or corrupt blob: fail open so the caller
      // mints a fresh token and re-stores under the current key.
      return null;
    }
  },
});

export const storeCachedDarajaToken = internalMutation({
  args: {
    orgId: v.id("orgs"),
    token: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      darajaTokenEnc: await encryptSecret(args.token),
      darajaTokenExpiresAt: args.expiresAt,
    });
    return null;
  },
});

/** 30-minute sweep of stale pendings (cron + every stk-status poll). */export const expirePending = internalMutation({
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
