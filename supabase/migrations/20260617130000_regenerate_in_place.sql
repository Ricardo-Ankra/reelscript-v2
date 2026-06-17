-- Phase 8 — regenerate video in place.
--
-- 1) Persist the user prompt so an existing video can be regenerated. Nullable,
--    NO backfill: videos created before this column have prompt = null, and the
--    regenerate form starts empty for them. startScriptGeneration is extended in the
--    same slice to write this going forward.
alter table videos add column if not exists prompt text;

-- 2) Authoritative concurrency stop: at most one in-flight script_generation job per
--    video. Partial (only queued/running rows), scoped to script_generation so it does
--    not constrain coexisting voice_synthesis/render jobs. Two racing regenerateVideo
--    calls can't both enqueue — the second insert fails with unique_violation (23505).
create unique index if not exists jobs_one_inflight_generation
  on jobs (video_id)
  where type = 'script_generation' and status in ('queued', 'running');
