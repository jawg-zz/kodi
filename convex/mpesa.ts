import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertOrgMember,
  assertStaff,
  darajaTimestamp,
  normalizePhone,
  siteBaseUrl,
  stkPassword,
} from "./lib/auth";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { encryptSecret } from "./lib/mpesaCrypto";
import { inspectInitiatorCert } from "./lib/initiator";
import { txShape } from "./mpesaInternal";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listMpesaTransactions = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(txShape),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    return await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(100);
  },
});

export const listTenantMpesaAttempts = query({
  args: { tenantId: v.id("tenants") },
  returns: v.array(txShape),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return [];
    await assertOrgMember(ctx, tenant.orgId);
    return await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .order("desc")
      .take(10);
  },
});

export const getMpesaCreds = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    shortcode: v.string(),
  }),
  handler: async (ctx) => {
    const caller = await assertStaff(ctx);
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .first();
    if (row === null || !row.consumerKeyEnc) {
      return {
        configured: false,
        environment: "sandbox" as const,
        shortcode: "",
      };
    }
    return {
      configured: true,
      environment: row.environment,
      shortcode: row.shortcode,
    };
  },
});

/** Owner-only save of Daraja credentials (encrypted before storage). */
export const saveMpesaCreds = action({
  args: {
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    consumerKey: v.string(),
    consumerSecret: v.string(),
    shortcode: v.string(),
    passkey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller: { userId: string; orgId: Id<"orgs"> } =
      await ctx.runQuery(internal.helpers.assertOwner, {});
    const consumerKey = args.consumerKey.trim();
    const consumerSecret = args.consumerSecret.trim();
    const shortcode = args.shortcode.trim();
    const passkey = args.passkey.trim();
    if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
      throw new ConvexError(
        "consumerKey, consumerSecret, shortcode and passkey are all required",
      );
    }
    if (!/^\d{5,7}$/.test(shortcode)) {
      throw new ConvexError("Shortcode must be 5–7 digits");
    }
    const [consumerKeyEnc, consumerSecretEnc, passkeyEnc] = await Promise.all([
      encryptSecret(consumerKey),
      encryptSecret(consumerSecret),
      encryptSecret(passkey),
    ]);
    await ctx.runMutation(internal.mpesaInternal.storeCreds, {
      orgId: caller.orgId,
      environment: args.environment,
      consumerKeyEnc,
      consumerSecretEnc,
      shortcode,
      passkeyEnc,
    });
    return null;
  },
});

/**
 * Owner: save the M-Pesa initiator operator (name + API password + X.509
 * cert PEM from the Daraja portal). Unlocks Transaction Status, Balance,
 * Reversals, B2C/B2B, Tax. Password is AES-GCM encrypted; the cert is
 * public-key material. Parsed before storage so a bad paste fails fast.
 */
export const saveInitiatorCreds = action({
  args: {
    initiatorName: v.string(),
    initiatorPassword: v.string(),
    initiatorCertPem: v.string(),
  },
  returns: v.object({
    certSubject: v.string(),
    certValidTo: v.string(),
    certKeyBits: v.number(),
  }),
  handler: async (ctx, args) => {
    const caller: { userId: string; orgId: Id<"orgs"> } =
      await ctx.runQuery(internal.helpers.assertOwner, {});
    const name = args.initiatorName.trim();
    const password = args.initiatorPassword;
    const certPem = args.initiatorCertPem.trim();
    if (!name || !password || !certPem) {
      throw new ConvexError(
        "Initiator name, password and certificate PEM are all required",
      );
    }
    if (name.length > 64) throw new ConvexError("Initiator name too long");
    if (/[@.]/.test(password)) {
      throw new ConvexError(
        "M-Pesa rejects initiator passwords containing @ or . — reset it on the org portal first",
      );
    }
    let info: { subject: string; validTo: string; keyBits: number };
    try {
      info = inspectInitiatorCert(certPem);
    } catch (e) {
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: caller.orgId },
    );
    if (creds === null) {
      throw new ConvexError(
        "Save the Daraja consumer key/secret/shortcode first, then the initiator.",
      );
    }
    await ctx.runMutation(internal.mpesaInternal.storeCreds, {
      orgId: caller.orgId,
      environment: creds.environment,
      consumerKeyEnc: await encryptSecret(creds.consumerKey),
      consumerSecretEnc: await encryptSecret(creds.consumerSecret),
      shortcode: creds.shortcode,
      passkeyEnc: await encryptSecret(creds.passkey),
      initiatorName: name,
      initiatorPasswordEnc: await encryptSecret(password),
      initiatorCertPem: certPem,
    });
    return {
      certSubject: info.subject,
      certValidTo: info.validTo,
      certKeyBits: info.keyBits,
    };
  },
});

/** Staff: initiator setup state for Settings (never returns secrets). */
export const getInitiatorStatus = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    initiatorName: v.string(),
    certSubject: v.optional(v.string()),
    certExpired: v.optional(v.boolean()),
  }),
  handler: async (ctx) => {
    const caller = await assertStaff(ctx);
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .first();
    if (
      row === null ||
      row.initiatorName === undefined ||
      row.initiatorCertPem === undefined
    ) {
      return { configured: false, initiatorName: "" };
    }
    let subject: string | undefined;
    let expired: boolean | undefined;
    try {
      const info = inspectInitiatorCert(row.initiatorCertPem);
      subject = info.subject;
      expired = Date.parse(info.validTo) < Date.now();
    } catch {
      subject = "Unparseable certificate — re-paste it";
      expired = true;
    }
    return {
      configured: true,
      initiatorName: row.initiatorName,
      certSubject: subject,
      certExpired: expired,
    };
  },
});

// ---------------------------------------------------------------------------
// Local Daraja helpers (token itself lives in lib/daraja, cached per org)
// ---------------------------------------------------------------------------

type ActionCaller = {
  userId: string;
  orgId: Id<"orgs">;
  role: string;
  tenantId: Id<"tenants"> | null;
};

type TxDoc = {
  _id: Id<"mpesaTransactions">;
  _creationTime: number;
  orgId: Id<"orgs">;
  tenantId: Id<"tenants">;
  checkoutRequestId: string;
  merchantRequestId?: string;
  phone: string;
  amount: number;
  status: "pending" | "success" | "failed" | "timeout";
  resultCode?: number;
  resultDesc?: string;
  mpesaReceipt?: string;
  paymentId?: Id<"payments">;
  initiatedBy?: string;
  idempotencyKey?: string;
};

/** Staff or self-tenant STK initiate. */
export const stkInitiate = action({
  args: {
    tenantId: v.id("tenants"),
    phone: v.string(),
    amount: v.number(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.object({
    checkoutRequestId: v.string(),
    deduplicated: v.optional(v.boolean()),
  }),
  handler: async (
    ctx: ActionCtx,
    args: {
      tenantId: Id<"tenants">;
      phone: string;
      amount: number;
      idempotencyKey?: string;
    },
  ): Promise<{ checkoutRequestId: string; deduplicated?: boolean }> => {
    const caller: ActionCaller = await ctx.runQuery(
      internal.helpers.assertCaller,
      {},
    );
    const phone = normalizePhone(args.phone);
    if (phone === null) {
      throw new ConvexError("A valid Safaricom number is required");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount < 1) {
      throw new ConvexError("Amount must be at least KES 1");
    }
    if (amount > 500_000) {
      throw new ConvexError(
        "Amount looks too large — please confirm and try again (max KES 500,000 per push)",
      );
    }
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("You can only pay your own rent");
    }
    const tenant: { orgId: Id<"orgs"> } | null = await ctx.runQuery(
      internal.helpers.getTenantOrg,
      { tenantId: args.tenantId },
    );
    if (tenant === null || tenant.orgId !== caller.orgId) {
      throw new ConvexError("Tenant not found in your organization");
    }
    const idem = (args.idempotencyKey ?? "").slice(0, 128) || undefined;
    if (idem) {
      const dup: { checkoutRequestId: string } | null = await ctx.runQuery(
        internal.helpers.findPendingByIdem,
        { orgId: caller.orgId, idempotencyKey: idem },
      );
      if (dup !== null) {
        return { checkoutRequestId: dup.checkoutRequestId, deduplicated: true };
      }
    }
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: caller.orgId },
    );
    if (creds === null) {
      throw new ConvexError(
        "M-Pesa is not configured for this business. Add Daraja credentials in Settings.",
      );
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) {
      throw new ConvexError(
        "M-Pesa callbacks are not configured — set MPESA_CALLBACK_URL env var to your Convex site URL",
      );
    }
    const callbackUrl = `${siteBase}/stk-callback`;
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, caller.orgId, creds);
    const timestamp = darajaTimestamp();
    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: stkPassword(creds.shortcode, creds.passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: creds.shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: args.tenantId.slice(0, 12),
        TransactionDesc: "Rent payment",
      }),
    });
    const stk = (await stkRes.json()) as {
      ResponseCode?: string;
      ResponseDescription?: string;
      CheckoutRequestID?: string;
      MerchantRequestID?: string;
    };
    if (stk.ResponseCode !== "0" || !stk.CheckoutRequestID) {
      throw new ConvexError(
        stk.ResponseDescription ?? "STK Push was rejected by Daraja",
      );
    }
    await ctx.runMutation(internal.mpesaInternal.insertTx, {
      orgId: caller.orgId,
      tenantId: args.tenantId,
      checkoutRequestId: stk.CheckoutRequestID,
      merchantRequestId: stk.MerchantRequestID,
      phone,
      amount,
      initiatedBy: caller.userId,
      idempotencyKey: idem,
    });
    return { checkoutRequestId: stk.CheckoutRequestID };
  },
});

/** Poll Daraja for a pending tx; mirror + reconcile on success. */
export const stkStatus = action({
  args: { checkoutRequestId: v.string() },
  returns: txShape,
  handler: async (
    ctx: ActionCtx,
    args: { checkoutRequestId: string },
  ): Promise<TxDoc> => {
    const caller: ActionCaller = await ctx.runQuery(
      internal.helpers.assertCaller,
      {},
    );
    const tx = await ctx.runMutation(internal.mpesaInternal.getTxByCheckout, {
      checkoutRequestId: args.checkoutRequestId,
    });
    if (tx === null || tx.orgId !== caller.orgId) {
      throw new ConvexError("Transaction not found");
    }
    if (caller.role === "tenant" && caller.tenantId !== tx.tenantId) {
      throw new ConvexError("Transaction not found");
    }
    await ctx.runMutation(internal.mpesaInternal.expirePending, {});
    const fresh = await ctx.runMutation(
      internal.mpesaInternal.getTxByCheckout,
      { checkoutRequestId: args.checkoutRequestId },
    );
    if (fresh === null || fresh.status !== "pending") {
      if (fresh === null) throw new ConvexError("Transaction not found");
      return fresh;
    }
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: caller.orgId },
    );
    if (creds === null) return fresh;
    try {
      const base = darajaBase(creds.environment);
      const token = await cachedDarajaToken(ctx, caller.orgId, creds);
      const timestamp = darajaTimestamp();
      const q = await fetch(`${base}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          BusinessShortCode: creds.shortcode,
          Password: stkPassword(creds.shortcode, creds.passkey, timestamp),
          Timestamp: timestamp,
          CheckoutRequestID: tx.checkoutRequestId,
        }),
      });
      const data = (await q.json()) as {
        ResultCode?: string;
        ResultDesc?: string;
      };
      const code = String(data.ResultCode ?? "");
      if (code === "0") {
        // Single atomic reconcile: records the payment (claiming the
        // checkout) or returns the existing payment when the callback
        // already won the race. Never writes two payments for one push.
        const reconciled = await ctx.runMutation(
          internal.mpesaInternal.reconcileSuccessInternal,
          {
            orgId: tx.orgId,
            tenantId: tx.tenantId,
            checkoutRequestId: tx.checkoutRequestId,
            amount: tx.amount,
            mpesaReceipt: tx.mpesaReceipt,
          },
        );
        if (reconciled !== null && !reconciled.deduplicated) {
          await ctx.runMutation(internal.mpesaInternal.updateTx, {
            checkoutRequestId: tx.checkoutRequestId,
            resultCode: 0,
            resultDesc: data.ResultDesc,
          });
        }
      } else if (code === "1032") {
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: tx.checkoutRequestId,
          status: "failed",
          resultCode: 1032,
          resultDesc: data.ResultDesc,
        });
      } else if (code === "1037") {
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: tx.checkoutRequestId,
          status: "timeout",
          resultCode: 1037,
          resultDesc: data.ResultDesc,
        });
      } else if (code && code !== "0") {
        // Any other Daraja result is terminal for the handset prompt —
        // mark it failed with the code so staff see WHY instead of a
        // "pending" row that only clears on the 30-minute sweep.
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: tx.checkoutRequestId,
          status: "failed",
          resultCode: Number(code) || undefined,
          resultDesc: data.ResultDesc,
        });
      }
    } catch {
      // Daraja unreachable — return cached row; frontend keeps polling.
    }
    const latest = await ctx.runMutation(
      internal.mpesaInternal.getTxByCheckout,
      { checkoutRequestId: args.checkoutRequestId },
    );
    if (latest === null) throw new ConvexError("Transaction not found");
    return latest;
  },
});

export const expirePendingTransactions = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx: MutationCtx): Promise<number> => {
    await assertStaff(ctx);
    return await ctx.runMutation(internal.mpesaInternal.expirePending, {});
  },
});
