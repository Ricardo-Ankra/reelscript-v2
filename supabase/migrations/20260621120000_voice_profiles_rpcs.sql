-- Phase 8 slice 2 — voice profiles editor. Two account-scoped RPCs over the already
-- deployed voice_profiles table. SECURITY INVOKER → the table's RLS (acct_isolation)
-- still applies on the inner statements, and the account is resolved from auth.uid()
-- so the client cannot supply an account id. Each RETURNS the affected id, or NULL
-- when no account/row matched (→ a failure, never a phantom "Saved"). Mirrors
-- set_account_model_routing.

-- Upsert the caller's profile for one ElevenLabs model (the editor owns the whole
-- 7-tag mapping for that model).
create or replace function upsert_voice_profile(
  p_model_id     text,
  p_model_name   text,
  p_tag_mappings jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_account uuid;
  v_id uuid;
begin
  select id into v_account from accounts where owner_user_id = auth.uid();
  if v_account is null then return null; end if;

  insert into voice_profiles (account_id, elevenlabs_model_id, model_name, tag_mappings)
  values (v_account, p_model_id, p_model_name, p_tag_mappings)
  on conflict (account_id, elevenlabs_model_id)
  do update set model_name = excluded.model_name, tag_mappings = excluded.tag_mappings
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function upsert_voice_profile(text, text, jsonb) to authenticated;

-- Delete the caller's profile for one model.
create or replace function delete_voice_profile(p_model_id text) returns uuid
language plpgsql
security invoker
as $$
declare
  v_account uuid;
  v_id uuid;
begin
  select id into v_account from accounts where owner_user_id = auth.uid();
  if v_account is null then return null; end if;

  delete from voice_profiles
  where account_id = v_account and elevenlabs_model_id = p_model_id
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function delete_voice_profile(text) to authenticated;
