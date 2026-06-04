-- =============================================================================
-- Reelscript V2 — Database Schema
-- Target: Supabase (PostgreSQL 15+)
-- =============================================================================
-- This file is the buildable schema behind the design spec (rev 8). It is
-- organised by domain: account, channel, video, render, cost, jobs, cache.
--
-- Conventions:
--   * uuid primary keys via gen_random_uuid()
--   * timestamptz everywhere, default now()
--   * EVERY application table carries account_id, so Row-Level Security is a
--     single, uniform check. This is the concrete form of the spec's
--     "account-scoped from day one" decision.
--   * Files (logos, audio, renders, uploads) live in Cloudflare R2; the DB
--     stores R2 object keys (text), never bytes.
--   * RLS is enabled on every table. The Inngest worker uses the Supabase
--     service role, which bypasses RLS, to write job/render results.
--
-- Run order matters (FKs); execute top to bottom.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type credential_provider as enum
  ('anthropic', 'openai', 'google', 'elevenlabs', 'pexels', 'pixabay');

create type ai_task as enum
  ('script_generation', 'video_composition', 'shot_edit',
   'resource_tagging', 'thumbnail_copy', 'primitive_drafting');

create type social_platform as enum
  ('youtube', 'instagram', 'tiktok', 'facebook');

create type channel_status as enum ('active', 'archived');

create type resource_kind as enum
  ('image', 'video', 'audio', 'document', 'url');

create type primitive_status as enum ('active', 'archived');

create type audio_status as enum
  ('not_synthesized', 'synthesized', 'stale');

create type shot_source as enum ('stock', 'resource', 'procedural');

create type render_status as enum
  ('queued', 'composing', 'resolving_assets', 'validating',
   'rendering', 'encoding', 'complete', 'failed');

create type job_type as enum
  ('script_generation', 'voice_synthesis', 'render', 'primitive_deploy');

create type job_status as enum
  ('queued', 'running', 'paused', 'failed', 'complete');

-- The failure taxonomy from spec section 15.1.
create type failure_class as enum
  ('transient', 'rate_limited', 'quota_exhausted',
   'hard', 'partial_render', 'bundle_deploy');

-- A paid-operation ledger entry's operation kind (cost model, spec 3.6).
create type cost_operation as enum
  ('script_generation', 'shot_edit', 'voice_synthesis',
   'composition', 'render', 'smoke_frame', 'music_remux',
   'resource_tagging', 'thumbnail_copy', 'asset_search');

-- =============================================================================
-- Shared helpers
-- =============================================================================

-- Touch updated_at on UPDATE. Attached to tables that track modification time.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- ACCOUNT DOMAIN
-- An account is the tenant boundary. In V1 it is one operator (one auth user),
-- but the model is multi-tenant-ready: every other table references account_id.
-- =============================================================================

create table accounts (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users (id) on delete cascade,
  name            text not null,
  -- Cost-monitoring alert (spec 3.6): off by default, observe-not-enforce.
  monthly_cost_alert_usd  numeric(10,2),         -- null = no threshold set
  monthly_cost_alert_on   boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index accounts_owner_idx on accounts (owner_user_id);

-- RLS helper: does the current user own this account?
-- SECURITY DEFINER so the policy can read accounts regardless of the caller's
-- own RLS context. STABLE so the planner can cache within a statement.
create or replace function public.auth_owns_account(acct uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a
    where a.id = acct and a.owner_user_id = auth.uid()
  );
$$;
grant execute on function public.auth_owns_account(uuid) to authenticated;

-- API credentials. Encrypted at rest; the app layer (or Supabase Vault)
-- performs encryption — the ciphertext is stored here and never returned to
-- the client after entry.
create table api_credentials (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  provider        credential_provider not null,
  label           text,
  encrypted_value text not null,
  status          text not null default 'unverified',  -- unverified|valid|invalid
  last_validated_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (account_id, provider, label)
);
create index api_credentials_account_idx on api_credentials (account_id);

-- Per-task model routing (spec 3.4). One row per task per account.
create table model_routing (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts (id) on delete cascade,
  task        ai_task not null,
  provider    credential_provider not null,
  model       text not null,            -- provider model identifier
  -- composition task may enable extended thinking (spec 8.7)
  thinking_enabled boolean not null default false,
  thinking_budget  integer,             -- tokens; null unless thinking_enabled
  unique (account_id, task)
);
create index model_routing_account_idx on model_routing (account_id);

-- ElevenLabs voice profiles (spec 3.7). Maps the fixed internal emotion
-- vocabulary to one model's capabilities. Models are fetched live from
-- ElevenLabs; this stores the chosen mapping. is_fallback marks the built-in
-- conservative profile used for unprofiled models.
create table voice_profiles (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references accounts (id) on delete cascade,
  elevenlabs_model_id text not null,    -- e.g. eleven_multilingual_v2
  model_name          text not null,    -- display name from the API
  tag_mappings        jsonb not null default '{}'::jsonb,
    -- shape: { "<excited>": {"mode":"audio_tag","value":"..."},
    --          "<pause>":   {"mode":"ssml_break"},
    --          "<whisper>": {"mode":"strip","nudge":{"stability":-0.1}} }
  is_fallback         boolean not null default false,
  created_at          timestamptz not null default now(),
  unique (account_id, elevenlabs_model_id)
);
create index voice_profiles_account_idx on voice_profiles (account_id);
-- At most one fallback profile per account.
create unique index voice_profiles_one_fallback
  on voice_profiles (account_id) where is_fallback;

-- Social publishing integrations (drafts only, spec 3.5).
create table social_integrations (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  platform        social_platform not null,
  access_token    text not null,        -- encrypted at rest
  refresh_token   text,                 -- encrypted at rest
  scopes          text[] not null default '{}',
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (account_id, platform)
);
create index social_integrations_account_idx on social_integrations (account_id);

-- Primitives (spec 9). Account-scoped because a primitive is brand-agnostic
-- and reusable across all of an account's channels. prop_schema carries the
-- per-prop lifecycle (active|deprecated|removed, spec 9.3). Pragmatic
-- versioning (spec 8.2): version bumps on edit; the deployed Remotion site
-- holds the current version.
create table primitives (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  name          text not null,
  description   text,
  code          text not null,          -- the React/Remotion component source
  prop_schema   jsonb not null default '[]'::jsonb,
    -- shape: [ { "name":"value","type":"string","state":"active","default":null },
    --          { "name":"legacyMode","type":"boolean","state":"deprecated","default":false } ]
  version       integer not null default 1,
  status        primitive_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account_id, name)
);
create index primitives_account_idx on primitives (account_id);
create trigger primitives_touch before update on primitives
  for each row execute function set_updated_at();

-- =============================================================================
-- CHANNEL DOMAIN
-- A channel is a complete brand definition. brand_voice and brand_kit are
-- structured JSONB (the spec's Brand voice and Visual identity sections); the
-- collections under a channel (resources, music, structures, templates) are
-- their own tables.
-- =============================================================================

create table channels (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  name          text not null,
  status        channel_status not null default 'active',
  brand_voice   jsonb not null default '{}'::jsonb,
    -- persona, audience, voice_guide, tone_tags[], dos[], donts[],
    -- banned_words[], hook_styles[], cta_styles[], reference_scripts[]
  brand_kit     jsonb not null default '{}'::jsonb,
    -- logo variants (R2 keys), palette tokens, typography, motion_preset,
    -- caption_style, kinetic_text_style, watermark
  voice_tts     jsonb not null default '{}'::jsonb,
    -- elevenlabs voice_id, model, stability, similarity_boost, style, speaker_boost
  defaults      jsonb not null default '{}'::jsonb,
    -- channel-level defaults: captions per ratio, kinetic-text usage, music on/off
  deleted_at    timestamptz,            -- 30-day soft delete (spec 4.7)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index channels_account_idx on channels (account_id);
create trigger channels_touch before update on channels
  for each row execute function set_updated_at();

-- Uploaded resources (spec 4.3). content_hash backs the file-bytes dedupe;
-- tags are populated by the fast synchronous tag on upload (spec 13.5).
create table channel_resources (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  channel_id      uuid not null references channels (id) on delete cascade,
  kind            resource_kind not null,
  r2_key          text,                 -- null for kind='url'
  source_url      text,                 -- the external URL for kind='url'
  original_filename text,
  content_hash    text,                 -- sha-256 of bytes (dedupe)
  description     text,                 -- AI-generated, user-editable
  tags            text[] not null default '{}',
  created_at      timestamptz not null default now()
);
create index channel_resources_channel_idx on channel_resources (channel_id);
create index channel_resources_tags_idx on channel_resources using gin (tags);

-- Seeded + user music library (spec 4.3). Used only when a video's music
-- toggle is on (spec 4.2.3). mood_tags drive the AI's initial track pick.
create table music_tracks (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  channel_id      uuid not null references channels (id) on delete cascade,
  source          text not null,        -- 'pexels' | 'upload'
  external_id     text,
  r2_key          text not null,
  title           text,
  mood_tags       text[] not null default '{}',
  duration_seconds numeric(8,2),
  attribution     text,
  created_at      timestamptz not null default now()
);
create index music_tracks_channel_idx on music_tracks (channel_id);

-- Reusable scene-structure recipes (spec 4.4).
create table show_structures (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  channel_id    uuid not null references channels (id) on delete cascade,
  name          text not null,
  scenes        jsonb not null default '[]'::jsonb,  -- [{role,duration,defaults}]
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index show_structures_channel_idx on show_structures (channel_id);

-- Thumbnail templates (spec 4.5). spec = typed elements + slot bindings.
create table thumbnail_templates (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  channel_id    uuid not null references channels (id) on delete cascade,
  name          text not null,
  spec          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index thumbnail_templates_channel_idx on thumbnail_templates (channel_id);

-- =============================================================================
-- VIDEO DOMAIN
-- Projects are pure organisation. Scenes are the LIVE authoritative working
-- state (spec 7.1). ScriptRevisions are immutable snapshots.
-- =============================================================================

create table projects (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  channel_id    uuid not null references channels (id) on delete cascade,
  name          text not null,
  created_at    timestamptz not null default now()
);
create index projects_channel_idx on projects (channel_id);

create table videos (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  channel_id    uuid not null references channels (id) on delete cascade,
  project_id    uuid references projects (id) on delete set null,  -- spec 5: deletes move to root
  title         text not null,
  settings      jsonb not null default '{}'::jsonb,
    -- aspect_ratio, target_length, fps, captions_on, kinetic_text_usage,
    -- music_on, show_structure_id
  -- current pointers (spec 7.3); FKs added after the referenced tables exist.
  current_render_id          uuid,
  current_script_revision_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index videos_channel_idx on videos (channel_id);
create index videos_project_idx on videos (project_id);
create trigger videos_touch before update on videos
  for each row execute function set_updated_at();

-- Immutable point-in-time snapshot of all scenes at a save point (spec 7.1).
-- content is a serialized copy of the scenes (and their shots); it is never a
-- parallel live authority. Last 20 retained per video (enforced in app logic).
create table script_revisions (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references accounts (id) on delete cascade,
  video_id           uuid not null references videos (id) on delete cascade,
  content            jsonb not null,    -- serialized snapshot of scenes + shots
  edit_summary       text,
  parent_revision_id uuid references script_revisions (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index script_revisions_video_idx on script_revisions (video_id, created_at desc);

-- LIVE authoritative scene state. narration is the source of truth; the script
-- panel is a stitched view of these. audio_status tracks synthesis staleness
-- (spec 6.4): editing narration flips the scene to 'stale'.
create table scenes (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  video_id        uuid not null references videos (id) on delete cascade,
  position        integer not null,     -- ordering ("order" is reserved)
  narration       text not null default '',
  duration_seconds numeric(8,2),
  audio_r2_key    text,                 -- voiceover for this scene, in R2
  word_alignments jsonb,                -- ElevenLabs character/word timings
  audio_status    audio_status not null default 'not_synthesized',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (video_id, position)
);
create index scenes_video_idx on scenes (video_id, position);
create trigger scenes_touch before update on scenes
  for each row execute function set_updated_at();

-- Shots are the visual breakdown of a scene (storyboard). Live working state,
-- edited in Phase 3. source declares how the shot's media is obtained.
create table shots (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  scene_id        uuid not null references scenes (id) on delete cascade,
  position        integer not null,
  description     text not null default '',  -- the AI's intent for this shot
  source          shot_source not null default 'stock',
  resource_id     uuid references channel_resources (id) on delete set null,
                  -- set when source='resource'
  stock_query     text,                 -- the search intent when source='stock'
  duration_seconds numeric(8,2),
  created_at      timestamptz not null default now(),
  unique (scene_id, position)
);
create index shots_scene_idx on shots (scene_id, position);

-- =============================================================================
-- RENDER DOMAIN
-- A render is self-contained via its composition spec (which embeds the theme
-- snapshot, spec 8.2). Preserved indefinitely (spec 7.2).
-- =============================================================================

create table renders (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references accounts (id) on delete cascade,
  video_id             uuid not null references videos (id) on delete cascade,
  script_revision_id   uuid not null references script_revisions (id),
  composition_spec_r2_key text,         -- the spec is stored in R2, passed by pointer
  output_r2_key        text,            -- the final MP4
  status               render_status not null default 'queued',
  idempotency_key      text not null,   -- hash(spec + script_revision); dedupes resubmits
  error                jsonb,           -- set on status='failed' (class, phase, detail)
  render_date          timestamptz,     -- completion time
  created_at           timestamptz not null default now(),
  unique (account_id, idempotency_key)
);
create index renders_video_idx on renders (video_id, created_at desc);

-- Deferred FKs for the video current-pointers (renders/script_revisions now exist).
alter table videos
  add constraint videos_current_render_fk
  foreign key (current_render_id) references renders (id) on delete set null;
alter table videos
  add constraint videos_current_revision_fk
  foreign key (current_script_revision_id) references script_revisions (id) on delete set null;

-- Which primitives a video uses, populated at composition time. Backs the
-- primitive usage_count and the "delete only at zero usage" rule (spec 9.8).
create table primitive_usages (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  primitive_id  uuid not null references primitives (id) on delete cascade,
  video_id      uuid not null references videos (id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (primitive_id, video_id)
);
create index primitive_usages_primitive_idx on primitive_usages (primitive_id);
create index primitive_usages_video_idx on primitive_usages (video_id);

-- =============================================================================
-- COST LEDGER (spec 3.6)
-- One append-only ledger of every paid operation, tagged with the video (and
-- render, where applicable). All cost figures are derived from this table:
--   per-render cost  = sum(cost_usd) where render_id = X
--   per-video total  = sum(cost_usd) where video_id  = X   (lifetime spend)
--   monthly spend    = sum(cost_usd) where account_id = X and created_at in month
-- =============================================================================

create table cost_events (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  video_id      uuid references videos (id) on delete set null,
  render_id     uuid references renders (id) on delete set null,
  operation     cost_operation not null,
  provider      text not null,          -- anthropic|openai|elevenlabs|aws_lambda|...
  units         numeric(14,4),          -- tokens, characters, seconds, etc.
  cost_usd      numeric(12,6) not null,
  created_at    timestamptz not null default now()
);
create index cost_events_video_idx   on cost_events (video_id);
create index cost_events_render_idx  on cost_events (render_id);
create index cost_events_account_idx on cost_events (account_id, created_at);

-- Convenience views (optional; the app can also aggregate directly).
create view video_costs as
  select video_id, sum(cost_usd) as lifetime_cost_usd
  from cost_events where video_id is not null group by video_id;

create view render_costs as
  select render_id, sum(cost_usd) as render_cost_usd
  from cost_events where render_id is not null group by render_id;

-- =============================================================================
-- JOBS & RESILIENCE (spec 15)
-- Inngest is the orchestrator; this table mirrors job state for resumability
-- visibility and the in-app recent-failures surface (spec 15.4). checkpoint
-- records the last completed phase so a resume picks up from there (spec 15.2).
-- =============================================================================

create table jobs (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  video_id      uuid references videos (id) on delete cascade,   -- null for primitive_deploy
  render_id     uuid references renders (id) on delete cascade,  -- set for render jobs
  type          job_type not null,
  status        job_status not null default 'queued',
  phase         text,                   -- current/last phase label
  checkpoint    jsonb not null default '{}'::jsonb,  -- durable resume state
  failure_class failure_class,          -- set when status in ('failed','paused')
  error         jsonb,                  -- message, context, failing-frame ref
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index jobs_account_status_idx on jobs (account_id, status);
create index jobs_video_idx on jobs (video_id);
create trigger jobs_touch before update on jobs
  for each row execute function set_updated_at();

-- =============================================================================
-- ASSET CACHE (spec 13.6)
-- Two layers: search-result cache (TTL) and content-hashed file cache. Scoped
-- to account for uniform RLS; could be made global later for cross-account
-- dedupe.
-- =============================================================================

create table asset_search_cache (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  query_hash    text not null,          -- hash(source,query,kind,orientation,min_width)
  results       jsonb not null,         -- the provider response (candidate metadata)
  expires_at    timestamptz not null,   -- 7-day TTL
  created_at    timestamptz not null default now(),
  unique (account_id, query_hash)
);
create index asset_search_cache_expiry_idx on asset_search_cache (expires_at);

create table asset_files (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts (id) on delete cascade,
  content_hash  text not null,          -- sha-256 of the downloaded bytes
  r2_key        text not null,
  source        text not null,          -- pexels|pixabay
  original_url  text,
  kind          resource_kind not null,
  created_at    timestamptz not null default now(),
  unique (account_id, content_hash)
);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- Enable on every table and apply the uniform account-ownership policy.
-- accounts is the one special case (keyed on owner_user_id directly).
-- The service role used by the Inngest worker bypasses RLS automatically.
-- =============================================================================

alter table accounts              enable row level security;
alter table api_credentials       enable row level security;
alter table model_routing         enable row level security;
alter table voice_profiles        enable row level security;
alter table social_integrations   enable row level security;
alter table primitives            enable row level security;
alter table channels              enable row level security;
alter table channel_resources     enable row level security;
alter table music_tracks          enable row level security;
alter table show_structures       enable row level security;
alter table thumbnail_templates   enable row level security;
alter table projects              enable row level security;
alter table videos                enable row level security;
alter table script_revisions      enable row level security;
alter table scenes                enable row level security;
alter table shots                 enable row level security;
alter table renders               enable row level security;
alter table primitive_usages      enable row level security;
alter table cost_events           enable row level security;
alter table jobs                  enable row level security;
alter table asset_search_cache    enable row level security;
alter table asset_files           enable row level security;

-- accounts: a user sees only their own account row.
create policy accounts_owner on accounts
  for all using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Uniform policy for every account-scoped table.
create policy acct_isolation on api_credentials
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on model_routing
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on voice_profiles
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on social_integrations
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on primitives
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on channels
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on channel_resources
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on music_tracks
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on show_structures
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on thumbnail_templates
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on projects
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on videos
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on script_revisions
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on scenes
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on shots
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on renders
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on primitive_usages
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on cost_events
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on jobs
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on asset_search_cache
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
create policy acct_isolation on asset_files
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));

-- =============================================================================
-- NOTES / DELIBERATE DEFERRALS
-- * Primitive prop-schema lifecycle (active/deprecated/removed) lives inside
--   primitives.prop_schema rather than as columns, so the AI-facing view
--   (active only) and validation view (active+deprecated) derive from one
--   object and cannot drift (spec 9.3).
-- * Pragmatic primitive versioning: primitives.version bumps on edit; the
--   deployed Remotion site holds the current version. Rigorous versioning
--   into the composition spec is deferred (spec 8.2 callout).
-- * No hard storage caps in V1 (spec 3.6) — no quota tables.
-- * Retention of the last 20 script revisions is enforced in application
--   logic, not a DB constraint.
-- * Encryption of credential/token columns is performed by the app layer or
--   Supabase Vault; the schema stores ciphertext only.
-- =============================================================================
