// stk-status — authenticated poll fallback. Queries Daraja stkpushquery for a
// pending transaction and mirrors the result into mpesa_transactions (and the
// ledger on success). Staff see their org's rows; tenants only their own.

import {
  darajaBase,
  darajaTimestamp,
  decryptSecret,
  errorResponse,
  jsonResponse,
  resolveCaller,
  sbFetch,
  sbRpc,
  stkPassword,
  handleOptions } from "../_shared/mod.ts";

async function darajaToken(base: string, key: string, secret: string): Promise<string> {
  const res = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: "Basic " + btoa(`${key}:${secret}`) } }
  );
  if (!res.ok) throw new Error(`Daraja OAuth failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Daraja did not return an access token");
  return data.access_token;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  const caller = await resolveCaller(req);
  if (caller instanceof Response) return caller;

  let body: { checkoutRequestId?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }
  if (!body.checkoutRequestId) return errorResponse("checkoutRequestId is required");

  const txRes = await sbFetch("mpesa_transactions", {
    params: { checkout_request_id: `eq.${body.checkoutRequestId}`, select: "*" },
  });
  const tx = ((txRes.data ?? []) as {
    id: string;
    org_id: string;
    tenant_id: string;
    amount: number;
    status: string;
    checkout_request_id: string;
    merchant_request_id: string | null;
    phone: string;
    result_code: number | null;
    result_desc: string | null;
    mpesa_receipt: string | null;
    payment_id: string | null;
  }[])[0];
  if (!tx || tx.org_id !== caller.orgId) return errorResponse("Transaction not found", 404);
  if (caller.role === "tenant" && caller.tenantId !== tx.tenant_id) {
    return errorResponse("Transaction not found", 404);
  }
  // Sweep stale pendings on every poll so the UI stops watching dead rows.
  await sbRpc("expire_pending_transactions", {});
  if (tx.status !== "pending") {
    const refetch = await sbFetch("mpesa_transactions", {
      params: { checkout_request_id: `eq.${body.checkoutRequestId}`, select: "*" },
    });
    return jsonResponse((((refetch.data ?? []) as unknown[])[0] ?? tx) as unknown);
  }

  const c = await sbFetch("mpesa_credentials", {
    params: { org_id: `eq.${caller.orgId}`, select: "environment,consumer_key_enc,consumer_secret_enc,shortcode,passkey_enc" },
  });
  const creds = ((c.data ?? []) as {
    environment: string;
    consumer_key_enc: string;
    consumer_secret_enc: string;
    shortcode: string;
    passkey_enc: string;
  }[])[0];
  if (!creds?.consumer_key_enc) return jsonResponse(tx); // not configured; keep cached state

  try {
    const [key, secret, passkey] = await Promise.all([
      decryptSecret(creds.consumer_key_enc),
      decryptSecret(creds.consumer_secret_enc),
      decryptSecret(creds.passkey_enc),
    ]);
    const base = darajaBase(creds.environment);
    const token = await darajaToken(base, key, secret);
    const timestamp = darajaTimestamp();
    const q = await fetch(`${base}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: stkPassword(creds.shortcode, passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: tx.checkout_request_id,
      }),
    });
    const data = (await q.json()) as { ResultCode?: string; ResultDesc?: string };
    const code = String(data.ResultCode ?? "");

    if (code === "0") {
      // Success confirmed via query (callback may still arrive — it dedupes).
      if (!tx.payment_id) {
        const pay = await sbRpc("record_payment", {
          p_org: tx.org_id,
          p_tenant: tx.tenant_id,
          p_amount: tx.amount,
          p_method: "mpesa_stk",
          p_mpesa_code: tx.mpesa_receipt,
          p_paid_at: new Date().toISOString(),
          p_note: "M-Pesa STK Push",
          p_recorded_by: null,
        });
        if (pay.ok) {
          await sbFetch("mpesa_transactions", {
            method: "PATCH",
            params: { checkout_request_id: `eq.${tx.checkout_request_id}` },
            body: { status: "success", result_code: 0, result_desc: data.ResultDesc ?? null, payment_id: pay.data },
          });
        }
      }
    } else if (code === "1032") {
      // User pressed "Cancel" on the handset — definitive failure.
      await sbFetch("mpesa_transactions", {
        method: "PATCH",
        params: { checkout_request_id: `eq.${tx.checkout_request_id}` },
        body: { status: "failed", result_code: 1032, result_desc: data.ResultDesc ?? null },
      });
    } else if (code === "1037") {
      // Handset unreachable / DS timeout — no callback will arrive.
      await sbFetch("mpesa_transactions", {
        method: "PATCH",
        params: { checkout_request_id: `eq.${tx.checkout_request_id}` },
        body: { status: "timeout", result_code: 1037, result_desc: data.ResultDesc ?? null },
      });
    } else if (code && code !== "0") {
      // Anything else ("still under processing", 9999, empty) is NOT final.
      // Keep pending so the UI keeps polling; the 30-min expiry sweeps dead
      // rows and the callback records success. Surface Daraja's latest note.
      await sbFetch("mpesa_transactions", {
        method: "PATCH",
        params: { checkout_request_id: `eq.${tx.checkout_request_id}` },
        body: { result_code: Number(code) || null, result_desc: data.ResultDesc ?? null },
      });
    }
  } catch {
    // Daraja unreachable — return cached row; frontend keeps polling.
  }

  const fresh = await sbFetch("mpesa_transactions", {
    params: { checkout_request_id: `eq.${body.checkoutRequestId}`, select: "*" },
  });
  return jsonResponse((((fresh.data ?? []) as unknown[])[0] ?? tx) as unknown);
});
