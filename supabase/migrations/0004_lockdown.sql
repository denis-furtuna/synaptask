-- Supabase's "Enable automatic RLS" project option adds public.rls_auto_enable(), the event-trigger
-- function behind it, which the API would otherwise list as /rest/v1/rpc/rls_auto_enable for every
-- caller (the security advisor warns about it). Nobody needs to call it: the event trigger keeps
-- working without EXECUTE grants. Skipped where the function does not exist (tests, other projects).
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
