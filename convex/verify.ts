import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, siteBaseUrl } from "./lib/auth";
import { fireAsyncJob, initiatorBundle } from "./lib/initiatorJobs";

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Verify, reconcile, know-your-customer Daraja tracks:
 *  - Transaction Status v1: receipt/OriginatorConversationID → tier lookup
 *    (genuine TransID verification for queued hits, STK limbo resolution).
 *  - Account Balance v1: nightly M-Pesa-vs-ledger diff.
 *  - Pull Transactions: 48h C2B windows with FULL numeric MSISDN — the
 *    authoritative phone source and the safety net for missed webhooks.
 */

const TXN_STATUS_CANDIDATES = [
  "mpesa/transactionstatus/v1/query",
  "transactionstatus/v1/query",
];

const BALANCE_CANDIDATES = [
  "mpesa/accountbalance/v1/query",
  "accountbalance/v1/query",
];

const PULL_REGISTER_CANDIDATES = [
  "pulltransactions/v1/register",
  "mpesa/pulltransactions/v1/register",
];

const PULL_QUERY_CANDIDATES = [
  "pulltransactions/v1/query",
  "mpesa/pulltransactions/v1/query",
];

/**
 * Staff: ask Daraja for the authoritative state of one transaction —
 * receipt (C2B TransID, STK receipt) or an OriginatorConversationID from
 * darajaJobs. Returns the accepted job; the result lands on
 * /async-result/txn_status and flips the job row.
 */
export const queryTransactionStatus = action({
  args: {
    orgId: v.id("orgs"),
    transactionId: v.optional(v.string()),
    originatorConversationId: v.optional(v.string()),
    partyA: v.optional(v.string()),
    remarks: v.optional(v.string()),
  },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const txId = (args.transactionId ?? "").trim();
    const ocId = (args.originatorConversationId ?? "").trim();
    if (!txId && !ocId) {
      throw new ConvexError(
        "Provide the M-Pesa receipt/TransID or the OriginatorConversationID",
      );
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    const partyA = (args.partyA ?? "").trim() || bundle.shortcode;
    // IdentifierType 1 = MSISDN party, 11 = organization shortcode party,
    // 4 = TransactionID lookup — Daraja picks by which fields are set.
    return await fireAsyncJob(ctx, bundle, {
      kind: "txn_status",
      candidates: TXN_STATUS_CANDIDATES,
      label: "Transaction Status",
      summary: `Status for ${txId || ocId}`.slice(0, 120),
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "TransactionStatusQuery",
        TransactionID: txId || undefined,
        OriginatorConversationID: ocId || undefined,
        PartyA: partyA,
        IdentifierType: txId ? "4" : "11",
        Remarks: (args.remarks ?? "Kodi status check").slice(0, 100),
        Occasion: "KodiVerify",
      },
    });
  },
});

/**
 * Staff: latest Transaction Status answer for a receipt (reads the newest
 * done/failed txn_status job whose summary names it). The review queue
 * calls this after firing queryTransactionStatus.
 */
export const latestStatusFor = query({
  args: { orgId: v.id("orgs"), transactionId: v.string() },
  returns: v.union(
    v.object({
      status: v.string(),
      resultCode: v.optional(v.string()),
      resultDesc: v.optional(v.string()),
      conversationId: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const jobs = await ctx.db
      .query("darajaJobs")
      .withIndex("by_org_kind", (q) =>
        q.eq("orgId", args.orgId).eq("kind", "txn_status" as never),
      )
      .order("desc")
      .take(50);
    const hit = jobs.find((j) =>
      (j.requestSummary ?? "").includes(args.transactionId),
    );
    if (hit === undefined || hit.status === "pending") return null;
    return {
      status: hit.status,
      resultCode: hit.resultCode,
      resultDesc: hit.resultDesc,
      conversationId: hit.conversationId,
    };
  },
});

/**
 * Staff/owner: fire an Account Balance query (async — result lands on
 * /async-result/balance). The nightly cron calls the internal variant;
 * this action is the manual "check now" button.
 */
export const queryAccountBalance = action({
  args: { orgId: v.id("orgs") },
  returns: v.object({
    conversationId: v.string(),
    jobId: v.id("darajaJobs"),
  }),
  handler: async (ctx, args) => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    return await fireAsyncJob(ctx, bundle, {
      kind: "balance",
      candidates: BALANCE_CANDIDATES,
      label: "Account Balance",
      summary: `Balance for ${bundle.shortcode}`,
      payload: {
        Initiator: bundle.initiatorName,
        SecurityCredential: bundle.credential,
        CommandID: "AccountBalance",
        PartyA: bundle.shortcode,
        IdentifierType: "4",
        Remarks: "Kodi nightly balance",
      },
    });
  },
});

/**
 * Parse a Daraja balance callback payload into per-account balances.
 * Format: pipe-delimited working-account lines
 * (e.g. "Working Account|KES|...|...|balance|..."). Returns the raw lines
 * plus any parseable numeric balances keyed by account label.
 */
export function parseBalancePayload(raw: string): {
  lines: string[];
  balances: { account: string; balance: number }[];
} {
  const lines = raw
    .split(/[|\n]/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const balances: { account: string; balance: number }[] = [];
  for (let i = 0; i + 5 < lines.length; i += 6) {
    const n = Number(lines[i + 4].replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n)) {
      balances.push({ account: lines[i], balance: Math.round(n) });
    }
  }
  return { lines, balances };
}

/**
 * Staff: latest parsed balance snapshot (from the newest completed balance
 * job's raw result). Empty when no balance query has completed yet.
 */
export const latestBalance = query({
  args: { orgId: v.id("orgs") },
  returns: v.object({
    balances: v.array(
      v.object({ account: v.string(), balance: v.number() }),
    ),
    conversationId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const jobs = await ctx.db
      .query("darajaJobs")
      .withIndex("by_org_kind", (q) =>
        q.eq("orgId", args.orgId).eq("kind", "balance" as never),
      )
      .order("desc")
      .take(10);
    const done = jobs.find(
      (j) => j.status === "done" && j.rawResult !== undefined,
    );
    if (done === undefined || done.rawResult === undefined) {
      return { balances: [] };
    }
    const parsed = parseBalancePayload(done.rawResult);
    return { balances: parsed.balances, conversationId: done.conversationId };
  },
});

/**
 * Owner: one-time Pull Transactions registration (shortcode + callback
 * URLs). After this, pullC2bWindow can page 48h C2B windows.
 */
export const registerPull = action({
  args: { orgId: v.id("orgs") },
  returns: v.object({ registered: v.boolean() }),
  handler: async (ctx, args): Promise<{ registered: boolean }> => {
    const caller: { userId: string; orgId: Id<"orgs"> } =
      await ctx.runQuery(internal.helpers.assertOwner, {});
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    const res = await fetch(
      `${bundle.base}/${PULL_REGISTER_CANDIDATES[0]}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bundle.token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          ShortCode: bundle.shortcode,
          ConfirmationURL: `${siteBase}/pull-result`,
          ValidationURL: `${siteBase}/pull-timeout`,
        }),
      },
    );
    const raw = await res.text();
    let data: { ResponseCode?: string; ResponseDescription?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new ConvexError(`Pull register rejected (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    }
    if (data.ResponseCode !== "0") {
      if (/already registered/i.test(`${data.ResponseCode} ${data.ResponseDescription ?? raw}`)) {
        await markPullRegistered(ctx, args.orgId);
        return { registered: true };
      }
      throw new ConvexError(
        `Pull register said no (${data.ResponseCode}): ${data.ResponseDescription ?? raw.slice(0, 200)}`,
      );
    }
    await markPullRegistered(ctx, args.orgId);
    return { registered: true };
  },
});

async function markPullRegistered(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
): Promise<void> {
  await ctx.runMutation(internal.verifyInternal.setPullRegistered, { orgId });
}

/**
 * Staff/cron: pull one 48h C2B window (offset-paginated) and reconcile
 * each row against c2bPayments: unknown TransIDs are ingested through
 * recordC2bInternal (matched or queued), so webhook misses heal
 * automatically. Pull rows carry the FULL numeric MSISDN — on ingest,
 * masked-pattern history upgrades to exact phone matches.
 */
export const pullC2bWindow = action({
  args: {
    orgId: v.id("orgs"),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    offset: v.optional(v.number()),
  },
  returns: v.object({
    pulled: v.number(),
    ingested: v.number(),
    matched: v.number(),
    queued: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ pulled: number; ingested: number; matched: number; queued: number }> => {
    const caller = await ctx.runQuery(internal.helpers.assertCaller, {});
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    if (caller.orgId !== args.orgId) {
      throw new ConvexError("Not a member of this organization");
    }
    const end = args.endDate ?? new Date().toISOString().slice(0, 19);
    const start =
      args.startDate ??
      new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 19);
    const siteBase = siteBaseUrl(process.env);
    if (!siteBase) throw new ConvexError("MPESA_CALLBACK_URL is not set");
    const bundle = await initiatorBundle(ctx, args.orgId, siteBase);
    // Pull query is synchronous paged JSON (not an async job): page with
    // the shared cached token straight through the candidates.
    let rows: Array<{
      TransID?: string;
      TransAmount?: string | number;
      BillRefNumber?: string;
      MSISDN?: string;
      FirstName?: string;
      MiddleName?: string;
      LastName?: string;
      TransTime?: string;
    }> = [];
    let lastErr = "";
    for (const path of PULL_QUERY_CANDIDATES) {
      try {
        const res = await fetch(`${bundle.base}/${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bundle.token}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            ShortCode: bundle.shortcode,
            StartDate: start,
            EndDate: end,
            Offset: String(args.offset ?? 0),
          }),
        });
        if (res.status === 404) {
          lastErr = (await res.text()).slice(0, 160);
          continue;
        }
        const data = (await res.json()) as {
          ResponseCode?: string;
          ResponseDescription?: string;
          Transactions?: typeof rows;
        };
        if (data.ResponseCode !== "0" || !Array.isArray(data.Transactions)) {
          throw new ConvexError(
            `Pull said no (${data.ResponseCode ?? "?"}): ${(data.ResponseDescription ?? "no transactions array").slice(0, 200)}`,
          );
        }
        rows = data.Transactions;
        lastErr = "";
        break;
      } catch (e) {
        if (e instanceof ConvexError) throw e;
        lastErr = e instanceof Error ? e.message.slice(0, 160) : String(e);
      }
    }
    if (lastErr !== "") {
      throw new ConvexError(`Pull query failed: ${lastErr}`);
    }
    let ingested = 0;
    let matched = 0;
    let queued = 0;
    for (const r of rows) {
      const transId = String(r.TransID ?? "").trim();
      if (transId === "") continue;
      const amount = Math.round(Number(r.TransAmount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const res = await ctx.runMutation(internal.c2b.recordC2bInternal, {
        shortcode: bundle.shortcode,
        transId,
        transAmount: amount,
        billRef: r.BillRefNumber,
        msisdn: String(r.MSISDN ?? ""),
        firstName: r.FirstName,
        middleName: r.MiddleName,
        lastName: r.LastName,
        transTime: r.TransTime,
        rawPayload: `pull:${start}`,
      });
      if (!res.deduplicated) {
        ingested += 1;
        if (res.status === "matched") matched += 1;
        else queued += 1;
      }
    }
    await ctx.runMutation(internal.verifyInternal.markPullCursor, {
      orgId: args.orgId,
      actorUserId: caller.userId,
      summary: `${rows.length} rows · ${ingested} new (${matched} matched, ${queued} queued)`,
    });
    return { pulled: rows.length, ingested, matched, queued };
  },
});
