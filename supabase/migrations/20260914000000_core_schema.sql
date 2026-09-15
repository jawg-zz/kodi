-- Kodi — Rent Management SaaS (Kenya)
-- Core schema: multi-tenant tables, FIFO payment allocation, receipt numbering,
-- monthly invoice generation. RLS policies live in the next migration.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Plans (platform pricing, readable by everyone for the pricing page)
-- ---------------------------------------------------------------------------
create table public.plans (
  code        text primary key,
  name        text not null,
  max_units   integer not null,
  price_kes   integer not null check (price_kes >= 0),
  sort_order  integer not null default 0
);

insert into public.plans (code, name, max_units, price_kes, sort_order) values
  ('starter', 'Starter', 10,  0,    1),
  ('growth',  'Growth',  50,  1500, 2),
  ('pro',     'Pro',     200, 4000, 3);

-- ---------------------------------------------------------------------------
-- Orgs (one landlord business = one org) and membership
-- ---------------------------------------------------------------------------
create table public.orgs (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  plan_code      text not null default 'starter' references public.plans(code),
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due')),
  subscription_period_end date,
  invoice_due_day integer not null default 5 check (invoice_due_day between 1 and 28),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.org_members (
  org_id    uuid not null references public.orgs(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'owner' check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone     text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Properties -> Units -> Tenants
-- ---------------------------------------------------------------------------
create table public.properties (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  name          text not null,
  property_type text not null default 'apartments'
    check (property_type in ('apartments', 'bedsitters', 'single_rooms', 'mixed', 'commercial')),
  location      text not null default '',
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.units (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  label             text not null,
  unit_type         text not null default 'bedsitter'
    check (unit_type in ('bedsitter', 'single', 'one_br', 'two_br', 'three_br', 'shop', 'other')),
  rent_amount       integer not null default 0 check (rent_amount >= 0),
  water_charge      integer not null default 0 check (water_charge >= 0),
  garbage_charge    integer not null default 0 check (garbage_charge >= 0),
  status            text not null default 'vacant'
    check (status in ('vacant', 'occupied', 'notice')),
  current_tenant_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (property_id, label)
);

create table public.tenants (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  full_name     text not null,
  phone         text not null,
  national_id   text not null default '',
  unit_id       uuid references public.units(id) on delete set null,
  move_in_date  date,
  deposit_held  integer not null default 0 check (deposit_held >= 0),
  status        text not null default 'active'
    check (status in ('active', 'notice', 'moved_out')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.units
  add constraint units_current_tenant_fkey
  foreign key (current_tenant_id) references public.tenants(id) on delete set null;

-- Portal login link: one auth user per tenant row.
create table public.tenant_users (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Invoices and payments (all money: integer whole KES)
-- ---------------------------------------------------------------------------
create table public.invoices (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  unit_id    uuid references public.units(id) on delete set null,
  month      text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  lines      jsonb not null default '{"rent":0,"water":0,"garbage":0,"other":0}'::jsonb,
  total      integer not null default 0 check (total >= 0),
  due_date   date not null,
  status     text not null default 'unpaid' check (status in ('unpaid', 'partial', 'paid')),
  balance    integer not null default 0 check (balance >= 0),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tenant_id, month)
);

create table public.receipt_counters (
  org_id  uuid primary key references public.orgs(id) on delete cascade,
  last_no integer not null default 0
);

create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  amount      integer not null check (amount > 0),
  method      text not null check (method in ('mpesa_stk', 'mpesa_manual', 'cash', 'bank')),
  mpesa_code  text,
  paid_at     timestamptz not null default now(),
  allocations jsonb not null default '[]'::jsonb,
  receipt_no  text not null,
  recorded_by uuid references auth.users(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);

create table public.mpesa_transactions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  checkout_request_id text not null unique,
  merchant_request_id text,
  phone               text not null,
  amount              integer not null check (amount > 0),
  status              text not null default 'pending'
    check (status in ('pending', 'success', 'failed', 'timeout')),
  result_code         integer,
  result_desc         text,
  mpesa_receipt       text,
  payment_id          uuid references public.payments(id) on delete set null,
  initiated_by        uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Daraja credentials, encrypted at rest by the edge functions. No client access.
create table public.mpesa_credentials (
  org_id            uuid primary key references public.orgs(id) on delete cascade,
  environment       text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  consumer_key_enc  text not null default '',
  consumer_secret_enc text not null default '',
  shortcode         text not null default '',
  passkey_enc       text not null default '',
  updated_at        timestamptz not null default now()
);

create table public.deposit_settlements (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  deposit_held      integer not null check (deposit_held >= 0),
  deductions        jsonb not null default '[]'::jsonb,
  total_deductions  integer not null default 0 check (total_deductions >= 0),
  refund_amount     integer not null default 0 check (refund_amount >= 0),
  notes             text,
  settled_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index idx_properties_org on public.properties (org_id);
create index idx_units_property on public.units (property_id);
create index idx_units_org_status on public.units (org_id, status);
create index idx_tenants_org_status on public.tenants (org_id, status);
create index idx_tenants_unit on public.tenants (unit_id);
create index idx_invoices_org_month on public.invoices (org_id, month);
create index idx_invoices_tenant on public.invoices (tenant_id, month);
create index idx_invoices_org_status on public.invoices (org_id, status);
create index idx_payments_org_paid on public.payments (org_id, paid_at desc);
create index idx_payments_tenant on public.payments (tenant_id, paid_at desc);
create index idx_mpesa_tx_org on public.mpesa_transactions (org_id, created_at desc);
create index idx_mpesa_tx_tenant on public.mpesa_transactions (tenant_id);
create index idx_deposit_settlements_tenant on public.deposit_settlements (tenant_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger trg_orgs_touch before update on public.orgs
  for each row execute function public.touch_updated_at();
create trigger trg_properties_touch before update on public.properties
  for each row execute function public.touch_updated_at();
create trigger trg_units_touch before update on public.units
  for each row execute function public.touch_updated_at();
create trigger trg_tenants_touch before update on public.tenants
  for each row execute function public.touch_updated_at();
create trigger trg_invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();
create trigger trg_mpesa_tx_touch before update on public.mpesa_transactions
  for each row execute function public.touch_updated_at();
create trigger trg_mpesa_credentials_touch before update on public.mpesa_credentials
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Keep unit occupancy in sync with tenant assignment/status. The trigger owns
-- units.status and units.current_tenant_id; the app only writes tenant rows.
-- ---------------------------------------------------------------------------
create or replace function public.sync_unit_tenant() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update units set status = 'vacant', current_tenant_id = null
    where id = old.unit_id and current_tenant_id = old.id;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.unit_id is not null
     and (old.unit_id is distinct from new.unit_id or new.status = 'moved_out') then
    update units set status = 'vacant', current_tenant_id = null
    where id = old.unit_id and current_tenant_id = new.id;
  end if;

  if new.unit_id is not null and new.status <> 'moved_out' then
    update units set
      status = case when new.status = 'notice' then 'notice' else 'occupied' end,
      current_tenant_id = new.id
    where id = new.unit_id;
  end if;

  return new;
end $$;

create trigger trg_tenants_sync_unit after insert or update of unit_id, status on public.tenants
  for each row execute function public.sync_unit_tenant();

create trigger trg_tenants_sync_unit_del after delete on public.tenants
  for each row execute function public.sync_unit_tenant();

-- ---------------------------------------------------------------------------
-- Per-org receipt numbering: RCP-0001, RCP-0002, ...
-- ---------------------------------------------------------------------------
create or replace function public.next_receipt_no(p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is not null and not exists (
    select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this organization';
  end if;
  insert into receipt_counters (org_id, last_no) values (p_org, 1)
  on conflict (org_id) do update set last_no = receipt_counters.last_no + 1
  returning last_no into n;
  return 'RCP-' || lpad(n::text, 4, '0');
end $$;

-- ---------------------------------------------------------------------------
-- FIFO payment allocation across open invoices (oldest month first).
-- Returns {"allocations": [{"invoiceId": ..., "amount": ...}], "leftover": n}
-- ---------------------------------------------------------------------------
create or replace function public.allocate_payment_fifo(
  p_org uuid, p_tenant uuid, p_amount integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  remaining integer := p_amount;
  applied integer;
  allocs jsonb := '[]'::jsonb;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Allocation amount must be positive';
  end if;
  for r in
    select id, balance from invoices
    where org_id = p_org and tenant_id = p_tenant and balance > 0
    order by month asc, created_at asc
    for update
  loop
    exit when remaining <= 0;
    applied := least(remaining, r.balance);
    update invoices set
      balance = balance - applied,
      status = case
        when balance - applied <= 0 then 'paid'
        when balance - applied < total then 'partial'
        else status end,
      updated_at = now()
    where id = r.id;
    allocs := allocs || jsonb_build_array(
      jsonb_build_object('invoiceId', r.id, 'amount', applied)
    );
    remaining := remaining - applied;
  end loop;
  return jsonb_build_object('allocations', allocs, 'leftover', remaining);
end $$;

-- ---------------------------------------------------------------------------
-- Record a payment atomically: receipt number + FIFO allocation + ledger row.
-- Called via RPC by staff and directly by the M-Pesa callback function.
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
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be a positive number of KES';
  end if;
  if p_method not in ('mpesa_stk', 'mpesa_manual', 'cash', 'bank') then
    raise exception 'Invalid payment method';
  end if;
  if auth.uid() is not null and not exists (
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

-- ---------------------------------------------------------------------------
-- Monthly invoice generation (idempotent per org/month, unique constraint backs it)
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
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month key, expected YYYY-MM';
  end if;
  if auth.uid() is not null and not exists (
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

-- Platform-wide daily generation for the current month (cron target).
create or replace function public.generate_invoices_due() returns integer
language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_total integer := 0;
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  for o in select id from orgs loop
    v_total := v_total + public.generate_monthly_invoices(o.id, v_month);
  end loop;
  return v_total;
end $$;

-- Schedule daily at 03:00 UTC when pg_cron is available (hosted Supabase).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'kodi-generate-invoices', '0 3 * * *',
      'select public.generate_invoices_due()'
    );
  end if;
end $$;
