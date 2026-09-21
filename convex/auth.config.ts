/**
 * Backend JWT verification config.
 *
 * The Convex Auth library mints ID tokens with iss = CONVEX_SITE_URL
 * ("https://convex.spidmax.win", confirmed via the live
 * /http/.well-known/openid-configuration) and aud = "convex". The issuer
 * below must match the token's iss exactly.
 *
 * Self-hosted routing on this deployment (verified live):
 * - API host serves functions: https://convexapi.spidmax.win (port 3210)
 * - Site host serves HTTP actions + JWKS + OAuth:
 *   https://convex.spidmax.win (port 3211)
 * - Dashboard host (convexdash.spidmax.win, port 6791) serves NO api/jwks
 *   routes — never point issuer/jwks at it.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://convex.spidmax.win",
      jwks: "https://convex.spidmax.win/.well-known/jwks.json",
      algorithm: "RS256",
      applicationID: "convex",
    },
  ],
};
