import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember } from "./lib/auth";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { postCandidates } from "./lib/initiatorJobs";
import { encryptSecret } from "./lib/mpesaCrypto";

/**
 * KYC + fraud signals, cached per tenant (repeat views don't rebill):
 *  - Mobile Number Validation: phone + national ID → TRUE/FALSE, no PII.
 *  - SIM Swap: last swap date (>3mo → 1900-01-01 sentinel).
 *  - Age on Network: SIM registration date.
 *  - IMSI bundles: hashed IMSI + age + swap.
 *  - C2B Hakikisha HOST: Safaricom calls US (token + notify endpoints in
 *    http.ts); we return the tenant name for an account code so typos die
 *    at the payer's handset before money moves.
 */

const KYC_VALIDATE_CANDIDATES = [
  "v1/KYC-validation/validateID",
  "mpesa/KYC-validation/v1/validateID",
];

const SIMSWAP_CANDIDATES = [
  "imsi/v2/checkATI",
  "mpesa/imsi/v2/checkATI",
];

const SIMAGE_CANDIDATES = [
  "registration/lookup/v1/checkATI",
  "mpesa/registration/lookup/v1/checkATI",
];

const IMSI_CANDIDATES = [
  "imsi/v1/checkATI",
  "imsi/v3/checkATI",
  "mpesa/imsi/v1/checkATI",
];

type CheckType = "mobile_validation" | "sim_swap" | "sim_age" | "imsi";

async function staffTenant(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
): Promise<{ phone: string; nationalId: string; fullName: string }> {
  const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
  if (caller.role === "tenant") throw new ConvexError("Staff only");
  if (caller.orgId !== orgId) {
    throw new ConvexError("Not a member of this organization");
  }
  const t = await ctx.runQuery(internal.fraudInternal.getTenantIdentity, {
    tenantId,
    orgId,
  });
  if (t === null) throw new ConvexError("Tenant not found in this organization");
  return t;
}

async function oauthBundle(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
): Promise<{ base: string; token: string; shortcode: string }> {
  const creds = await ctx.runMutation(
    internal.mpesaInternal.getDecryptedCreds,
    { orgId },
  );
  if (creds === null) throw new ConvexError("Save Daraja credentials first");
  const base = darajaBase(creds.environment);
  return { base, token: await cachedDarajaToken(ctx, orgId, creds), shortcode: creds.shortcode };
}

function bundleFor(
  orgId: Id<"orgs">,
  b: { base: string; token: string; shortcode: string },
): Parameters<typeof postCandidates>[0] {
  return {
    orgId,
    environment: "sandbox",
    base: b.base,
    token: b.token,
    shortcode: b.shortcode,
    initiatorName: "",
    credential: "",
    siteBase: "",
  };
}

async function runCheck(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  checkType: CheckType,
  candidates: string[],
  payload: Record<string, unknown>,
  label: string,
  summarize: (body: Record<string, unknown>, raw: string) => { result: string; detail: string },
): Promise<{ result: string; detail: string }> {
  await staffTenant(ctx, orgId, tenantId);
  const b = await oauthBundle(ctx, orgId);
  const res = await postCandidates(bundleFor(orgId, b), candidates, payload, label);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const out = summarize(parsed, res.body);
  await ctx.runMutation(internal.fraudInternal.storeCheck, {
    orgId,
    tenantId,
    checkType,
    result: out.result,
    detail: out.detail,
  });
  return out;
}

/**
 * Staff: authoritative national-ID ↔ phone check (TRUE/FALSE, no PII).
 * Needs apisupport onboarding; commercial ~4.5 KES tapering.
 */
export const validateTenantId = action({
  args: {
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    idType: v.optional(
      v.union(v.literal("01"), v.literal("02"), v.literal("05")),
    ),
  },
  returns: v.object({ result: v.string(), detail: v.string() }),
  handler: async (ctx, args) => {
    const t = await staffTenant(ctx, args.orgId, args.tenantId);
    const digits = t.phone.replace(/\D/g, "");
    return await runCheck(
      ctx,
      args.orgId,
      args.tenantId,
      "mobile_validation",
      KYC_VALIDATE_CANDIDATES,
      {
        phoneNumber: digits,
        idType: args.idType ?? "01",
        idNumber: t.nationalId,
      },
      "Mobile Number Validation",
      (parsed, raw) => {
        const ok =
          parsed["Result"] ?? parsed["result"] ?? parsed["Valid"] ?? parsed["valid"];
        const truthy = ok === true || String(ok).toUpperCase() === "TRUE";
        return {
          result: truthy ? "MATCH" : "MISMATCH",
          detail: truthy
            ? `${t.fullName}: ID matches phone ${digits}`
            : `${t.fullName}: ID does NOT match phone — verify onboarding docs (${raw.slice(0, 160)})`,
        };
      },
    );
  },
});

/** Staff: SIM-swap recency (recent swap + large refund = step-up auth). */
export const checkSimSwap = action({
  args: { orgId: v.id("orgs"), tenantId: v.id("tenants") },
  returns: v.object({ result: v.string(), detail: v.string() }),
  handler: async (ctx, args) => {
    const t = await staffTenant(ctx, args.orgId, args.tenantId);
    return await runCheck(
      ctx,
      args.orgId,
      args.tenantId,
      "sim_swap",
      SIMSWAP_CANDIDATES,
      { MSISDN: t.phone.replace(/\D/g, "") },
      "SIM Swap",
      (parsed, raw) => {
        const date = String(
          parsed["LastSwapDate"] ?? parsed["lastSwapDate"] ?? parsed["SwapDate"] ?? "",
        );
        const recent = date !== "" && date !== "1900-01-01";
        return {
          result: recent ? `SWAPPED:${date}` : "STABLE",
          detail: recent
            ? `SIM swapped on ${date} — step up verification before large refunds`
            : `No recent swap (${raw.slice(0, 160)})`,
        };
      },
    );
  },
});

/** Staff: SIM age on network (brand-new SIM + new tenant = caution). */
export const checkSimAge = action({
  args: { orgId: v.id("orgs"), tenantId: v.id("tenants") },
  returns: v.object({ result: v.string(), detail: v.string() }),
  handler: async (ctx, args) => {
    const t = await staffTenant(ctx, args.orgId, args.tenantId);
    return await runCheck(
      ctx,
      args.orgId,
      args.tenantId,
      "sim_age",
      SIMAGE_CANDIDATES,
      { MSISDN: t.phone.replace(/\D/g, "") },
      "SIM Age",
      (parsed, raw) => {
        const reg = String(
          parsed["RegistrationDate"] ?? parsed["registrationDate"] ?? "",
        );
        return {
          result: reg !== "" ? `SINCE:${reg}` : "UNKNOWN",
          detail: reg !== "" ? `SIM registered ${reg}` : raw.slice(0, 200),
        };
      },
    );
  },
});

/** Staff: IMSI bundle check (hashed IMSI + age + swap signals). */
export const checkImsi = action({
  args: { orgId: v.id("orgs"), tenantId: v.id("tenants") },
  returns: v.object({ result: v.string(), detail: v.string() }),
  handler: async (ctx, args) => {
    const t = await staffTenant(ctx, args.orgId, args.tenantId);
    return await runCheck(
      ctx,
      args.orgId,
      args.tenantId,
      "imsi",
      IMSI_CANDIDATES,
      { MSISDN: t.phone.replace(/\D/g, "") },
      "IMSI check",
      (parsed, raw) => ({
        result: String(parsed["Result"] ?? parsed["result"] ?? "RECORDED"),
        detail: raw.slice(0, 300),
      }),
    );
  },
});

/** Staff: cached fraud-signal history for a tenant (no Daraja calls). */
export const getKycChecks = query({
  args: { tenantId: v.id("tenants") },
  returns: v.array(
    v.object({
      checkType: v.string(),
      result: v.string(),
      detail: v.optional(v.string()),
      checkedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return [];
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("You can only view your own checks");
    }
    const rows = await ctx.db
      .query("kycChecks")
      .withIndex("by_tenant_type", (q) => q.eq("tenantId", args.tenantId))
      .collect();
    return rows
      .sort((a, b) => b.checkedAt - a.checkedAt)
      .slice(0, 20)
      .map((r) => ({
        checkType: r.checkType,
        result: r.result,
        detail: r.detail,
        checkedAt: r.checkedAt,
      }));
  },
});

/** Owner: store Bonga operator creds (Settings → Lipa na Bonga card). */
export const saveBongaCreds = action({
  args: {
    orgId: v.id("orgs"),
    username: v.string(),
    password: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    if (!args.username.trim() || !args.password) {
      throw new ConvexError("Bonga username and password are required");
    }
    await ctx.runMutation(internal.bongaInternal.storeBongaCreds, {
      orgId: args.orgId,
      usernameEnc: await encryptSecret(args.username.trim()),
      passwordEnc: await encryptSecret(args.password),
    });
    return null;
  },
});

export { oauthBundle };
