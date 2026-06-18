-- Phase 8 — channel video defaults. Writes the three format keys (aspect_ratio,
-- fps, target_length) into channels.defaults via a key-merge, preserving the
-- brand editor's sibling keys (captions_on, caption_emphasis_density, music_on).
-- SECURITY INVOKER → caller RLS on channels applies. RETURNS the updated id
-- (NULL when no row matched) → no phantom save.
create or replace function set_channel_video_defaults(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set defaults   = defaults || p_value,
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_video_defaults(uuid, jsonb) to authenticated;

-- Change the brand editor's defaults write from wholesale to a key-merge so the
-- video-defaults keys survive a brand save. Only the `defaults` line changes
-- (brand_kit was already merged; brand_voice stays wholesale).
create or replace function update_channel_brand(
  p_channel_id      uuid,
  p_name            text,
  p_brand_kit_patch jsonb,
  p_brand_voice     jsonb,
  p_defaults        jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set name        = p_name,
      brand_kit   = brand_kit || p_brand_kit_patch,
      brand_voice = p_brand_voice,
      defaults    = defaults || p_defaults,
      updated_at  = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function update_channel_brand(uuid, text, jsonb, jsonb, jsonb) to authenticated;
