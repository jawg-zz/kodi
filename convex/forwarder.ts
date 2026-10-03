import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { siteBaseUrl } from "./lib/auth";
import { initiatorBundle, fireAsyncJob } from "./lib/initiatorJobs";

const B2B_CANDIDATES = [
  "mpesa/b2b/v1/paymentrequest",
  "b2b/v1/paymentrequest",
];

const POCHI_CANDIDATES = [
  "mpesa/b2pochi/v1/paymentrequest",
  "b2pochi/v1/paymentrequest",
];

const B2C_CANDIDATES = [
  "mpesa/b2c/v1/paymentrequest",
  "b2c/v1/paymentrequest",
];

function needSiteBase(): string {
  const siteBase = siteBaseUrl(process.env);
  if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
  return siteBase;
}

/**
 * Fee computation: pct of the sweep amount, capped per org per month.
 * Returns 0 when no fee settings exist (fee model unset).
 */
export function computeFee(
  amount: number,
  feePct: number,
  feeCapKes: number,
  alreadyChargedThisMonth: number,
): number {
  if (!(feePct > 0)) return 0;
  const raw = Math.floor((amount * feePct) / 100);
  const remaining = Math.max(0, feeCapKes - alreadyChargedThisMonth);
  return Math.min(raw, remaining);
}

/** Split the batch fee across rows proportionally (whole shillings, no drift). */
export function distributeFee(
  rows: { amount: number }[],
  feeTotal: number,
): number[] {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (total <= 0 || feeTotal <= 0) return rows.map(() => 0);
  const fees = rows.map((r) => Math.floor((r.amount * feeTotal) / total));
  let assigned = fees.reduce((s, f) => s + f, 0);
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].amount - rows[a].amount);
  let i = 0;
  while (assigned < feeTotal && order.length > 0) {
    fees[order[i % order.length]] += 1;
    assigned += 1;
    i += 1;
  }
  return fees;
}

export const getSettings = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      feePct: v.number(),
      feeCapKes: v.number(),
      forwardHoldHours: v.number(),
      forwardMinKes: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .first();
    if (row === null) return null;
    return {
      feePct: row.feePct,
      feeCapKes: row.feeCapKes,
      forwardHoldHours: row.forwardHoldHours,
      forwardMinKes: row.forwardMinKes,
    };
  },
});

type SweepCandidate = {
  orgId: Id<"orgs">;
  name: string;
  method: string;
  target: string;
  platformOrgId: Id<"orgs">;
};

export const sweepCandidates = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      orgId: v.id("orgs"),
      name: v.string(),
      method: v.string(),
      target: v.string(),
      platformOrgId: v.id("orgs"),
    }),
  ),
  handler: async (ctx) => {
    const creds = await ctx.db.query("mpesaCredentials").collect();
    const platform = creds.find((c) => c.platformPaybill === true);
    if (platform === undefined) return [];
    const orgs = await ctx.db.query("orgs").collect();
    const out: SweepCandidate[] = [];
    for (const o of orgs) {
      if (o._id.toString() === platform.orgId.toString()) continue;
      if (o.subscription_status === "suspended") continue;
      if (o.autoForward === false) continue;
      if (!o.payoutMethod || !o.payoutTarget) continue;
      out.push({
        orgId: o._id,
        name: o.name,
        method: o.payoutMethod,
        target: o.payoutTarget,
        platformOrgId: platform.orgId,
      });
    }
    return out;
  },
});

export const getFeeAccruedThisMonth = internalQuery({
  args: { orgId: v.id("orgs") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const rows = await ctx.db
      .query("platformCollections")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return rows
      .filter((r) => r.settledAt !== undefined && r.settledAt >= start)
      .reduce((s, r) => s + (r.fee ?? 0), 0);
  },
});

/** Rows eligible for one org's sweep: past the hold window, unsettled. */
export const previewSweep = internalQuery({
  args: { orgId: v.id("orgs"), holdHours: v.number() },
  returns: v.object({
    rows: v.array(v.object({ id: v.id("platformCollections"), amount: v.number() })),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.holdHours * 3_600_000;
    const rows = (
      await ctx.db
        .query("platformCollections")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    )
      .filter((r) => r.settledAt === undefined && r._creationTime <= cutoff)
      .sort((a, b) => a._creationTime - b._creationTime);
    return {
      rows: rows.map((r) => ({ id: r._id, amount: r.amount })),
      total: rows.reduce((s, r) => s + r.amount, 0),
    };
  },
});

export const markRowsForwarded = internalMutation({
  args: {
    rowIds: v.array(v.id("platformCollections")),
    feePerRow: v.array(v.number()),
    payoutRef: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.rowIds.length !== args.feePerRow.length) {
      throw new ConvexError("Row/fee length mismatch");
    }
    for (let i = 0; i < args.rowIds.length; i++) {
      const row = await ctx.db.get(args.rowIds[i]);
      if (row === null || row.settledAt !== undefined) continue;
      await ctx.db.patch(args.rowIds[i], {
        fee: args.feePerRow[i],
        settledAt: Date.now(),
        payoutRef: args.payoutRef,
        settleKind: "auto",
      });
    }
    return null;
  },
});

export const raiseForwardAlert = internalMutation({
  args: { orgId: v.id("orgs"), title: v.string(), detail: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("paymentAlerts", {
      orgId: args.orgId,
      kind: "forward_failed",
      title: args.title,
      detail: args.detail,
      acknowledged: false,
    });
    return null;
  },
});

async function fireDisbursement(
  ctx: ActionCtx,
  org: SweepCandidate,
  amount: number,
): Promise<string> {
  const siteBase = needSiteBase();
  // The sweep runs on the platform org's initiator bundle (money leaves
  // the platform paybill), targeting the landlord's registered rail.
  const bundle = await initiatorBundle(ctx, org.platformOrgId, siteBase);
  const remarks = `Kodi settlement ${org.name}`.slice(0, 100);
  if (org.method === "pochi") {
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2b",
      candidates: POCHI_CANDIDATES,
      label: "Pochi forward",
      summary: `Pochi forward ${amount} KES → ${org.target}`.slice(0, 120),
      amount,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "BusinessPayToPochi",
        PartyA: bundle.shortcode,
        PartyB: org.target,
        Amount: amount,
        Remarks: remarks,
      },
    });
    return res.conversationId;
  }
  if (org.method === "b2c") {
    const res = await fireAsyncJob(ctx, bundle, {
      kind: "b2c",
      candidates: B2C_CANDIDATES,
      label: "B2C forward",
      summary: `B2C forward ${amount} KES → ${org.target}`.slice(0, 120),
      amount,
      payload: {
        InitiatorName: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "BusinessPayment",
        Amount: amount,
        PartyA: bundle.shortcode,
        PartyB: org.target,
        Remarks: remarks,
      },
    });
    return res.conversationId;
  }
  const commandId = org.method === "till" ? "BusinessBuyGoods" : "BusinessPayBill";
  const res = await fireAsyncJob(ctx, bundle, {
    kind: "b2b",
    candidates: B2B_CANDIDATES,
    label: "B2B forward",
    summary: `${commandId} ${amount} KES → ${org.target}`.slice(0, 120),
    amount,
    payload: {
      Initiator: bundle.initiatorName,
      SecurityCredential: bundle.credential,
      CommandID: commandId,
      SenderIdentifierType: "4",
      RecieverIdentifierType: "4",
      Amount: amount,
      PartyA: bundle.shortcode,
      PartyB: org.target,
      AccountReference: `KODI-${org.name.slice(0, 8)}`.replace(/[^A-Za-z0-9-]/g, ""),
      Remarks: remarks,
    },
  });
  return res.conversationId;
}

/**
 * Nightly auto-forward sweep. For each eligible org: take unsettled
 * collections older than the hold window, deduct the platform fee, fire
 * the right Daraja disbursement, and mark rows settled with the
 * conversation ID. Failures raise an alert and retry on the next sweep —
 * money never leaves the ledger.
 */
export const sweepForward = internalAction({
  args: {},
  returns: v.object({ orgs: v.number(), swept: v.number(), failed: v.number() }),
  handler: async (ctx): Promise<{ orgs: number; swept: number; failed: number }> => {
    const settings = await ctx.runQuery(internal.forwarder.getSettings, {});
    const holdHours = settings?.forwardHoldHours ?? 24;
    const minKes = settings?.forwardMinKes ?? 500;
    const orgs = await ctx.runQuery(internal.forwarder.sweepCandidates, {});
    let swept = 0;
    let failed = 0;
    for (const org of orgs) {
      try {
        const preview = await ctx.runQuery(internal.forwarder.previewSweep, {
          orgId: org.orgId,
          holdHours,
        });
        if (preview.total < minKes) continue;
        const accrued = await ctx.runQuery(internal.forwarder.getFeeAccruedThisMonth, {
          orgId: org.orgId,
        });
        const feeTotal = computeFee(
          preview.total,
          settings?.feePct ?? 0,
          settings?.feeCapKes ?? 0,
          accrued,
        );
        const net = preview.total - feeTotal;
        if (net < 10) continue;
        // Whole rows only, oldest first.
        let running = 0;
        const picked: { id: (typeof preview.rows)[number]["id"]; amount: number }[] = [];
        for (const r of preview.rows) {
          if (running + r.amount > net) break;
          running += r.amount;
          picked.push(r);
        }
        if (running < 10) continue;
        const perRow = distributeFee(picked, feeTotal);
        const ref = await fireDisbursement(ctx, org, running);
        await ctx.runMutation(internal.forwarder.markRowsForwarded, {
          rowIds: picked.map((p) => p.id),
          feePerRow: perRow,
          payoutRef: ref,
        });
        swept += 1;
      } catch (e) {
        failed += 1;
        await ctx.runMutation(internal.forwarder.raiseForwardAlert, {
          orgId: org.orgId,
          title: `Auto-forward failed for ${org.name}`,
          detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        });
      }
    }
    return { orgs: orgs.length, swept, failed };
  },
});
