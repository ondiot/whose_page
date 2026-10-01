-- Blank Page — schema
-- Run this whole file once in Supabase SQL Editor.

create extension if not exists pgcrypto;

-- ROOMS ----------------------------------------------------------
create table if not exists rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text unique not null,
  status           text not null default 'lobby',
    -- lobby | writing | guessing | reveal | ended
  round            int not null default 1,
  round_seconds    int not null default 60,
  writing_ends_at  timestamptz,
  created_at       timestamptz not null default now()
);

-- PLAYERS ----------------------------------------------------------
create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  name       text not null,
  avatar     text not null,
  is_host    boolean not null default false,
  score      int not null default 0,
  joined_at  timestamptz not null default now()
);

-- PAPERS (one submission per player per round) -----------------------
create table if not exists papers (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms(id) on delete cascade,
  round       int not null,
  author_id   uuid not null references players(id) on delete cascade,
  content     text not null,
  auto_filled boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (room_id, round, author_id)
);

-- ASSIGNMENTS (who has to guess which paper, per round) ---------------
create table if not exists assignments (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references rooms(id) on delete cascade,
  round              int not null,
  paper_id           uuid not null references papers(id) on delete cascade,
  assigned_to        uuid not null references players(id) on delete cascade,
  guessed_player_id  uuid references players(id),
  created_at         timestamptz not null default now(),
  unique (room_id, round, assigned_to)
);

-- RLS: wide open for anon key (casual party game, no auth) ------------
alter table rooms       enable row level security;
alter table players     enable row level security;
alter table papers      enable row level security;
alter table assignments enable row level security;

create policy "anon all rooms"       on rooms       for all using (true) with check (true);
create policy "anon all players"     on players     for all using (true) with check (true);
create policy "anon all papers"      on papers      for all using (true) with check (true);
create policy "anon all assignments" on assignments for all using (true) with check (true);

-- Realtime: broadcast row changes on these tables ---------------------
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table papers;
alter publication supabase_realtime add table assignments;
