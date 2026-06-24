-- Reelscript V2 Slice 2b: the ingest data contract. Additive — conform-output columns on
-- shots, written by 2b's ingestShots pipeline. footage_key = the conformed clip/still in
-- R2 (target dims/fps); style_ref_key = a representative still (extract+store only, not
-- wired to generation yet). No RPC change — these are pipeline outputs, never authored by
-- script-gen.
alter table shots add column if not exists footage_key   text;
alter table shots add column if not exists style_ref_key text;
