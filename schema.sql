-- Little Doses database schema.
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

create table public.medications (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  dose_amount   numeric not null check (dose_amount > 0),
  unit          text not null default 'ml',
  times         text[] not null default '{}',   -- daily times, e.g. {08:00,20:00}
  instructions  text,
  reorder_days  integer not null default 7,     -- warn when this many days are left
  order_info    text,                           -- how to reorder (pharmacy, GP, etc.)
  ordered_on    date,                           -- set when a reorder is placed, cleared on restock
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- One row per dose given. The unique constraint stops the same dose being
-- logged twice if both phones tap at the same moment.
create table public.doses (
  id             uuid primary key default gen_random_uuid(),
  medication_id  uuid not null references public.medications(id) on delete cascade,
  day            date not null,
  slot           text not null,
  amount         numeric not null,
  given_at       timestamptz not null default now(),
  given_by       text,
  note           text,
  unique (medication_id, day, slot)
);

-- Stock arriving (+) and manual corrections (+/-). Remaining stock is
-- stock events minus doses given, so nothing ever needs a running counter.
create table public.stock_events (
  id             uuid primary key default gen_random_uuid(),
  medication_id  uuid not null references public.medications(id) on delete cascade,
  change         numeric not null,
  reason         text not null,
  created_at     timestamptz not null default now(),
  created_by     text
);

create view public.medication_stock with (security_invoker = on) as
select
  m.id as medication_id,
  coalesce((select sum(s.change) from public.stock_events s where s.medication_id = m.id), 0)
  - coalesce((select sum(d.amount) from public.doses d where d.medication_id = m.id), 0) as remaining
from public.medications m;

-- Only signed-in users can read or write. Turn off public sign-ups in
-- Authentication settings so the only accounts are the ones you create.
alter table public.medications  enable row level security;
alter table public.doses        enable row level security;
alter table public.stock_events enable row level security;

create policy "household" on public.medications  for all to authenticated using (true) with check (true);
create policy "household" on public.doses        for all to authenticated using (true) with check (true);
create policy "household" on public.stock_events for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.medications, public.doses, public.stock_events to authenticated;
grant select on public.medication_stock to authenticated;

-- Live updates, so a dose logged on one phone appears on the other straight away.
alter publication supabase_realtime add table public.medications, public.doses, public.stock_events;
