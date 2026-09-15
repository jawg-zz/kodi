-- Kodi — advisor hardening (post-deploy review).
-- Fixes the genuine issues from Supabase security + performance advisors:
--   1. SECURITY BUG: security-definer RPCs checked `auth.uid() is not null`
--      and skipped the membership test for anonymous callers, so anon could
--      call next_receipt_no / record_payment / generate_monthly_invoices with
--      service-role-free access. All three now REQUIRE an authenticated caller
--      and org membership (service-role callbacks bypass RLS, unaffected).
--   2. search_path pinned on touch_updated_at (was mutable).
--   3. RLS policies wrap auth.uid() in (select ...) so the initplan runs once
--      per query instead of per row (auth_rls_initplan).
--   4. Covering indexes for unindexed foreign keys.
--
-- Vaulted / intentional waivers (no change):
--   - anon/authenticated can EXECUTE security-definer helpers: safe because
--     every function enforces membership internally (now including anon).
--   - multiple permissive staff+tenant SELECT policies: intended (two roles).
--   - unused_index INFO: fresh project, no traffic yet.
--   - rls_enabled_no_policy on mpesa_credentials/_receipt_counters: intended,
--     function-only tables with zero client policies by design.

-- ---------------------------------------------------------------------------
-- 1. Require authenticated membership in the three gated RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.next_receipt_no(p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or not exists (
    select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this organization';
  end if;
  insert into receipt_counters (org_id, last_no) values (p_org, 1)
  on conflict (org_id) do update set last_no = receipt_counters.last_no + 1
  returning last_no into n;
  return 'RCP-' || lpad(n::text, 4, '0');
end $$;

create or replace function public.record_payment(
  p_org uuid,
  p_tenant uuid,
  p_amount integer,
  p_method text,
  p_mpesa_code text default null,
  p_paid_at timestamptz default null,
  p_note text default null,
  p_recorded_by uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_receipt text;
  v_alloc jsonb;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be a positive number of KES';
  end if;
  if p_method not in ('mpesa_stk', 'mpesa_manual', 'cash', 'bank') then
    raise exception 'Invalid payment method';
  end if;
  if auth.uid() is null or not exists (
    select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this organization';
  end if;
  if not exists (select 1 from tenants where id = p_tenant and org_id = p_org) then
    raise exception 'Tenant not found in this organization';
  end if;

  v_receipt := public.next_receipt_no(p_org);
  v_alloc := public.allocate_payment_fifo(p_org, p_tenant, p_amount);

  insert into payments
    (org_id, tenant_id, amount, method, mpesa_code, paid_at, allocations, receipt_no, recorded_by, note)
  values
    (p_org, p_tenant, p_amount, p_method, p_mpesa_code,
     coalesce(p_paid_at, now()), v_alloc->'allocations', v_receipt, p_recorded_by, p_note)
  returning id into v_id;

  return v_id;
end $$;

create or replace function public.generate_monthly_invoices(
  p_org uuid,
  p_month text
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_due_date date;
  v_last_day date;
  v_due_day integer;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month key, expected YYYY-MM';
  end if;
  if auth.uid() is null or not exists (
    select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this organization';
  end if;

  select o.invoice_due_day into v_due_day from orgs o where o.id = p_org;
  if not found then raise exception 'Organization not found'; end if;

  v_last_day := (date_trunc('month', (p_month || '-01')::date) + interval '1 month - 1 day')::date;
  v_due_date := (p_month || '-' ||
    lpad(least(v_due_day, extract(day from v_last_day)::int)::text, 2, '0'))::date;

  insert into invoices
    (org_id, tenant_id, unit_id, month, lines, total, due_date, status, balance)
  select
    p_org, t.id, u.id, p_month,
    jsonb_build_object('rent', u.rent_amount, 'water', u.water_charge,
                       'garbage', u.garbage_charge, 'other', 0),
    u.rent_amount + u.water_charge + u.garbage_charge,
    v_due_date,
    'unpaid',
    u.rent_amount + u.water_charge + u.garbage_charge
  from units u
  join tenants t on t.id = u.current_tenant_id
  where u.org_id = p_org
    and u.status in ('occupied', 'notice')
    and t.status in ('active', 'notice')
    and u.rent_amount + u.water_charge + u.garbage_charge > 0
    and not exists (
      select 1 from invoices i
      where i.org_id = p_org and i.tenant_id = t.id and i.month = p_month
    )
  on conflict (org_id, tenant_id, month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Pin search_path on the trigger helper.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Initplan-stable RLS policies: (select auth.uid()) runs once per query.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles
  for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists orgs_owner_delete on public.orgs;
create policy orgs_owner_delete on public.orgs
  for delete to authenticated using (
    exists (select 1 from org_members m
            where m.org_id = orgs.id and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(org_id));

drop policy if exists org_members_self_join on public.org_members;
create policy org_members_self_join on public.org_members
  for insert to authenticated
  with check (user_id = (select auth.uid()) and role = 'owner');

drop policy if exists tenant_users_self_read on public.tenant_users;
create policy tenant_users_self_read on public.tenant_users
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Covering indexes for foreign keys flagged by the performance advisor.
-- ---------------------------------------------------------------------------
create index if not exists idx_deposit_settlements_org on public.deposit_settlements (org_id);
create index if not exists idx_deposit_settlements_settled_by on public.deposit_settlements (settled_by);
create index if not exists idx_invoices_unit on public.invoices (unit_id);
create index if not exists idx_mpesa_tx_payment on public.mpesa_transactions (payment_id);
create index if not exists idx_mpesa_tx_initiated_by on public.mpesa_transactions (initiated_by);
create index if not exists idx_org_members_user on public.org_members (user_id);
create index if not exists idx_orgs_plan on public.orgs (plan_code);
create index if not exists idx_payments_recorded_by on public.payments (recorded_by);
create index if not exists idx_units_current_tenant on public.units (current_tenant_id);
