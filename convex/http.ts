import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { billManagerPost } from "./billManager";
import { cachedDarajaToken, darajaBase } from "./lib/daraja";
import { classifyStkCode } from "./lib/stkOutcome";

const http = httpRouter();

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

/**
 * Public STK callback (Safaricom cannot send auth headers).
 * The CheckoutRequestID is an unguessable capability linking the callback
 * to a pending row. Success writes go through one atomic mutation
 * (reconcileSuccessInternal): retried or racing callbacks dedupe instead
 * of writing a second payment. Failures just flip the tx row.
 *
 * NOTE: path deliberately free of the word "mpesa" — Daraja rejects
 * callback URLs containing "MPESA" (400.003.02). Same for all routes here.
 */
http.route({
  path: "/stk-callback",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/stk-callback",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const started = Date.now();
    const log = (
      outcome: string,
      opts: { transId?: string; shortcode?: string; detail?: string } = {},
    ): Promise<null> =>
      ctx
        .runMutation(internal.c2b.logWebhookInternal, {
          orgId: undefined,
          route: "stk-callback",
          transId: opts.transId,
          shortcode: opts.shortcode,
          outcome,
          detail: opts.detail,
          latencyMs: Date.now() - started,
        })
        .catch(() => null);
    let body: {
      Body?: {
        stkCallback?: {
          MerchantRequestID?: string;
          CheckoutRequestID?: string;
          ResultCode?: number;
          ResultDesc?: string;
          CallbackMetadata?: {
            Item?: { Name: string; Value?: string | number }[];
          };
        };
      };
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      await log("invalid-json");
      return json({ error: "Invalid JSON body" }, 400);
    }
    const cb = body.Body?.stkCallback;
    if (
      cb?.CheckoutRequestID === undefined ||
      typeof cb.CheckoutRequestID !== "string"
    ) {
      await log("bad-shape");
      return json({ error: "Missing CheckoutRequestID" }, 400);
    }
    if (cb.CheckoutRequestID.length > 128) {
      await log("bad-shape", { transId: cb.CheckoutRequestID.slice(0, 64) });
      return json({ error: "Bad CheckoutRequestID" }, 400);
    }
    const tx = await ctx.runMutation(internal.mpesaInternal.getTxByCheckout, {
      checkoutRequestId: cb.CheckoutRequestID,
    });
    if (tx === null) {
      await log("unknown-checkout", { transId: cb.CheckoutRequestID });
      return json({ error: "Unknown transaction" }, 404);
    }
    const code = Number(cb.ResultCode ?? -1);
    const items = cb.CallbackMetadata?.Item ?? [];
    const meta: Record<string, string | number | undefined> = {};
    for (const i of items) meta[i.Name] = i.Value;
    const receipt =
      typeof meta["MpesaReceiptNumber"] === "string"
        ? (meta["MpesaReceiptNumber"] as string)
        : undefined;
    // Trust Daraja's reported amount (fallback: initiated amount) — the
    // ledger stores what M-Pesa actually moved, not what was requested.
    const paidAmount =
      typeof meta["Amount"] === "number"
        ? Math.round(meta["Amount"] as number)
        : tx.amount;

    if (code === 0) {
      if (tx.status === "success" && tx.paymentId !== undefined) {
        await log("duplicate", { transId: cb.CheckoutRequestID });
        return json({ ok: true, deduplicated: true });
      }
      try {
        const reconciled = await ctx.runMutation(
          internal.mpesaInternal.reconcileSuccessInternal,
          {
            orgId: tx.orgId,
            tenantId: tx.tenantId,
            checkoutRequestId: cb.CheckoutRequestID,
            amount: paidAmount,
            mpesaReceipt: receipt,
          },
        );
        if (reconciled === null) {
          await log("reconcile-null", { transId: cb.CheckoutRequestID });
          return json({ error: "Could not reconcile payment" }, 500);
        }
        // Late success after a timeout sweep is still real money: keep the
        // row flipped to success (reconcile does that) and say so, so
        // staff reading the STK list know the earlier timeout was superseded.
        const late = tx.status === "timeout" || tx.status === "failed";
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: cb.CheckoutRequestID,
          resultDesc:
            cb.ResultDesc ?? (late ? "Late success after timeout" : undefined),
          mpesaReceipt: receipt,
          paidAmount,
        });
        await log(reconciled.deduplicated ? "duplicate" : late ? "late-success" : "success", {
          transId: cb.CheckoutRequestID,
          detail: `${paidAmount} KES${receipt ? ` · ${receipt}` : ""}`,
        });
        return json({
          ok: true,
          paymentId: reconciled.paymentId,
          deduplicated: reconciled.deduplicated || undefined,
          late: late || undefined,
        });
      } catch (e) {
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: cb.CheckoutRequestID,
          status: "failed",
          resultCode: code,
          resultDesc: `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        await log("reconcile-failed", {
          transId: cb.CheckoutRequestID,
          detail: e instanceof Error ? e.message.slice(0, 200) : undefined,
        });
        return json(
          {
            error:
              "Payment received but ledger write failed — flagged for review",
          },
          500,
        );
      }
    }

    // Terminal handset outcomes only (shared classifyStkCode): cancelled
    // fails the row, unreachable times it out. Any other callback code
    // (transitional states, unknown) leaves the row pending — the poll
    // loop or a later callback resolves it. Failing here would tell staff
    // to resend a live prompt (double-charge risk).
    const outcome = classifyStkCode(code);
    if (outcome === "cancelled" || outcome === "timeout") {
      const status = outcome === "timeout" ? "timeout" : "failed";
      await ctx.runMutation(internal.mpesaInternal.updateTx, {
        checkoutRequestId: cb.CheckoutRequestID,
        status,
        resultCode: code,
        resultDesc: cb.ResultDesc,
      });
      await log(status, {
        transId: cb.CheckoutRequestID,
        detail: cb.ResultDesc?.slice(0, 200),
      });
      return json({ ok: true, status });
    }
    await log("pending", {
      transId: cb.CheckoutRequestID,
      detail: `Non-terminal callback code ${code}: ${cb.ResultDesc?.slice(0, 160) ?? "no description"}`,
    });
    return json({ ok: true, status: "pending" });
  }),
});

/**
 * C2B (Paybill) validation + confirmation. Safaricom calls these with no
 * auth headers; the shortcode in the payload routes to the owning org.
 *
 * Validation accepts everything structurally valid (unknown shortcodes and
 * empty TransIDs are rejected) — tenant matching happens at confirmation
 * so money is never bounced for a typo'd account number; it parks in the
 * review queue instead.
 */
http.route({
  path: "/c2b-validation",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/c2b-validation",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Invalid JSON body" },
        400,
      );
    }
    const transId = String(body["TransID"] ?? "");
    const shortcode = String(body["BusinessShortCode"] ?? "");
    if (transId === "" || transId.length > 64 || shortcode === "") {
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Missing TransID/ShortCode" },
        400,
      );
    }
    const rawAmount = body["TransAmount"];
    const amount =
      typeof rawAmount === "number"
        ? Math.round(rawAmount)
        : Math.round(Number(rawAmount));
    const billRef =
      typeof body["BillRefNumber"] === "string"
        ? body["BillRefNumber"]
        : undefined;
    try {
      const decision = await ctx.runMutation(
        internal.c2b.validateC2bInternal,
        { shortcode, transId, transAmount: amount, billRef },
      );
      return json(
        { ResultCode: decision.resultCode, ResultDesc: decision.resultDesc },
        decision.resultCode === "0" ? 200 : 400,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ ResultCode: "C2B00016", ResultDesc: msg }, 400);
    }
  }),
});

http.route({
  path: "/c2b-confirmation",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/c2b-confirmation",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const started = Date.now();
    const log = (
      outcome: string,
      opts: { orgId?: never; transId?: string; shortcode?: string; detail?: string } = {},
    ): Promise<null> =>
      ctx
        .runMutation(internal.c2b.logWebhookInternal, {
          orgId: undefined,
          route: "c2b-confirmation",
          transId: opts.transId,
          shortcode: opts.shortcode,
          outcome,
          detail: opts.detail,
          latencyMs: Date.now() - started,
        })
        .catch(() => null);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      await log("invalid-json");
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Invalid JSON body" },
        400,
      );
    }
    const str = (k: string): string | undefined => {
      const v = body[k];
      return typeof v === "string" ? v : undefined;
    };
    const transId = (str("TransID") ?? "").trim();
    const shortcode = (str("BusinessShortCode") ?? "").trim();
    const rawAmount = body["TransAmount"];
    const amount =
      typeof rawAmount === "number"
        ? Math.round(rawAmount)
        : Math.round(Number(rawAmount));
    if (transId === "" || transId.length > 64 || shortcode === "") {
      await log("bad-shape", { transId, shortcode });
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Missing TransID/ShortCode" },
        400,
      );
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      await log("bad-amount", { transId, shortcode });
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Bad TransAmount" },
        400,
      );
    }
    const msisdn = (str("MSISDN") ?? "").trim();
    if (msisdn === "") {
      await log("missing-msisdn", { transId, shortcode });
      return json(
        { ResultCode: "C2B00016", ResultDesc: "Missing MSISDN" },
        400,
      );
    }
    try {
      const res = await ctx.runMutation(internal.c2b.recordC2bInternal, {
        shortcode,
        transId,
        transAmount: amount,
        billRef: str("BillRefNumber"),
        msisdn,
        firstName: str("FirstName"),
        middleName: str("MiddleName"),
        lastName: str("LastName"),
        transTime: str("TransTime"),
        rawPayload: JSON.stringify(body).slice(0, 2000),
      });
      const outcome = res.deduplicated
        ? "duplicate"
        : res.status === "matched"
          ? "matched"
          : "pending-review";
      await log(outcome, {
        transId,
        shortcode,
        detail: `${amount} KES · ${str("BillRefNumber") ?? "no ref"}`,
      });
      return json({
        ResultCode: "0",
        ResultDesc:
          res.status === "matched"
            ? res.deduplicated
              ? "Duplicate acknowledged"
              : "Payment recorded"
            : "Received — pending review",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log("error", { transId, shortcode, detail: msg.slice(0, 200) });
      // Unknown shortcode: loud 404 so Daraja dashboards flag the misroute.
      if (/Unknown business shortcode/.test(msg)) {
        return json({ ResultCode: "C2B00011", ResultDesc: msg }, 404);
      }
      return json({ ResultCode: "C2B00016", ResultDesc: msg }, 400);
    }
  }),
});

/**
 * M-Pesa reversal notifications (C2B reversals + STK reversals). Safaricom
 * sends these when money is pulled back after a confirmation — without
 * this route a reversed payment would stay recorded forever. The handler
 * voids the linked ledger payment through the standard reversal path so
 * invoices and credit unwind exactly as a staff void would.
 */
http.route({
  path: "/stk-reversal",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/stk-reversal",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const started = Date.now();
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ResultCode: "C2B00016", ResultDesc: "Invalid JSON body" }, 400);
    }
    const str = (k: string): string | undefined => {
      const v = body[k];
      return typeof v === "string" ? v : undefined;
    };
    // Reversal payloads carry the ORIGINAL transaction id under a few
    // keys depending on channel — accept any of them.
    const transId = (
      str("OriginalTransactionID") ??
      str("TransID") ??
      str("ReceiptNumber") ??
      ""
    ).trim();
    if (transId === "" || transId.length > 64) {
      return json({ ResultCode: "C2B00016", ResultDesc: "Missing original TransID" }, 400);
    }
    try {
      const res = await ctx.runMutation(internal.c2b.reverseC2bInternal, {
        transId,
        reason: str("ResultDesc") ?? str("Remarks") ?? "Reversed by M-Pesa",
      });
      await ctx.runMutation(internal.c2b.logWebhookInternal, {
        orgId: res.orgId ?? undefined,
        route: "reversal",
        transId,
        outcome: res.outcome,
        detail: res.detail,
        latencyMs: Date.now() - started,
      });
      return json({ ResultCode: "0", ResultDesc: res.message });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ ResultCode: "C2B00016", ResultDesc: msg }, 400);
    }
  }),
});

/**
 * Generic Result/Timeout callbacks for outbound async jobs (Transaction
 * Status, Balance, Reversal, B2C/B2B, Tax, Pull). Daraja POSTs
 * {Result:{ResultType,ResultCode,ResultDesc,OriginatorConversationID,
 * ConversationID,...}} — we resolve by conversation id and flip the job
 * row. Paths are /async-result/:kind so one registration pattern covers
 * all eight families without banned words.
 */
const ASYNC_KINDS = [
  "txn_status",
  "balance",
  "reversal",
  "b2c",
  "topup",
  "b2b",
  "tax",
  "pull",
] as const;

for (const kind of ASYNC_KINDS) {
  http.route({
    path: `/async-result/${kind}`,
    method: "OPTIONS",
    handler: httpAction(async () => {
      return new Response("ok", { status: 200, headers: cors() });
    }),
  });
  http.route({
    path: `/async-timeout/${kind}`,
    method: "OPTIONS",
    handler: httpAction(async () => {
      return new Response("ok", { status: 200, headers: cors() });
    }),
  });
  const handleAsync = async (
    ctx: ActionCtx,
    req: Request,
    timedOut: boolean,
  ): Promise<Response> => {
    const started = Date.now();
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ResultCode: "C2B00016", ResultDesc: "Invalid JSON" }, 400);
    }
    const result = (body["Result"] ?? {}) as Record<string, unknown>;
    const str = (o: Record<string, unknown>, k: string): string | undefined => {
      const v = o[k];
      return typeof v === "string" ? v : undefined;
    };
    const originator =
      str(result, "OriginatorConversationID") ??
      str(body, "OriginatorConversationID");
    const conversation =
      str(result, "ConversationID") ?? str(body, "ConversationID");
    if (!originator && !conversation) {
      return json({ ResultCode: "C2B00016", ResultDesc: "Missing conversation id" }, 400);
    }
    const code = timedOut
      ? "timeout"
      : String(result["ResultCode"] ?? body["ResultCode"] ?? "-1");
    const desc =
      str(result, "ResultDesc") ?? str(body, "ResultDesc") ?? (timedOut ? "Queue timeout — poll Transaction Status" : undefined);
    const resolved = await ctx
      .runMutation(internal.darajaJobs.resolveJobByConversation, {
        originatorConversationId: originator,
        conversationId: conversation,
        resultCode: code,
        resultDesc: desc,
        rawResult: JSON.stringify(body).slice(0, 2000),
      })
      .catch(() => null);
    // Kind-specific side effects live in verify.ts/reconcile.ts via job
    // polling — the callback only flips the row + logs, never money moves.
    // (Exception: reversal completion auto-voids; B2C flips settlements.)
    if (resolved !== null && code === "0" && resolved.kind === "reversal") {
      await ctx
        .runMutation(internal.c2b.autoVoidOnReversalComplete, {
          jobId: resolved._id,
        })
        .catch(() => null);
    }
    if (resolved !== null && resolved.kind === "b2c") {
      const raw =
        typeof body["Result"] === "object" && body["Result"] !== null
          ? (body["Result"] as Record<string, unknown>)
          : {};
      const params = raw["ResultParameters"];
      let receipt: string | undefined;
      if (
        params !== null &&
        typeof params === "object" &&
        Array.isArray((params as { ResultParameter?: unknown }).ResultParameter)
      ) {
        for (const p of (params as { ResultParameter: Array<{ Name?: unknown; Value?: unknown }> }).ResultParameter) {
          if (p?.Name === "TransactionReceipt" && typeof p.Value === "string") {
            receipt = p.Value;
          }
        }
      }
      await ctx
        .runMutation(internal.payoutsInternal.settleB2cResult, {
          originatorConversationId: originator,
          conversationId: conversation,
          ok: code === "0",
          receipt,
        })
        .catch(() => null);
    }
    await ctx
      .runMutation(internal.c2b.logWebhookInternal, {
        orgId: resolved?.orgId ?? undefined,
        route: timedOut ? `async-timeout/${kind}` : `async-result/${kind}`,
        transId: originator ?? conversation,
        outcome: resolved === null ? "unknown-job" : code === "0" ? "done" : "failed",
        detail: desc?.slice(0, 200),
        latencyMs: Date.now() - started,
      })
      .catch(() => null);
    return json({ ResultCode: "0", ResultDesc: "Acknowledged" });
  };
  http.route({
    path: `/async-result/${kind}`,
    method: "POST",
    handler: httpAction(async (ctx, req) => handleAsync(ctx, req, false)),
  });
  http.route({
    path: `/async-timeout/${kind}`,
    method: "POST",
    handler: httpAction(async (ctx, req) => handleAsync(ctx, req, true)),
  });
}

/**
 * Bill Manager payment callback: Safaricom POSTs
 * {transactionId, paidAmount, msisdn (FULL), dateCreated,
 * accountReference, shortCode} and retries 5× until acknowledged.
 * Ingest dedupes by transactionId, reconciles through the ledger, and we
 * acknowledge so Safaricom sends the tenant the e-receipt.
 */
http.route({
  path: "/billmanager-callback",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/billmanager-callback",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const started = Date.now();
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const str = (k: string): string | undefined => {
      const v = body[k];
      return typeof v === "string" ? v : undefined;
    };
    const transactionId = (str("transactionId") ?? "").trim();
    const shortCode = (str("shortCode") ?? "").trim();
    const rawAmount = body["paidAmount"];
    const amount =
      typeof rawAmount === "number"
        ? Math.round(rawAmount)
        : Math.round(Number(rawAmount));
    const msisdn = (str("msisdn") ?? "").trim();
    if (transactionId === "" || shortCode === "" || msisdn === "") {
      return json({ error: "Missing transactionId/shortCode/msisdn" }, 400);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "Bad paidAmount" }, 400);
    }
    try {
      const res = await ctx.runMutation(
        internal.billManagerInternal.ingestPayment,
        {
          shortcode: shortCode,
          transactionId,
          paidAmount: amount,
          msisdn,
          accountReference: str("accountReference"),
          dateCreated: str("dateCreated"),
        },
      );
      await ctx
        .runMutation(internal.c2b.logWebhookInternal, {
          orgId: undefined,
          route: "billmanager-callback",
          transId: transactionId,
          shortcode: shortCode,
          outcome: res.deduplicated ? "duplicate" : res.status,
          detail: `${amount} KES · ${str("accountReference") ?? "no ref"}`,
          latencyMs: Date.now() - started,
        })
        .catch(() => null);
      // Docs step 3: POST the reconciliation acknowledgment so Safaricom
      // sends the tenant the e-receipt. Best-effort — the ledger write
      // above already committed, so an ack failure only logs (the money
      // stays recorded; staff can re-ack from the receipt page later).
      // httpAction ctx has no runAction, so the POST goes through the
      // exported billManagerPost helper inline.
      let acked: string | undefined;
      if (res.ack !== undefined && !res.deduplicated) {
        try {
          // httpAction ctx is action-capable (fetch + runQuery/runMutation),
          // so mint the token and read creds inline — no helper needed.
          const creds = await ctx.runMutation(
            internal.mpesaInternal.getDecryptedCreds,
            { orgId: res.ack.orgId },
          );
          if (creds === null) throw new Error("Save Daraja credentials first");
          const appKey = await ctx.runQuery(
            internal.billManagerInternal.getAppKey,
            { orgId: res.ack.orgId },
          );
          if (appKey === null) throw new Error("Bill Manager is not opted in");
          const base = darajaBase(creds.environment);
          const token = await cachedDarajaToken(ctx, res.ack.orgId, creds);
          const ackRes = await billManagerPost(
            base,
            token,
            appKey,
            "v1/billmanager-invoice/reconciliation",
            {
              paymentDate: res.ack.paymentDate,
              paidAmount: String(res.ack.paidAmount),
              accountReference: res.ack.accountReference,
              transactionId: res.ack.transactionId,
              phoneNumber: res.ack.phoneNumber,
              fullName: res.ack.fullName,
              invoiceName: res.ack.invoiceName,
              externalReference: res.ack.externalReference,
            },
            "Bill Manager",
          );
          acked = `HTTP ${ackRes.status}: ${ackRes.body.slice(0, 120)}`;
          if (ackRes.status < 200 || ackRes.status >= 300) {
            throw new Error(acked);
          }
        } catch (e) {
          acked = undefined;
          await ctx
            .runMutation(internal.c2b.logWebhookInternal, {
              orgId: res.ack.orgId,
              route: "billmanager-callback",
              transId: transactionId,
              shortcode: shortCode,
              outcome: "ack-failed",
              detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
            })
            .catch(() => null);
        }
      }
      return json({ acknowledged: true, status: res.status, acked });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, /Unknown business shortcode/.test(msg) ? 404 : 400);
    }
  }),
});

/**
 * C2B Hakikisha host (REVERSED direction — Safaricom calls US after
 * apisupport onboarding + reciprocal B2C Hakikisha contract):
 *  - POST /hakikisha-token: mint a token for Safaricom's notify calls.
 *  - POST /hakikisha-notify {accountNumber, shortcode}: return
 *    {accountName} shown to the payer pre-confirm on STK/USSD/app.
 * Typos die at source; the review queue shrinks to phone-only cases.
 */
http.route({
  path: "/hakikisha-token",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/hakikisha-token",
  method: "POST",
  handler: httpAction(async () => {
    // Token contract is whatever apisupport provisions at onboarding;
    // acknowledge with a timestamped opaque token.
    return json({
      access_token: `kodi-hk-${Date.now().toString(36)}`,
      expires_in: "3599",
    });
  }),
});

http.route({
  path: "/hakikisha-notify",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/hakikisha-notify",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ accountName: "" }, 400);
    }
    const account = String(
      body["accountNumber"] ?? body["BillRefNumber"] ?? "",
    ).trim().toUpperCase();
    const shortcode = String(
      body["shortcode"] ?? body["BusinessShortCode"] ?? "",
    ).trim();
    if (account === "" || shortcode === "") {
      return json({ accountName: "" }, 400);
    }
    const name = await ctx
      .runQuery(internal.hakikishaInternal.lookupAccountName, {
        shortcode,
        account,
      })
      .catch(() => null);
    if (name === null) return json({ accountName: "" }, 404);
    return json({ accountName: name });
  }),
});

/**
 * Pull Transactions callback stubs. The query path used here is
 * synchronous polling (pullC2bWindow), but one-time registration sends
 * these URLs — they acknowledge + log so Daraja never sees a dead hook.
 */
for (const p of ["/pull-result", "/pull-timeout"]) {
  http.route({
    path: p,
    method: "OPTIONS",
    handler: httpAction(async () => {
      return new Response("ok", { status: 200, headers: cors() });
    }),
  });
  http.route({
    path: p,
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      const raw = await req.text().catch(() => "");
      await ctx
        .runMutation(internal.c2b.logWebhookInternal, {
          orgId: undefined,
          route: p.slice(1),
          outcome: "ack",
          detail: raw.slice(0, 200),
        })
        .catch(() => null);
      return json({ ResultCode: "0", ResultDesc: "Acknowledged" });
    }),
  });
}

export default http;
