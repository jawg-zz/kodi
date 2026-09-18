# Kodi — Rent Management SaaS for Kenyan Landlords

Multi-tenant rent management: landlords sign up, manage plots/units/tenants,
auto-generate monthly rent invoices (rent + water + garbage), collect via live
M-Pesa STK Push with automatic reconciliation, and serve a tenant self-service
portal. Printable A4 invoices, receipts, statements, and deposit settlements;
collection reports with CSV export.

## Repo layout

```
kodi/
├── apps/web/               Vite + React + TypeScript + Tailwind v4 SPA
│   └── src/
│       ├── lib/            supabase client, auth context, typed API layer
│       ├── components/     UI primitives, layout, M-Pesa collect modal
│       └── pages/          auth, onboarding, dashboard, properties, tenants,
│                           invoices, payments, portal, reports, settings, print docs
├── packages/shared/        dependency-free TS: KES money, KE phones, months,
│                           FIFO allocation, CSV (+ 31 vitest tests)
├── supabase/
│   ├── migrations/         Postgres schema + RLS + business functions
│   └── functions/          Deno edge functions (invite, Daraja, STK, callback)
├── tools/                  dev-only Postgres verification harness
├── vercel.json / netlify.toml
```

## Prerequisites

- Node 20+, npm
- A free [Supabase](https://supabase.com) project
- (Optional, for live payments) a free [Daraja sandbox app](https://developer.safaricom.co.ke) for consumer key/secret

## 1. Database

Apply the migrations to your Supabase project (SQL editor or CLI), in
filename order — they chain (single-occupancy, M-Pesa flow hardening,
service-role exemption, prepaid credit carryover):

```
supabase/migrations/*.sql
```

This creates plans, orgs, members, properties, units, tenants, invoices,
payments, tenant credit ledger, M-Pesa tables, deposit settlements, plus
`record_payment()` (atomic FIFO allocation + receipt numbering + credit
carryover) and `generate_monthly_invoices()` (idempotent per org/month,
consumes held credit oldest-first), all behind row-level-security tenant
isolation.

To enable automatic monthly invoicing, schedule `select public.generate_invoices_due()`
daily (Supabase Dashboard → Database → Cron, or pg_cron).

## 2. Edge functions

```bash
supabase functions deploy invite-user mpesa-credentials stk-initiate mpesa-callback stk-status
supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CREDENTIALS_KEY=<32+ random chars>
```

`mpesa-callback` is public (`verify_jwt = false` in `functions/config.toml`);
Safaricom posts STK results there and the function reconciles them into the
ledger automatically. Authenticated functions verify the caller's JWT and scope
everything to their org.

## 3. Web app

```bash
cp apps/web/.env.example apps/web/.env   # add VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev        # http://localhost:5173
```

Deploy `apps/web/dist` (`npm run build`) to Vercel or Netlify — both configs
are included, with SPA fallback routing.

## Verification (all green)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | `dist/` in ~3 s |
| Unit tests | `npm run test` | 35/35 (money, phones, months, FIFO, CSV) |
| DB + RLS suite | `npm run db:verify` | 63/63 on disposable embedded Postgres |

`npm run db:verify` spins up a local Postgres (no Docker needed), applies the
auth shim + all migrations, and asserts cross-org isolation, tenant scoping,
idempotent invoice generation, FIFO allocation, credit carryover, receipt
numbering, and the function-only payments ledger.

## M-Pesa setup (per business, in Settings → M-Pesa)

1. Sandbox: consumer key/secret from developer.safaricom.co.ke, shortcode
   `174379`, sandbox passkey. Test STK Push immediately with a Safaricom test number.
2. Production: switch environment, enter your paybill/till credentials after
   Safaricom go-live approval.

Manual M-Pesa (transaction code), cash, and bank payments always work without
any Daraja configuration.

## Plans

Starter (free, ≤10 units) · Growth (KES 1,500/mo, ≤50) · Pro (KES 4,000/mo, ≤200).
Unit limits are enforced when adding units. Subscription collection is manual
in v1 (contact-to-activate); automated billing is on the roadmap.
