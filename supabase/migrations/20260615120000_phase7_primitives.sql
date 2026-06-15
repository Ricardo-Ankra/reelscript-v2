-- =============================================================================
-- Phase 7 — Primitive authoring studio
-- A primitive is offered to the composition AI only once it is actually in the
-- deployed Remotion bundle (spec 9.7). deployed_version records the version that the
-- last successful primitive/deploy baked into the live site; compose offers a primitive
-- only when deployed_version = version. A save whose re-bundle fails stays
-- validated-but-not-deployed (deployed_version unchanged) and is NOT offered — the
-- bundle_deploy failure path (spec 15.1).
--
-- primitives, primitive_usages, the primitive_deploy job type, and the active/archived
-- status enum already exist (schema rev 8). RLS already covers primitives.
-- =============================================================================

alter table primitives
  add column if not exists deployed_version integer;  -- null = never deployed yet
