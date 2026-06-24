// =============================================================================
// Reelscript V2 — API Surface
// =============================================================================
// The boundary between the frontend, Vercel, Inngest, and Supabase, expressed as
// typed contracts. The governing rule (spec 2.1): the frontend holds no secrets
// and runs no long jobs. That splits the surface into three tiers.
//
//   Tier 1  Direct Supabase client, protected by RLS. Most reads and writes.
//           No custom server code — the database IS the API for plain data.
//   Tier 2  Vercel server actions / route handlers. Anything touching a secret
//           (provider keys), needing trusted server logic, or kicking off a job.
//   Tier 3  Inngest functions. The long, multi-step jobs, triggered by events
//           emitted from Tier 2, fed by webhooks.
//
// Types below use `string` for ids with a comment naming the entity; swap for
// branded types in the real codebase if desired. Shapes reference the schema
// (reelscript_v2_schema.sql) and the primitive contract (primitive-contract.ts).
// =============================================================================

import type { PropSchema, PrimitiveMeta, PrimitiveInstance } from '../contracts/primitive-contract';

// Shared
type Id = string; // uuid
type R2Key = string;
type ISO = string; // ISO-8601 timestamp

// =============================================================================
// TIER 1 — Direct Supabase client (RLS-enforced). No custom endpoints.
// =============================================================================
// The frontend uses the Supabase JS client for these, and RLS (spec 12) makes
// them safe — a user can only ever touch rows under their own account. Listed
// here so the surface is complete, not because they need handlers.
//
//   Read / list / create / update / soft-delete:
//     channels, projects, videos, scenes, shots, channel_resources (metadata),
//     music_tracks (metadata), show_structures,
//     voice_profiles (rows; the model *list* is Tier 2), model_routing,
//     account cost-alert settings.
//   Read-only from the client (written only by Tier 2/3 server code):
//     renders, script_revisions, jobs, cost_events + the cost views,
//     primitives (authored via Tier 2), primitive_usages.
//
// Two writes that look like plain data but carry a rule, handled by DB triggers
// rather than server round-trips:
//   * editing scenes.narration flips audio_status 'synthesized' -> 'stale'
//     (spec 6.4) — a BEFORE UPDATE trigger, so the client just writes the text.
//   * scene reorder / merge / split are client transactions on scene rows;
//     merge/split are deliberate actions, not side effects of typing (spec 13.4).
//
// Realtime subscriptions (spec 13.3), also via the Supabase client:
export interface RealtimeChannels {
  // render + synthesis progress and streaming all ride Supabase Realtime.
  'job:{jobId}': { status: string; phase?: string; percent?: number; elapsedMs: number };
  'scene-audio:{videoId}': { sceneId: Id; audio_status: 'not_synthesized' | 'synthesized' | 'stale' };
  'script-stream:{jobId}': { delta: string; done: boolean }; // token-by-token script gen
}

// =============================================================================
// TIER 2 — Vercel server actions / route handlers
// =============================================================================
// Each runs server-side on Vercel, holds the relevant secret, does quick work or
// emits an Inngest event, and returns fast. Long work never happens inline here.

// ---- Account & credentials --------------------------------------------------
export interface CredentialApi {
  /** Validate a stored (or just-entered) provider key. Used by the test-now
   *  button (spec 3.3) and the first-run setup (spec 14). */
  testCredential(input: { provider: string; value?: string }): Promise<{ valid: boolean; detail?: string }>;

  /** Fetch the ElevenLabs models the account can access, for the voice-profile
   *  picker (spec 3.7). Select-never-type. Cached; refresh forces a refetch. */
  listElevenLabsModels(input: { refresh?: boolean }): Promise<{
    models: { id: string; name: string; capabilities?: Record<string, unknown> }[];
    fetchedAt: ISO;
  }>;
}

// ---- Resources --------------------------------------------------------------
export interface ResourceApi {
  /** Issue a signed R2 upload URL and create the channel_resources row. The
   *  client uploads bytes directly to R2 with this URL. */
  createResourceUpload(input: { channelId: Id; filename: string; kind: string }): Promise<{
    resourceId: Id;
    uploadUrl: string; // signed R2 PUT URL
  }>;

  /** Called after the client finishes the R2 upload. Runs the fast synchronous
   *  tag (vision/ASR) so the asset is immediately discoverable (spec 13.5). */
  confirmResourceUpload(input: { resourceId: Id }): Promise<{ tags: string[]; description: string }>;
}

// ---- Script & scenes --------------------------------------------------------
export interface ScriptApi {
  /** Kick off generation (spec 6.2). Emits `script/generate`; the script streams
   *  back over the `script-stream:{jobId}` Realtime channel. Returns immediately. */
  startScriptGeneration(input: {
    videoId: Id;
    prompt: string;
    config: { aspectRatio: string; targetLength: number; fps: number; captions: boolean; musicOn: boolean; showStructureId?: Id };
  }): Promise<{ jobId: Id }>;

  /** Quick per-shot regeneration (spec 6.3), Haiku, fast enough to run inline. */
  regenerateShot(input: { shotId: Id; instruction: string }): Promise<{ shot: ShotDto }>;

  /** Chat-with-the-prompter: returns a proposed change as a diff for preview
   *  before applying (spec 6.3). Applying is a Tier 1 write to the scenes. */
  chatWithPrompter(input: { videoId: Id; message: string }): Promise<{ proposedDiff: SceneDiff[] }>;

  /** Snapshot the live scenes into an immutable revision and prune to the last
   *  20 (spec 7.1). */
  createScriptRevision(input: { videoId: Id; editSummary?: string }): Promise<{ revisionId: Id }>;

  /** Rewrite the live scenes from a snapshot; resets audio_status as needed. */
  restoreScriptRevision(input: { videoId: Id; revisionId: Id }): Promise<{ ok: true }>;
}

// ---- Voice synthesis (spec 6.4) --------------------------------------------
export interface VoiceApi {
  /** Cost estimate before paying ElevenLabs (spec 6.4). Inline. */
  estimateSynthesis(input: { videoId: Id; sceneIds?: Id[] }): Promise<{ characters: number; estimatedUsd: number }>;

  /** Synthesize one scene or all stale/not-synthesized scenes. Emits
   *  `voice/synthesize`; the governor caps concurrency at 5 (spec 15.3). Per-scene
   *  status flips live over `scene-audio:{videoId}`. */
  synthesizeScenes(input: { videoId: Id; sceneIds?: Id[] /* omit = all */ }): Promise<{ jobId: Id }>;
}

// ---- Render & export --------------------------------------------------------
export interface RenderApi {
  /** Start a render (spec 6.5). Validates completeness (no not-synthesized
   *  scenes; stale needs explicit override), computes the idempotency key
   *  (spec 10.5), creates the Render row, emits `render/start`. Re-submitting an
   *  identical key returns the in-flight/complete render instead of a new one. */
  startRender(input: { videoId: Id; overrideStale?: boolean }): Promise<
    { renderId: Id; jobId: Id } | { blocked: 'unsynthesized_scenes'; sceneIds: Id[] }
  >;

  /** Change music on a finished render (spec 6.6). Emits `music/remux` — the
   *  cheap ffmpeg-Lambda path, never a re-render. No-op if the video has music
   *  off. */
  updateMusic(input: {
    renderId: Id;
    music: { trackId?: Id; volume?: number; duck?: number; loop?: boolean; cropMs?: [number, number]; fade?: [number, number] };
  }): Promise<{ jobId: Id }>;

  /** Push a render to a connected platform as a draft (never auto-publish,
   *  spec 6.6 / out-of-scope). Uses the stored OAuth token. */
  pushToSocial(input: { renderId: Id; platform: string }): Promise<{ externalDraftId: string }>;

  /** Signed R2 URL for downloading the MP4 (and optional sidecars). */
  getDownloadUrl(input: { renderId: Id; include?: ('mp4' | 'srt' | 'vtt' | 'stems')[] }): Promise<{ urls: Record<string, string> }>;
}

// ---- Primitive authoring studio (spec 9) -----------------------------------
export interface PrimitiveApi {
  /** Draft or edit a primitive's code from a natural-language instruction, using
   *  the primitive skill (spec 9.5). Returns code; may stream. Nothing is saved
   *  or trusted here — gates still gate. */
  draftPrimitive(input: { primitiveId?: Id; instruction: string; currentCode?: string }): Promise<{ code: string; proposedSchema: PropSchema }>;

  /** Run the four authoring gates (spec 9.6). Lint is static (server); compile,
   *  smoke, and brand-integration run on the isolated Lambda. Returns per-gate
   *  results and, on failure, the failing frame — the inputs to the bounded
   *  auto-fix loop (spec 9.6.1, orchestrated by repeated draft+runGates calls,
   *  2–3 automatic attempts before handing back). */
  runPrimitiveGates(input: { code: string; propSchema: PropSchema }): Promise<{
    passed: boolean;
    gates: { gate: 'lint' | 'compile' | 'smoke' | 'brand'; passed: boolean; reason?: string }[];
    failingFrameR2Key?: R2Key;
  }>;

  /** Persist a gated primitive. Enforces assertSchemaEvolution (spec 9.3) — a
   *  destructive schema edit is rejected here. Bumps version, then emits
   *  `primitive/deploy` to re-bundle the Remotion site (spec 9.7). */
  savePrimitive(input: { primitiveId?: Id; code: string; propSchema: PropSchema; meta: PrimitiveMeta }): Promise<{ primitiveId: Id; version: number; deployJobId: Id }>;

  /** Archive (retire from new videos) or delete (only at zero usage) — spec 9.8.
   *  Delete is rejected server-side if primitive_usages is non-empty. */
  setPrimitiveStatus(input: { primitiveId: Id; action: 'archive' | 'restore' | 'delete' }): Promise<{ ok: true } | { blocked: 'in_use'; usageCount: number }>;
}

// =============================================================================
// TIER 3 — Inngest functions (event-triggered long jobs)
// =============================================================================
// Tier 2 emits these events; Inngest runs the multi-step functions, each step
// checkpointing durably so a failure resumes from the last good step (spec 15.2).

export interface InngestEvents {
  'script/generate': { jobId: Id; videoId: Id; prompt: string; config: Record<string, unknown> };
  'voice/synthesize': { jobId: Id; videoId: Id; sceneIds: Id[] };
  'render/start': { jobId: Id; renderId: Id; videoId: Id };
  'render/lambda-complete': { renderId: Id; outputR2Key: R2Key; chunks: { index: number; ok: boolean }[] }; // from webhook
  'music/remux': { jobId: Id; renderId: Id; music: Record<string, unknown> };
  'primitive/deploy': { jobId: Id; primitiveId: Id; version: number };
}

// The render pipeline as ordered steps (spec 13.1). Each is an Inngest step.run
// (checkpointed) except where noted. Failure handling per the taxonomy (spec 15.1).
export type RenderPipelineStep =
  | 'compose' //        call composition model (thinking + agentic asset selection)
  | 'gate1' //          spec validation; retry with AI up to 2 (spec 11.1)
  | 'resolveAssets' //  cache/stock via the rate governor; sign URLs at this point
  | 'storeSpec' //      write composition spec to R2 (passed to Lambda by pointer)
  | 'gate2' //          smoke frame on Lambda + vision check (spec 11.2)
  | 'render' //         invoke Remotion Lambda; step.waitForEvent('render/lambda-complete')
  | 'remux' //          ffmpeg Lambda, only if music is on
  | 'finalize'; //      update Render row, post-render hooks (social drafts)

// =============================================================================
// WEBHOOKS (external -> Vercel route handler -> Inngest event)
// =============================================================================
export interface Webhooks {
  /** Remotion Lambda signals completion; the handler emits
   *  `render/lambda-complete`, which the waiting render step resumes on
   *  (the wait-for-event pattern, spec 10.6). */
  'POST /api/webhooks/lambda-render': { renderId: Id; status: 'complete' | 'failed'; outputR2Key?: R2Key; error?: unknown };

  /** Social OAuth redirect; stores tokens in social_integrations. */
  'GET /api/webhooks/oauth/:platform': { code: string; state: string };
}

// =============================================================================
// Supporting DTOs (subset; shapes mirror the schema)
// =============================================================================
export interface ShotDto {
  id: Id;
  sceneId: Id;
  position: number;
  description: string;
  source: 'stock' | 'resource' | 'procedural';
  resourceId?: Id;
  stockQuery?: string;
  durationSeconds?: number;
}

export interface SceneDiff {
  sceneId: Id;
  before: string;
  after: string;
}

// Re-export the composition-layer type the render pipeline assembles, for
// callers that build or inspect specs.
export type { PrimitiveInstance };

// =============================================================================
// Notes
// * Auth: every Tier 2 action runs after Supabase Auth resolves the user; the
//   account is derived server-side, never trusted from the client. Tier 1 is
//   guarded by RLS regardless.
// * Why so few endpoints: plain CRUD is Tier 1 (Supabase + RLS), so Tier 2 is
//   only secrets, trusted logic, and job kickoff — which keeps the custom
//   surface small and the secret-holding code in one place.
// * Idempotency: startRender and updateMusic carry/derive idempotency keys so a
//   double-click or a step retry never starts duplicate paid work (spec 10.5).
// * The bounded auto-fix loop is not one endpoint; it is the studio repeatedly
//   calling draftPrimitive + runPrimitiveGates, capped at 2–3 automatic attempts
//   then handing back (spec 9.6.1).
// =============================================================================
