/**
 * Backend JWT verification config — Logto OIDC (self-hosted).
 *
 * Identity: https://logtoend.spidmax.win/oidc (standard OIDC discovery at
 * https://logtoend.spidmax.win/oidc/.well-known/openid-configuration,
 * JWKS at https://logtoend.spidmax.win/oidc/jwks).
 *
 * NOTE — admin vs core hosts: the admin console lives at logto.spidmax.win
 * but the tenant's OIDC (issuer, JWKS, tokens) is served from the CORE host
 * logtoend.spidmax.win. The verifier MUST point at the core host; the admin
 * host's JWKS serves a different (stale EC) key and verification fails.
 *
 * Convex verifies the ID token's iss/aud/signature against this and exposes
 * it as ctx.auth.getUserIdentity(). Only identity.subject is consumed (see
 * convex/lib/auth.ts); email is read in the invite-claim path
 * (convex/invites.ts); name/phone come from the profile and invite flows,
 * not the token.
 *
 * Signing key requirement: Convex customJwt accepts RS256 or ES256 only.
 * Logto ships with an EC P-384 (ES384) key, so the instance MUST be rotated
 * to an RSA key first (see docs/logto-runbook.md §3) — otherwise every
 * authenticated call fails signature verification.
 *
 * Hard cutover from Zitadel OIDC: the old provider is gone. Old
 * subject-keyed rows are orphaned; everyone re-registers in Logto.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://logtoend.spidmax.win/oidc",
      jwks: "https://logtoend.spidmax.win/oidc/jwks",
      algorithm: "RS256",
      applicationID: "1n1zuedqyc7yptyd44ih1",
    },
  ],
};
