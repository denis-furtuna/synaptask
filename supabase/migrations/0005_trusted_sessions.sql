-- Supabase Auth issues OAuth (connector) tokens at aal1 even when the approving session was aal2
-- (seen live: auth.sessions.aal = 'aal1' for the Claude session), so require_mfa blocked Claude.
--
-- Simply accepting aal1 tokens of a trusted app would be unsafe: someone with only the password
-- could start their own authorization for the already trusted client id (it is a public client),
-- approve it through the API with a password-only session and exchange the code themselves.
-- So trust is bound to ONE session: the first OAuth session of that app created after the
-- approval on the consent page (which needed an authenticator code), and within 10 minutes of it.
-- Claude exchanges its code within seconds, so that session is Claude's. Any later session of the
-- same app (a reconnect that skipped the consent page, or an attacker) is not trusted until the
-- app is approved again on the consent page.

create or replace function public.oauth_client_trusted() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.trusted_clients t
    join auth.sessions s
      on s.user_id = t.user_id
     and s.oauth_client_id::text = t.client_id
    where t.user_id = (select auth.uid())
      and t.client_id = (select auth.jwt() ->> 'client_id')
      and s.id::text = (select auth.jwt() ->> 'session_id')
      and s.created_at >= t.updated_at
      and s.created_at <= t.updated_at + interval '10 minutes'
      and not exists (
        select 1 from auth.sessions e
        where e.user_id = s.user_id
          and e.oauth_client_id = s.oauth_client_id
          and e.created_at >= t.updated_at
          and (e.created_at, e.id) < (s.created_at, s.id)
      )
  );
$$;
revoke execute on function public.oauth_client_trusted() from public, anon;
grant execute on function public.oauth_client_trusted() to authenticated;

-- MFA everywhere, except the bound session of a trusted app on the tables the connector may use.
-- (vaults, push_subscriptions and trusted_clients keep the strict rule and refuse OAuth tokens anyway.)
do $$
declare t text;
begin
  foreach t in array array['categories', 'tasks', 'ideas', 'vault_items', 'vault_inbox', 'user_settings',
                           'work_grants', 'work_access_requests'] loop
    execute format('drop policy require_mfa on public.%I', t);
    execute format($p$
      create policy require_mfa on public.%I as restrictive for all to authenticated
        using ((select auth.jwt() ->> 'aal') = 'aal2' or (select public.oauth_client_trusted()))
        with check ((select auth.jwt() ->> 'aal') = 'aal2' or (select public.oauth_client_trusted()))
    $p$, t);
  end loop;
end $$;

create or replace function public.vault_public_key() returns jsonb
language sql stable security definer set search_path = '' as $$
  select v.public_key
  from public.vaults v
  where v.user_id = (select auth.uid())
    and ((select auth.jwt() ->> 'aal') = 'aal2' or (select public.oauth_client_trusted()));
$$;
revoke execute on function public.vault_public_key() from public, anon;
grant execute on function public.vault_public_key() to authenticated;
