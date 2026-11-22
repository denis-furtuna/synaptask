-- Shopping list: items to buy, grouped by the user's own shopping categories
-- (e.g. Groceries, For projects, Fun). An item can also point at a project idea.
-- Same protections as the other personal tables: own rows only, MFA (or the bound session of a
-- trusted connector app, see 0005), and nothing for anonymous visitors.

create table public.shopping_categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 100),
  color       text not null default '#8792a3' check (color ~ '^#[0-9a-fA-F]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.shopping_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id  uuid,   -- no foreign keys: rows sync in any order and deletes are soft
  idea_id      uuid,
  title        text not null default '' check (char_length(title) <= 300),
  quantity     text not null default '' check (char_length(quantity) <= 50),
  notes        text not null default '' check (char_length(notes) <= 5000),
  bought_at    timestamptz,
  source       text not null default 'app' check (source in ('app', 'claude')),
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index shopping_categories_sync on public.shopping_categories (user_id, updated_at, id);
create index shopping_items_sync on public.shopping_items (user_id, updated_at, id);

create trigger set_updated_at before insert or update on public.shopping_categories
  for each row execute function public.set_updated_at();
create trigger set_updated_at before insert or update on public.shopping_items
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ privileges

revoke all on public.shopping_categories, public.shopping_items from anon;
grant select, insert, update, delete on public.shopping_categories, public.shopping_items to authenticated;
grant all on public.shopping_categories, public.shopping_items to service_role;

-- ------------------------------------------------------------------ row level security

alter table public.shopping_categories enable row level security;
alter table public.shopping_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['shopping_categories', 'shopping_items'] loop
    execute format($p$
      create policy own_rows on public.%I for all to authenticated
        using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))
    $p$, t);
    execute format($p$
      create policy require_mfa on public.%I as restrictive for all to authenticated
        using ((select auth.jwt() ->> 'aal') = 'aal2' or (select public.oauth_client_trusted()))
        with check ((select auth.jwt() ->> 'aal') = 'aal2' or (select public.oauth_client_trusted()))
    $p$, t);
    execute format($p$
      create policy trusted_clients_only on public.%I as restrictive for all to authenticated
        using ((select auth.jwt() ->> 'client_id') is null or (select public.oauth_client_trusted()))
        with check ((select auth.jwt() ->> 'client_id') is null or (select public.oauth_client_trusted()))
    $p$, t);
  end loop;
end $$;
