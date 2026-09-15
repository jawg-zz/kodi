-- Kodi — Row Level Security: tenant isolation for the multi-tenant SaaS.
-- Staff (org members) see their org's rows. Tenant portal users see only
-- their own records. Payments are ledger rows: staff and tenants read them,
-- but inserts only happen via record_payment() / edge functions.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;

create or replace function public.current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from tenant_users where user_id = auth.uid() limit 1;
$$;

-- ---------------------------------------------------------------------------
-- plans: public read
-- ---------------------------------------------------------------------------
alter table public.plans enable row level security;
create policy plans_public_read on public.plans
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- profiles: own row only
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
create policy profiles_own on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- orgs
-- ---------------------------------------------------------------------------
alter table public.orgs enable row level security;
create policy orgs_member_read on public.orgs
  for select to authenticated using (public.is_org_member(id));
create policy orgs_anyone_create on public.orgs
  for insert to authenticated with check (true);
create policy orgs_member_update on public.orgs
  for update to authenticated
  using (public.is_org_member(id)) with check (public.is_org_member(id));
create policy orgs_owner_delete on public.orgs
  for delete to authenticated using (
    exists (select 1 from org_members m
            where m.org_id = orgs.id and m.user_id = auth.uid() and m.role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- org_members
-- ---------------------------------------------------------------------------
alter table public.org_members enable row level security;
create policy org_members_read on public.org_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_org_member(org_id));
create policy org_members_self_join on public.org_members
  for insert to authenticated
  with check (user_id = auth.uid() and role = 'owner');

-- ---------------------------------------------------------------------------
-- properties / units
-- ---------------------------------------------------------------------------
alter table public.properties enable row level security;
create policy properties_staff_all on public.properties
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

alter table public.units enable row level security;
create policy units_staff_all on public.units
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- tenants: staff full access; tenant users read their own row
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
create policy tenants_staff_all on public.tenants
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy tenants_self_read on public.tenants
  for select to authenticated using (id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- tenant_users: staff manage links; tenant users see their own link
-- ---------------------------------------------------------------------------
alter table public.tenant_users enable row level security;
create policy tenant_users_staff on public.tenant_users
  for all to authenticated
  using (
    exists (select 1 from tenants t
            where t.id = tenant_users.tenant_id and public.is_org_member(t.org_id))
  )
  with check (
    exists (select 1 from tenants t
            where t.id = tenant_users.tenant_id and public.is_org_member(t.org_id))
  );
create policy tenant_users_self_read on public.tenant_users
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- invoices: staff full; tenants read own
-- ---------------------------------------------------------------------------
alter table public.invoices enable row level security;
create policy invoices_staff_all on public.invoices
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy invoices_tenant_read on public.invoices
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- payments: read-only for clients; writes only via record_payment() (definer)
-- and the M-Pesa callback (service role)
-- ---------------------------------------------------------------------------
alter table public.payments enable row level security;
create policy payments_staff_read on public.payments
  for select to authenticated using (public.is_org_member(org_id));
create policy payments_tenant_read on public.payments
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- mpesa_transactions: staff/tenant read own; writes service-role only
-- ---------------------------------------------------------------------------
alter table public.mpesa_transactions enable row level security;
create policy mpesa_tx_staff_read on public.mpesa_transactions
  for select to authenticated using (public.is_org_member(org_id));
create policy mpesa_tx_tenant_read on public.mpesa_transactions
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- mpesa_credentials: no client access at all (edge functions use service role)
-- ---------------------------------------------------------------------------
alter table public.mpesa_credentials enable row level security;

-- receipt_counters: function-only access
alter table public.receipt_counters enable row level security;

-- ---------------------------------------------------------------------------
-- deposit_settlements: staff full; tenants read own
-- ---------------------------------------------------------------------------
alter table public.deposit_settlements enable row level security;
create policy deposits_staff_all on public.deposit_settlements
  for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy deposits_tenant_read on public.deposit_settlements
  for select to authenticated using (tenant_id = public.current_tenant_id());
