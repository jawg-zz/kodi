## Migrate Kodi auth from Convex Auth (Password) to self-hosted Zitadel OIDC

**Decisions locked in:** hard cutover (no live users to preserve — old auth rows abandoned, everyone re-registers) · Zitadel-hosted login/signup pages (no in-app password forms) · I produce the Dokploy runbook, you provision Zitadel and paste back 2 values.

### Why this shape
Backend only ever consumes `identity.subject` (59 call sites via `convex/lib/auth.ts` → orgMembers/tenantUsers lookups; nothing reads email/claims from the JWT). So swapping the token issuer requires zero changes to tenants/properties/invoices/payments/mpesa/export logic. Frontend isolates all auth behind `src/lib/auth.tsx` `AuthState` + `App.tsx` guards, so keeping that shape stable limits churn to ~5 files. Zitadel speaks standard OIDC/JWKS, which is exactly what the backend image's verifier wants (fixes the `kid`/JWKS saga permanently — the `tools/patch-auth-kid.cjs` hack gets deleted).

### Phase 1 — You provision Zitadel on Dokploy (runbook I deliver)
1. New Dokploy services alongside existing `web`: `zitadel` (official image) + dedicated `postgres` with its own volume (not shared with Convex DB). Own public origin e.g. `https://auth.spidmax.win`; internal Postgres unexposed; port outside 3210/3211/6791.
2. In Zitadel console: create org → project → Application of SPA/User-Agent type (public client, PKCE): redirect URIs = app origin + `/auth/callback`, plus silent-renew + post-logout URIs; scopes `openid profile email`.
3. You paste back: `ZITADEL_ISSUER` (= `https://auth.spidmax.win`, no trailing path) and `ZITADEL_CLIENT_ID`. Nothing else from Zitadel enters the repo (both are public, baked as `VITE_*`).

### Phase 2 — Backend (Convex)
1. `convex/auth.config.ts`: replace the single `customJwt` (Convex site issuer) with Zitadel: `issuer = ZITADEL_ISSUER`, `jwks = <issuer>/.well-known/jwks.json`, `algorithm RS256`, `applicationID = ZITADEL_CLIENT_ID` (Zitadel `aud`).
2. Delete `convex/auth.ts` (Password provider) and remove `auth.addHttpRoutes(http)` from `convex/http.ts`; `POST/OPTIONS /mpesa-callback` stays public and untouched.
3. `convex/schema.ts`: remove `...authTables` (drops users/authAccounts/authSessions/etc. — intended, hard cutover). App tables (`orgMembers`, `tenantUsers`, `profiles`, `invites`, audit) unchanged — old subject-keyed rows orphan, new Zitadel `sub` keys fresh rows.
4. `convex/orgs.ts`: remove the `users`-table fallback (line ~136); `createOrg` keeps explicit `fullName/phone` args; `myOrg` read shape unchanged.
5. `convex/invites.ts` (+Internal): keep token flow; add `invite.email == identity.email` match on claim (Zitadel gives verified email; today no check exists). `getInvite` stays public.
6. Delete `tools/patch-auth-kid.cjs` + root `postinstall`; remove `@convex-dev/auth` dep. `convex/lib/auth.ts` unchanged (subject-only).

### Phase 3 — Frontend (apps/web)
1. Deps: remove `@convex-dev/auth`, add `oidc-client-ts`.
2. New `src/lib/zitadel.ts`: `UserManager` (authority + client_id from env, code+PKCE, `signinRedirectCallback` at `/auth/callback`, silent renew, `returnTo` preserved in sessionStorage so `/invite/:token` survives login).
3. Rewrite `src/lib/auth.tsx` internals, keep `AuthState` shape: `signIn/signUp` → `signinRedirect`; `signOut` → Zitadel logout + local user removal; `isAuthenticated` from OIDC user; `myOrg` query gated as today; all 14 `useAuth` consumers + `App.tsx` guards untouched.
4. `main.tsx`: `ConvexAuthProvider` → plain `ConvexProvider` + `convex.setAuth(fetchZitadelAccessToken)`; add public `/auth/callback` route.
5. `AuthPages.tsx`: replace email/password forms with "Sign in / Create account" buttons redirecting to Zitadel (drop dead `?check-email=1` banner; phone/name collection moves to onboarding/`createOrg` args).
6. `InvitePage.tsx`: stash `returnTo=/invite/<token>` pre-login, restore post-callback; `claimInvite` call unchanged.
7. Config: add `VITE_ZITADEL_ISSUER`, `VITE_ZITADEL_CLIENT_ID` (+ `VITE_APP_URL` if needed) to `.env`, `.env.example`, `Dockerfile` ARG/ENV, Dokploy web build args. `VITE_CONVEX_URL` unchanged.

### Phase 4 — Deploy + verify
1. Gates: `npm run typecheck`, `npm run build`, `npm run test`, `npx convex deploy --dry-run`.
2. `npx convex deploy` (drops auth tables, pushes new `auth.config.ts`); rebuild web on Dokploy.
3. Live probes: Zitadel `/.well-known/openid-configuration` + JWKS (`n`/`e`, `kid` present); signup → onboarding → `createOrg` → `myOrg`; invite create→accept as manager + tenant; sign-out → protected routes redirect; `OPTIONS/POST /mpesa-callback` still 200; console shows no `Invalid JWKS` / `kid` errors.
4. Rollback: revert the two commits + redeploy; note old sessions are unrecoverable after table drop (accepted under hard cutover).

**Deliverables:** runbook file + code changes + deployed backend + build instructions for the web service. Open question for implementation: wipe app tables for a true empty start, or leave orphaned rows (my choice: leave + document; one dashboard wipe if you want pristine).