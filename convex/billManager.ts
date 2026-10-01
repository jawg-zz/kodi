import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertOrgMember, assertStaff, audit, siteBaseUrl } from "./lib/auth";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { encryptSecret } from "./lib/mpesaCrypto";
import { postCandidates } from "./lib/initiatorJobs";

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

/**
 * Production base path per the go-live email
 * (https://api.safaricom.co.ke/v1/billmanager-invoice/v1/billmanager-invoice/*):
 * the family segment doubles. Sandbox may use the single-segment form —
 * candidates below try the email-confirmed path first.
 */
const BILLMANAGER_BASE = "v1/billmanager-invoice/v1/billmanager-invoice";
const BILLMANAGER_BASE_SANDBOX = "v1/billmanager-invoice";

/**
 * Bill Manager POST with the appKey header. postCandidates doesn't take
 * extra headers, and these calls need per-chunk/per-status handling
 * anyway — so this helper keeps the raw fetch but translates the two
 * portal-fix failures (unsubscribed product, wrong path) into the same
 * plain language the shared caller uses.
 */
async function billManagerPost(
  base: string,
  token: string,
  appKey: string,
  path: string,
  body: Record<string, unknown>,
  label: string,
  timeoutMs = 30_000,
): Promise<{ status: number; body: string }> {
  // Email-confirmed production path first, then the single-segment
  // sandbox form, then the mpesa/-prefixed legacy form.
  const single = path.startsWith(`${BILLMANAGER_BASE}/`)
    ? `${BILLMANAGER_BASE_SANDBOX}/${path.slice(BILLMANAGER_BASE.length + 1)}`
    : path;
  const candidates = [path, single, `mpesa/${single}`];
  let last404 = "";
  for (const p of candidates) {
    const res = await fetch(`${base}/${p}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        appKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 404) {
      last404 = text.slice(0, 160);
      continue;
    }
    if (/no apiproduct match/i.test(text)) {
      throw new ConvexError(
        `${label}: your Daraja app isn't subscribed to the Bill Manager product — open the app at developer.safaricom.co.ke, subscribe it, then retry. Keys and shortcode are fine.`,
      );
    }
    return { status: res.status, body: text };
  }
  throw new ConvexError(
    `${label}: no known endpoint path answered (all 404) — ${last404 || "check the Daraja catalogue for a renamed path"}`,
  );
}

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
    // Route through the shared caller: Bill Manager opt-in is a sync
    // endpoint (no job row), but postCandidates gives us the friendly
    // "app isn't subscribed" error plus the documented-path fallback.
    const res = await postCandidates(
      {
        orgId: args.orgId,
        environment: creds.environment,
        base,
        token,
        shortcode: creds.shortcode,
        initiatorName: "",
        credential: "",
        siteBase,
      },
      [
        `${BILLMANAGER_BASE}/optin`,
        `${BILLMANAGER_BASE_SANDBOX}/optin`,
        `mpesa/${BILLMANAGER_BASE_SANDBOX}/optin`,
      ],
      {
        shortcode: creds.shortcode,
        email,
        officialContact: contact,
        sendReminders: args.sendReminders ? 1 : 0,
        callbackurl: `${siteBase}/billmanager-callback`,
      },
      "Bill Manager",
    );
    let data: { app_key?: string; ResponseCode?: string; ResponseDescription?: string } = {};
    try {
      data = JSON.parse(res.body) as typeof data;
    } catch {
      throw new ConvexError(`Bill Manager opt-in rejected with a non-JSON reply: ${res.body.slice(0, 200)}`);
    }
    if (!data.app_key) {
      if (/already|opted/i.test(`${data.ResponseCode} ${data.ResponseDescription ?? res.body}`)) {
        await ctx.runMutation(internal.billManagerInternal.markOptedIn, {
          orgId: args.orgId,
          email,
        });
        return { optedIn: true };
      }
      throw new ConvexError(
        `Opt-in said no (${data.ResponseCode ?? "?"}): ${(data.ResponseDescription ?? res.body).slice(0, 200)}`,
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
      let res: { status: number; body: string };
      try {
        res = await billManagerPost(
          base,
          token,
          appKey,
          `${BILLMANAGER_BASE}/bulk-invoicing`,
          {
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
          },
          "Bill Manager",
          60_000,
        );
      } catch (e) {
        failed += chunk.length;
        await ctx.runMutation(internal.c2b.logWebhookInternal, {
          orgId: args.orgId,
          route: "out-billmanager",
          outcome: "mirror-rejected",
          detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        mirrored += chunk.length;
      } else {
        failed += chunk.length;
        await ctx.runMutation(internal.c2b.logWebhookInternal, {
          orgId: args.orgId,
          route: "out-billmanager",
          outcome: "mirror-rejected",
          detail: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
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
    const res = await billManagerPost(
      base,
      token,
      appKey,
      path,
      { externalReference: ref },
      "Bill Manager",
    );
    if (res.status === 409) {
      throw new ConvexError("Already paid — cancel is rejected once paid");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ConvexError(
        `Cancel rejected (HTTP ${res.status}): ${res.body.slice(0, 200)}`,
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
    const res = await billManagerPost(
      base,
      token,
      appKey,
      `${BILLMANAGER_BASE}/change-optin-details`,
      {
        shortcode: creds.shortcode,
        email: args.email?.trim() || undefined,
        officialContact: args.officialContact?.trim() || undefined,
        sendReminders:
          args.sendReminders === undefined
            ? undefined
            : args.sendReminders
              ? 1
              : 0,
      },
      "Bill Manager",
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ConvexError(
        `Update rejected (HTTP ${res.status}): ${res.body.slice(0, 200)}`,
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
