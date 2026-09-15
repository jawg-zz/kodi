-- Kodi — M-Pesa flow hardening.
-- G1 (double-charge guard): idempotency key on mpesa_transactions. The app
--   sends idempotency_key = hash(org, tenant, amount, minute-bucket); a
--   retried/double-tapped initiate within the same window returns the
--   existing pending row instead of sending a second STK push.
-- G2 (stale pending): expire_pending_transactions() marks rows still pending
--   after 30 minutes as timeout so the UI stops polling them pointlessly.
--   Called from stk-status on every poll (cheap) — no cron dependency.
-- G3 (duplicate manual codes): unique index on mpesa_code for manual codes
--   so the same SMS code cannot be recorded twice. STK receipts stay
--   non-unique (Safaricom may legitimately repeat them across txns).
-- Verified locally via npm run db:verify before applying to hosted.

alter table public.mpesa_transactions
  add column if not exists idempotency_key text;

create unique index if not exists idx_mpesa_tx_idem
  on public.mpesa_transactions (org_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists idx_payments_mpesa_code_unique
  on public.payments (org_id, mpesa_code)
  where mpesa_code is not null and method = 'mpesa_manual';

create or replace function public.expire_pending_transactions() returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update mpesa_transactions
  set status = 'timeout',
      result_desc = coalesce(result_desc, 'No confirmation received within 30 minutes.'),
      updated_at = now()
  where status = 'pending'
    and created_at < now() - interval '30 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.expire_pending_transactions() from anon;
grant execute on function public.expire_pending_transactions() to authenticated;
