-- DEV-ONLY: apply AFTER migrations. Grants mirroring hosted Supabase defaults.
-- RLS governs row access on hosted Supabase; here it gates the same way.

grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.plans to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated, service_role;
