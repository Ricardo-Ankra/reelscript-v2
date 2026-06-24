-- Reelscript V2 Slice 1a: the generation data contract. Additive — generation-output
-- columns on shots (written by 1b's generation pipeline) + an entities table for
-- locked-seed-per-entity continuity (1b assigns/reuses the seed).

alter table shots add column if not exists keyframe_first_key text;
alter table shots add column if not exists keyframe_last_key  text;
alter table shots add column if not exists clip_key           text;
alter table shots add column if not exists routed_model       text;

create table if not exists entities (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts (id) on delete cascade,
  video_id     uuid not null references videos (id) on delete cascade,
  name         text not null,
  seed         integer not null,
  keyframe_key text,
  created_at   timestamptz not null default now(),
  unique (video_id, name)
);

create index if not exists entities_video_idx on entities (video_id);

alter table entities enable row level security;

drop policy if exists acct_isolation on entities;
create policy acct_isolation on entities
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
