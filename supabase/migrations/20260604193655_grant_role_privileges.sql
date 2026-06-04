-- =============================================================================
-- Role privileges for the Supabase API roles
-- =============================================================================
-- RLS (migration 0001) decides WHICH ROWS a caller may touch. It does not grant
-- the base table privilege a role needs to issue the statement at all — that is
-- a separate GRANT. On the local stack Supabase's default privileges hand these
-- grants to anon/authenticated/service_role automatically, but tables created by
-- `supabase db push` on a hosted project do not inherit them, so authenticated
-- requests fail with "permission denied for table ...". This migration makes the
-- schema self-sufficient: it grants the privileges explicitly and sets default
-- privileges so future objects are covered too.
--
-- This does NOT weaken isolation. anon/authenticated are not table owners and do
-- not have BYPASSRLS, so every row they touch is still filtered by the policies.
-- service_role (BYPASSRLS, used by the Inngest worker from Phase 1) needs these
-- grants to operate at all.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- GRANT ON ALL TABLES includes views, so the cost views are covered too.
grant all on all tables in schema public
  to anon, authenticated, service_role;
grant all on all sequences in schema public
  to anon, authenticated, service_role;
grant execute on all functions in schema public
  to anon, authenticated, service_role;

-- Cover objects added by future migrations without another grant pass.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
