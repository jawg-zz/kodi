-- One responsible tenant per unit: at most one active/notice tenant may point
-- at the same unit. Moved-out history is unaffected (status excluded).
--
-- A partial unique index is the backstop, plus a trigger that raises a
-- human-readable error (Postgres unique violations don't name the problem
-- in a way the app can surface nicely).

create unique index if not exists uq_tenants_unit_active
  on public.tenants (unit_id)
  where unit_id is not null and status in ('active', 'notice');

create or replace function public.reject_double_occupancy() returns trigger
language plpgsql as $$
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

drop trigger if exists trg_tenants_single_occupancy on public.tenants;
create trigger trg_tenants_single_occupancy
  before insert or update of unit_id, status on public.tenants
  for each row execute function public.reject_double_occupancy();
