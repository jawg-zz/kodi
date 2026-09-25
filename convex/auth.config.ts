/**
 * Backend JWT verification config — Logto OIDC (self-hosted).
 *
 * Identity: <LOGTO_BASE_URL>/oidc (standard OIDC discovery at
 * <LOGTO_BASE_URL>/oidc/.well-known/openid-configuration, RS256 JWKS).
 * Fill in the three values below from your Logto console + discovery doc.
 *
 * Convex verifies the ID token's iss/aud/signature against this and exposes
 * it as ctx.auth.getUserIdentity(). Only identity.subject is consumed (see
 * convex/lib/auth.ts); email is read in the invite-claim path
 * (convex/invites.ts); name/phone come from the profile and invite flows,
 * not the token.
 *
 * Hard cutover from Zitadel OIDC (Sept 2026): the old provider is gone. Old
 * subject-keyed rows are orphaned; everyone re-registers in Logto.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://LOGTO_HOST_NOT_SET/oidc",
      jwks: "https://LOGTO_HOST_NOT_SET/oidc/jwks",
      algorithm: "RS256",
      applicationID: "LOGTO_APP_ID_NOT_SET",
    },
  ],
};
