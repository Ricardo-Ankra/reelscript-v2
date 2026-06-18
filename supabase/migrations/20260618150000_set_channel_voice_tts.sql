-- Phase 8 — channel voice params. Writes the whole voice_tts column (the editor
-- owns all its keys: voice_id, model, and the 4 tuning params). SECURITY INVOKER
-- → the caller's RLS on channels applies. RETURNS the updated id (NULL when no row
-- matched) so the action never reports a phantom "Saved".
create or replace function set_channel_voice_tts(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set voice_tts  = p_value,
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_voice_tts(uuid, jsonb) to authenticated;
