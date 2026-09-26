# Self-hosted Logto — console setup runbook for Kodi auth

Goal: self-hosted Logto as Kodi's OIDC identity provider, replacing
Zitadel. Kodi needs exactly two values back from this runbook:
`LOGTO_ISSUER` (includes `/oidc`) and `LOGTO_APP_ID`.

This runbook assumes your Logto instance is already deployed and reachable
with the admin console working.

> **Admin host vs core host.** Logto splits its front door in two: the ADMIN
> console (e.g. `https://logto.spidmax.win`, where you click around) and the
> CORE OIDC service (e.g. `https://logtoend.spidmax.win`, which actually
> issues tokens and serves `/.well-known/openid-configuration` + `/oidc/jwks`).
> They can serve DIFFERENT keys — key rotations done in the console apply to
> the tenant, but each host serves its own view of them. **Every URL below
> that says `<core-host>` means the core OIDC host, NOT the admin console
> host.** Verify with `curl https://<core-host>/oidc/jwks` — it must show the
> RSA key; the admin host's JWKS may show a stale EC key and must be ignored.

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

## 3. Rotate the OIDC signing key to RSA (required)

Convex's `customJwt` verifier accepts **RS256 or ES256 only**, but Logto
ships with an EC P-384 (**ES384**) signing key — with the stock key, every
authenticated Convex call fails signature verification. Rotate once to RSA:

```bash
# Inside the Logto container (or wherever the Logto CLI can reach its DB):
npx logto db config rotate oidc.privateKeys --type rsa --gracePeriod 3600
```

Notes:
- The 1-hour grace period stages the new key: clients refresh JWKS before
  it starts signing. Keep the previous key until existing sessions/tokens
  signed with it have expired.
- Re-run the JWKS check below afterwards: the active key must now show
  `"kty": "RSA"` / `"alg": "RS256"`.
- Reference: Logto docs "Rotate signing keys (OSS)".

## 4. Verify before handing back (use the CORE host)

```bash
curl -sS https://<core-host>/oidc/.well-known/openid-configuration | head -c 600; echo
curl -sS https://<core-host>/oidc/jwks | head -c 400; echo
```

Expect: `issuer` exactly `https://<core-host>/oidc` (with the `/oidc`
suffix — report the exact string; `convex/auth.config.ts` must match it
byte-for-byte), a `jwks_uri` under the same origin, an
`end_session_endpoint` (used for logout), and a JWKS key with
`"kty": "RSA"` / `"alg": "RS256"` (§3 above). If the admin host's JWKS
shows a different key, ignore it — only the core host matters.

## 5. Hand back to dev (paste into chat)

```text
LOGTO_ISSUER=https://<core-host>/oidc
LOGTO_APP_ID=<string app id>
```

Plus the full discovery JSON (or at least `issuer` + `jwks_uri` lines) so
`convex/auth.config.ts` can be filled in exactly.

## 6. What dev does next (no action for you)

Backend `convex/auth.config.ts` switches to
`{ issuer: LOGTO_ISSUER, jwks: <jwks_uri>, algorithm: "RS256",
applicationID: LOGTO_APP_ID }` and runs `npx convex deploy` (auth config
only takes effect after deploy). Frontend swaps `VITE_ZITADEL_*` build
args for `VITE_LOGTO_ISSUER` / `VITE_LOGTO_APP_ID` and Dokploy rebuilds
the web bundle. Hard cutover: old Zitadel-subject rows are orphaned;
everyone registers fresh in Logto.
