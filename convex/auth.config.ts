/**
 * Backend JWT verification config.
 *
 * The Convex Auth library mints ID tokens with iss = CONVEX_SITE_URL
 * ("https://convex.spidmax.win", confirmed via the live
 * /http/.well-known/openid-configuration) and aud = "convex". The issuer
 * below must match the token's iss exactly.
 *
 * Self-hosted routing on this deployment (verified live):
 * - API host serves functions + JWKS: https://convexapi.spidmax.win
 * - HTTP routes live under /http: /http/.well-known/jwks.json -> 200
 * - Dashboard host (convex.spidmax.win) serves NO api/jwks routes, so the
 *   JWKS points at the API host. The backend fetches it server-side;
 *   cross-host JWKS is fine as long as the URL is reachable.
 * On Convex Cloud the /http prefix goes away — point both at the bare
 * site URL and update CONVEX_SITE_URL.
 */
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://convex.spidmax.win",
      jwks: "https://convexapi.spidmax.win/http/.well-known/jwks.json",
      algorithm: "RS256",
      applicationID: "convex",
    },
  ],
};
