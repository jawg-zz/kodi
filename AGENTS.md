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
  `webhookHealth`/`alerts`) merges REAL kodi flow tables (payments mpesa_*
  methods, c2b orphans, mpesaTransactions, platformCollections,
  depositSettlements, webhookLog, darajaJobs, paymentAlerts) with the
  /hooks/mpesa mirror feed. Money-safety: rows already represented by a
  `payments` record are excluded upstream. Console deep-link envs:
  `VITE_WEB_URL` (console->web), `VITE_CONSOLE_URL` (web->console).
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
