// mpesa-credentials — staff-only get/save of the org's Daraja credentials.
// Secrets are AES-GCM encrypted with CREDENTIALS_KEY before storage; the
// table itself has no client RLS access at all.

import {
  decryptSecret,
  encryptSecret,
  errorResponse,
  jsonResponse,
  resolveCaller,
  sbFetch,
} from "../_shared/mod.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  const caller = await resolveCaller(req);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner" && caller.role !== "manager") {
    return errorResponse("Only staff can manage M-Pesa credentials", 403);
  }

  let body: { action?: string } & Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  if (body.action === "get") {
    const r = await sbFetch("mpesa_credentials", {
      params: { org_id: `eq.${caller.orgId}`, select: "environment,shortcode,consumer_key_enc" },
    });
    const rows = (r.data ?? []) as { environment: string; shortcode: string; consumer_key_enc: string }[];
    if (rows.length === 0) {
      return jsonResponse({ configured: false, environment: "sandbox", shortcode: "" });
    }
    return jsonResponse({
      configured: Boolean(rows[0].consumer_key_enc),
      environment: rows[0].environment,
      shortcode: rows[0].shortcode,
    });
  }

  if (body.action === "save") {
    const environment = body.environment === "production" ? "production" : "sandbox";
    const consumerKey = (body.consumerKey ?? "").trim();
    const consumerSecret = (body.consumerSecret ?? "").trim();
    const shortcode = (body.shortcode ?? "").trim();
    const passkey = (body.passkey ?? "").trim();
    if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
      return errorResponse("consumerKey, consumerSecret, shortcode and passkey are all required");
    }
    if (!/^\d{5,7}$/.test(shortcode)) return errorResponse("Shortcode must be 5–7 digits");
    try {
      const payload = {
        org_id: caller.orgId,
        environment,
        consumer_key_enc: await encryptSecret(consumerKey),
        consumer_secret_enc: await encryptSecret(consumerSecret),
        shortcode,
        passkey_enc: await encryptSecret(passkey),
      };
      const r = await sbFetch("mpesa_credentials", { method: "POST", body: payload });
      if (!r.ok) {
        // Row exists → update.
        const u = await sbFetch("mpesa_credentials", {
          method: "PATCH",
          params: { org_id: `eq.${caller.orgId}` },
          body: payload,
        });
        if (!u.ok) return errorResponse("Could not save credentials", 500);
      }
      void decryptSecret;
      return jsonResponse({ ok: true });
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Encryption failed", 500);
    }
  }

  return errorResponse("action must be 'get' or 'save'");
});
