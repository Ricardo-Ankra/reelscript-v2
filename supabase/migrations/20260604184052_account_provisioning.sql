-- =============================================================================
-- Account provisioning on sign-up
-- =============================================================================
-- The schema's RLS model keys every table to an accounts row via
-- auth_owns_account(), but nothing creates that row when a user signs up. This
-- trigger fills the gap: on every new auth.users insert it creates the owning
-- accounts row, so a user has an account from their very first authenticated
-- request (and the Phase 0 RLS check can be demonstrated at all).
--
-- SECURITY DEFINER: the function runs as its owner (the admin role), so it can
-- write to accounts during sign-up, before the new user has any RLS context of
-- their own. search_path is pinned to keep the definer-privileged body from
-- resolving objects through a caller-controlled path.
--
-- Name is NEVER null (accounts.name is NOT NULL). Email/password sign-up may not
-- collect a display name, so we derive a sensible default: an explicit display
-- name if present, else the email local-part, else the full email, with a final
-- literal backstop.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  account_name text;
begin
  account_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(split_part(new.email, '@', 1)), ''),
    nullif(trim(new.email), ''),
    'My Account'
  );

  insert into public.accounts (owner_user_id, name)
  values (new.id, account_name)
  on conflict (owner_user_id) do nothing;

  return new;
end;
$$;

-- Fire once per created user.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
