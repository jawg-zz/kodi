# AGENTS.md — kodi

## What this is
Rent-management SaaS for Kenyan landlords (orgs, properties, units, tenants,
invoices, M-Pesa collections/payouts via Daraja, ratiba mandates) PLUS the
KenyaPay merchant-ops console. Single Convex deployment on self-hosted
(Dokploy): API https://convexapi.spidmax.win · HTTP actions
https://convex.spidmax.win · dashboard https://convexdash.spidmax.win.

## Monorepo map
- `apps/web` — landlord frontend (React 19, Vite 8, Tailwind, Logto OIDC)
- `apps/docs` — docs site
- `apps/console` — KenyaPay merchant-ops console (React 19, Vite 8, recharts 3;
  dev port 5174; `VITE_CONVEX_URL` from `.env.local` / committed `.env.production`;
  relative base → deployable at any host/subpath)
- `packages/shared` — shared types/logic
- `convex/` — THE backend: schema (kodi tables + console tables
  merchants/transactions/settlements/webhookLogs/alerts), ~50 modules, Daraja
  http routes (`/stk-callback`, `/c2b-*`, `/hakikisha-*`, plus `/hooks/mpesa`
  console mirror), crons, Logto auth config, vitest test suite

## ⚠️ Single source of truth: `convex/` here, pushed from here ONLY
- Push: `export $(grep -v '^#' .env.local | xargs) && npx convex dev --once < /dev/null`
  (the `< /dev/null` matters — otherwise the CLI blocks on stdin). `.env.local`
  holds CONVEX_SELF_HOSTED_URL + admin key; never commit it.
- Never run `npx convex dev` from any other clone. The legacy
  `jawg-zz/mpesa-merchant-dashboard` repo is retired (its convex/ mirror was
  deleted; only its gh-pages preview still serves).
- Before risky schema changes: `npx convex export --path backup.zip` — exports
  include UNREGISTERED tablets, so a schema push that drops tables is still
  recoverable afterwards (data lives in an append-only documents table).
  Historical pre-restore backups also in `~/mpesa-backups/` on the openhands
  machine (contain mpesaCredentials/national IDs — never commit).

## Commands
- `npm test` / `npm run test:convex` — vitest suites for the backend
- Console read model: `convex/console.ts` (queries `transactions`/`settlements`/
  `webhookHealth`/`alerts`/`whoami`/`transactionDetail`) merges REAL kodi flow
  tables (payments mpesa_* methods, c2b orphans, mpesaTransactions,
  platformCollections, depositSettlements, webhookLog, darajaJobs,
  paymentAlerts) with the /hooks/mpesa mirror feed. `transactionDetail`
  (`{source, id}`) returns one row's full lifecycle for the drawer — payment +
  platformCollections fee/settlement + checkout + tenant/org + matching
  `webhookLog`/`webhookLogs` deliveries + raw payload — scope-checked like
  every other query (feed rows are platform-admin only).
  Money-safety: rows already represented by a
  `payments` record are excluded upstream. Console deep-link envs:
  `VITE_WEB_URL` (console->web), `VITE_CONSOLE_URL` (web->console).
  Console AUTH: Logto, same issuer/app as web (`VITE_LOGTO_ISSUER`/
  `VITE_LOGTO_APP_ID` in root `.env.local` + `apps/console/.env.production`);
  platformAdmins -> cross-org view incl. simulator feed, orgMembers ->
  own org only (mirror rows hidden), others ConvexError. Tests:
  `convex/console.test.ts` + `convex/console.detail.test.ts`. Single-origin
  deploy: apps/web/Dockerfile
  builds BOTH SPAs and its nginx serves web at `/` + console at
  `kodi.spidmax.win/console/` (no subdomain needed); console derives its
  OIDC base from the URL at runtime (VITE_APP_URL overrides), and shares
  localStorage with web on the same origin = one login covers both.
  Logto admin registers (shared SPA app): `https://kodi.spidmax.win/console/auth/callback`,
  `https://kodi.spidmax.win/console/auth/silent-renew`, post-logout
  `https://kodi.spidmax.win/console/` (plus web's root URIs).
  Console handles callback/silent-renew by path suffix (no router;
  see `apps/console/src/lib/logto.ts`).
  Console AUTH GATING (learned the hard way): queries must never fire on
  Logto state alone — `useConvexAuth()` reports the BACKEND's verdict.
  `ConvexAuthGate` (App.tsx, wired in main.tsx under
  `ConvexProviderWithAuth useAuth={useConvexAuth}`) mounts the dashboard only
  once Convex accepts the token, else the sign-in screen; renewal is
  refresh-token only (`automaticSilentRenew`/`monitorSession` OFF — Logto's
  /oidc/auth sets X-Frame-Options: SAMEORIGIN, so an iframe can never work).
- Console view state lives in the URL (no router): `?q=&range=&channel=&status=&txn=`
  + `#sec-*` hash. `lib/urlState.ts` — `useTxUrlState()` merges patches onto a
  re-parse of the CURRENT location.search, so independent hook instances
  (App: q/range, TransactionsTable: channel/status/txn) never clobber each
  other. Defaults are omitted for clean URLs; params are validated against
  allowlists (`STK Push` needs URL encoding). Row click -> `?txn=<code>` opens
  the detail drawer. Pause/live semantics: `lib/liveView.ts`
  (`watermark`/`countNewer`) — while paused the table renders a frozen
  snapshot and a "N new transactions" banner.
- `npm run dev` / `dev:docs` / `dev:console` — per-app dev servers
- `npm run typecheck` — web + console
- Backend deployment env vars (set via `npx convex env set`): CREDENTIALS_KEY
  (encrypts Daraja secrets), MPESA_CALLBACK_URL (public convex site URL +
  callback path), JWKS/JWT_PRIVATE_KEY (Logto auth).

## Data-safety lessons (learned the hard way, 2026-10-16)
1. A schema push from a schema that omits a table unregisters the tablet AND
   its indexes — it once wiped all kodi tables because a dashboard schema was
   pushed from the wrong repo. Recovery worked because documents persist in the
   append-only persistence layer, but always prefer not to need it.
2. `users` + `auth*` tables are system-managed — not part of the app schema.
3. Deployment data includes sensitive PII (national IDs, phones,
   mpesaCredentials) — exports/backups are sensitive files.
4. `apps/console` (M-Pesa Merchant Console, served at
   kodi.spidmax.win/console) is a SINGLE-PAGE dashboard with NO router:
   sidebar nav = scroll-to-section (`sec-*` ids on panels in App.tsx) +
   scroll-spy/active states inside `components/Sidebar.tsx`. New console
   sections need an `id` prop or section id + a Sidebar nav target.
