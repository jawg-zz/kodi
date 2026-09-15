-- Kodi — audit follow-up: pin search_path on the unit-limit trigger helper
-- (advisor function_search_path_mutable). Applied migrations are never
-- edited, so this fix ships as its own migration.
-- Verified locally via npm run db:verify before applying to hosted.

create or replace function public.enforce_unit_limit() returns trigger
language plpgsql security definer set search_path = public as $$
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
