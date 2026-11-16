-- Trusted connector apps.
--
-- Dynamic client registration (needed so Claude can register itself) lets anyone register an OAuth
-- app with this project, so an approved OAuth token alone is not enough to reach your data.
-- The consent page (web/js/consent.js) records an app here only after it has checked that the app
-- returns to Claude (claude.ai / claude.com, or localhost for Claude Code) and you typed a fresh
-- authenticator code. Every table the connector can reach requires the token's client_id to be on
-- this list, so:
--   * an app approved any other way (a look-alike app, or someone who has only your password and
--     calls the approve endpoint directly) gets nothing;
--   * "Disconnect" in Settings deletes the row and cuts the app off at once, without waiting for
--     its access token to expire.
-- Only a direct app session with MFA (never an OAuth token) can read or change this list.

create table public.trusted_clients (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id    text not null check (length(client_id) between 1 and 200),
  name         text not null default '' check (length(name) <= 200),
  redirect_uri text not null default '' check (length(redirect_uri) <= 2000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(), -- last approval
  primary key (user_id, client_id)
);

create trigger set_updated_at before insert or update on public.trusted_clients
  for each row execute function public.set_updated_at();

-- Is the OAuth app behind the caller's token on the caller's trusted list?
-- (Direct app sessions have no client_id and get false; the policies below let them through anyway.)
create or replace function public.oauth_client_trusted() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.trusted_clients t
    where t.user_id = (select auth.uid())
      and t.client_id = (select auth.jwt() ->> 'client_id')
  );
$$;
revoke execute on function public.oauth_client_trusted() from public, anon;
grant execute on function public.oauth_client_trusted() to authenticated;

-- ------------------------------------------------------------------ privileges

revoke all on public.trusted_clients from anon;
grant select, insert, update, delete on public.trusted_clients to authenticated;
grant all on public.trusted_clients to service_role;

-- ------------------------------------------------------------------ row level security

alter table public.trusted_clients enable row level security;

create policy own_rows on public.trusted_clients for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy require_mfa on public.trusted_clients as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy no_oauth_clients on public.trusted_clients as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);

-- Every table an OAuth token can reach: only trusted apps get in.
-- (vaults and push_subscriptions already refuse every OAuth token.)
do $$
declare t text;
begin
  foreach t in array array['categories', 'tasks', 'ideas', 'vault_items', 'vault_inbox', 'user_settings',
                           'work_grants', 'work_access_requests'] loop
    execute format($p$
      create policy trusted_clients_only on public.%I as restrictive for all to authenticated
        using ((select auth.jwt() ->> 'client_id') is null or (select public.oauth_client_trusted()))
        with check ((select auth.jwt() ->> 'client_id') is null or (select public.oauth_client_trusted()))
    $p$, t);
  end loop;
end $$;
