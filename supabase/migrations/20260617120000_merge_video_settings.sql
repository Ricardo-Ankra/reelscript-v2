-- Phase 8 — video settings panel: atomic JSONB merge for video.settings.
-- A single-statement shallow merge (settings || patch) so concurrent per-key
-- toggles can't lose each other to a stale read-modify-write. SECURITY INVOKER, so
-- the caller's RLS on `videos` applies (only the owner's row updates). Returns the
-- new settings (NULL if no row matched), which the server action reconciles to.
create or replace function merge_video_settings(p_video_id uuid, p_patch jsonb)
returns jsonb
language sql
security invoker
as $$
  update videos
  set settings = settings || p_patch
  where id = p_video_id
  returning settings;
$$;

grant execute on function merge_video_settings(uuid, jsonb) to authenticated;
