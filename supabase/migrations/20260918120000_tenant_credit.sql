-- Kodi — prepaid credit carryover + trigger hardening.
--
-- Problem: overpayments had nowhere to live. allocate_payment_fifo()
-- computed a leftover that record_payment() silently dropped, so a tenant
-- who paid extra still showed the full balance on next month's invoice.
-- Now the leftover persists per tenant in tenant_credits and is applied
-- automatically (oldest open invoice first) whenever monthly invoices are
-- generated. Staff and the tenant can both read the credit balance; only
-- theledger functions (and service-role callbacks) write it.
--
-- Also pins search_path on reject_double_occupancy (advisor hygiene — every
-- other trigger helper already pins it).
--
-- Applied migrations are never edited; this ships as its own migration.
-- Verified locally via npm run db:verify before applying to hosted.

-- ---------------------------------------------------------------------------
-- Credit ledger: one row per tenant, balance >= 0.
-- ---------------------------------------------------------------------------
create table public.tenant_credits (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  balance    integer not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tenant_credits_org on public.tenant_credits (org_id);

create trigger trg_tenant_credits_touch before update on public.tenant_credits
  for each row execute function public.touch_updated_at();

alter table public.tenant_credits enable row level security;
create policy tenant_credits_staff_all on public.tenant_credits
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy tenant_credits_tenant_read on public.tenant_credits
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- Backfill: paid-but-never-applied remainder per tenant. Credit was never
-- consumed before this migration, so paid minus ever-allocated is exact.
insert into public.tenant_credits (org_id, tenant_id, balance)
select p.org_id, p.tenant_id, sum(p.amount - coalesce(a.applied, 0))::integer
from public.payments p
left join lateral (
  select sum((x ->> 'amount')::integer) as applied
  from jsonb_array_elements(p.allocations) as x
) a on true
group by p.org_id, p.tenant_id
having sum(p.amount - coalesce(a.applied, 0)) > 0;

-- ---------------------------------------------------------------------------
-- record_payment: persist the FIFO leftover as tenant credit.
-- (Membership / service-role gating unchanged from the exemption migration.)
-- ---------------------------------------------------------------------------
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
  v_leftover integer := 0;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be a positive number of KES';
  end if;
  if p_method not in ('mpesa_stk', 'mpesa_manual', 'cash', 'bank') then
    raise exception 'Invalid payment method';
  end if;
  if not public.is_service_role()
     and (auth.uid() is null or not exists (
       select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
     )) then
    raise exception 'Not a member of this organization';
  end if;
  if not exists (select 1 from tenants where id = p_tenant and org_id = p_org) then
    raise exception 'Tenant not found in this organization';
  end if;

  v_receipt := public.next_receipt_no(p_org);
  v_alloc := public.allocate_payment_fifo(p_org, p_tenant, p_amount);
  v_leftover := coalesce((v_alloc ->> 'leftover')::integer, 0);

  insert into payments
    (org_id, tenant_id, amount, method, mpesa_code, paid_at, allocations, receipt_no, recorded_by, note)
  values
    (p_org, p_tenant, p_amount, p_method, p_mpesa_code,
     coalesce(p_paid_at, now()), v_alloc->'allocations', v_receipt, p_recorded_by, p_note)
  returning id into v_id;

  if v_leftover > 0 then
    insert into public.tenant_credits (org_id, tenant_id, balance)
    values (p_org, p_tenant, v_leftover)
    on conflict (tenant_id) do update set
      balance = public.tenant_credits.balance + excluded.balance,
      updated_at = now();
  end if;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- generate_monthly_invoices: consume held credit against open invoices
-- (oldest month first) right after inserting the new month's invoices.
-- Idempotency is unaffected: re-running a month inserts nothing and there
-- is no open balance left for credit to chase twice.
-- ---------------------------------------------------------------------------
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
  c record;
  inv record;
  v_remaining integer;
  v_applied integer;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month key, expected YYYY-MM';
  end if;
  if not public.is_service_role()
     and (auth.uid() is null or not exists (
       select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
     )) then
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

  for c in
    select tenant_id, balance from public.tenant_credits
    where org_id = p_org and balance > 0
    for update
  loop
    v_remaining := c.balance;
    for inv in
      select id, balance, total from public.invoices
      where org_id = p_org and tenant_id = c.tenant_id and balance > 0
      order by month asc, created_at asc
      for update
    loop
      exit when v_remaining <= 0;
      v_applied := least(v_remaining, inv.balance);
      update public.invoices set
        balance = balance - v_applied,
        status = case
          when balance - v_applied <= 0 then 'paid'
          when balance - v_applied < total then 'partial'
          else status end,
        updated_at = now()
      where id = inv.id;
      v_remaining := v_remaining - v_applied;
    end loop;
    update public.tenant_credits set balance = v_remaining, updated_at = now()
    where tenant_id = c.tenant_id;
  end loop;

  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Pin search_path on the double-occupancy trigger (no privilege change).
-- ---------------------------------------------------------------------------
create or replace function public.reject_double_occupancy() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.unit_id is not null and new.status in ('active', 'notice')
     and exists (
       select 1 from public.tenants t
       where t.unit_id = new.unit_id
         and t.id is distinct from new.id
         and t.status in ('active', 'notice')
     ) then
    raise exception 'That unit already has an active tenant. Move them out first, or pick a vacant unit.';
  end if;
  return new;
end $$;
