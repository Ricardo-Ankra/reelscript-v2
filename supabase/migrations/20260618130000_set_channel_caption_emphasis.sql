-- Phase 8 — caption-emphasis tables editor. Writes ONLY brand_kit.caption_emphasis
-- via jsonb_set (create_missing=true), preserving sibling keys (colors, typography,
-- motion_preset, logos) that other slices own. SECURITY INVOKER → the caller's RLS
-- on channels applies (acct_isolation with check (auth_owns_account(account_id))).
-- RETURNS the updated id (NULL when no row matched) so the action never reports a
-- phantom "Saved".
create or replace function set_channel_caption_emphasis(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set brand_kit  = jsonb_set(brand_kit, '{caption_emphasis}', p_value, true),
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_caption_emphasis(uuid, jsonb) to authenticated;
