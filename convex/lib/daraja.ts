import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

export const DARAJA_SANDBOX = "https://sandbox.safaricom.co.ke";
export const DARAJA_PROD = "https://api.safaricom.co.ke";

/**
 * Refresh the cached token this far before Daraja's 3600s expiry, so a
 * token can never die mid-request and concurrent actions never race a
 * last-second mint.
 */
export const TOKEN_SKEW_MS = 120_000;
/** Assumed lifetime when Daraja omits `expires_in` from the token reply. */
export const TOKEN_TTL_FALLBACK_MS = 3_500_000;

export type DarajaEnv = "sandbox" | "production";

export function darajaBase(environment: DarajaEnv): string {
  return environment === "production" ? DARAJA_PROD : DARAJA_SANDBOX;
}

/** Pure freshness check: is the cached token still usable at `now`? */
export function isTokenFresh(expiresAt: number, now = Date.now()): boolean {
  return Number.isFinite(expiresAt) && expiresAt - TOKEN_SKEW_MS > now;
}

export type MintCreds = {
  environment: DarajaEnv;
  consumerKey: string;
  consumerSecret: string;
};

/**
 * Shared Daraja OAuth token, cached per org on the mpesaCredentials row
 * (AES-GCM encrypted, same key as the credentials).
 *
 * Daraja invalidates the previous token on every mint, so minting per call
 * makes parallel actions kill each other's tokens (stkInitiate + stkStatus
 * + registerC2bUrls racing = mystery 404.001.03s). Every action goes
 * through here: a fresh-enough cached token is reused, otherwise one mint
 * refreshes the row. A residual race remains when two actions both see a
 * stale token at the same instant — acceptable: it only happens at the
 * hourly boundary instead of on every call.
 */
export async function cachedDarajaToken(
  ctx: ActionCtx,
  orgId: Id<"orgs">,
  creds: MintCreds,
): Promise<string> {
  const cached = await ctx.runQuery(
    internal.mpesaInternal.getCachedDarajaToken,
    { orgId },
  );
  if (cached !== null && isTokenFresh(cached.expiresAt)) return cached.token;
  const base = darajaBase(creds.environment);
  const res = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: "Basic " + btoa(`${creds.consumerKey}:${creds.consumerSecret}`),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    throw new ConvexError(
      `Daraja OAuth failed (${res.status}) — check consumer key/secret`,
    );
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: string | number;
  };
  if (!data.access_token) {
    throw new ConvexError("Daraja did not return an access token");
  }
  const ttlSec = Number(data.expires_in);
  const ttlMs =
    Number.isFinite(ttlSec) && ttlSec > 60
      ? Math.round(ttlSec * 1000)
      : TOKEN_TTL_FALLBACK_MS;
  await ctx.runMutation(internal.mpesaInternal.storeCachedDarajaToken, {
    orgId,
    token: data.access_token,
    expiresAt: Date.now() + ttlMs,
  });
  return data.access_token;
}
