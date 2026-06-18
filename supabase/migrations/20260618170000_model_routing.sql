-- Phase 8 — model routing. Per-account map of task → Anthropic model id, e.g.
-- { "script_generation": "claude-opus-4-8", ... }. Empty {} → code defaults apply.
alter table accounts
  add column if not exists model_routing jsonb not null default '{}'::jsonb;

-- Writes the caller's own account's model_routing wholesale (the editor owns all
-- four keys). SECURITY INVOKER → only the owner (owner_user_id = auth.uid()) can
-- write. RETURNS the updated id (NULL when no row matched) → no phantom save.
create or replace function set_account_model_routing(p_value jsonb)
returns uuid
language sql
security invoker
as $$
  update accounts
  set model_routing = p_value,
      updated_at    = now()
  where owner_user_id = auth.uid()
  returning id;
$$;

grant execute on function set_account_model_routing(jsonb) to authenticated;
