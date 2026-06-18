-- Phase 8 — channel logos. Writes ONLY brand_kit.logos via jsonb_set
-- (create_missing=true), preserving sibling keys (colors, typography,
-- motion_preset, caption_emphasis) that other slices own. SECURITY INVOKER → the
-- caller's RLS on channels applies (acct_isolation with check
-- (auth_owns_account(account_id))). RETURNS the updated id (NULL when no row
-- matched) so the action never reports a phantom "Saved".
create or replace function set_channel_logos(
  p_channel_id uuid,
  p_logos      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set brand_kit  = jsonb_set(brand_kit, '{logos}', p_logos, true),
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_logos(uuid, jsonb) to authenticated;
