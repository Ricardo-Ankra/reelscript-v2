-- =============================================================================
-- Caption emphasis revision (2026-06-16) — rename the settings key
--   kinetic_text_usage → caption_emphasis_density   (values: off | sparing | liberal)
--
-- Kinetic text is folded into the animated caption track; the per-video / per-channel
-- toggle that used to govern KineticText now governs caption emphasis DENSITY. The
-- values are unchanged (off|sparing|liberal), so this is a pure key rename of an
-- existing JSONB property. Done now (pre-launch) so there is no compatibility shim.
--
-- The setting lives inside JSONB (videos.settings, channels.defaults) — there is no
-- dedicated column. RLS is unchanged. Idempotent: only touches rows that still carry
-- the old key.
-- =============================================================================

update videos
set settings = (settings - 'kinetic_text_usage')
  || jsonb_build_object('caption_emphasis_density', settings -> 'kinetic_text_usage')
where settings ? 'kinetic_text_usage';

update channels
set defaults = (defaults - 'kinetic_text_usage')
  || jsonb_build_object('caption_emphasis_density', defaults -> 'kinetic_text_usage')
where defaults ? 'kinetic_text_usage';
