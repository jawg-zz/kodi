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
 * Public M-Pesa STK callback (Safaricom cannot send auth headers).
 * The CheckoutRequestID is an unguessable capability linking the callback
 * to a pending row. Idempotent: retried success callbacks dedupe.
 */
http.route({
  path: "/mpesa-callback",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response("ok", { status: 200, headers: cors() });
  }),
});

http.route({
  path: "/mpesa-callback",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
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
      return json({ error: "Invalid JSON body" }, 400);
    }
    const cb = body.Body?.stkCallback;
    if (
      cb?.CheckoutRequestID === undefined ||
      typeof cb.CheckoutRequestID !== "string"
    ) {
      return json({ error: "Missing CheckoutRequestID" }, 400);
    }
    if (cb.CheckoutRequestID.length > 128) {
      return json({ error: "Bad CheckoutRequestID" }, 400);
    }
    const tx = await ctx.runMutation(internal.mpesaInternal.getTxByCheckout, {
      checkoutRequestId: cb.CheckoutRequestID,
    });
    if (tx === null) {
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
    const paidAmount =
      typeof meta["Amount"] === "number"
        ? Math.round(meta["Amount"] as number)
        : tx.amount;

    if (code === 0) {
      if (tx.status === "success" && tx.paymentId !== undefined) {
        return json({ ok: true, deduplicated: true });
      }
      try {
        const paymentId = await ctx.runMutation(
          internal.payments.internalRecordStkPayment,
          {
            orgId: tx.orgId,
            tenantId: tx.tenantId,
            amount: paidAmount,
            mpesaCode: receipt,
            paidAt: Date.now(),
          },
        );
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: cb.CheckoutRequestID,
          status: "success",
          resultCode: code,
          resultDesc: cb.ResultDesc,
          mpesaReceipt: receipt,
          paymentId,
        });
        return json({ ok: true, paymentId });
      } catch (e) {
        await ctx.runMutation(internal.mpesaInternal.updateTx, {
          checkoutRequestId: cb.CheckoutRequestID,
          status: "failed",
          resultCode: code,
          resultDesc: `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
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
    return json({ ok: true, status });
  }),
});

export default http;
