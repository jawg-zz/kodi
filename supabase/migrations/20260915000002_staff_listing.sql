-- Kodi — staff listing without a fake FK join.
-- Fixes "Could not find a relationship between 'org_members' and 'profiles'
-- in the schema cache": the app embedded profiles from org_members, but no
-- foreign key connects those tables (both point at auth.users independently),
-- so PostgREST rejects the query. This SECURITY DEFINER function returns the
-- org's staff with profile names in one call; membership enforced inside.
-- (A client-side join is not viable: the profiles RLS policy is own-row-only,
-- so staff could never resolve each other's names.)

create or replace function public.list_staff_members(p_org uuid)
returns table (user_id uuid, role text, full_name text)
language sql stable security definer set search_path = public as $$
  select m.user_id, m.role, coalesce(p.full_name, '')
  from org_members m
  left join profiles p on p.id = m.user_id
  where m.org_id = p_org
    and exists (
      select 1 from org_members me
      where me.org_id = p_org and me.user_id = auth.uid()
    )
  order by m.role, coalesce(p.full_name, '');
$$;

revoke all on function public.list_staff_members(uuid) from anon;
grant execute on function public.list_staff_members(uuid) to authenticated;
