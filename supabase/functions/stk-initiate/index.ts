// stk-initiate — authenticated staff OR the tenant themselves. Validates the
// org's Daraja credentials, sends an STK Push, and stores a pending row in
// mpesa_transactions. Actual money movement is confirmed via mpesa-callback.

import {
  darajaBase,
  darajaTimestamp,
  decryptSecret,
  errorResponse,
  jsonResponse,
  normalizePhone,
  resolveCaller,
  sbFetch,
  stkPassword,
  handleOptions } from "../_shared/mod.ts";

async function darajaToken(base: string, key: string, secret: string): Promise<string> {
  const res = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: "Basic " + btoa(`${key}:${secret}`) } }
  );
  if (!res.ok) throw new Error(`Daraja OAuth failed (${res.status}) — check consumer key/secret`);
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

  let body: { tenantId?: string; phone?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const tenantId = body.tenantId ?? "";
  const phone = normalizePhone(body.phone ?? "");
  const amount = Math.round(Number(body.amount));
  if (!tenantId) return errorResponse("tenantId is required");
  if (!phone) return errorResponse("A valid Safaricom number is required");
  if (!Number.isFinite(amount) || amount < 1) return errorResponse("Amount must be at least KES 1");

  // Tenants may only pay for themselves.
  if (caller.role === "tenant" && caller.tenantId !== tenantId) {
    return errorResponse("You can only pay your own rent", 403);
  }

  // Tenant must belong to the caller's org.
  const t = await sbFetch("tenants", {
    params: { id: `eq.${tenantId}`, org_id: `eq.${caller.orgId}`, select: "id,org_id" },
  });
  if (!t.ok || ((t.data ?? []) as unknown[]).length === 0) {
    return errorResponse("Tenant not found in your organization", 404);
  }

  // Org credentials.
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
  if (!creds?.consumer_key_enc) {
    return errorResponse("M-Pesa is not configured for this business. Add Daraja credentials in Settings.", 409);
  }

  let key: string, secret: string, passkey: string;
  try {
    [key, secret, passkey] = await Promise.all([
      decryptSecret(creds.consumer_key_enc),
      decryptSecret(creds.consumer_secret_enc),
      decryptSecret(creds.passkey_enc),
    ]);
  } catch {
    return errorResponse("Could not decrypt M-Pesa credentials — check CREDENTIALS_KEY", 500);
  }

  const base = darajaBase(creds.environment);
  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mpesa-callback`;
  try {
    const token = await darajaToken(base, key, secret);
    const timestamp = darajaTimestamp();
    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: creds.shortcode,
        Password: stkPassword(creds.shortcode, passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: creds.shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: tenantId.slice(0, 12),
        TransactionDesc: "Rent payment",
      }),
    });
    const stk = (await stkRes.json()) as {
      ResponseCode?: string;
      ResponseDescription?: string;
      CheckoutRequestID?: string;
      MerchantRequestID?: string;
    };
    if (stk.ResponseCode !== "0" || !stk.CheckoutRequestID) {
      return errorResponse(stk.ResponseDescription ?? "STK Push was rejected by Daraja", 502);
    }

    await sbFetch("mpesa_transactions", {
      method: "POST",
      body: {
        org_id: caller.orgId,
        tenant_id: tenantId,
        checkout_request_id: stk.CheckoutRequestID,
        merchant_request_id: stk.MerchantRequestID ?? null,
        phone,
        amount,
        status: "pending",
        initiated_by: caller.userId,
      },
    });

    return jsonResponse({ checkoutRequestId: stk.CheckoutRequestID });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "STK Push failed", 502);
  }
});
