import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, siteBaseUrl } from "./lib/auth";
import {
  fireAsyncJob,
  initiatorBundle,
  postCandidates,
} from "./lib/initiatorJobs";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Money-OUT Daraja tracks. All async with Result/Timeout callbacks onto
 * /async-result/* (generic dispatcher in http.ts):
 *  - Reversal v1 (C2B-only): receipt as TransactionID; completion
 *    auto-voids the linked ledger payment (autoVoidOnReversalComplete).
 *  - B2C v3: deposit refunds to tenant wallets. B2C reversals are
 *    API-unsupported (portal only) — the UI says so.
 *  - Account Top Up (MMF→B2C utility): keeps disbursements funded.
 *  - Business PayBill/BuyGoods: MMF→utility/merchant, incl. the
 *    BusinessTransferFromMMFToUtility funding step.
 *  - Pochi + Express Checkout + B2C Hakikisha pre-flight + Tax Remittance.
 */

const REVERSAL_CANDIDATES = [
  "mpesa/reversal/v1/request",
  "reversal/v1/request",
];

const B2C_CANDIDATES = [
  "mpesa/b2c/v3/paymentrequest",
  "mpesa/b2c/v1/paymentrequest",
  "b2c/v1/paymentrequest",
];

const B2B_CANDIDATES = [
  "mpesa/b2b/v1/paymentrequest",
  "b2b/v1/paymentrequest",
];

const POCHI_CANDIDATES = [
  "mpesa/b2pochi/v1/paymentrequest",
  "b2pochi/v1/paymentrequest",
];

const EXPRESS_CANDIDATES = [
  "mpesa/ussdpush/v1/get-msisdn",
  "ussdpush/v1/get-msisdn",
];

const B2C_HAKIKISHA_CANDIDATES = [
  "mpesa/b2c/hakikisha/v1/hakikisha",
  "b2c/hakikisha/v1/hakikisha",
];

const TAX_CANDIDATES = [
  "mpesa/b2b/v1/remittax",
  "b2b/v1/remittax",
];

async function callerOrg(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
): Promise<{ userId: string }> {
  const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
  if (caller.role === "tenant") throw new ConvexError("Staff only");
  if (caller.orgId !== orgId) {
    throw new ConvexError("Not a member of this organization");
  }
  return { userId: caller.userId };
}

function needSiteBase(): string {
  const siteBase = siteBaseUrl(process.env);
  if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
  return siteBase;
}

/**
 * Staff: reverse a completed C2B payment at Daraja (duplicate debit,
 * tenant charged twice). The ledger void happens when Daraja's completion
 * callback arrives (ResultCode 0 → auto-void); until then the payment
 * stays active so staff can see the in-flight state on the job row.
 */
export const reverseDarajaPayment = action({
  args: {
    orgId: v.id("orgs"),
    paymentId: v.id("payments"),
    receiverParty: v.optional(v.string()),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (
    ctx: ActionCtx,
    args: { orgId: Id<"orgs">; paymentId: Id<"payments">; receiverParty?: string; remarks?: string },
  ): Promise<{ conversationId: string; jobId: Id<"darajaJobs"> }> => {
    await callerOrg(ctx, args.orgId);
    const payment = await ctx.runQuery(internal.payoutsInternal.getPaymentForReversal, {
      paymentId: args.paymentId,
      orgId: args.orgId,
    });
    if (payment === null) {
      throw new ConvexError("Payment not found in this organization");
    }
    if (payment.status !== "active") {
      throw new ConvexError("Only active payments can be reversed at Daraja");
    }
    if (payment.mpesaCode === undefined) {
      throw new ConvexError(
        "No M-Pesa receipt on this payment — only Daraja-settled payments reverse via API (use staff void otherwise)",
      );
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    return await fireAsyncJob(ctx, bundle, {
      kind: "reversal",
      candidates: REVERSAL_CANDIDATES,
      label: "Reversal",
      summary: `Reverse ${payment.mpesaCode} (${payment.amount} KES)`.slice(0, 120),
      tenantId: payment.tenantId,
      paymentId: args.paymentId,
      amount: payment.amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "TransactionReversal",
        TransactionID: payment.mpesaCode,
        Amount: payment.amount,
        ReceiverParty: (args.receiverParty ?? "").trim() || bundle.shortcode,
        RecieverIdentifierType: "11",
        Remarks: (args.remarks ?? "Kodi duplicate-debit reversal").slice(0, 100),
        Occasion: "KodiReversal",
      },
    });
  },
});

const B2C_COMMANDS = ["BusinessPayment", "SalaryPayment", "PromotionPayment"] as const;

/**
 * Staff: pay a deposit refund (or any disbursement) straight to the
 * tenant's M-Pesa wallet via B2C v3. Links the settlement row when one is
 * given; the result callback flips the job and the settlement's b2cStatus.
 * Requires a Bulk/One-account shortcode funded from MMF (topUpFloat).
 */
export const payB2cRefund = action({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    phone: v.string(),
    amount: v.number(),
    commandId: v.optional(
      v.union(
        v.literal("BusinessPayment"),
        v.literal("SalaryPayment"),
        v.literal("PromotionPayment"),
      ),
    ),
    settlementId: v.optional(v.id("depositSettlements")),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const { userId } = await callerOrg(ctx, args.orgId);
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount < 10 || amount > 250_000) {
      throw new ConvexError("B2C amount must be KES 10 – 250,000 per transaction");
    }
    const tenant = await ctx.runQuery(internal.payoutsInternal.getTenantForPayout, {
      tenantId: args.tenantId,
      orgId: args.orgId,
    });
    if (tenant === null) throw new ConvexError("Tenant not found in this organization");
    const digits = args.phone.replace(/\D/g, "");
    const msisdn = digits.length === 12 ? digits : null;
    if (msisdn === null || !msisdn.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX recipient number is required");
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    const command = args.commandId ?? "BusinessPayment";
    if (!B2C_COMMANDS.includes(command)) throw new ConvexError("Unknown B2C command");
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2c",
      candidates: B2C_CANDIDATES,
      label: "B2C payment",
      summary: `B2C ${amount} KES → ${tenant.fullName}`.slice(0, 120),
      tenantId: args.tenantId,
      amount,
      payload: {
        InitiatorName: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: command,
        Amount: amount,
        PartyA: bundle.shortcode,
        PartyB: msisdn,
        Remarks: (args.remarks ?? "Kodi deposit refund").slice(0, 100),
        Occasion: "KodiRefund",
      },
    });
    await ctx.runMutation(internal.payoutsInternal.linkB2cJob, {
      jobId: res.jobId,
      settlementId: args.settlementId,
      actorUserId: userId,
      orgId: args.orgId,
    });
    return res;
  },
});

/**
 * Owner: move float MMF → B2C utility so refunds stay funded
 * (BusinessPayToBulk). The prerequisite behind every B2C payout.
 */
export const topUpFloat = action({
  args: { orgId: v.id("orgs"), amount: v.number() },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    return await fireAsyncJob(ctx, bundle, {
      kind: "topup",
      candidates: B2B_CANDIDATES,
      label: "Float top-up",
      summary: `MMF→Utility ${amount} KES`,
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "BusinessPayToBulk",
        SenderIdentifierType: "4",
        RecieverIdentifierType: "4",
        Amount: amount,
        PartyA: bundle.shortcode,
        PartyB: bundle.shortcode,
        Remarks: "Kodi float top-up",
        AccountReference: "FLOAT-TOPUP".slice(0, 13),
      },
    });
  },
});

const B2B_COMMANDS = [
  "BusinessPayBill",
  "BusinessBuyGoods",
  "BusinessTransferFromMMFToUtility",
] as const;

/**
 * Owner: B2B payment — supplier paybill/buy-goods or the MMF→Utility
 * funding move. Requester tracks on-whose-behalf (optional).
 */
export const payBusinessBill = action({
  args: {
    orgId: v.id("orgs"),
    commandId: v.union(
      v.literal("BusinessPayBill"),
      v.literal("BusinessBuyGoods"),
      v.literal("BusinessTransferFromMMFToUtility"),
    ),
    partyB: v.string(),
    amount: v.number(),
    accountReference: v.optional(v.string()),
    requester: v.optional(v.string()),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    if (!B2B_COMMANDS.includes(args.commandId)) {
      throw new ConvexError("Unknown B2B command");
    }
    const partyB = args.partyB.trim();
    if (!/^\d{5,12}$/.test(partyB)) throw new ConvexError("PartyB must be a shortcode/till (5–12 digits)");
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    return await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: B2B_CANDIDATES,
      label: "B2B payment",
      summary: `${args.commandId} ${amount} KES → ${partyB}`.slice(0, 120),
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: args.commandId,
        SenderIdentifierType: "4",
        RecieverIdentifierType: "4",
        Amount: amount,
        PartyA: bundle.shortcode,
        PartyB: partyB,
        AccountReference: (args.accountReference ?? "KODI-OPS").slice(0, 13),
        Requester: args.requester?.slice(0, 12),
        Remarks: (args.remarks ?? "Kodi ops payment").slice(0, 100),
      },
    });
  },
});

/**
 * Owner: payout to a Pochi micro-SME wallet (niche — supplier refunds to
 * Pochi wallets). Kept separate from B2C because the endpoint differs.
 */
export const payToPochi = action({
  args: {
    orgId: v.id("orgs"),
    phone: v.string(),
    amount: v.number(),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    const digits = args.phone.replace(/\D/g, "");
    if (digits.length !== 12 || !digits.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX Pochi number is required");
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    return await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: POCHI_CANDIDATES,
      label: "Pochi payout",
      summary: `Pochi ${amount} KES → ${digits}`.slice(0, 120),
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "BusinessPayToPochi",
        PartyA: bundle.shortcode,
        PartyB: digits,
        Amount: amount,
        Remarks: (args.remarks ?? "Kodi Pochi payout").slice(0, 100),
      },
    });
  },
});

/**
 * Owner: USSD push to a till operator (B2B Express Checkout — merchant
 * till→paybill only; no tenant use, kept for ops completeness).
 */
export const expressCheckoutPush = action({
  args: {
    orgId: v.id("orgs"),
    operatorId: v.string(),
    operatorPin: v.string(),
    amount: v.number(),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    if (!args.operatorId.trim() || !args.operatorPin.trim()) {
      throw new ConvexError("Operator ID and PIN are required");
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    // The operator PIN travels to Daraja (their API, their field) — never
    // written to any table; the job summary names no PIN.
    return await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: EXPRESS_CANDIDATES,
      label: "Express checkout",
      summary: `USSD push ${amount} KES (operator ${args.operatorId.trim()})`.slice(0, 120),
      amount,
      payload: {
        OperatorID: args.operatorId.trim(),
        OperatorPIN: args.operatorPin,
        Amount: amount,
        PartyA: bundle.shortcode,
      },
    });
  },
});

/**
 * Staff: B2C Hakikisha pre-flight — first name + masked rest for an
 * MSISDN before a deposit refund leaves. Sync (OAuth only, no job row).
 */
export const hakikishaB2c = action({
  args: { orgId: v.id("orgs"), phone: v.string() },
  returns: v.object({
    firstName: v.optional(v.string()),
    maskedName: v.optional(v.string()),
    raw: v.string(),
  }),
  handler: async (ctx, args) => {
    await callerOrg(ctx, args.orgId);
    const digits = args.phone.replace(/\D/g, "");
    if (digits.length !== 12 || !digits.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX number is required");
    }
    const siteBase = needSiteBase();
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    const res = await postCandidates(
      bundle,
      B2C_HAKIKISHA_CANDIDATES,
      { MSISDN: digits, ShortCode: bundle.shortcode },
      "B2C Hakikisha",
    );
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const first =
      typeof parsed["FirstName"] === "string" ? (parsed["FirstName"] as string) : undefined;
    const masked =
      typeof parsed["MaskedName"] === "string"
        ? (parsed["MaskedName"] as string)
        : undefined;
    return { firstName: first, maskedName: masked, raw: res.body.slice(0, 500) };
  },
});

const TAX_PARTY_B = "572572";

/**
 * Owner: remit rental-income tax to KRA (PayTaxToKRA, fixed PartyB
 * 572572, ref = KRA PRN from a prior KRA integration).
 */
export const remitTax = action({
  args: {
    orgId: v.id("orgs"),
    amount: v.number(),
    kraPrn: v.string(),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Amount must be positive");
    }
    const prn = args.kraPrn.trim();
    if (prn === "" || prn.length > 20) {
      throw new ConvexError("A valid KRA PRN is required");
    }
    const bundle = await initiatorBundle(ctx, args.orgId, needSiteBase());
    return await fireAsyncJob(ctx, bundle, {
      kind: "tax",
      candidates: TAX_CANDIDATES,
      label: "Tax remittance",
      summary: `KRA ${amount} KES · ${prn}`.slice(0, 120),
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "PayTaxToKRA",
        SenderIdentifierType: "4",
        RecieverIdentifierType: "4",
        Amount: amount,
        PartyA: bundle.shortcode,
        PartyB: TAX_PARTY_B,
        AccountReference: prn.slice(0, 13),
        Remarks: (args.remarks ?? "Kodi tax remittance").slice(0, 100),
      },
    });
  },
});

/** Staff: B2C settlement link state for the tenant detail page. */
export const getSettlementPayout = query({
  args: { settlementId: v.id("depositSettlements") },
  returns: v.union(
    v.object({
      b2cStatus: v.optional(v.string()),
      b2cConversationId: v.optional(v.string()),
      b2cReceipt: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.settlementId);
    if (row === null) return null;
    const caller = await assertOrgMember(ctx, row.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    return {
      b2cStatus: row.b2cStatus,
      b2cConversationId: row.b2cConversationId,
      b2cReceipt: row.b2cReceipt,
    };
  },
});
