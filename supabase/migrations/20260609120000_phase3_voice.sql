-- =============================================================================
-- Phase 3 — Voice Synthesis
-- The audio-staleness rule as a BEFORE UPDATE trigger on scenes (the api-surface's
-- promised DB rule): when a scene's narration changes and its audio was
-- 'synthesized', the existing audio no longer matches the script, so flip it to
-- 'stale'. The client just writes narration text; the flip is automatic and
-- streams to the editor over the existing Phase 2 Realtime publication (scenes is
-- already published with replica identity full — no publication change needed).
--
-- Condition precision — the whole staleness model rests on this:
--   * OLD.narration IS DISTINCT FROM NEW.narration  (IS DISTINCT FROM, not <>, so
--     a null↔text change is still caught), AND
--   * OLD.audio_status = 'synthesized'              (only synthesized audio can go
--     stale; not_synthesized and stale are left alone).
--
-- Crucially this does NOT trip on the re-synthesis write: synthesis sets
-- audio_status='synthesized' (and audio_r2_key/word_alignments/duration_seconds)
-- WITHOUT changing narration, so OLD.narration IS DISTINCT FROM NEW.narration is
-- false and the trigger is a no-op. Regeneration (the upsert RPC) DOES change
-- narration, so a regenerated synthesized scene correctly goes stale.
-- =============================================================================

create or replace function public.scenes_audio_staleness()
returns trigger language plpgsql as $$
begin
  if old.narration is distinct from new.narration
     and old.audio_status = 'synthesized' then
    new.audio_status := 'stale';
  end if;
  return new;
end;
$$;

-- BEFORE UPDATE so the flip is part of the same write the client issues (no second
-- round-trip, no echo). Ordering vs. the existing scenes_touch (updated_at) trigger
-- is irrelevant — they touch disjoint columns.
drop trigger if exists scenes_audio_staleness on public.scenes;
create trigger scenes_audio_staleness
  before update on public.scenes
  for each row execute function public.scenes_audio_staleness();
