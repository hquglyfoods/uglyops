-- ============================================================
-- Bug / error reporting. When something fails silently (a blocked
-- write, an uncaught JS error), the app records it here so HQ can
-- see exactly what happened instead of relying on the user to report it.
-- Run once in the Supabase SQL editor.
-- ============================================================

create table if not exists public.error_reports (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  user_id       uuid,                         -- who hit it (may be null if pre-auth)
  role          text,                         -- 'hq' | 'franchisee' | null
  store_name    text,                         -- franchisee store, when known
  app           text,                         -- 'ops' | 'os'
  context       text,                         -- what the user was doing e.g. 'submit_task'
  message       text,                         -- error message / description
  detail        jsonb,                        -- structured extras (ids, status, etc.)
  severity      text not null default 'error',-- 'info' | 'error' | 'high'
  user_agent    text,
  resolved      boolean not null default false
);

create index if not exists error_reports_created_idx on public.error_reports (created_at desc);
create index if not exists error_reports_unresolved_idx on public.error_reports (resolved, created_at desc);

alter table public.error_reports enable row level security;

-- Any signed-in user may file a report (their own). No one but HQ can read them.
drop policy if exists error_reports_insert on public.error_reports;
create policy error_reports_insert on public.error_reports
  for insert to authenticated
  with check (true);

drop policy if exists error_reports_hq_read on public.error_reports;
create policy error_reports_hq_read on public.error_reports
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'hq'));

-- HQ can mark reports resolved.
drop policy if exists error_reports_hq_update on public.error_reports;
create policy error_reports_hq_update on public.error_reports
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'hq'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'hq'));
