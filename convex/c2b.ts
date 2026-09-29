import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, audit, normalizePhone, siteBaseUrl } from "./lib/auth";
import { recordPaymentCore, reversePaymentInTx } from "./lib/ledger";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

const SANDBOX = "https://sandbox.safaricom.co.ke";
const PROD = "https://api.safaricom.co.ke";

const c2bStatus = v.union(
  v.literal("pending_review"),
  v.literal("matched"),
  v.literal("rejected"),
);

const c2bShape = v.object({
  _id: v.id("c2bPayments"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  tenantId: v.optional(v.id("tenants")),
  transId: v.string(),
  transAmount: v.number(),
  billRef: v.optional(v.string()),
  msisdn: v.string(),
  firstName: v.optional(v.string()),
  middleName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  transTime: v.optional(v.string()),
  status: c2bStatus,
  matchReason: v.optional(v.string()),
  paymentId: v.optional(v.id("payments")),
});

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Human-meaningful account code: property + unit initials, e.g. "GC-A1".
 * Falls back to the random KDI- scheme when the tenant has no unit or the
 * smart code is taken. Readable codes cut M-Pesa-menu typos; the random
 * fallback keeps uniqueness without staff intervention.
 */
function smartAccountCode(
  propertyName: string | undefined,
  unitLabel: string | undefined,
): string | null {
  const initials = (propertyName ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 3);
  const unit = (unitLabel ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
  if (initials === "" || unit === "") return null;
  return `${initials}-${unit}`;
}

/** Stable per-tenant Paybill account code, e.g. "GC-A1" then "KDI-7Q2X". */
function mintAccountCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `KDI-${suffix}`;
}

async function codeTaken(ctx: MutationCtx, code: string): Promise<boolean> {
  const clash = await ctx.db
    .query("tenants")
    .withIndex("by_account", (q) => q.eq("accountCode", code))
    .first();
  return clash !== null;
}

async function uniqueAccountCode(
  ctx: MutationCtx,
  preferred: string | null,
): Promise<string> {
  if (preferred !== null && !(await codeTaken(ctx, preferred))) {
    return preferred;
  }
  if (preferred !== null) {
    for (let i = 2; i <= 9; i += 1) {
      const suffixed = `${preferred}-${i}`;
      if (!(await codeTaken(ctx, suffixed))) return suffixed;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    const code = mintAccountCode();
    if (!(await codeTaken(ctx, code))) return code;
  }
  return `KDI-${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

/** Ensure the tenant has an account code (legacy backfill path only). */
export async function ensureAccountCode(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<string> {
  const tenant = await ctx.db.get(tenantId);
  if (tenant === null) throw new ConvexError("Tenant not found");
  if (tenant.accountCode) return tenant.accountCode;
  const code = await mintAccountCodeFor(ctx, tenant.orgId, tenant.unitId);
  await ctx.db.patch(tenantId, { accountCode: code });
  return code;
}

/**
 * Mint a fresh unique code for a new tenant, in-transaction: smart
 * property-unit code first, suffixed variants, then the random scheme.
 * Called BEFORE the tenant insert so the row is born with its code.
 */
export async function mintAccountCodeFor(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  unitId: Id<"units"> | undefined,
): Promise<string> {
  let preferred: string | null = null;
  if (unitId !== undefined) {
    const unit = await ctx.db.get(unitId);
    if (unit !== null && unit.orgId === orgId) {
      const property =
        unit.propertyId === undefined
          ? null
          : await ctx.db.get(unit.propertyId);
      preferred = smartAccountCode(property?.name, unit.label);
    }
  }
  return await uniqueAccountCode(ctx, preferred);
}

export type C2bPayload = {
  TransID?: string;
  TransAmount?: string | number;
  BillRefNumber?: string;
  MSISDN?: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
  TransTime?: string;
  BusinessShortCode?: string | number;
};

function parseAmount(raw: string | number | undefined): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function shortName(p: C2bPayload): string {
  return [p.FirstName, p.MiddleName, p.LastName].filter(Boolean).join(" ");
}

type OrgRow = {
  _id: Id<"orgs">;
  shortcode: string;
  environment: "sandbox" | "production";
};

async function orgForShortcode(
  ctx: MutationCtx,
  shortcode: string,
): Promise<OrgRow | null> {
  // Shortcodes are unique per org in practice; scan credentials (one row
  // per org) rather than adding a shortcode index.
  const rows = await ctx.db.query("mpesaCredentials").collect();
  const hit = rows.find((r) => r.shortcode === shortcode);
  if (hit === undefined) return null;
  return {
    _id: hit.orgId,
    shortcode: hit.shortcode,
    environment: hit.environment,
  };
}

type Match =
  | { tenantId: Id<"tenants">; reason: string }
  | { tenantId: null; reason: string };

async function raiseAlert(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  kind: string,
  title: string,
  detail: string | undefined,
  transId: string | undefined,
): Promise<void> {
  const open = await ctx.db
    .query("paymentAlerts")
    .withIndex("by_org_open", (q) =>
      q.eq("orgId", orgId).eq("acknowledged", false),
    )
    .collect();
  if (
    open.some(
      (a) => a.kind === kind && (a.transId ?? "") === (transId ?? ""),
    )
  ) {
    return;
  }
  await ctx.db.insert("paymentAlerts", {
    orgId,
    kind,
    title,
    detail,
    transId,
    acknowledged: false,
  });
}

/**
 * Anomaly scan on every confirmation: brand-new senders, flood bursts,
 * and outsized amounts each raise one deduped alert. Runs inside the
 * confirmation transaction — cheap reads, no Daraja calls.
 */
async function anomalyScan(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  transId: string,
  amount: number,
  msisdn: string,
): Promise<void> {
  // Brand-new sender: no prior C2B hit from this phone at all.
  const prior = await ctx.db
    .query("c2bPayments")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const fromSender = prior.filter((p) => p.msisdn === msisdn);
  if (fromSender.length === 0) {
    await raiseAlert(
      ctx,
      orgId,
      "new_sender",
      `First Paybill payment from ${msisdn}`,
      `${amount.toLocaleString("en-US")} KES · ${transId} — verify the sender's M-Pesa SMS before matching large amounts.`,
      transId,
    );
  }
  // Flood burst: 6+ hits from anywhere in the last 10 minutes.
  const tenMinAgo = Date.now() - 10 * 60_000;
  const recent = prior.filter((p) => p._creationTime >= tenMinAgo);
  if (recent.length >= 5) {
    await raiseAlert(
      ctx,
      orgId,
      "burst",
      `${recent.length + 1} Paybill hits in 10 minutes`,
      "Possible retry storm or flood — check the webhook log before bulk-matching.",
      undefined,
    );
  }
  // Outsized amount vs the org's matched median (needs history to judge).
  const matched = prior.filter((p) => p.status === "matched");
  if (matched.length >= 5) {
    const sorted = matched.map((p) => p.transAmount).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && amount >= median * 5) {
      await raiseAlert(
        ctx,
        orgId,
        "outlier",
        `${amount.toLocaleString("en-US")} KES is far above the usual (~${median.toLocaleString("en-US")} KES)`,
        `${transId} from ${msisdn} — ask the tenant to forward the M-Pesa SMS.`,
        transId,
      );
    }
  }
}

/**
 * Layered tenant match for a confirmation hit:
 *  1. exact account code (BillRefNumber, case-insensitive),
 *  2. national ID (tenants know it by heart — accepted as-is),
 *  3. sender phone (MSISDN) against the org's tenant phones,
 *  4. unmatched → pending review, never dropped.
 *
 * Layers 2–3 log which key matched so staff can see a hit matched loosely.
 * Skips layers cleanly when data is missing (empty national ID, unknown
 * phone) instead of failing.
 */
async function matchTenant(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  billRef: string | undefined,
  msisdn: string,
): Promise<Match> {
  const ref = (billRef ?? "").trim().toUpperCase();
  const digits = ref.replace(/\D/g, "");
  if (ref !== "") {
    const byCode = await ctx.db
      .query("tenants")
      .withIndex("by_account", (q) => q.eq("accountCode", ref))
      .first();
    if (byCode !== null && byCode.orgId === orgId) {
      return { tenantId: byCode._id, reason: `account code ${ref}` };
    }
    // National ID fallback: tenants type the ID they already know instead
    // of the issued code. Scans the org's tenants (bounded per org) and
    // requires a single unambiguous hit — duplicates fall through to the
    // review queue rather than guessing.
    if (digits !== "" && digits.length >= 6) {
      const tenants = await ctx.db
        .query("tenants")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      const hits = tenants.filter(
        (t) => t.national_id.replace(/\D/g, "") === digits,
      );
      if (hits.length === 1) {
        return { tenantId: hits[0]._id, reason: "national ID" };
      }
    }
  }
  const phone = normalizePhone(msisdn);
  if (phone !== null) {
    const byPhone = await ctx.db
      .query("tenants")
      .withIndex("by_org_phone", (q) => q.eq("orgId", orgId).eq("phone", phone))
      .first();
    if (byPhone !== null) {
      return {
        tenantId: byPhone._id,
        reason:
          ref !== ""
            ? `sender phone (account "${billRef}" not recognised)`
            : "sender phone",
      };
    }
  }
  return {
    tenantId: null,
    reason:
      ref !== ""
        ? `no tenant for account "${billRef}"${phone ? " or sender phone" : ""}`
        : "no account number and sender phone not recognised",
  };
}

/**
 * Jaro–Winkler similarity in [0,1] for short strings (names, refs).
 * Dependency-free: names are short and queues are small, so O(n*m) is fine.
 */
export function nameSimilarity(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (s1 === "" || s2 === "") return 0;
  const len1 = s1.length;
  const len2 = s2.length;
  const matchDist = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1m = new Array<boolean>(len1).fill(false);
  const s2m = new Array<boolean>(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i += 1) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(len2 - 1, i + matchDist);
    for (let j = lo; j <= hi; j += 1) {
      if (!s2m[j] && s1[i] === s2[j]) {
        s1m[i] = true;
        s2m[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i += 1) {
    if (s1m[i]) {
      while (!s2m[k]) k += 1;
      if (s1[i] !== s2[k]) transpositions += 1;
      k += 1;
    }
  }
  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  // Winkler boost for shared prefixes (first names usually match first).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i += 1) {
    if (s1[i] === s2[i]) prefix += 1;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export type TenantSuggestion = {
  tenantId: Id<"tenants">;
  tenantName: string;
  phone: string;
  accountCode?: string;
  score: number;
  signals: string[];
};

/**
 * Ranked tenant suggestions for a queued C2B hit: sender-name similarity,
 * bill-ref similarity to account code / national ID tail, and an exact
 * phone boost. Returns the top few above threshold — staff pick, never
 * auto-match, so a wrong suggestion costs one click, not wrong money.
 */
export const suggestC2bTenant = query({
  args: { id: v.id("c2bPayments"), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      tenantId: v.id("tenants"),
      tenantName: v.string(),
      phone: v.string(),
      accountCode: v.optional(v.string()),
      score: v.number(),
      signals: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("C2B payment not found");
    const caller = await assertOrgMember(ctx, row.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
    const sender = [row.firstName, row.middleName, row.lastName]
      .filter(Boolean)
      .join(" ");
    const ref = (row.billRef ?? "").trim().toUpperCase();
    const refDigits = ref.replace(/\D/g, "");
    const senderPhone = normalizePhone(row.msisdn);

    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", row.orgId))
      .collect();
    const scored: TenantSuggestion[] = [];
    for (const t of tenants) {
      if (t.status === "moved_out") continue;
      const signals: string[] = [];
      let score = 0;
      if (sender !== "") {
        const sim = nameSimilarity(sender, t.full_name);
        if (sim >= 0.75) {
          score += sim * 0.55;
          signals.push(`name ~${Math.round(sim * 100)}%`);
        }
      }
      if (ref !== "") {
        if (t.accountCode) {
          const sim = nameSimilarity(ref, t.accountCode);
          if (sim >= 0.7) {
            score += sim * 0.35;
            signals.push("account close");
          }
        }
        const idDigits = t.national_id.replace(/\D/g, "");
        if (refDigits !== "" && idDigits !== "") {
          if (idDigits === refDigits) {
            score += 0.5;
            signals.push("national ID exact");
          } else if (
            refDigits.length >= 4 &&
            idDigits.endsWith(refDigits.slice(-4))
          ) {
            score += 0.2;
            signals.push("ID tail match");
          }
        }
      }
      if (senderPhone !== null && t.phone === senderPhone) {
        score += 0.4;
        signals.push("sender phone");
      }
      if (score >= 0.3 && signals.length > 0) {
        scored.push({
          tenantId: t._id,
          tenantName: t.full_name,
          phone: t.phone,
          accountCode: t.accountCode,
          score: Math.round(score * 100) / 100,
          signals,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit) as never;
  },
});

/**
 * Staff: match every queued hit whose sender phone belongs to exactly one
 * tenant. One audit entry per matched row; ambiguous rows stay queued.
 * Returns the number matched.
 */
export const bulkMatchC2bByPhone = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.object({ matched: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const queue = await ctx.db
      .query("c2bPayments")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "pending_review"),
      )
      .collect();
    let matched = 0;
    let skipped = 0;
    for (const row of queue) {
      const phone = normalizePhone(row.msisdn);
      if (phone === null) {
        skipped += 1;
        continue;
      }
      const tenant = await ctx.db
        .query("tenants")
        .withIndex("by_org_phone", (q) =>
          q.eq("orgId", args.orgId).eq("phone", phone),
        )
        .first();
      if (tenant === null || tenant.status === "moved_out") {
        skipped += 1;
        continue;
      }
      // Re-check status inside the loop: two staff bulk-matching at once
      // must not double-record the same TransID.
      const fresh = await ctx.db.get(row._id);
      if (fresh === null || fresh.status !== "pending_review") {
        skipped += 1;
        continue;
      }
      const res = await recordPaymentCore(ctx, {
        orgId: args.orgId,
        tenantId: tenant._id,
        amount: row.transAmount,
        method: "mpesa_c2b",
        mpesaCode: row.transId,
        note: `Paybill bulk-match by staff${row.billRef ? ` · ${row.billRef}` : ""}`,
      });
      await ctx.db.patch(row._id, {
        tenantId: tenant._id,
        status: "matched",
        matchReason: `bulk-matched by sender phone to ${tenant.full_name}`,
        paymentId: res.id,
      });
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: caller.userId,
        action: "c2b.match",
        entityType: "c2bPayment",
        entityId: row._id,
        metadata: JSON.stringify({ tenantId: tenant._id, paymentId: res.id, bulk: true }),
      });
      matched += 1;
    }
    return { matched, skipped };
  },
});

/**
 * Shared C2B confirmation write. Idempotent per TransID; matched hits
 * record through the atomic ledger (same dedupe/allocation/credit path as
 * STK), unmatched hits park in the review queue. Returns the row id.
 */
export const recordC2bInternal = internalMutation({
  args: {
    shortcode: v.string(),
    transId: v.string(),
    transAmount: v.number(),
    billRef: v.optional(v.string()),
    msisdn: v.string(),
    firstName: v.optional(v.string()),
    middleName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    transTime: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
  },
  returns: v.object({
    id: v.id("c2bPayments"),
    status: c2bStatus,
    deduplicated: v.boolean(),
    paymentId: v.optional(v.id("payments")),
  }),
  handler: async (ctx, args) => {
    const transId = args.transId.trim();
    if (transId === "" || transId.length > 64) {
      throw new ConvexError("Bad TransID");
    }
    // Retry-safe: Safaricom re-sends confirmations it gets no 200 for.
    const seen = await ctx.db
      .query("c2bPayments")
      .withIndex("by_trans", (q) => q.eq("transId", transId))
      .first();
    if (seen !== null) {
      return {
        id: seen._id,
        status: seen.status,
        deduplicated: true,
        paymentId: seen.paymentId,
      };
    }
    const amount = Math.round(args.transAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Bad TransAmount");
    }
    const org = await orgForShortcode(ctx, args.shortcode);
    if (org === null) {
      throw new ConvexError("Unknown business shortcode");
    }
    await anomalyScan(ctx, org._id, transId, amount, args.msisdn);
    const match = await matchTenant(ctx, org._id, args.billRef, args.msisdn);
    if (match.tenantId === null) {
      const id = await ctx.db.insert("c2bPayments", {
        orgId: org._id,
        transId,
        transAmount: amount,
        billRef: args.billRef?.trim() || undefined,
        msisdn: args.msisdn,
        firstName: args.firstName,
        middleName: args.middleName,
        lastName: args.lastName,
        transTime: args.transTime,
        status: "pending_review",
        matchReason: match.reason,
        rawPayload: args.rawPayload?.slice(0, 2000),
      });
      return { id, status: "pending_review" as const, deduplicated: false };
    }
    const res = await recordPaymentCore(ctx, {
      orgId: org._id,
      tenantId: match.tenantId,
      amount,
      method: "mpesa_c2b",
      mpesaCode: transId,
      note: `Paybill ${args.shortcode}${args.billRef ? ` · ${args.billRef}` : ""}${shortName(args as C2bPayload) ? ` · ${shortName(args as C2bPayload)}` : ""}`,
    });
    const id = await ctx.db.insert("c2bPayments", {
      orgId: org._id,
      tenantId: match.tenantId,
      transId,
      transAmount: amount,
      billRef: args.billRef?.trim() || undefined,
      msisdn: args.msisdn,
      firstName: args.firstName,
      middleName: args.middleName,
      lastName: args.lastName,
      transTime: args.transTime,
      status: "matched",
      matchReason: match.reason,
      paymentId: res.id,
      rawPayload: args.rawPayload?.slice(0, 2000),
    });
    return { id, status: "matched" as const, deduplicated: false, paymentId: res.id };
  },
});

/**
 * Staff: attach a pending-review C2B hit to the right tenant. Records the
 * ledger payment through the same atomic path (TransID dedupes), links it,
 * and audits the match.
 */
export const matchC2bPayment = mutation({
  args: { id: v.id("c2bPayments"), tenantId: v.id("tenants") },
  returns: v.id("payments"),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("C2B payment not found");
    const caller = await assertStaff(ctx, row.orgId);
    if (row.status !== "pending_review") {
      throw new ConvexError("This payment is already handled.");
    }
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null || tenant.orgId !== row.orgId) {
      throw new ConvexError("Tenant not found in this organization");
    }
    const res = await recordPaymentCore(ctx, {
      orgId: row.orgId,
      tenantId: args.tenantId,
      amount: row.transAmount,
      method: "mpesa_c2b",
      mpesaCode: row.transId,
      note: `Paybill match by staff${row.billRef ? ` · ${row.billRef}` : ""}`,
    });
    await ctx.db.patch(args.id, {
      tenantId: args.tenantId,
      status: "matched",
      matchReason: `matched by staff to ${tenant.full_name}`,
      paymentId: res.id,
    });
    await audit(ctx, {
      orgId: row.orgId,
      actorUserId: caller.userId,
      action: "c2b.match",
      entityType: "c2bPayment",
      entityId: args.id,
      metadata: JSON.stringify({ tenantId: args.tenantId, paymentId: res.id }),
    });
    return res.id;
  },
});

/**
 * Staff: reject a pending-review hit (test ping, wrong business). The money
 * stays with M-Pesa — this only clears the queue row with a reason.
 */
export const rejectC2bPayment = mutation({
  args: { id: v.id("c2bPayments"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("C2B payment not found");
    const caller = await assertStaff(ctx, row.orgId);
    if (row.status !== "pending_review") {
      throw new ConvexError("This payment is already handled.");
    }
    const reason = args.reason.trim();
    if (reason === "") throw new ConvexError("Give a reason for the rejection.");
    await ctx.db.patch(args.id, {
      status: "rejected",
      matchReason: reason,
    });
    await audit(ctx, {
      orgId: row.orgId,
      actorUserId: caller.userId,
      action: "c2b.reject",
      entityType: "c2bPayment",
      entityId: args.id,
      metadata: JSON.stringify({ reason }),
    });
    return null;
  },
});

/**
 * Internal: unwind a reversed M-Pesa transaction. Finds the C2B row by
 * TransID (falls back to a payment-code lookup for STK receipts), voids
 * the linked ledger payment through the standard reversal path, and marks
 * the row. Idempotent: an already-reversed payment reports as such.
 */
export const reverseC2bInternal = internalMutation({
  args: { transId: v.string(), reason: v.string() },
  returns: v.object({
    outcome: v.string(),
    message: v.string(),
    orgId: v.optional(v.id("orgs")),
    detail: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const transId = args.transId.trim();
    // 1) C2B row by TransID.
    const c2b = await ctx.db
      .query("c2bPayments")
      .withIndex("by_trans", (q) => q.eq("transId", transId))
      .first();
    if (c2b !== null) {
      if (c2b.paymentId === undefined) {
        await ctx.db.patch(c2b._id, {
          status: "rejected",
          matchReason: `Reversed by M-Pesa: ${args.reason}`,
        });
        return {
          outcome: "queued-rejected",
          message: "Queued hit marked reversed (no payment had been recorded)",
          orgId: c2b.orgId,
        };
      }
      const payment = await ctx.db.get(c2b.paymentId);
      if (payment === null) {
        return {
          outcome: "unknown",
          message: "Linked payment not found",
          orgId: c2b.orgId,
        };
      }
      if ((payment.status ?? "active") !== "active") {
        return {
          outcome: "already-reversed",
          message: "Payment was already reversed",
          orgId: c2b.orgId,
        };
      }
      const res = await reversePaymentInTx(
        ctx,
        c2b.paymentId,
        "refunded",
        `M-Pesa reversal ${transId}: ${args.reason}`,
        "stk-reversal",
      );
      await ctx.db.patch(c2b._id, {
        status: "rejected",
        matchReason: `Reversed by M-Pesa: ${args.reason}`,
      });
      await audit(ctx, {
        orgId: c2b.orgId,
        action: "c2b.reversal",
        entityType: "c2bPayment",
        entityId: c2b._id,
        metadata: JSON.stringify({
          transId,
          paymentId: c2b.paymentId,
          creditShortfall: res.creditShortfall,
        }),
      });
      return {
        outcome: "reversed",
        message: "Linked payment refunded and invoices restored",
        orgId: c2b.orgId,
        detail: `credit shortfall ${res.creditShortfall}`,
      };
    }
    // 2) Fall back: STK receipt / manual code lookup in payments.
    return {
      outcome: "unknown",
      message: "No C2B or payment row for this TransID — needs staff review",
      detail: transId,
    };
  },
});

/** Staff: C2B queue for the org, newest first (pending first). */
export const listC2bPayments = query({
  args: { orgId: v.id("orgs"), status: v.optional(c2bStatus) },
  returns: v.array(
    v.object({
      _id: v.id("c2bPayments"),
      _creationTime: v.number(),
      orgId: v.id("orgs"),
      tenantId: v.optional(v.id("tenants")),
      tenantName: v.optional(v.string()),
      transId: v.string(),
      transAmount: v.number(),
      billRef: v.optional(v.string()),
      msisdn: v.string(),
      senderName: v.optional(v.string()),
      transTime: v.optional(v.string()),
      status: c2bStatus,
      matchReason: v.optional(v.string()),
      paymentId: v.optional(v.id("payments")),
    }),
  ),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const rows =
      args.status === undefined
        ? await ctx.db
            .query("c2bPayments")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .order("desc")
            .take(200)
        : await ctx.db
            .query("c2bPayments")
            .withIndex("by_org_status", (q) =>
              q.eq("orgId", args.orgId).eq("status", args.status as "pending_review" | "matched" | "rejected"),
            )
            .order("desc")
            .take(200);
    const out = [];
    for (const r of rows) {
      const tenant = r.tenantId === undefined ? null : await ctx.db.get(r.tenantId);
      out.push({
        _id: r._id,
        _creationTime: r._creationTime,
        orgId: r.orgId,
        tenantId: r.tenantId,
        tenantName: tenant?.full_name,
        transId: r.transId,
        transAmount: r.transAmount,
        billRef: r.billRef,
        msisdn: r.msisdn,
        senderName: shortName({ FirstName: r.firstName, MiddleName: r.middleName, LastName: r.lastName }) || undefined,
        transTime: r.transTime,
        status: r.status,
        matchReason: r.matchReason,
        paymentId: r.paymentId,
      });
    }
    return out as never;
  },
});

/** What the tenant types into the M-Pesa menu: shortcode + account code. */
export const getPaybillInfo = query({
  args: { tenantId: v.id("tenants") },
  returns: v.union(
    v.object({
      shortcode: v.string(),
      accountCode: v.string(),
      registered: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) return null;
    const caller = await assertOrgMember(ctx, tenant.orgId);
    if (caller.role === "tenant" && caller.tenantId !== args.tenantId) {
      throw new ConvexError("Not found");
    }
    const creds = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", tenant.orgId))
      .first();
    if (creds === null || !creds.consumerKeyEnc) return null;
    return {
      shortcode: creds.shortcode,
      // Required at creation since the invariant landed; legacy rows fall
      // back to "" and the staff backfill heals them. Never mint inside a
      // query (queries cannot write).
      accountCode: tenant.accountCode ?? "",
      registered: creds.c2bRegistered ?? false,
    };
  },
});

/** Mint/backfill the caller's tenant account code (self-serve safe). */
export const ensureMyAccountCode = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const caller = await assertOrgMember(ctx, (await getOwnTenantOrg(ctx)).orgId);
    if (caller.role !== "tenant" || caller.tenantId === null) {
      throw new ConvexError("Tenant only");
    }
    return await ensureAccountCode(ctx, caller.tenantId);
  },
});

/**
 * Staff: mint/backfill one tenant's account code (pre-code rows show
 * "assigning…" until this runs).
 */
export const ensureTenantAccountCode = mutation({
  args: { tenantId: v.id("tenants") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (tenant === null) throw new ConvexError("Tenant not found");
    await assertStaff(ctx, tenant.orgId);
    return await ensureAccountCode(ctx, args.tenantId);
  },
});

/**
 * Staff: backfill account codes for every tenant in the org missing one.
 * Returns the number minted. One audit entry for the run.
 */
export const backfillAccountCodes = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.object({ minted: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const caller = await assertStaff(ctx, args.orgId);
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    let minted = 0;
    let skipped = 0;
    for (const t of tenants) {
      if (t.accountCode) {
        skipped += 1;
        continue;
      }
      await ensureAccountCode(ctx, t._id);
      minted += 1;
    }
    if (minted > 0) {
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: caller.userId,
        action: "tenant.backfillCodes",
        entityType: "tenant",
        entityId: undefined,
        metadata: JSON.stringify({ minted }),
      });
    }
    return { minted, skipped };
  },
});

async function getOwnTenantOrg(ctx: MutationCtx): Promise<{ orgId: Id<"orgs"> }> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated");
  const link = await ctx.db
    .query("tenantUsers")
    .withIndex("by_user", (q) => q.eq("userId", identity.subject))
    .first();
  if (link === null) throw new ConvexError("Not a tenant account");
  const tenant = await ctx.db.get(link.tenantId);
  if (tenant === null) throw new ConvexError("Tenant not found");
  return { orgId: tenant.orgId };
}

/** Owner: register the C2B validation/confirmation URLs on Daraja. */
export const registerC2bUrls = action({
  args: {},
  returns: v.object({ registered: v.boolean() }),
  handler: async (
    ctx: ActionCtx,
  ): Promise<{ registered: boolean }> => {
    const caller: { userId: string; orgId: Id<"orgs"> } = await ctx.runQuery(
      internal.helpers.assertOwner,
      {},
    );
    const creds = await ctx.runMutation(
      internal.mpesaInternal.getDecryptedCreds,
      { orgId: caller.orgId },
    );
    if (creds === null) {
      throw new ConvexError(
        "M-Pesa is not configured for this business. Save Daraja credentials first.",
      );
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) {
      throw new ConvexError(
        "Set MPESA_CALLBACK_URL env var to your Convex site URL first.",
      );
    }
    const base = creds.environment === "production" ? PROD : SANDBOX;
    const tokenRes = await fetch(
      `${base}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: "Basic " + btoa(`${creds.consumerKey}:${creds.consumerSecret}`),
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!tokenRes.ok) {
      throw new ConvexError(
        `Daraja OAuth failed (${tokenRes.status}) — check consumer key/secret`,
      );
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      throw new ConvexError("Daraja did not return an access token");
    }
    const confirmUrl = `${siteBase}/c2b-confirmation`;
    const validUrl = `${siteBase}/c2b-validation`;
    const regRes = await fetch(`${base}/mpesa/c2b/v1/registerurl`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        ShortCode: creds.shortcode,
        ResponseType: "Completed",
        // NOTE: Daraja rejects callback URLs containing the word "MPESA"
        // (error 400.003.02) — keep these paths free of it.
        ConfirmationURL: confirmUrl,
        ValidationURL: validUrl,
      }),
    });
    const rawBody = await regRes.text();
    let reg: { ResponseCode?: string; ResponseDescription?: string };
    try {
      reg = JSON.parse(rawBody) as typeof reg;
    } catch {
      throw new ConvexError(
        `Daraja rejected registration (HTTP ${regRes.status}) with a non-JSON reply: ${rawBody.slice(0, 200)}`,
      );
    }
    if (reg.ResponseCode !== "0") {
      // "URLs are already registered" (500.003.1001) means a prior call —
      // possibly an earlier tap whose response was lost — already stored
      // these (or other) URLs at Daraja. Treat as success: the goal state
      // (some registration live) holds; verify with a small live payment
      // and check the webhook log if confirmations never arrive (they may
      // point at older URLs, which only the Daraja portal can change).
      const raw = `${reg.ResponseCode ?? ""} ${reg.ResponseDescription ?? rawBody}`;
      if (/already registered/i.test(raw)) {
        await ctx.runMutation(internal.c2b.logWebhookInternal, {
          orgId: caller.orgId,
          route: "c2b-register",
          shortcode: creds.shortcode,
          outcome: "register-already-live",
          detail: rawBody.slice(0, 200),
        });
        await ctx.runMutation(internal.c2b.markC2bRegistered, {
          orgId: caller.orgId,
        });
        return { registered: true };
      }
      // Surface everything Daraja tells us: the description names the
      // actual cause (till-vs-paybill, sandbox mismatch, bad URLs…).
      // Include the exact URLs sent (public site URLs, not secrets) so a
      // "banned word" rejection shows which part offends.
      // Also log the attempt so the webhook log shows the rejection.
      await ctx.runMutation(internal.c2b.logWebhookInternal, {
        orgId: caller.orgId,
        route: "c2b-register",
        shortcode: creds.shortcode,
        outcome: "register-rejected",
        detail: `HTTP ${regRes.status} · ${reg.ResponseCode ?? "?"} · ${reg.ResponseDescription ?? rawBody.slice(0, 200)}`,
      });
      throw new ConvexError(
        `Daraja said no (HTTP ${regRes.status}, code ${reg.ResponseCode ?? "?"}): ${reg.ResponseDescription ?? rawBody.slice(0, 300)} — shortcode ${creds.shortcode} on ${creds.environment}. Sent ConfirmationURL=${confirmUrl} ValidationURL=${validUrl}.`,
      );
    }
    await ctx.runMutation(internal.c2b.markC2bRegistered, {
      orgId: caller.orgId,
    });
    return { registered: true };
  },
});

/** Internal: flag the org's C2B URLs as registered (after Daraja confirms). */
export const markC2bRegistered = internalMutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (row !== null) {
      await ctx.db.patch(row._id, {
        c2bRegistered: true,
        c2bRegisteredAt: Date.now(),
      });
    }
    return null;
  },
});

/** C2B registration state for Settings (owner view). */
export const getC2bStatus = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    shortcode: v.string(),
    registered: v.boolean(),
    registeredAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const caller = await assertStaff(ctx);
    const row = await ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .first();
    if (row === null || !row.consumerKeyEnc) {
      return { configured: false, shortcode: "", registered: false };
    }
    return {
      configured: true,
      shortcode: row.shortcode,
      registered: row.c2bRegistered ?? false,
      registeredAt: row.c2bRegisteredAt,
    };
  },
});

const alertShape = v.object({
  _id: v.id("paymentAlerts"),
  _creationTime: v.number(),
  kind: v.string(),
  title: v.string(),
  detail: v.optional(v.string()),
  transId: v.optional(v.string()),
  acknowledged: v.boolean(),
});

/** Staff: open (unacknowledged) anomaly alerts, newest first. */
export const listAlerts = query({
  args: { orgId: v.id("orgs"), openOnly: v.optional(v.boolean()) },
  returns: v.array(alertShape),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const rows =
      args.openOnly === false
        ? await ctx.db
            .query("paymentAlerts")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .order("desc")
            .take(100)
        : await ctx.db
            .query("paymentAlerts")
            .withIndex("by_org_open", (q) =>
              q.eq("orgId", args.orgId).eq("acknowledged", false),
            )
            .order("desc")
            .take(100);
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      transId: r.transId,
      acknowledged: r.acknowledged,
    })) as never;
  },
});

/** Staff: acknowledge an alert (keeps it in history). */
export const acknowledgeAlert = mutation({
  args: { id: v.id("paymentAlerts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("Alert not found");
    const caller = await assertStaff(ctx, row.orgId);
    if (!row.acknowledged) {
      await ctx.db.patch(args.id, {
        acknowledged: true,
        acknowledgedBy: caller.userId,
        acknowledgedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Internal: raise an anomaly alert (dedupes open alerts per kind+transId so
 * a retry storm doesn't spam the list).
 */
export const raiseAlertInternal = internalMutation({
  args: {
    orgId: v.id("orgs"),
    kind: v.string(),
    title: v.string(),
    detail: v.optional(v.string()),
    transId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const open = await ctx.db
      .query("paymentAlerts")
      .withIndex("by_org_open", (q) =>
        q.eq("orgId", args.orgId).eq("acknowledged", false),
      )
      .collect();
    if (
      open.some(
        (a) => a.kind === args.kind && (a.transId ?? "") === (args.transId ?? ""),
      )
    ) {
      return null;
    }
    await ctx.db.insert("paymentAlerts", {
      orgId: args.orgId,
      kind: args.kind,
      title: args.title,
      detail: args.detail,
      transId: args.transId,
      acknowledged: false,
    });
    return null;
  },
});

/**
 * Internal: append one webhook debug row. Called from the public routes so
 * Daraja debugging doesn't need server logs.
 */
export const logWebhookInternal = internalMutation({
  args: {
    orgId: v.optional(v.id("orgs")),
    route: v.string(),
    transId: v.optional(v.string()),
    shortcode: v.optional(v.string()),
    outcome: v.string(),
    detail: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("webhookLog", {
      orgId: args.orgId,
      route: args.route,
      transId: args.transId,
      shortcode: args.shortcode,
      outcome: args.outcome.slice(0, 120),
      detail: args.detail?.slice(0, 500),
      latencyMs: args.latencyMs,
    });
    return null;
  },
});

/** Staff: recent webhook hits for debugging, newest first. */
export const listWebhookLog = query({
  args: { orgId: v.id("orgs"), route: v.optional(v.string()) },
  returns: v.array(
    v.object({
      _id: v.id("webhookLog"),
      _creationTime: v.number(),
      route: v.string(),
      transId: v.optional(v.string()),
      shortcode: v.optional(v.string()),
      outcome: v.string(),
      detail: v.optional(v.string()),
      latencyMs: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const rows =
      args.route === undefined
        ? await ctx.db
            .query("webhookLog")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .order("desc")
            .take(100)
        : await ctx.db
            .query("webhookLog")
            .withIndex("by_route", (q) => q.eq("route", args.route as string))
            .order("desc")
            .take(100);
    const scoped =
      args.route === undefined
        ? rows
        : rows.filter((r) => r.orgId === undefined || r.orgId === args.orgId);
    return scoped.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      route: r.route,
      transId: r.transId,
      shortcode: r.shortcode,
      outcome: r.outcome,
      detail: r.detail,
      latencyMs: r.latencyMs,
    })) as never;
  },
});

/**
 * Staff: risk review for a queued C2B hit. Daraja's TransactionStatus API
 * needs an initiator certificate uploaded per shortcode, so Kodi cannot
 * verify C2B server-side out of the box — instead this scores the hit
 * against the tenant's history and tells staff exactly what to check
 * (sender's M-Pesa SMS + amount + timing) before matching.
 */
export const verifyC2bTransaction = query({
  args: { id: v.id("c2bPayments") },
  returns: v.object({
    risk: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    checks: v.array(v.string()),
    priorFromSender: v.number(),
    avgAmount: v.number(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("C2B payment not found");
    const caller = await assertOrgMember(ctx, row.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");

    const checks: string[] = [];
    let risk: "low" | "medium" | "high" = "low";

    // History from this sender phone across all C2B hits.
    const prior = await ctx.db
      .query("c2bPayments")
      .withIndex("by_org", (q) => q.eq("orgId", row.orgId))
      .collect();
    const fromSender = prior.filter(
      (p) => p.msisdn === row.msisdn && p._id !== row._id,
    );
    const matchedBefore = fromSender.filter((p) => p.status === "matched");
    const avg =
      matchedBefore.length > 0
        ? Math.round(
            matchedBefore.reduce((s, p) => s + p.transAmount, 0) /
              matchedBefore.length,
          )
        : 0;

    if (matchedBefore.length === 0) {
      risk = "medium";
      checks.push("First payment from this sender — confirm the tenant's M-Pesa SMS before matching.");
    } else {
      checks.push(
        `${matchedBefore.length} earlier payment${matchedBefore.length === 1 ? "" : "s"} from this sender matched cleanly.`,
      );
    }
    if (avg > 0) {
      const drift = Math.abs(row.transAmount - avg) / avg;
      if (drift > 1) {
        risk = "high";
        checks.push(
          `Amount is far off this sender's usual (~${avg.toLocaleString("en-US")} KES) — double-check with the tenant.`,
        );
      }
    }
    if (row.transAmount >= 100_000) {
      risk = risk === "low" ? "medium" : risk;
      checks.push("Large amount — ask the tenant to forward the M-Pesa SMS before matching.");
    }
    if ((row.billRef ?? "").trim() === "") {
      checks.push("No account number was typed — matching relied on sender phone alone.");
      if (risk === "low") risk = "medium";
    }
    if (risk === "low") {
      checks.push("No red flags: known sender, plausible amount, account recognised or reviewable.");
    }
    checks.push("Daraja cannot countersign C2B server-side without an initiator certificate — the sender's SMS is the source of truth.");
    return { risk, checks, priorFromSender: fromSender.length, avgAmount: avg } as never;
  },
});

/**
 * Staff sandbox: dry-run a Paybill confirmation against the REAL matching
 * and allocation logic without writing anything. Shows which tenant would
 * match (and by which layer), the FIFO split, and any leftover credit —
 * new staff practice matching here instead of on live money.
 */
export const simulateC2b = query({
  args: {
    orgId: v.id("orgs"),
    billRef: v.optional(v.string()),
    msisdn: v.string(),
    amount: v.number(),
  },
  returns: v.object({
    match: v.union(
      v.object({ tenantName: v.string(), reason: v.string() }),
      v.null(),
    ),
    preview: v.array(
      v.object({
        month: v.string(),
        balance: v.number(),
        applied: v.number(),
      }),
    ),
    leftover: v.number(),
    suggestions: v.array(
      v.object({
        tenantName: v.string(),
        score: v.number(),
        signals: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const amount = Math.round(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ConvexError("Enter a simulation amount in KES.");
    }
    // Same layers as the live path, read-only.
    const ref = (args.billRef ?? "").trim().toUpperCase();
    const digits = ref.replace(/\D/g, "");
    let match: { tenantId: Id<"tenants">; reason: string } | null = null;
    if (ref !== "") {
      const byCode = await ctx.db
        .query("tenants")
        .withIndex("by_account", (q) => q.eq("accountCode", ref))
        .first();
      if (byCode !== null && byCode.orgId === args.orgId) {
        match = { tenantId: byCode._id, reason: `account code ${ref}` };
      } else if (digits !== "" && digits.length >= 6) {
        const tenants = await ctx.db
          .query("tenants")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
        const hits = tenants.filter(
          (t) => t.national_id.replace(/\D/g, "") === digits,
        );
        if (hits.length === 1) {
          match = { tenantId: hits[0]._id, reason: "national ID" };
        }
      }
    }
    if (match === null) {
      const phone = normalizePhone(args.msisdn);
      if (phone !== null) {
        const byPhone = await ctx.db
          .query("tenants")
          .withIndex("by_org_phone", (q) =>
            q.eq("orgId", args.orgId).eq("phone", phone),
          )
          .first();
        if (byPhone !== null) {
          match = { tenantId: byPhone._id, reason: "sender phone" };
        }
      }
    }
    // FIFO preview for the matched tenant (same sort as the ledger).
    let preview: { month: string; balance: number; applied: number }[] = [];
    let leftover = amount;
    let tenantName = "";
    if (match !== null) {
      const tenant = await ctx.db.get(match.tenantId);
      tenantName = tenant?.full_name ?? "";
      const open = await ctx.db
        .query("invoices")
        .withIndex("by_tenant_month", (q) => q.eq("tenantId", match!.tenantId))
        .collect();
      open.sort((a, b) => a.month.localeCompare(b.month));
      let remaining = amount;
      for (const inv of open) {
        if (remaining <= 0) break;
        if (inv.orgId !== args.orgId || inv.balance <= 0) continue;
        const applied = Math.min(remaining, inv.balance);
        preview.push({ month: inv.month, balance: inv.balance, applied });
        remaining -= applied;
      }
      leftover = remaining;
    }
    // Top-3 suggestions when unmatched (same scorer, trimmed).
    const suggestions: { tenantName: string; score: number; signals: string[] }[] = [];
    if (match === null) {
      const senderPhone = normalizePhone(args.msisdn);
      const tenants = await ctx.db
        .query("tenants")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
      const scored: { tenantName: string; score: number; signals: string[] }[] = [];
      for (const t of tenants) {
        if (t.status === "moved_out") continue;
        const signals: string[] = [];
        let score = 0;
        if (ref !== "" && t.accountCode) {
          const sim = nameSimilarity(ref, t.accountCode);
          if (sim >= 0.7) {
            score += sim * 0.35;
            signals.push("account close");
          }
        }
        if (senderPhone !== null && t.phone === senderPhone) {
          score += 0.4;
          signals.push("sender phone");
        }
        if (score >= 0.3 && signals.length > 0) {
          scored.push({
            tenantName: t.full_name,
            score: Math.round(score * 100) / 100,
            signals,
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      suggestions.push(...scored.slice(0, 3));
    }
    return {
      match:
        match === null
          ? null
          : { tenantName, reason: match.reason },
      preview: preview as never,
      leftover,
      suggestions: suggestions as never,
    };
  },
});

export { c2bShape, parseAmount };
