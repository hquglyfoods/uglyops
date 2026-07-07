-- ============================================================
-- Auto-delete notifications older than 30 days.
-- Keeps the notifications table (and the bell history) tidy.
-- Run once in the Supabase SQL editor.
-- ============================================================

-- A small function that deletes stale notifications.
create or replace function public.purge_old_notifications()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.notifications
  where created_at < now() - interval '30 days';
$$;

-- Schedule it to run daily at 08:00 UTC (about 03:00-04:00 ET) via pg_cron.
-- pg_cron ships with Supabase; enable it once if it isn't already.
create extension if not exists pg_cron;

-- Remove any previous copy of this job, then (re)create it.
do $$
begin
  perform cron.unschedule('purge_old_notifications');
exception when others then
  null; -- job did not exist yet
end $$;

select cron.schedule(
  'purge_old_notifications',
  '0 8 * * *',
  $$ select public.purge_old_notifications(); $$
);

-- One immediate cleanup so you don't wait a day for the first run.
select public.purge_old_notifications();
