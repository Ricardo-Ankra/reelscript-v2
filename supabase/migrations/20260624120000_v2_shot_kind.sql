-- Reelscript V2 Slice 0: the three source classes + cinematography + provenance on
-- shots. Additive. kind = producing subsystem (generative|motion_graphic|live_action),
-- distinct from source = acquisition path. camera_spec/lighting_spec authored for
-- generative shots; provenance is a script-time stub. Classification is done in TS
-- (classifyBeat) and passed in; SQL only persists.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'shot_kind') then
    create type shot_kind as enum ('generative', 'motion_graphic', 'live_action');
  end if;
end $$;

alter table shots add column if not exists kind shot_kind not null default 'live_action';
alter table shots add column if not exists camera_spec jsonb;
alter table shots add column if not exists lighting_spec jsonb;
alter table shots add column if not exists provenance jsonb;
alter table shots add column if not exists hero boolean not null default false;
alter table shots add column if not exists needs_speech boolean not null default false;
alter table shots add column if not exists broadcast_4k boolean not null default false;

-- Backfill kind from the existing source for pre-V2 rows.
update shots set kind = case
  when source = 'procedural' then 'motion_graphic'::shot_kind
  when source = 'generated'  then 'generative'::shot_kind
  else 'live_action'::shot_kind
end;

-- Rewrite the upsert to persist the new fields (alongside visual_brief).
create or replace function public.upsert_scene_with_shots(
  p_account_id      uuid,
  p_video_id        uuid,
  p_position        integer,
  p_narration       text,
  p_duration_seconds numeric,
  p_shots           jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scene_id uuid;
  v_shot     jsonb;
begin
  insert into scenes (account_id, video_id, position, narration, duration_seconds)
  values (p_account_id, p_video_id, p_position, coalesce(p_narration, ''), p_duration_seconds)
  on conflict (video_id, position) do update
    set narration        = excluded.narration,
        duration_seconds = excluded.duration_seconds
  returning id into v_scene_id;

  delete from shots where scene_id = v_scene_id;

  for v_shot in select * from jsonb_array_elements(coalesce(p_shots, '[]'::jsonb))
  loop
    insert into shots (
      account_id, scene_id, position, description, source, stock_query, duration_seconds,
      visual_brief, kind, camera_spec, lighting_spec, provenance, hero, needs_speech, broadcast_4k
    )
    values (
      p_account_id,
      v_scene_id,
      (v_shot->>'position')::integer,
      coalesce(v_shot->>'description', ''),
      coalesce(v_shot->>'source', 'stock')::shot_source,
      v_shot->>'stock_query',
      nullif(v_shot->>'duration_seconds', '')::numeric,
      v_shot->'visual_brief',
      coalesce(v_shot->>'kind', 'live_action')::shot_kind,
      v_shot->'camera_spec',
      v_shot->'lighting_spec',
      v_shot->'provenance',
      coalesce((v_shot->>'hero')::boolean, false),
      coalesce((v_shot->>'needs_speech')::boolean, false),
      coalesce((v_shot->>'broadcast_4k')::boolean, false)
    );
  end loop;

  return v_scene_id;
end;
$$;

grant execute on function public.upsert_scene_with_shots(uuid, uuid, integer, text, numeric, jsonb) to service_role;
