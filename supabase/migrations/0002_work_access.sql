-- Time-limited Claude access to the Work section, approved in the app.
--
-- How it works
--  * The connector asks (work_access_requests); the app shows the request and sends a push.
--  * You approve in the unlocked app: it seals the raw vault key to the server's "grant" public key
--    (private half: the GRANT_PRIVATE_JWK Edge Function secret) and stores it in work_grants with an
--    expiry of at most 24 hours.
--  * While a grant is active the connector may read and write vault_items. It can never create,
--    extend or delete a grant itself. Expired grants are deleted every minute (reminders function),
--    and "Stop now" in the app deletes the grant immediately.
--  * Outside a grant, work data stays end-to-end encrypted exactly as before.

create table public.work_grants (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  sealed_key  jsonb not null check (jsonb_typeof(sealed_key) = 'object' and sealed_key ?& array['wk', 'iv', 'ct'] and octet_length(sealed_key::text) <= 4000),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.work_access_requests (
  user_id       uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  requested_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.limit_work_grant() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.expires_at <= now() then
    raise exception 'a grant must expire in the future' using errcode = '23514';
  end if;
  if new.expires_at > now() + interval '24 hours 5 minutes' then
    raise exception 'a grant lasts at most 24 hours' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger limit_work_grant before insert or update on public.work_grants
  for each row execute function public.limit_work_grant();
create trigger set_updated_at before insert or update on public.work_grants
  for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.work_access_requests
  for each row execute function public.set_updated_at();

-- Is the connector currently allowed into the caller's Work section?
create or replace function public.work_grant_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.work_grants g
    where g.user_id = (select auth.uid()) and g.expires_at > now()
  );
$$;
revoke execute on function public.work_grant_active() from public, anon;
grant execute on function public.work_grant_active() to authenticated;

-- ------------------------------------------------------------------ privileges

revoke all on public.work_grants, public.work_access_requests from anon;
grant select, insert, update, delete on public.work_grants, public.work_access_requests to authenticated;
grant all on public.work_grants, public.work_access_requests to service_role;

-- ------------------------------------------------------------------ row level security

alter table public.work_grants enable row level security;
alter table public.work_access_requests enable row level security;

create policy own_rows on public.work_grants for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.work_access_requests for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy require_mfa on public.work_grants as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.work_access_requests as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- Only you (a direct app session) create, change or delete grants; the connector only reads an active one.
create policy no_oauth_insert on public.work_grants as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'client_id') is null);
create policy no_oauth_update on public.work_grants as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy no_oauth_delete on public.work_grants as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy oauth_sees_active_only on public.work_grants as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'client_id') is null or expires_at > now());

-- The connector may ask (insert/update its request); only the app clears requests.
create policy no_oauth_delete on public.work_access_requests as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);

-- Work items: the connector gets in only while a grant is active (replaces the blanket ban from 0001).
drop policy no_oauth_clients on public.vault_items;
create policy oauth_needs_grant on public.vault_items as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null or (select public.work_grant_active()))
  with check ((select auth.jwt() ->> 'client_id') is null or (select public.work_grant_active()));
