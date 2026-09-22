# Zitadel on Dokploy — provisioning runbook for Kodi auth

Goal: self-hosted Zitadel as Kodi's OIDC identity provider, replacing
Convex Auth (email+password). Kodi needs exactly two values back from this
runbook: `ZITADEL_ISSUER` and `ZITADEL_CLIENT_ID`.

Reference: official compose lives at
`zitadel/zitadel:main — deploy/compose/` (compose file, `.env.example`,
`docker-compose.mode-external-tls.yml` overlay). What follows adapts it to
Dokploy, where Dokploy itself terminates TLS and routes domains — so run the
base (non-TLS) services and map a domain to Zitadel's port 8080.

## 0. What you're building

- `zitadel` service: image `ghcr.io/zitadel/zitadel:v4.16.0` (pin; bump
  deliberately), command `start-from-init --masterkey "<32-char secret>"`,
  port 8080 internally. Env highlights: `ZITADEL_EXTERNALDOMAIN`
  (= your public domain, e.g. `auth.spidmax.win`),
  `ZITADEL_EXTERNALSECURE=true`, `ZITADEL_TLS_ENABLED=false` (Dokploy
  handles TLS), `ZITADEL_DATABASE_POSTGRES_DSN` (below), login-v2 URLs
  derived from the public scheme+domain (see §3).
- `postgres` service: image `postgres:17.10-alpine` (Zitadel needs ≥ 14),
  dedicated named volume (NOT shared with the Convex backend DB), NOT
  exposed publicly. DSN shape:
  `postgresql://<user>:<password>@postgres:5432/zitadel` (+ `?sslmode=disable`
  for intra-compose traffic).
- No Traefik service from the official compose — Dokploy is the reverse
  proxy. Map domain `auth.spidmax.win` → zitadel service port 8080.
- Keep the port off 3210/3211/6791 (Convex API/site/dashboard).

## 1. Dokploy services

1. Create a Postgres-backed app (or two services in one Dokploy project):
   - `zitadel-db`: postgres 17 image, persistent volume, strong admin
     password stored in Dokploy env. No public domain.
   - `zitadel`: image `ghcr.io/zitadel/zitadel:v4.16.0`, internal port 8080,
     public domain `auth.spidmax.win` (Dokploy TLS on).
2. Env (Dokploy dashboard, never committed):
   - `ZITADEL_MASTERKEY` — generate: `openssl rand -hex 16` (exactly 32 chars).
     Losing this loses encrypted instance data — back it up.
   - `ZITADEL_DOMAIN=auth.spidmax.win`
   - `ZITADEL_EXTERNALPORT=443`, `ZITADEL_EXTERNALSECURE=true`,
     `ZITADEL_TLS_ENABLED=false`, `ZITADEL_PUBLIC_SCHEME=https`
   - `ZITADEL_DATABASE_POSTGRES_DSN` pointing at `zitadel-db`.
   - `LOGIN_CLIENT_PAT_EXPIRATION=2099-01-01T00:00:00Z`
   - Login v2 base/redirect URLs built from the public origin, e.g.
     `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI=https://auth.spidmax.win/ui/v2/login/`
     (mirror for `ZITADEL_OIDC_DEFAULTLOGINURLV2` and
     `ZITADEL_OIDC_DEFAULTLOGOUTURLV2` per the official compose).
3. Deploy. First boot runs `start-from-init`, creates the schema, and seeds
   the first instance + org + login client.

## 2. Console setup (first login)

1. Open `https://auth.spidmax.win`. Log in with the seeded admin (first-
   instance credentials from Dokploy logs/env per official flow).
2. Create an organization for Kodi (e.g. `kodi`).
3. Create a Project (e.g. `kodi-web`).
4. Add an Application of type **User-Agent (SPA)** — public client, PKCE,
   no client secret:
   - Redirect URIs (adjust to the real web origin):
     - `https://<kodi-web-origin>/auth/callback` (required)
     - `https://<kodi-web-origin>/silent-renew.html` (recommended)
   - Post-logout redirect URIs: `https://<kodi-web-origin>/`
   - Scopes: `openid profile email` (+ `offline_access` if refresh tokens wanted).
   - Grant types: authorization code + refresh token.
5. Copy the **Client ID** (numeric Zitadel app id).

## 3. Verify before handing back

```bash
curl -sS https://auth.spidmax.win/.well-known/openid-configuration | head -c 600; echo
curl -sS https://auth.spidmax.win/.well-known/jwks.json | head -c 300; echo
```

Expect: `issuer` exactly `https://auth.spidmax.win`, a `jwks_uri` under the
same origin, and JWKS keys with `kty/key_ops or use/alg/kid/n/e` (standard
RS256 — no `pem` shape). If `issuer` has a trailing slash or path, report
the exact string; `auth.config.ts` must match it byte-for-byte.

## 4. Hand back to dev (paste into chat)

```text
ZITADEL_ISSUER=https://auth.spidmax.win
ZITADEL_CLIENT_ID=<numeric app id>
```

Optional but useful: whether self-registration is open or invite-only, and
the web app's public origin (for redirect URIs).

## 5. What dev does next (no action for you)

Backend `convex/auth.config.ts` switches to
`{ issuer: ZITADEL_ISSUER, jwks: <issuer>/.well-known/jwks.json,
algorithm: "RS256", applicationID: ZITADEL_CLIENT_ID }`; Convex Auth tables
and the `patch-auth-kid` hack are deleted. Frontend adds `oidc-client-ts`
with `VITE_ZITADEL_ISSUER` / `VITE_ZITADEL_CLIENT_ID`, callback route
`/auth/callback`, and invite-token preservation across login. Hard cutover:
old password accounts do not carry over; everyone registers fresh in Zitadel.
