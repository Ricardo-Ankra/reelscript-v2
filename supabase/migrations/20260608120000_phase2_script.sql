-- =============================================================================
-- Phase 2 — Script & Scenes
-- 1. Enable Supabase Realtime (postgres_changes) on scenes, shots, jobs so the
--    editor can stream rows as the generator writes them. RLS still gates what
--    each subscriber receives (auth_owns_account). REPLICA IDENTITY FULL lets
--    Realtime evaluate RLS against the full row.
-- 2. upsert_scene_with_shots(): writes one scene + all its shots atomically in a
--    single transaction (one call per NDJSON line). The Supabase JS client can't
--    wrap two upserts in a client-side transaction, so this RPC guarantees a
--    card never appears without its shots and a mid-stream failure leaves N
--    complete scenes — never a scene with missing shots. Idempotent under
--    Inngest retries: scene upserts on (video_id, position); shots are replaced.
-- =============================================================================

-- 1. Realtime ---------------------------------------------------------------
alter table public.scenes replica identity full;
alter table public.shots  replica identity full;
alter table public.jobs   replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scenes'
  ) then
    alter publication supabase_realtime add table public.scenes;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shots'
  ) then
    alter publication supabase_realtime add table public.shots;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;
end $$;

-- 2. Atomic scene+shots upsert ----------------------------------------------
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

  -- Replace this scene's shots so a regeneration/retry converges to the
  -- generated set rather than accumulating stale rows.
  delete from shots where scene_id = v_scene_id;

  for v_shot in select * from jsonb_array_elements(coalesce(p_shots, '[]'::jsonb))
  loop
    insert into shots (account_id, scene_id, position, description, source, stock_query, duration_seconds)
    values (
      p_account_id,
      v_scene_id,
      (v_shot->>'position')::integer,
      coalesce(v_shot->>'description', ''),
      coalesce(v_shot->>'source', 'stock')::shot_source,
      v_shot->>'stock_query',
      nullif(v_shot->>'duration_seconds', '')::numeric
    );
  end loop;

  return v_scene_id;
end;
$$;

-- The Inngest worker calls this through the service-role client.
grant execute on function public.upsert_scene_with_shots(uuid, uuid, integer, text, numeric, jsonb) to service_role;
