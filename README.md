# Kodi — Rent Management SaaS for Kenyan Landlords

Multi-tenant rent management: landlords sign up, manage plots/units/tenants,
auto-generate monthly rent invoices (rent + water + garbage), collect via live
M-Pesa STK Push with automatic reconciliation, and serve a tenant self-service
portal. Printable A4 invoices, receipts, statements, and deposit settlements;
collection reports with CSV export.

Backend: **Convex** (typed database + server functions + auth + cron + HTTP),
frontend: Vite + React + TypeScript + Tailwind v4 SPA with Convex Auth.

## Repo layout

```
kodi/
├── convex/                 Convex backend (schema, queries, mutations,
│                           actions, M-Pesa/Daraja, HTTP callback, crons)
│   ├── schema.ts           data model (orgs, properties, units, tenants,
│   │                       invoices, payments, credit ledger, M-Pesa, invites)
│   ├── lib/auth.ts         caller resolution + org guards + Daraja helpers
│   ├── orgs|properties|tenants|invoices|payments|mpesa|invites|export.ts
│   ├── auth.ts             Convex Auth (email+password)
│   ├── http.ts             public POST /mpesa-callback (Safaricom webhook)
│   ├── crons.ts            30-min stale-pending sweep
│   └── seed.ts             platform plans seed
├── apps/web/               Vite + React + TypeScript + Tailwind v4 SPA
│   └── src/
│       ├── lib/            convex client, auth context, typed API layer
│       ├── components/     UI primitives, layout, M-Pesa collect modal
│       └── pages/          auth, onboarding, dashboard, properties, tenants,
│                           invoices, payments, portal, reports, settings, print docs
├── packages/shared/        dependency-free TS: KES money, KE phones, months,
│                           FIFO allocation, CSV (+ 35 vitest tests)
├── supabase/               legacy Supabase backend (retained for reference;
│                           the app no longer reads it — see convex/ instead)
├── tools/                  dev-only Postgres verification harness (legacy)
├── vercel.json / netlify.toml
```

## Prerequisites

- Node 20+, npm
- A free [Convex](https://convex.dev) account (`npx convex dev` provisions it)
- (Optional, for live payments) a free [Daraja sandbox app](https://developer.safaricom.co.ke) for consumer key/secret

## 1. Backend (first run)

```bash
npx convex dev          # provisions the deployment, pushes convex/, runs codegen
npx convex run seed:seedPlans   # seed Starter/Growth/Pro (idempotent)
npx convex env set CREDENTIALS_KEY "$(openssl rand -hex 32)"
# After first deploy, point Daraja callbacks here:
npx convex env set MPESA_CALLBACK_URL "<your-convex-site-url>/mpesa-callback"
# NOTE: some self-hosted setups serve HTTP actions under /http
# (e.g. https://convexapi.spidmax.win/http/mpesa-callback) — probe
# OPTIONS <host>/http/mpesa-callback (expect 200) vs <host>/mpesa-callback
# and set MPESA_CALLBACK_URL to whichever answers.
```

Auth is Convex Auth email+password (no email server needed). Tenant isolation
lives in `convex/lib/auth.ts` — every function resolves the caller to staff
(`orgMembers`) or tenant (`tenantUsers`) and guards the org boundary in plain
TypeScript. Money movement mirrors the old `record_payment()` semantics:
atomic receipt numbering (RCP-NNNN) + FIFO allocation across open invoices +
leftover carried as tenant credit, consumed oldest-first at invoice generation.

Invites are link-based: staff create an invite (`/invite/<token>`, 7-day
expiry, 20/hour/org throttle); the invitee signs up, then claims it to join as
manager or tenant. There is no admin-create-user + temp-password flow.

## 2. Web app

```bash
# VITE_CONVEX_URL comes from `npx convex dev` (it prints CONVEX_URL)
echo "VITE_CONVEX_URL=https://YOUR-DEPLOYMENT.convex.cloud" > apps/web/.env
npm install
npm run dev        # http://localhost:5173
```

Deploy `apps/web/dist` (`npm run build`) to Vercel or Netlify — both configs
are included, with SPA fallback routing. For Dokploy, set `VITE_CONVEX_URL` as
a build arg (see `docker-compose.yml` + `apps/web/Dockerfile`).

## Verification (all green)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | `dist/` in ~5 s |
| Unit tests | `npm run test` | 35/35 (money, phones, months, FIFO, CSV) |

After `npx convex dev` succeeds it also runs backend typechecking + push
validation on the deployment.

## M-Pesa setup (per business, in Settings → M-Pesa)

1. Sandbox: consumer key/secret from developer.safaricom.co.ke, shortcode
   `174379`, sandbox passkey. Test STK Push immediately with a Safaricom test number.
2. Production: switch environment, enter your paybill/till credentials after
   Safaricom go-live approval. Set the Daraja CallBackURL to your
   `MPESA_CALLBACK_URL` (`<convex-site-url>/mpesa-callback`) — it is public;
   the CheckoutRequestID acts as the capability and successes dedupe.

Manual M-Pesa (transaction code), cash, and bank payments always work without
any Daraja configuration. Daraja secrets are AES-GCM encrypted with
`CREDENTIALS_KEY` before storage and only ever decrypted inside actions.

## Plans

Starter (free, ≤10 units) · Growth (KES 1,500/mo, ≤50) · Pro (KES 4,000/mo, ≤200).
Unit limits are enforced when adding units. Subscription collection is manual
in v1 (contact-to-activate); automated billing is on the roadmap.
