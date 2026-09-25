/**
 * Backend JWT verification config — Logto OIDC (self-hosted).
 *
 * Identity: https://logto.spidmax.win/oidc (standard OIDC discovery at
 * https://logto.spidmax.win/oidc/.well-known/openid-configuration,
 * JWKS at https://logto.spidmax.win/oidc/jwks).
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
      issuer: "https://logto.spidmax.win/oidc",
      jwks: "https://logto.spidmax.win/oidc/jwks",
      algorithm: "RS256",
      applicationID: "1n1zuedqyc7yptyd44ih1",
    },
  ],
};
