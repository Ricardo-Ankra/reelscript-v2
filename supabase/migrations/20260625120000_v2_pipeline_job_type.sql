-- V2 Slice 6a: a job_type for the master orchestration pipeline run. Additive — the
-- existing script_generation/voice_synthesis/render/primitive_deploy types are unchanged.
alter type job_type add value if not exists 'pipeline';
