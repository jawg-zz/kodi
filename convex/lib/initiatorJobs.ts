import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { cachedDarajaToken, darajaBase } from "./daraja";
import { mintSecurityCredential } from "./initiator";

/**
 * Shared plumbing for every initiator-credential Daraja API (Transaction
 * Status, Balance, Reversal, B2C/B2B, Tax, Pull): credential bundle,
 * async POST with Result/Timeout URLs, EndpointCandidates 404 fallback,
 * darajaJobs row lifecycle. Sync APIs (Bonga, QR, KYC, Hakikisha) use the
 * bundle + postDaraja directly and skip the job row.
 *
 * Endpoint families: Daraja 3.0 renamed several paths (e.g. c2b v1→v2,
 * b2c v1→v3). The map below carries the documented path first, then the
 * older family path; postCandidates tries each in order and only falls
 * through on HTTP 404 (wrong path), surfacing every other Daraja error
 * verbatim. Candidate probing costs at most one extra 404 per org per
 * API family — cached implicitly because the first success wins and later
 * calls try the winner first.
 */

export type InitiatorBundle = {
  orgId: Id<"orgs">;
  environment: "sandbox" | "production";
  base: string;
  token: string;
  shortcode: string;
  initiatorName: string;
  credential: string;
  siteBase: string;
};

/** Load + decrypt everything an initiator call needs, or throw. */
export async function initiatorBundle(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
  siteBase: string,
): Promise<InitiatorBundle> {
  const creds = await ctx.runMutation(
    internal.mpesaInternal.getDecryptedCreds,
    { orgId },
  );
  if (creds === null) {
    throw new ConvexError(
      "M-Pesa is not configured for this business. Add Daraja credentials in Settings.",
    );
  }
  const init = await ctx.runMutation(
    internal.mpesaInternal.getDecryptedInitiator,
    { orgId },
  );
  if (init === null) {
    throw new ConvexError(
      "Initiator credentials are not set — owner: Settings → Initiator & payouts.",
    );
  }
  return {
    orgId,
    environment: creds.environment,
    base: darajaBase(creds.environment),
    token: await cachedDarajaToken(ctx, orgId, creds),
    shortcode: creds.shortcode,
    initiatorName: init.initiatorName,
    credential: mintSecurityCredential(
      init.initiatorPassword,
      init.initiatorCertPem,
    ),
    siteBase,
  };
}

export type JobKind =
  | "txn_status"
  | "balance"
  | "reversal"
  | "b2c"
  | "topup"
  | "b2b"
  | "tax"
  | "pull";

export function conversationId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`.slice(
    0,
    64,
  );
}

/** Result/Timeout URLs for one async job (paths avoid banned words). */
export function jobUrls(siteBase: string, kind: JobKind): {
  resultUrl: string;
  timeoutUrl: string;
} {
  return {
    resultUrl: `${siteBase}/async-result/${kind}`,
    timeoutUrl: `${siteBase}/async-timeout/${kind}`,
  };
}

type PostResult = {
  responseCode: string;
  responseDescription?: string;
  conversationId?: string;
  originatorConversationId?: string;
  body: string;
};

/**
 * POST a JSON body to the first candidate path that isn't a 404.
 * Returns the parsed envelope. Throws ConvexError with Daraja's own
 * message for every non-404 failure (auth, validation, spike arrest…).
 */
export async function postCandidates(
  bundle: InitiatorBundle,
  candidates: string[],
  payload: Record<string, unknown>,
  label: string,
): Promise<PostResult> {
  let last404 = "";
  for (const path of candidates) {
    const res = await fetch(`${bundle.base}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bundle.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (res.status === 404) {
      last404 = raw.slice(0, 160);
      continue;
    }
    // The gateway's product errors ("no apiproduct match") don't follow
    // the ResponseCode JSON envelope — sometimes not JSON at all. Check
    // the raw body first so these portal-fix failures never surface as a
    // confusing parse error or "Invalid Access Token" trace.
    if (/no apiproduct match/i.test(raw.slice(0, 500))) {
      throw new ConvexError(
        `${label}: your Daraja app isn't subscribed to this API product — open the app at developer.safaricom.co.ke, subscribe it to the ${label} product, then retry. Keys and shortcode are fine.`,
      );
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Non-JSON with a 2xx is a bare success acknowledgement (some
      // sync endpoints return plain text) — accept it as code "0".
      if (res.status >= 200 && res.status < 300) {
        return {
          responseCode: "0",
          responseDescription: raw.slice(0, 200),
          conversationId: undefined,
          originatorConversationId: undefined,
          body: raw.slice(0, 2000),
        };
      }
      throw new ConvexError(
        `${label} rejected (HTTP ${res.status}) with a non-JSON reply: ${raw.slice(0, 200)}`,
      );
    }
    const code = String(data["ResponseCode"] ?? data["responseCode"] ?? "");
    // JSON without any response code on a 2xx is also a bare success
    // (e.g. `{app_key: ...}` opt-in bodies) — don't demand a "0".
    if (code === "" && res.status >= 200 && res.status < 300) {
      return {
        responseCode: "0",
        responseDescription: "",
        conversationId: undefined,
        originatorConversationId: undefined,
        body: raw.slice(0, 2000),
      };
    }
    if (code !== "0") {
      const desc = String(
        data["ResponseDescription"] ??
          data["responseDescription"] ??
          data["errorMessage"] ??
          raw.slice(0, 300),
      );
      if (/no apiproduct match/i.test(`${desc} ${raw.slice(0, 300)}`)) {
        throw new ConvexError(
          `${label}: your Daraja app isn't subscribed to this API product — open the app at developer.safaricom.co.ke, subscribe it to the ${label} product, then retry. Keys and shortcode are fine.`,
        );
      }
      // TEMP-DEBUG: include the raw body so the gateway's actual field
      // shape is visible in the UI error. Remove once parsed.
      throw new ConvexError(
        `${label} said no (${code || `HTTP ${res.status}`}): ${desc} | raw: ${raw.slice(0, 300)}`,
      );
    }
    const conv = data["ConversationID"] ?? data["OriginatorConversationID"];
    return {
      responseCode: code,
      responseDescription: String(data["ResponseDescription"] ?? ""),
      conversationId:
        typeof conv === "string" && conv !== "" ? conv : undefined,
      originatorConversationId:
        typeof data["OriginatorConversationID"] === "string"
          ? (data["OriginatorConversationID"] as string)
          : undefined,
      body: raw.slice(0, 2000),
    };
  }
  throw new ConvexError(
    `${label}: no known endpoint path answered (all 404) — ${last404 || "check the Daraja catalogue for a renamed path"}`,
  );
}

/**
 * Fire an async initiator job: open the darajaJobs row, POST with
 * ResultURL/QueueTimeOutURL, record the accepted conversation id, and
 * webhook-log the outcome. The result callback (http.ts) flips the row.
 * Sync-response APIs should call postCandidates directly instead.
 */
export async function fireAsyncJob(
  ctx: ActionCtx,
  bundle: InitiatorBundle,
  opts: {
    kind: JobKind;
    candidates: string[];
    payload: Record<string, unknown>;
    label: string;
    summary: string;
    tenantId?: Id<"tenants">;
    paymentId?: Id<"payments">;
    amount?: number;
  },
): Promise<{ conversationId: string; jobId: Id<"darajaJobs"> }> {
  const conv = conversationId(
    { txn_status: "TXS", balance: "BAL", reversal: "REV", b2c: "B2C", topup: "TOP", b2b: "B2B", tax: "TAX", pull: "PULL" }[opts.kind],
  );
  const { resultUrl, timeoutUrl } = jobUrls(bundle.siteBase, opts.kind);
  const jobId: Id<"darajaJobs"> = await ctx.runMutation(
    internal.darajaJobs.openJob,
    {
      orgId: bundle.orgId,
      kind: opts.kind,
      conversationId: conv,
      summary: opts.summary,
      tenantId: opts.tenantId,
      paymentId: opts.paymentId,
      amount: opts.amount,
    },
  );
  try {
    const res = await postCandidates(bundle, opts.candidates, {
      ...opts.payload,
      OriginatorConversationID: conv,
      ResultURL: resultUrl,
      QueueTimeOutURL: timeoutUrl,
    }, opts.label);
    await ctx.runMutation(internal.darajaJobs.markJobAccepted, {
      jobId,
      darajaConversationId: res.conversationId,
    });
    await ctx.runMutation(internal.c2b.logWebhookInternal, {
      orgId: bundle.orgId,
      route: `out-${opts.kind}`,
      transId: conv,
      outcome: "accepted",
      detail: `${opts.label}: ${res.responseDescription ?? "accepted"}`.slice(0, 200),
    });
    return { conversationId: conv, jobId };
  } catch (e) {
    await ctx.runMutation(internal.darajaJobs.markJobFailed, {
      jobId,
      resultDesc: e instanceof Error ? e.message.slice(0, 500) : String(e),
    });
    throw e;
  }
}
