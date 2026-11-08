-- Little Doses: feed tracking. Run once after schema.sql:
-- Dashboard → SQL Editor → New query → paste → Run.

-- The feeding plan. Saving a plan adds a row that applies from that day on,
-- so earlier days keep the target they had at the time.
create table public.feed_plans (
  starts_on        date primary key,
  target_ml        numeric not null check (target_ml > 0),   -- ml per 24 hours
  times            text[] not null default '{}',             -- e.g. {06:00,09:00,12:00}
  amount_per_feed  numeric check (amount_per_feed > 0),      -- blank = split target evenly
  default_type     text not null default 'expressed',
  updated_at       timestamptz not null default now()
);

-- One row per feed. Scheduled feeds carry their slot time; extra feeds have none.
create table public.feeds (
  id            uuid primary key default gen_random_uuid(),
  day           date not null,
  slot          text,
  fed_at        timestamptz not null default now(),
  type          text not null check (type in ('expressed', 'formula', 'breastfeed')),
  amount_ml     numeric check (amount_ml >= 0),
  duration_min  integer check (duration_min >= 0),
  given_by      text,
  note          text,
  created_at    timestamptz not null default now()
);

-- Stops the same scheduled feed being logged twice from both phones.
create unique index feeds_one_per_slot on public.feeds (day, slot) where slot is not null;

alter table public.feed_plans enable row level security;
alter table public.feeds      enable row level security;

create policy "household" on public.feed_plans for all to authenticated using (true) with check (true);
create policy "household" on public.feeds      for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.feed_plans, public.feeds to authenticated;

alter publication supabase_realtime add table public.feed_plans, public.feeds;
