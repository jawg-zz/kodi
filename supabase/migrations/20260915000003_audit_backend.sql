-- Kodi — audit fixes batch 1 (backend).
-- G1 (critical): plan unit limits were client-side only. Any staff member
--   could bypass the Starter/Growth cap with a direct INSERT. This trigger
--   enforces max_units from plans server-side on every unit insert.
-- G2 (hardening): only owners may install/update Daraja credentials.
--   Managers could previously overwrite the org's M-Pesa secrets. Staff
--   still read the configured/environment view via the edge function.
-- G3 (correctness): tenants.phone per-org uniqueness was unenforceable
--   (NULL unit_id + no partial unique index), so the same tenant could be
--   added twice to one org. Adds a unique index on (org_id, phone).
-- Verified locally via npm run db:verify before applying to hosted.

-- ---------------------------------------------------------------------------
-- G1: server-side unit limit
-- ---------------------------------------------------------------------------
create or replace function public.enforce_unit_limit() returns trigger
language plpgsql as $$
declare
  v_max integer;
  v_count integer;
begin
  select p.max_units into v_max
  from orgs o join plans p on p.code = o.plan_code
  where o.id = new.org_id;
  if not found then
    raise exception 'Organization not found';
  end if;
  select count(*) into v_count from units where org_id = new.org_id;
  if v_count >= v_max then
    raise exception 'Unit limit reached for this plan (%)', v_max
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_units_enforce_limit on public.units;
create trigger trg_units_enforce_limit before insert on public.units
  for each row execute function public.enforce_unit_limit();

-- ---------------------------------------------------------------------------
-- G2: Daraja credential writes stay service-role-only (no client policies).
-- Rationale: the mpesa-credentials edge function already uses the service
-- role (bypasses RLS), so client policies would only widen access. Instead
-- the function itself is restricted to owners (see its index.ts change):
-- managers keep read-only use of STK, owners manage secrets.
-- This migration therefore adds NO policy here — RLS enabled with zero
-- policies = deny-all for clients, which is the intended posture.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- G3: one row per phone per org
-- ---------------------------------------------------------------------------
create unique index if not exists idx_tenants_org_phone
  on public.tenants (org_id, phone);
