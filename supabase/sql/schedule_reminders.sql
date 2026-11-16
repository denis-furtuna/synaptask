-- Run once in the Supabase SQL editor, AFTER deploying the `reminders` function.
-- Calls the function every minute. The two secrets live in Supabase Vault, never in this file.
--
-- 1. Replace the two placeholders below:
--      YOUR-PROJECT-REF   from your project URL (https://YOUR-PROJECT-REF.supabase.co)
--      YOUR-SECRET-KEY    Project Settings -> API Keys -> Secret keys -> the key named "default"
--                         (starts with sb_secret_). Do not save this file with the key in it.
-- 2. Run the whole script.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'synaptask_project_url');
select vault.create_secret('YOUR-SECRET-KEY', 'synaptask_secret_key');

select cron.schedule(
  'synaptask-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'synaptask_project_url') || '/functions/v1/reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'synaptask_secret_key')
    ),
    body := jsonb_build_object('time', now()),
    timeout_milliseconds := 30000
  );
  $$
);

-- Check it is running (after a minute or two):
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content from net._http_response order by created desc limit 5;
-- Stop it:
--   select cron.unschedule('synaptask-reminders');
