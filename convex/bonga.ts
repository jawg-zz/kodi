import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { postCandidates } from "./lib/initiatorJobs";

/**
 * Lipa na Bonga: tenants part-pay rent with loyalty points (0.2 KES/pt).
 * Separate SHA256 user/pass auth (NOT OAuth) — owner stores the Bonga
 * operator creds once; staff quote points, tenant PIN-confirms on their
 * handset; funds land on the Paybill and the existing C2B confirmation
 * path records them. No new ledger path needed.
 */

const BONGA_CALC_CANDIDATES = [
  "v1/lipa/na/bonga/calculate-points",
  "lipa/na/bonga/v1/calculate-points",
];

const BONGA_REDEEM_CANDIDATES = [
  "v1/lipa/na/bonga/redeem-paybill",
  "lipa/na/bonga/v1/redeem-paybill",
];

async function bongaAuth(username: string, password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${username}${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function bongaBundle(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
): Promise<{
  base: string;
  token: string;
  shortcode: string;
  auth: string;
}> {
  const creds = await ctx.runMutation(
    internal.mpesaInternal.getDecryptedCreds,
    { orgId },
  );
  if (creds === null) throw new ConvexError("Save Daraja credentials first");
  const bonga = await ctx.runQuery(internal.bongaInternal.getBongaCreds, {
    orgId,
  });
  if (bonga === null) {
    throw new ConvexError(
      "Bonga operator credentials are not set — owner: Settings → Lipa na Bonga",
    );
  }
  const base = darajaBase(creds.environment);
  const token = await cachedDarajaToken(ctx, orgId, creds);
  return {
    base,
    token,
    shortcode: creds.shortcode,
    auth: await bongaAuth(bonga.username, bonga.password),
  };
}

/**
 * Staff: quote how many points a phone number holds and their KES value.
 * Read-only — safe to call during record-payment.
 */
export const quoteBongaPoints = action({
  args: { orgId: v.id("orgs"), phone: v.string() },
  returns: v.object({
    points: v.number(),
    valueKes: v.number(),
    raw: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const digits = args.phone.replace(/\D/g, "");
    if (digits.length !== 12 || !digits.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX number is required");
    }
    const b = await bongaBundle(ctx, args.orgId);
    const res = await postCandidates(
      {
        orgId: args.orgId,
        environment: "sandbox",
        base: b.base,
        token: b.token,
        shortcode: b.shortcode,
        initiatorName: "",
        credential: b.auth,
        siteBase: "",
      },
      BONGA_CALC_CANDIDATES,
      { MSISDN: digits },
      "Bonga quote",
    );
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const points = Math.max(
      0,
      Math.round(Number(parsed["Points"] ?? parsed["points"] ?? 0)),
    );
    return {
      points,
      valueKes: Math.round(points * 0.2),
      raw: res.body.slice(0, 500),
    };
  },
});

/**
 * Staff: redeem points toward a tenant's Paybill account (part-payment).
 * PIN-confirmed on the tenant handset; the C2B confirmation callback
 * records the landed funds through the normal path.
 */
export const redeemBongaPoints = action({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    phone: v.string(),
    points: v.number(),
  },
  returns: v.object({ raw: v.string() }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const pts = Math.round(args.points);
    if (!Number.isFinite(pts) || pts <= 0) {
      throw new ConvexError("Points must be positive");
    }
    const digits = args.phone.replace(/\D/g, "");
    if (digits.length !== 12 || !digits.startsWith("254")) {
      throw new ConvexError("A valid 254XXXXXXXXXX number is required");
    }
    const tenant = await ctx.runQuery(
      internal.payoutsInternal.getTenantForPayout,
      { tenantId: args.tenantId, orgId: args.orgId },
    );
    if (tenant === null) throw new ConvexError("Tenant not found in this organization");
    const b = await bongaBundle(ctx, args.orgId);
    const res = await postCandidates(
      {
        orgId: args.orgId,
        environment: "sandbox",
        base: b.base,
        token: b.token,
        shortcode: b.shortcode,
        initiatorName: "",
        credential: b.auth,
        siteBase: "",
      },
      BONGA_REDEEM_CANDIDATES,
      {
        MSISDN: digits,
        Points: pts,
        ShortCode: b.shortcode,
        BillRefNumber: tenant.fullName.slice(0, 20),
      },
      "Bonga redeem",
    );
    await ctx.runMutation(internal.c2b.logWebhookInternal, {
      orgId: args.orgId,
      route: "out-bonga",
      outcome: "redeemed",
      detail: `${pts} pts (~${Math.round(pts * 0.2)} KES) → ${tenant.fullName}`.slice(0, 200),
    });
    return { raw: res.body.slice(0, 500) };
  },
});
