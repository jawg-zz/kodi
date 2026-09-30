import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertOrgMember } from "./lib/auth";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { postCandidates } from "./lib/initiatorJobs";

/**
 * Smart collections: Dynamic QR per invoice + B2B Hakikisha shortcode
 * setup guard. Both are synchronous OAuth-only calls (no initiator cert,
 * no job rows).
 */

const QR_CANDIDATES = [
  "mpesa/qrcode/v1/generate",
  "qrcode/v1/generate",
];

const ORGINFO_CANDIDATES = [
  "sfcverify/v1/query/info",
  "mpesa/sfcverify/v1/query/info",
];

/**
 * Staff: mint (or re-mint) a Dynamic QR for one invoice — PB + shortcode
 * + account code as RefNo + live balance. Cached on invoiceQrs so prints
 * don't re-mint; regenerated when the balance no longer matches.
 */
export const mintInvoiceQr = action({
  args: { invoiceId: v.id("invoices"), merchantName: v.optional(v.string()) },
  returns: v.object({
    qrBase64: v.string(),
    amount: v.number(),
    refNo: v.string(),
    cached: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ qrBase64: string; amount: number; refNo: string; cached: boolean }> => {
    const inv = await ctx.runQuery(internal.collectInternal.getInvoiceForQr, {
      invoiceId: args.invoiceId,
    });
    if (inv === null) throw new ConvexError("Invoice not found");
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== inv.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const cached = await ctx.runQuery(internal.collectInternal.getCachedQr, {
      invoiceId: args.invoiceId,
    });
    if (cached !== null && cached.amount === inv.balance) {
      return {
        qrBase64: cached.qrBase64,
        amount: cached.amount,
        refNo: cached.refNo,
        cached: true,
      };
    }
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: inv.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, inv.orgId, creds);
    const bundle = {
      orgId: inv.orgId,
      environment: creds.environment,
      base,
      token,
      shortcode: creds.shortcode,
      initiatorName: "",
      credential: "",
      siteBase: "",
    };
    const res = await postCandidates(
      bundle,
      QR_CANDIDATES,
      {
        MerchantName: (args.merchantName ?? inv.orgName ?? "Kodi").slice(0, 20),
        RefNo: inv.accountCode.slice(0, 20),
        Amount: inv.balance,
        TrxCode: "PB",
        CPI: creds.shortcode,
        Size: "300",
      },
      "Dynamic QR",
    );
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const qr =
      typeof parsed["QRCode"] === "string" ? (parsed["QRCode"] as string) : "";
    if (qr === "") {
      throw new ConvexError("Daraja returned no QR image — check the shortcode is a Paybill");
    }
    await ctx.runMutation(internal.collectInternal.storeQr, {
      orgId: inv.orgId,
      invoiceId: args.invoiceId,
      qrBase64: qr,
      amount: inv.balance,
      refNo: inv.accountCode,
    });
    return { qrBase64: qr, amount: inv.balance, refNo: inv.accountCode, cached: false };
  },
});

/** Staff: cached QR for an invoice (prints read this, no Daraja call). */
export const getInvoiceQr = query({
  args: { invoiceId: v.id("invoices") },
  returns: v.union(
    v.object({
      qrBase64: v.string(),
      amount: v.number(),
      refNo: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("invoiceQrs")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", args.invoiceId))
      .first();
    if (row === null) return null;
    await assertOrgMember(ctx, row.orgId);
    return { qrBase64: row.qrBase64, amount: row.amount, refNo: row.refNo };
  },
});

const ORG_TYPES = ["4", "2"] as const;

/**
 * Owner: B2B Hakikisha setup guard — "shortcode X belongs to org Y on
 * tariff Z". Run once per Settings setup and after any shortcode change;
 * catches misconfig (wrong shortcode, till-vs-paybill) before money moves.
 */
export const verifyShortcodeOwner = action({
  args: {
    orgId: v.id("orgs"),
    shortcode: v.optional(v.string()),
    orgType: v.optional(v.union(v.literal("4"), v.literal("2"))),
  },
  returns: v.object({
    orgName: v.optional(v.string()),
    tariff: v.optional(v.string()),
    raw: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: args.orgId },
    );
    if (creds === null) throw new ConvexError("Save Daraja credentials first");
    const shortcode = (args.shortcode ?? creds.shortcode).trim();
    if (!/^\d{5,7}$/.test(shortcode)) {
      throw new ConvexError("Shortcode must be 5–7 digits");
    }
    const orgType = args.orgType ?? "4";
    if (!ORG_TYPES.includes(orgType as (typeof ORG_TYPES)[number])) {
      throw new ConvexError("Unknown org type");
    }
    const base = darajaBase(creds.environment);
    const token = await cachedDarajaToken(ctx, args.orgId, creds);
    const res = await postCandidates(
      {
        orgId: args.orgId,
        environment: creds.environment,
        base,
        token,
        shortcode: creds.shortcode,
        initiatorName: "",
        credential: "",
        siteBase: "",
      },
      ORGINFO_CANDIDATES,
      { ShortCode: shortcode, OrgType: orgType },
      "B2B Hakikisha",
    );
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const name =
      typeof parsed["OrgName"] === "string"
        ? (parsed["OrgName"] as string)
        : typeof parsed["orgName"] === "string"
          ? (parsed["orgName"] as string)
          : undefined;
    const tariff =
      typeof parsed["ChargeProfile"] === "string"
        ? (parsed["ChargeProfile"] as string)
        : typeof parsed["chargeProfile"] === "string"
          ? (parsed["chargeProfile"] as string)
          : undefined;
    await ctx.runMutation(internal.collectInternal.auditShortcodeCheck, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      shortcode,
      result: `${name ?? "?"} · ${tariff ?? "?"}`,
    });
    return { orgName: name, tariff, raw: res.body.slice(0, 500) };
  },
});
