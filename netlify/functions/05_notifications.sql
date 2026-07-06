-- ============================================================
-- In-app notification history (bell icon)
-- Run this once in the Supabase SQL editor.
-- ============================================================

-- 1) Notification history. One row per push the server sent.
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  body           text,
  url            text,
  tag            text,
  audience_role  text not null default 'hq',   -- 'hq' or 'franchisee'
  franchisee_id  uuid,                          -- set when targeted at ONE store
  titles         text,                          -- comma list of C-level titles (phase alerts); null = all HQ
  created_at     timestamptz not null default now()
);

create index if not exists notifications_created_idx  on public.notifications (created_at desc);
create index if not exists notifications_role_idx      on public.notifications (audience_role);
create index if not exists notifications_franchisee_idx on public.notifications (franchisee_id);

-- 2) Per-user "last seen" marker so each person has their own unread count.
create table if not exists public.notification_reads (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  last_seen   timestamptz not null default now()
);

-- ============================================================
-- RLS
-- ============================================================
alter table public.notifications      enable row level security;
alter table public.notification_reads enable row level security;

-- HQ can read every notification; franchisees only see broadcasts to franchisees
-- or ones addressed to their own store. (Title filtering for C-levels is applied
-- in the app; every HQ user may read HQ rows.)
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select using (
    -- HQ sees all HQ-addressed rows
    (audience_role = 'hq' and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'hq'
    ))
    or
    -- franchisee sees franchisee broadcasts + rows for their own store
    (audience_role = 'franchisee' and (
        franchisee_id is null
        or franchisee_id in (
          select p.franchisee_id from public.profiles p where p.id = auth.uid()
        )
    ))
  );

-- Only the service role (server) inserts notifications; no client insert.
drop policy if exists notifications_no_client_write on public.notifications;
create policy notifications_no_client_write on public.notifications
  for insert with check (false);

-- Each user manages only their own read marker.
drop policy if exists notification_reads_self on public.notification_reads;
create policy notification_reads_self on public.notification_reads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
