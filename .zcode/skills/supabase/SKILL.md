# Kodi Supabase Workflow

Project ref: `fsysabhazmberfszfhao`. MCP server `supabase-kodi` (read-only) is
configured in user scope; it auto-connects at session start.

## Golden rules

1. **Migrations are the source of truth.** Schema changes go in NEW files under
   `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql` — never edit an
   applied migration. Never apply DDL directly to the hosted project; the MCP
   server is read-only on purpose.
2. **Verify locally first.** `npm run db:verify` applies the shim + all
   migrations to disposable embedded Postgres and runs the 28-check RLS suite.
   It must be 28/28 before any migration touches the hosted project.
3. **RLS is load-bearing.** Every business table carries `org_id`. Staff access
   goes through `is_org_member()`; tenants through `current_tenant_id()`.
   `payments` and `mpesa_credentials` have NO client insert/select — writes only
   via `record_payment()` / service-role edge functions.
4. **Money is integer KES** everywhere. Phones stored canonical `2547XXXXXXXX`
   (`normalizeKenyanPhone` in `packages/shared`).

## MCP tools → when to use them

- `list_tables` / `execute_sql` (SELECT only): inspect hosted schema/data,
  confirm a migration applied, debug a production issue.
- `get_advisors`: run after any migration — security + performance findings
  must be addressed or explicitly waived.
- `query_logs`: debug edge-function or auth failures on hosted.
- `list_migrations`: confirm which migrations the hosted project has.
- `get_project_url` / `get_publishable_keys`: fill `apps/web/.env`.
- `search_docs`: Supabase feature questions — prefer over guessing.

## Deploying a migration to hosted

1. Write the migration file, run `npm run db:verify` (28/28 required).
2. Apply via Dashboard → SQL editor (paste file contents), or
   `supabase db push` with the project linked.
3. Confirm via MCP `list_migrations`, then run `get_advisors` and fix findings.

## Edge functions

Source in `supabase/functions/<name>/index.ts`, shared helpers in
`supabase/functions/_shared/mod.ts`. Deploy with
`supabase functions deploy <name>`; required secrets
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_KEY`) are set in
Dashboard → Edge Functions. `mpesa-callback` stays `verify_jwt = false`
(Safaricom posts without JWT; CheckoutRequestID is the capability).

## Local gates (all must be green)

- `npm run typecheck` — web app
- `npm run build` — production bundle
- `npm run test` — 31 shared-package unit tests
- `npm run db:verify` — 28 migration + RLS checks
