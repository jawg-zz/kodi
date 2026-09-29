import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

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

    const status = code === 1032 ? "failed" : code === 1037 ? "timeout" : "failed";
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
  handler: httpAction(async (_ctx, req) => {
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
    return json({ ResultCode: "0", ResultDesc: "Accepted" });
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

export default http;
