# Self-hosted Logto — console setup runbook for Kodi auth

Goal: self-hosted Logto as Kodi's OIDC identity provider, replacing
Zitadel. Kodi needs exactly two values back from this runbook:
`LOGTO_ISSUER` (includes `/oidc`) and `LOGTO_APP_ID`.

This runbook assumes your Logto instance is already deployed and reachable
(e.g. `https://logto.spidmax.win`) with the admin console working.

## 1. Create the SPA application

1. Open the Logto admin console → Applications → Create application.
2. Type: **Single Page App** (public client, PKCE, no client secret).
3. Name it e.g. `kodi-web`.
4. Redirect URIs (must match exactly — the app builds them from the web
   origin, defaulting to `window.location.origin`):
   - `https://kodi.spidmax.win/auth/callback` (required — login return)
   - `https://kodi.spidmax.win/auth/silent-renew` (required — the silent-renew
     iframe hits `redirect_uri`, so both must be registered)
5. Post sign-out redirect URI: `https://kodi.spidmax.win/`.
6. Copy the **App ID** (Logto uses string IDs, e.g. `abc123xyz`).

## 2. Enable email sign-in (required)

Kodi's invite-claim flow (`convex/invites.ts`) matches the token's `email`
claim against the invite email. Users MUST have a verified email in their
ID token, or tenant/manager claiming breaks.

1. Console → Sign-in experience → Sign-up and sign-in: enable **email**
   address with verification-code connector. Configure your mail provider
   (SMTP or a connector) and verify a code round-trips.
2. Keep **Create account** (public registration) enabled — landlords
   self-serve and tenants register with their invited email, then claim.
3. Scopes the app requests (`openid profile email offline_access`) must be
   grantable — `offline_access` gives rotating refresh tokens so session
   renewal works even when third-party cookies block the silent iframe.

## 3. Verify before handing back

```bash
curl -sS https://<logto-host>/oidc/.well-known/openid-configuration | head -c 600; echo
```

Expect: `issuer` exactly `https://<logto-host>/oidc` (with the `/oidc`
suffix — report the exact string; `convex/auth.config.ts` must match it
byte-for-byte), a `jwks_uri` under the same origin, and an
`end_session_endpoint` (used for logout).

## 4. Hand back to dev (paste into chat)

```text
LOGTO_ISSUER=https://<logto-host>/oidc
LOGTO_APP_ID=<string app id>
```

Plus the full discovery JSON (or at least `issuer` + `jwks_uri` lines) so
`convex/auth.config.ts` can be filled in exactly.

## 5. What dev does next (no action for you)

Backend `convex/auth.config.ts` switches to
`{ issuer: LOGTO_ISSUER, jwks: <jwks_uri>, algorithm: "RS256",
applicationID: LOGTO_APP_ID }` and runs `npx convex deploy` (auth config
only takes effect after deploy). Frontend swaps `VITE_ZITADEL_*` build
args for `VITE_LOGTO_ISSUER` / `VITE_LOGTO_APP_ID` and Dokploy rebuilds
the web bundle. Hard cutover: old Zitadel-subject rows are orphaned;
everyone registers fresh in Logto.
