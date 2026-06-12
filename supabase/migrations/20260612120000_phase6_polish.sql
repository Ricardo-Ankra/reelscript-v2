-- =============================================================================
-- Phase 6 — Creative polish (captions, kinetic text, music + remux)
-- The render now outputs a VOICEOVER-ONLY base MP4; a dedicated ffmpeg Lambda
-- re-mixes the chosen music onto it (spec 10.1) into the final output. So a render
-- carries both pointers plus the music choice it was mixed with, and a re-mux key so
-- an identical re-save is a cache hit instead of a needless re-mix.
--
-- Captions live inside the composition spec JSON (no column); SRT/VTT sidecars live
-- in R2 at captions/{render_id}.{srt,vtt} (derived by convention, no column).
-- music_tracks already exists (schema rev 8); the music_remux cost op already exists.
-- RLS already covers renders via the uniform acct_isolation policy — no policy change.
-- =============================================================================

alter table renders
  add column if not exists base_output_r2_key text,          -- voiceover-only render (no music)
  add column if not exists music_track_id uuid
    references music_tracks (id) on delete set null,          -- the mixed-in track (null = music off)
  add column if not exists music_params jsonb not null default '{}'::jsonb,  -- mix params (volume, duck, loop, crop, fade)
  add column if not exists music_remux_key text;              -- hash(base,track,canonical(params)); cache guard
