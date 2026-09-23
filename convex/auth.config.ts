/**
 * Backend JWT verification config — Zitadel OIDC (self-hosted).
 *
 * Identity: https://auth.spidmax.win (verified live: standard OIDC
 * discovery, RS256 JWKS with kid at /oauth/v2/keys).
 *
 * Convex verifies the access token's iss/aud/signature against this and
 * exposes it as ctx.auth.getUserIdentity(). Only identity.subject is
 * consumed (see convex/lib/auth.ts); email/name come from the profile and
 * invite flows, not the token.
 *
 * Hard cutover from Convex Auth Password (Sept 2026): the old provider,
 * authTables, and HTTP routes are gone. Old subject-keyed rows are orphaned;
 * everyone re-registers in Zitadel.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://auth.spidmax.win",
      jwks: "https://auth.spidmax.win/oauth/v2/keys",
      algorithm: "RS256",
      applicationID: "392096213291302915",
    },
  ],
};
