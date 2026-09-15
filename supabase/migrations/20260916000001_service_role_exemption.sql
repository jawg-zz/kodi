-- Kodi — service-role exemption for automated writes.
-- Fixes "Reconcile failed: Not a member of this organization" when the
-- M-Pesa callback (or any service-role caller with no JWT) invokes
-- record_payment/next_receipt_no/generate_monthly_invoices: auth.uid() is
-- null for service-role, so the membership test must be skipped for it.
-- Detection: auth.jwt() ->> 'role' = 'service_role' (null JWT = not service
-- role, so anon can no longer slip through — the original bug stays fixed).
-- Applied migrations are never edited; this ships as its own migration.
-- Verified locally via npm run db:verify before applying to hosted.

create or replace function public.is_service_role() returns boolean
language sql stable set search_path = public as $$
  select coalesce((auth.jwt() ->> 'role') = 'service_role', false);
$$;

revoke all on function public.is_service_role() from anon;
grant execute on function public.is_service_role() to authenticated;

create or replace function public.next_receipt_no(p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_service_role()
     and (auth.uid() is null or not exists (
       select 1 from org_members m where m.org_id = p_org and m.user_id = auth.uid()
     )) then
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
  return v_count;
end $$;
