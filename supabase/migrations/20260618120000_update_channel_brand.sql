-- Phase 8 — channel brand editor. One atomic write of the channel's editable
-- brand surface. brand_kit is SHALLOW-MERGED (brand_kit || patch) so sibling
-- keys owned by later slices (caption_emphasis, caption_style, logos) survive;
-- brand_voice and defaults are written wholesale (this editor owns all their
-- keys). SECURITY INVOKER → the caller's RLS on channels applies (acct_isolation
-- with check (auth_owns_account(account_id))), so only the owner's row updates.
-- RETURNS the updated id (NULL when no row matched) so the action can tell a
-- real save from a zero-row miss and never report a phantom "Saved".
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
      defaults    = p_defaults,
      updated_at  = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function update_channel_brand(uuid, text, jsonb, jsonb, jsonb) to authenticated;
