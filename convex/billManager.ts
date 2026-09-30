import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertOrgMember, assertStaff, audit, siteBaseUrl } from "./lib/auth";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { encryptSecret } from "./lib/mpesaCrypto";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Bill Manager: Safaricom-hosted e-invoicing + reminders + receipts.
 * Opt in once per shortcode → mirror each Kodi invoice (bulk ≤1000/call)
 * → tenants get SMS + 7/3/0-day reminders from Safaricom → they pay via
 * any channel with the account ref → payment callback hits
 * /billmanager-callback (retried 5× by Safaricom, deduped by
 * transactionId) → we reconcile through the ledger and acknowledge →
 * Safaricom sends the e-receipt. Callbacks carry the FULL MSISDN, unlike
 * C2B v2's masked number.
 */

const BILLMANAGER_BASE = "v1/billmanager-invoice";

const billStateShape = v.object({
  optedIn: v.boolean(),
  email: v.optional(v.string()),
  lastMirroredAt: v.optional(v.number()),
  seenCount: v.number(),
});

export const getBillManagerState = query({
  args: { orgId: v.id("orgs") },
  returns: billStateShape,
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const row = await ctx.db
      .query("billManagerState")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row === null) return { optedIn: false, seenCount: 0 };
    return {
      optedIn: row.optedIn,
      email: row.email ?? undefined,
      lastMirroredAt: row.lastMirroredAt,
      seenCount: row.seenTransactionIds?.length ?? 0,
    };
  },
});

/** Owner: opt the shortcode into Bill Manager (one-time per shortcode). */
export const optInBillManager = action({
  args: {
    orgId: v.id("orgs"),
    email: v.string(),
    officialContact: v.string(),
    sendReminders: v.boolean(),
  },
  returns: v.object({ optedIn: v.boolean() }),
  handler: async (ctx, args): Promise<{ optedIn: boolean }> => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const email = args.email.trim();
    const contact = args.officialContact.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ConvexError("A valid notification email is required");
    }
    if (contact === "") throw new ConvexError("An official contact is required");
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: args.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, args.orgId, creds);
    const res = await fetch(`${base}/${BILLMANAGER_BASE}/optin`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        shortcode: creds.shortcode,
        email,
        officialContact: contact,
        sendReminders: args.sendReminders ? 1 : 0,
        callbackurl: `${siteBase}/billmanager-callback`,
      }),
    });
    const raw = await res.text();
    let data: { app_key?: string; ResponseCode?: string; ResponseDescription?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new ConvexError(`Bill Manager opt-in rejected (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    }
    if (!data.app_key) {
      if (/already|opted/i.test(`${data.ResponseCode} ${data.ResponseDescription ?? raw}`)) {
        await ctx.runMutation(internal.billManagerInternal.markOptedIn, {
          orgId: args.orgId,
          email,
        });
        return { optedIn: true };
      }
      throw new ConvexError(
        `Opt-in said no (${data.ResponseCode ?? "?"}): ${(data.ResponseDescription ?? raw).slice(0, 200)}`,
      );
    }
    await ctx.runMutation(internal.billManagerInternal.markOptedIn, {
      orgId: args.orgId,
      email,
      appKeyEnc: await encryptSecret(data.app_key),
    });
    return { optedIn: true };
  },
});

/**
 * Staff: mirror unpaid Kodi invoices into Bill Manager (bulk, ≤1000/call).
 * externalReference = Convex invoice id; accountReference = tenant Paybill
 * code — so the payment callback routes through the existing match path.
 */
export const mirrorInvoicesToBillManager = action({
  args: { orgId: v.id("orgs"), month: v.optional(v.string()) },
  returns: v.object({ mirrored: v.number(), failed: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ mirrored: number; failed: number }> => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const targets = await ctx.runQuery(
      internal.billManagerInternal.unpaidForMirror,
      { orgId: args.orgId, month: args.month },
    );
    if (targets.appKey === null) {
      throw new ConvexError(
        "Bill Manager is not opted in — owner: Settings → Bill Manager → Opt in",
      );
    }
    if (targets.invoices.length === 0) return { mirrored: 0, failed: 0 };
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: args.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, args.orgId, creds);
    const appKey: string = targets.appKey;
    let mirrored = 0;
    let failed = 0;
    for (let i = 0; i < targets.invoices.length; i += 1000) {
      const chunk = targets.invoices.slice(i, i + 1000);
      const res = await fetch(`${base}/${BILLMANAGER_BASE}/bulk-invoicing`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          appKey,
        },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          bulk: chunk.map(
            (inv: {
              invoiceId: string;
              tenantName: string;
              phone: string;
              month: string;
              dueDate: string;
              accountCode: string;
              balance: number;
              items: Array<{ itemName: string; amount: number }>;
            }) => ({
            externalReference: inv.invoiceId,
            billedFullName: inv.tenantName,
            billedPhone: inv.phone,
            billedPeriod: inv.month,
            invoiceName: `Rent ${inv.month}`,
            dueDate: inv.dueDate,
            accountReference: inv.accountCode,
            amount: inv.balance,
            invoiceItems: inv.items,
          })),
        }),
      });
      if (res.ok) {
        mirrored += chunk.length;
      } else {
        failed += chunk.length;
        await ctx.runMutation(internal.c2b.logWebhookInternal, {
          orgId: args.orgId,
          route: "out-billmanager",
          outcome: "mirror-rejected",
          detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        });
      }
    }
    await ctx.runMutation(internal.billManagerInternal.markMirrored, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      summary: `${mirrored} mirrored, ${failed} failed`,
    });
    return { mirrored, failed };
  },
});

/**
 * Owner: cancel a mirrored invoice (single or bulk id) while unpaid —
 * Daraja answers 409 once the tenant has paid.
 */
export const cancelBillManagerInvoice = action({
  args: {
    orgId: v.id("orgs"),
    externalReference: v.string(),
    bulk: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const ref = args.externalReference.trim();
    if (ref === "") throw new ConvexError("Invoice reference is required");
    const appKey = await ctx.runQuery(internal.billManagerInternal.getAppKey, {
      orgId: args.orgId,
    });
    if (appKey === null) throw new ConvexError("Bill Manager is not opted in");
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: args.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, args.orgId, creds);
    const path =
      args.bulk === true
        ? `${BILLMANAGER_BASE}/cancel-bulk-invoice`
        : `${BILLMANAGER_BASE}/cancel-single-invoice`;
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        appKey,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ externalReference: ref }),
    });
    if (res.status === 409) {
      throw new ConvexError("Already paid — cancel is rejected once paid");
    }
    if (!res.ok) {
      throw new ConvexError(
        `Cancel rejected (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    await ctx.runMutation(internal.billManagerInternal.auditCancel, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      ref,
    });
    return null;
  },
});

/** Owner: update opt-in contact details. */
export const updateBillManagerDetails = action({
  args: {
    orgId: v.id("orgs"),
    email: v.optional(v.string()),
    officialContact: v.optional(v.string()),
    sendReminders: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const appKey = await ctx.runQuery(internal.billManagerInternal.getAppKey, {
      orgId: args.orgId,
    });
    if (appKey === null) throw new ConvexError("Bill Manager is not opted in");
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: args.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, args.orgId, creds);
    const res = await fetch(
      `${base}/${BILLMANAGER_BASE}/change-optin-details`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          appKey,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          shortcode: creds.shortcode,
          email: args.email?.trim() || undefined,
          officialContact: args.officialContact?.trim() || undefined,
          sendReminders:
            args.sendReminders === undefined
              ? undefined
              : args.sendReminders
                ? 1
                : 0,
        }),
      },
    );
    if (!res.ok) {
      throw new ConvexError(
        `Update rejected (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return null;
  },
});

/** Staff: acknowledge a mirrored invoice paid (audit trail). */
export const acknowledgeBillManagerReceipt = mutation({
  args: { orgId: v.id("orgs"), transactionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      action: "billmanager.ack",
      entityType: "c2bPayment",
      entityId: args.transactionId,
    });
    return null;
  },
});

export { billStateShape };
