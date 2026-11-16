-- Synaptask schema.
--
-- Security model
--  * Every row belongs to auth.uid(). RLS is on for every table.
--  * A RESTRICTIVE policy on every table requires an MFA session (aal2), so a stolen
--    password alone reads and writes nothing.
--  * OAuth tokens (the Claude connector) carry a client_id claim. Tables the connector
--    must not touch get a RESTRICTIVE "client_id IS NULL" policy. The connector may
--    INSERT into vault_inbox but never read it back.
--  * Work items are ciphertext. The server only sees remind_at for them.
--
-- The column limits here match sanitize() in web/js/store.js.

-- ------------------------------------------------------------------ helpers

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- clock_timestamp(), not now(): rows written in one statement still get distinct,
  -- increasing values, which the client's "updated_at > cursor" sync relies on.
  new.updated_at := clock_timestamp();
  return new;
end $$;

create or replace function public.reset_reminded_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.remind_at is distinct from old.remind_at then
    new.reminded_at := null;
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ tables

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 100),
  color       text not null default '#8792a3' check (color ~ '^#[0-9a-fA-F]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id        uuid,   -- no foreign key: rows sync in any order and deletes are soft
  idea_id            uuid,
  title              text not null default '' check (char_length(title) <= 500),
  notes              text not null default '' check (char_length(notes) <= 20000),
  priority           smallint not null default 0 check (priority between 0 and 3),
  due_date           date,
  due_time           text check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  remind_at          timestamptz,
  reminded_at        timestamptz,
  recurrence         jsonb check (recurrence is null or (jsonb_typeof(recurrence) = 'object' and octet_length(recurrence::text) <= 500)),
  subtasks           jsonb not null default '[]' check (jsonb_typeof(subtasks) = 'array' and jsonb_array_length(subtasks) <= 100 and octet_length(subtasks::text) <= 200000),
  completed_at       timestamptz,
  last_completed_at  timestamptz,
  source             text not null default 'app' check (source in ('app', 'claude')),
  position           integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create table public.ideas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default '' check (char_length(title) <= 300),
  notes       text not null default '' check (char_length(notes) <= 50000),
  stage       text not null default 'idea' check (stage in ('idea', 'planning', 'building', 'done')),
  tags        jsonb not null default '[]' check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) <= 20 and octet_length(tags::text) <= 4000),
  links       jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 30 and octet_length(links::text) <= 70000),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Encrypted work tasks and work categories. Content is AES-256-GCM ciphertext made in the browser.
create table public.vault_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ciphertext   text not null default '' check (char_length(ciphertext) <= 400000),
  iv           text not null default '' check (char_length(iv) <= 32),
  remind_at    timestamptz,   -- the only plaintext: when a generic "work task is due" push is sent
  reminded_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- One per user: the wrapped vault key (see web/js/vault.js) and the public key for the inbox.
create table public.vaults (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  record      jsonb not null check (jsonb_typeof(record) = 'object' and octet_length(record::text) <= 20000),
  public_key  jsonb not null check (jsonb_typeof(public_key) = 'object' and octet_length(public_key::text) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Work tasks from Claude, sealed to the vault's public key. Imported and deleted by the app on unlock.
create table public.vault_inbox (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sealed      jsonb not null check (jsonb_typeof(sealed) = 'object' and sealed ?& array['wk', 'iv', 'ct'] and octet_length(sealed::text) <= 200000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 2000),
  p256dh      text not null check (char_length(p256dh) between 1 and 200),
  auth        text not null check (char_length(auth) between 1 and 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_settings (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone         text not null default 'UTC' check (char_length(timezone) <= 64 and timezone ~ '^[A-Za-z0-9_+/-]+$'),
  email_reminders  boolean not null default true,
  push_reminders   boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ------------------------------------------------------------------ indexes

create index categories_sync   on public.categories (user_id, updated_at);
create index tasks_sync        on public.tasks (user_id, updated_at);
create index ideas_sync        on public.ideas (user_id, updated_at);
create index vault_items_sync  on public.vault_items (user_id, updated_at);
create index vault_inbox_user  on public.vault_inbox (user_id, created_at);
create index push_user         on public.push_subscriptions (user_id);
create index tasks_due on public.tasks (remind_at)
  where reminded_at is null and completed_at is null and deleted_at is null and remind_at is not null;
create index vault_items_due on public.vault_items (remind_at)
  where reminded_at is null and deleted_at is null and remind_at is not null;

-- ------------------------------------------------------------------ triggers

create trigger set_updated_at before insert or update on public.categories         for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.tasks              for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.ideas              for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.vault_items        for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.vaults             for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.vault_inbox        for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.push_subscriptions for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.user_settings      for each row execute function public.set_updated_at();

create trigger reset_reminded_at before update on public.tasks       for each row execute function public.reset_reminded_at();
create trigger reset_reminded_at before update on public.vault_items for each row execute function public.reset_reminded_at();

-- ------------------------------------------------------------------ privileges

-- Nothing for anonymous visitors. Signed-in users get table access; RLS decides which rows.
revoke all on public.categories, public.tasks, public.ideas, public.vault_items, public.vaults,
  public.vault_inbox, public.push_subscriptions, public.user_settings from anon;
grant select, insert, update, delete on public.categories, public.tasks, public.ideas, public.vault_items,
  public.vaults, public.push_subscriptions to authenticated;
grant select, insert, delete on public.vault_inbox to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant all on public.categories, public.tasks, public.ideas, public.vault_items, public.vaults,
  public.vault_inbox, public.push_subscriptions, public.user_settings to service_role;

-- ------------------------------------------------------------------ row level security

alter table public.categories         enable row level security;
alter table public.tasks              enable row level security;
alter table public.ideas              enable row level security;
alter table public.vault_items        enable row level security;
alter table public.vaults             enable row level security;
alter table public.vault_inbox        enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.user_settings      enable row level security;

-- Own rows only (personal data: the app and the connector).
create policy own_rows on public.categories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.ideas for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.vault_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.vaults for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- The inbox: anyone signed in as the user (including the connector) may drop a sealed task in;
-- only a direct app session may read or delete.
create policy inbox_insert on public.vault_inbox for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy inbox_read on public.vault_inbox for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'client_id') is null);
create policy inbox_delete on public.vault_inbox for delete to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'client_id') is null);

-- MFA required everywhere.
create policy require_mfa on public.categories as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.tasks as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.ideas as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.vault_items as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.vaults as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.vault_inbox as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.push_subscriptions as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy require_mfa on public.user_settings as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- The connector never touches encrypted work data, the vault keys or push devices.
create policy no_oauth_clients on public.vault_items as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy no_oauth_clients on public.vaults as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy no_oauth_clients on public.push_subscriptions as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
-- It may read the time zone (to place reminders) but not change any setting.
create policy no_oauth_insert on public.user_settings as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'client_id') is null);
create policy no_oauth_update on public.user_settings as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);

-- ------------------------------------------------------------------ connector helper

-- The connector cannot read the vaults table, but needs the public key to seal work tasks.
create or replace function public.vault_public_key() returns jsonb
language sql stable security definer set search_path = '' as $$
  select v.public_key
  from public.vaults v
  where v.user_id = (select auth.uid())
    and (select auth.jwt() ->> 'aal') = 'aal2';
$$;
revoke execute on function public.vault_public_key() from public, anon;
grant execute on function public.vault_public_key() to authenticated;
