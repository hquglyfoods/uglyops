-- ============================================================
-- 13_lead_stages.sql
-- Lets HQ rename / recolor / reorder the lead pipeline stages
-- from inside the app. The stage KEYS never change (existing
-- leads keep their stage value), only the display settings.
-- Run this in the Supabase SQL editor.
-- ============================================================

create table if not exists public.lead_stage_settings (
  stage_key   text primary key,   -- fixed key: new_inquiry, contacted, ... rejected
  label       text not null,      -- display name (editable)
  color       text not null,      -- hex color (editable)
  sort_order  int,                -- display order (rejected pinned last)
  updated_at  timestamptz not null default now()
);

alter table public.lead_stage_settings enable row level security;

-- HQ-only read/write
drop policy if exists lead_stage_settings_hq on public.lead_stage_settings;
create policy lead_stage_settings_hq on public.lead_stage_settings
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'hq')
  ) with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'hq')
  );

-- Seed with the current defaults (only if empty). Safe to re-run.
insert into public.lead_stage_settings (stage_key, label, color, sort_order) values
  ('new_inquiry',      'New Inquiry',      '#8A8480', 0),
  ('contacted',        'Contacted',        '#5B8FD4', 1),
  ('interviewed',      'Interviewed',      '#9B78D4', 2),
  ('discovery_day',    'Discovery Day',    '#E8B85C', 3),
  ('fdd_sent',         'FDD Sending',      '#CC9C3A', 4),
  ('waiting_for_sign', 'Waiting for Sign', '#E89C5C', 5),
  ('agreement_signed', 'Agreement Signed', '#5FB87A', 6),
  ('rejected',         'Rejected',         '#E05252', 7)
on conflict (stage_key) do nothing;
