// mpesa-callback — PUBLIC endpoint called by Safaricom with the STK result.
// No Authorization header (Safaricom can't send one); the CheckoutRequestID
// is an unguessable capability linking the callback to a pending row.
// On success: record_payment() allocates FIFO and creates the ledger row.

import { errorResponse, jsonResponse, sbFetch, sbRpc } from "../_shared/mod.ts";

interface CallbackItem {
  Name: string;
  Value?: string | number;
}
interface StkCallback {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number;
  ResultDesc?: string;
  CallbackMetadata?: { Item?: CallbackItem[] };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  let body: { Body?: { stkCallback?: StkCallback } };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }
  const cb = body.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return errorResponse("Missing CheckoutRequestID");

  const txRes = await sbFetch("mpesa_transactions", {
    params: { checkout_request_id: `eq.${cb.CheckoutRequestID}`, select: "*" },
  });
  const tx = ((txRes.data ?? []) as {
    id: string;
    org_id: string;
    tenant_id: string;
    amount: number;
    status: string;
    payment_id: string | null;
  }[])[0];
  if (!tx) return errorResponse("Unknown transaction", 404);

  const code = Number(cb.ResultCode ?? -1);
  const items = cb.CallbackMetadata?.Item ?? [];
  const meta = Object.fromEntries(items.map((i) => [i.Name, i.Value]));
  const receipt = typeof meta["MpesaReceiptNumber"] === "string" ? meta["MpesaReceiptNumber"] : null;
  const paidAmount = typeof meta["Amount"] === "number" ? Math.round(meta["Amount"]) : tx.amount;

  if (code === 0) {
    // Idempotent: Safaricom may retry callbacks.
    if (tx.status === "success" && tx.payment_id) {
      return jsonResponse({ ok: true, deduplicated: true });
    }
    const pay = await sbRpc("record_payment", {
      p_org: tx.org_id,
      p_tenant: tx.tenant_id,
      p_amount: paidAmount,
      p_method: "mpesa_stk",
      p_mpesa_code: receipt,
      p_paid_at: new Date().toISOString(),
      p_note: "M-Pesa STK Push",
      p_recorded_by: null,
    });
    if (!pay.ok) {
      await sbFetch("mpesa_transactions", {
        method: "PATCH",
        params: { checkout_request_id: `eq.${cb.CheckoutRequestID}` },
        body: { status: "failed", result_code: code, result_desc: `Reconcile failed: ${JSON.stringify(pay.data)}` },
      });
      return errorResponse("Payment received but ledger write failed — flagged for review", 500);
    }
    await sbFetch("mpesa_transactions", {
      method: "PATCH",
      params: { checkout_request_id: `eq.${cb.CheckoutRequestID}` },
      body: {
        status: "success",
        result_code: code,
        result_desc: cb.ResultDesc ?? null,
        mpesa_receipt: receipt,
        payment_id: pay.data,
      },
    });
    return jsonResponse({ ok: true, paymentId: pay.data });
  }

  // Cancelled / failed / timed-out on the phone.
  const status = code === 1032 ? "failed" : code === 1037 ? "timeout" : "failed";
  await sbFetch("mpesa_transactions", {
    method: "PATCH",
    params: { checkout_request_id: `eq.${cb.CheckoutRequestID}` },
    body: { status, result_code: code, result_desc: cb.ResultDesc ?? null },
  });
  return jsonResponse({ ok: true, status });
});
