-- Slice C1: a structured, editable visual brief per shot (authored at script time),
-- and a 'generated' shot source for the later generation slice. Additive: the column
-- is nullable and the enum value is unused until slice D registers a generator.

alter table shots add column if not exists visual_brief jsonb;

-- Safe to add in this migration's txn (PG15): the value is not USED until committed.
alter type shot_source add value if not exists 'generated';

-- Rewrite the scene+shots upsert to also persist each shot's visual_brief (the
-- worker passes it under the snake_case "visual_brief" key in the p_shots array).
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
    insert into shots (account_id, scene_id, position, description, source, stock_query, duration_seconds, visual_brief)
    values (
      p_account_id,
      v_scene_id,
      (v_shot->>'position')::integer,
      coalesce(v_shot->>'description', ''),
      coalesce(v_shot->>'source', 'stock')::shot_source,
      v_shot->>'stock_query',
      nullif(v_shot->>'duration_seconds', '')::numeric,
      v_shot->'visual_brief'
    );
  end loop;

  return v_scene_id;
end;
$$;

grant execute on function public.upsert_scene_with_shots(uuid, uuid, integer, text, numeric, jsonb) to service_role;
