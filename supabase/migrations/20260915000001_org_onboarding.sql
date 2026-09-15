-- Kodi — atomic org onboarding.
-- Fixes "new row violates row-level security policy for table orgs" on
-- signup: the app inserted orgs then org_members in two statements, but the
-- orgs INSERT ... SELECT needs SELECT permission on the new row, which a
-- not-yet-member lacks. This SECURITY DEFINER function creates the org, adds
-- the caller as owner, and upserts their profile atomically.
-- Verified locally via npm run db:verify before applying to hosted.

create or replace function public.create_org_with_owner(
  p_name text,
  p_plan_code text default 'starter',
  p_full_name text default '',
  p_phone text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_org orgs%rowtype;
begin
  if v_user is null then
    raise exception 'You must be signed in to create an organization.';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Give your rental business a name.';
  end if;
  if p_plan_code not in ('starter', 'growth', 'pro') then
    raise exception 'Invalid plan.';
  end if;

  insert into orgs (name, plan_code, subscription_status)
  values (btrim(p_name), p_plan_code, 'trialing')
  returning * into v_org;

  insert into org_members (org_id, user_id, role)
  values (v_org.id, v_user, 'owner')
  on conflict (org_id, user_id) do update set role = 'owner';

  insert into profiles (id, full_name, phone)
  values (v_user, coalesce(nullif(btrim(p_full_name), ''), ''), nullif(btrim(coalesce(p_phone, '')), ''))
  on conflict (id) do update set
    full_name = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
    phone = coalesce(excluded.phone, profiles.phone);

  return jsonb_build_object(
    'id', v_org.id,
    'name', v_org.name,
    'plan_code', v_org.plan_code,
    'subscription_status', v_org.subscription_status,
    'subscription_period_end', v_org.subscription_period_end,
    'invoice_due_day', v_org.invoice_due_day,
    'created_at', v_org.created_at
  );
end $$;

-- Authenticated users may call it; membership is enforced inside.
revoke all on function public.create_org_with_owner(text, text, text, text) from anon;
grant execute on function public.create_org_with_owner(text, text, text, text) to authenticated;
