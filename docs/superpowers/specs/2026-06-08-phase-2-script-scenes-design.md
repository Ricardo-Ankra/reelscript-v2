# Phase 2 — Script & Scenes — Design

**Status:** approved 2026-06-08
**Build plan phase:** Phase 2 ("a prompt becomes an editable script")
**Milestone:** type a prompt, watch the script stream in, edit a scene, see it persist.

## 1. Goal & scope

Turn a natural-language prompt into an editable script. The AI (Opus, via
Inngest) writes `scenes` + `shots` rows to the database; the editor reflects the
database over Supabase Realtime, so scenes appear one-by-one as they are
generated. The user edits scene narration with debounced autosave. Scenes are
the source of truth; the "stitched view" is simply the ordered scene cards read
top-to-bottom (one rendering path, no separate continuous-script pane).

### In scope (core only)
- A prompt box that creates a new video and kicks off generation.
- Opus generation (Inngest) writing scenes + shots to the DB.
- Row-level streaming into the editor via Realtime (postgres_changes).
- A single-column scene-card editor: editable narration, read-only shots.
- Debounced per-scene autosave (Tier-1 Supabase update).
- A `jobs` row for generation status + error surfacing.

### Explicitly deferred (anticipated structurally, not built)
Add/delete/reorder scenes; editable shots; revisions & restore; per-shot
regenerate & chat-with-prompter; video list / picker UI; the
`narration → audio_status='stale'` trigger; reading `model_routing`. The scene
card is laid out so the deferred features (audio status, regenerate action,
editable shots) drop in without a card redesign.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Streaming model | **Rows appear via DB Realtime** (postgres_changes on `scenes`/`shots`) | The source of truth *is* the stream; RLS-safe; no partial-JSON-to-UI plumbing; matches "scenes are the source of truth." |
| Generation method | **Streaming NDJSON, one scene per line** | One coherent, cheapest Opus call; trivial parsing (split on `\n`); genuine progressive appearance. |
| Entry flow | **Prompt creates a new video**, opens its editor | Non-destructive; each prompt = a fresh script; natural `/videos/[id]` route. |
| Video config | **Sensible defaults baked into `video.settings`**, no form | Keeps the UI to a prompt box, matching "type a prompt." |
| Editor layout | **Option A — single column of stacked scene cards** | The card maps 1:1 to a scene, which is the autosave boundary and (later) the audio-staleness boundary. UI unit = data unit. |
| Generation status | **A minimal `jobs` row**, surfaced via Realtime | Error surfacing matters (Phase 1 lesson); same mechanism voice/render reuse. |
| Per-line atomicity | **`upsert_scene_with_shots` RPC, one txn per line** | A card never appears without its shots; a mid-stream failure leaves N complete scenes. JS client can't transact two upserts. |
| Generation temperature | **Pinned low (e.g. 0.2)** | Reduces malformed-NDJSON risk — the top risk. |
| Config source of truth | **`video.settings` written once**, copied into the event | One authoritative source, not two independently-read ones. |
| Audio-staleness trigger | **Deferred to Phase 3** | No-op until voice exists (only flips `synthesized` rows). |

## 3. Architecture & data flow

```
Dashboard prompt box
   │  startScriptGeneration(prompt)        [Tier 2 server action]
   ▼
ensure seeded channel → create video (defaults) → create jobs row (queued)
   │  inngest.send('script/generate', { jobId, videoId, accountId, prompt, config })
   ▼  returns { videoId, jobId }
client router.push(`/videos/${videoId}`)

Inngest generate-script function          [Tier 3, service-role admin client]
   step: mark job running
   stream Opus (NDJSON, low temp) →
     for each completed line:
       Zod-validate scene → rpc upsert_scene_with_shots(...)   [1 txn: scene + shots]
       (malformed line → skip + increment skipped counter)
   step: mark job complete (+ scenes-written / skipped-line counts) or failed + error
        every scene/shot/jobs write ──► Supabase Realtime ──►
Editor (/videos/[id], client)
   subscribe postgres_changes: scenes & shots (filter video_id), jobs (filter id)
   render ordered SceneCards as INSERTs arrive
   job status drives "Generating… / done / error"
   edit narration → debounced Tier-1 scenes.update
```

All slow/secret work is on Inngest with the service-role admin client (no user
session in the worker), consistent with the Phase 1 render function. The browser
uses the RLS-protected publishable client for reads, Realtime, and autosave.

## 4. Schema / database changes

**One migration** (`supabase/migrations/<ts>_phase2_script.sql`), two parts:
- Add `scenes`, `shots`, and `jobs` to the `supabase_realtime` publication so
  postgres_changes events fire for them. RLS already restricts what each
  subscriber receives (rows whose `account_id` matches the authenticated user);
  no policy changes required.
- Create a Postgres function **`upsert_scene_with_shots(...)`** that upserts one
  scene and all of its shots in a **single transaction** (see Section 5,
  "Per-line atomicity"). The Inngest worker calls it once per NDJSON line via
  `rpc()`. It runs as the table owner / `security definer` with a fixed
  `search_path`; the worker already uses the service-role client, so no
  RLS interaction is required, but `account_id` is passed in explicitly and
  written on both the scene and its shots.

**No other schema changes.** Relevant existing structures (already applied in
`20260604184050_init_schema.sql`):
- `scenes(id, account_id, video_id, position, narration, duration_seconds,
  audio_status, …)`, `unique(video_id, position)`, `set_updated_at()` trigger.
- `shots(id, account_id, scene_id, position, description, source, resource_id,
  stock_query, duration_seconds)`, `unique(scene_id, position)`.
- `videos(… title, settings jsonb, current_script_revision_id, …)`.
- `channels(… name, brand_voice, brand_kit, voice_tts, defaults …)`.
- `jobs(id, account_id, video_id, type, status, phase, error, attempts, …)`.
- Enums: `job_type` includes `script_generation`; `job_status` is
  `queued|running|paused|failed|complete`; `shot_source` is
  `stock|resource|procedural`; `audio_status` is
  `not_synthesized|synthesized|stale`.

## 5. Generation pipeline

### Dependencies & config
- Add `@anthropic-ai/sdk` to `package.json`.
- Add an `anthropic.apiKey` lazy getter to `src/lib/env.server.ts` (same
  `required()` pattern as the rest). `ANTHROPIC_API_KEY` already exists in
  `.env.example`.
- **Model:** a single pinned constant (latest Opus) with a `TODO` to read
  `model_routing` when that is wired (Phase 9).
- **Temperature: pinned low (decided).** The generation call uses a low
  temperature (e.g. `0.2`). This directly reduces malformed-NDJSON risk — the
  top listed risk — by making structural output more deterministic.
- **Verify first (external unknown).** Before building the per-line parser,
  confirm against the `claude-api` reference whether the chosen approach is a
  **plain text stream** (model emits NDJSON as text, we split on `\n`) versus a
  **structured-output / tool-use** stream (which would deliver incremental tool
  JSON, not newline-delimited text). This is the one external unknown that could
  invalidate the per-line parsing design, so it is resolved *first* at
  implementation time. The locked decision is NDJSON-as-text; verification
  confirms the API shape that delivers it, and the exact model id.

### Config source of truth (decided)
Video config (aspect ratio, target length, fps, captions, music) has **one
authoritative source: `video.settings`**, written once when the Tier-2 action
creates the video. The same values are passed in the Inngest event payload as
`config` purely so the worker need not re-read the row — they are the *same*
values, not an independently-authored second source. The defaults live in one
place (the action) and flow: defaults → `video.settings` (write once) → event
`config` (copy) → prompt.

### Prompt
Built from: the user prompt; the seeded channel's brand (name + optional tone
from `brand_voice`); and the video config from the event payload (sourced from
`video.settings`, per "Config source of truth"). Instructions to the model:
- Output **one JSON object per line** (NDJSON). No prose, no markdown fences.
- Each line is one complete scene:
  `{ position, narration, durationSeconds, shots: [{ position, description, source, stockQuery? }] }`.
- `source` is one of `stock | resource | procedural`; include `stockQuery` when
  `source = "stock"`. Aim the total duration near the target length.

### Streaming insert
- Consume the Anthropic text stream; maintain a buffer. On each `\n`, take the
  completed line(s), leaving any partial trailing text buffered.
- For each completed line: parse JSON → **Zod-validate** against the scene
  schema. On failure, **increment a skipped-line counter** and continue (the job
  still completes — see "Degenerate-generation visibility" below).
- **Per-line atomicity (decided).** A scene and *all of its shots* are written
  **atomically, in a single transaction, per NDJSON line**, via the Postgres
  RPC `upsert_scene_with_shots(...)` called once per valid line. This is a
  deliberate choice over two separate `.upsert()` calls: the Supabase JS client
  cannot wrap two client-side writes in one transaction, so a scene could appear
  in the editor without its shots, and a mid-stream failure could leave a
  half-written scene. With the RPC, a card never appears without its shots, and a
  mid-stream failure leaves **N complete scenes**, never a scene with missing
  shots. The function upserts the scene on conflict `(video_id, position)` and
  its shots on conflict `(scene_id, position)` inside the transaction, so
  Inngest's at-least-once retries converge instead of duplicating.
- `account_id` and `video_id` come from the event payload; `scene_id` is
  resolved inside the RPC.

### Degenerate-generation visibility (decided)
A job that completes after skipping many malformed lines currently reads as a
success even if it produced three scenes from a ten-scene intent. To make this
diagnosable rather than silent, the function records a **count of
skipped/malformed lines** (and the count of scenes written) in the job's
`error`/metadata JSON on completion — one field, the down payment on Phase 9
observability. A clean run records zero.

### Status & errors
- The Tier-2 action creates the `jobs` row (`queued`).
- The function sets `running` at start, `complete` at the end (with the
  skipped-line/scene-count metadata), or `failed` with an `error` payload on a
  terminal error. This row is the single source of truth for progress/outcome
  and is delivered to the editor over Realtime.

## 6. Editor (Option A)

- `src/app/(app)/videos/[id]/page.tsx` (server component): loads the video and
  any existing scenes/shots for first paint.
- `Editor.tsx` (client): opens the Realtime subscriptions, renders the ordered
  single column of `SceneCard`s, owns debounced autosave, shows the job-status
  affordance ("Generating… / done / error").
- `SceneCard.tsx`:
  - **Editable narration** (textarea); debounced ~700 ms autosave via Tier-1
    `scenes.update({ narration }).eq('id', sceneId)`; subtle "saving…/saved".
  - **Shots read-only beneath the narration** — muted, smaller, visibly "the
    AI's plan for this scene," not clickable. (This is the slot Phase 3 makes
    editable.)
  - **Reserved, laid out but not built:** a status-indicator home in a corner
    (Phase 4 audio status) and a per-card action slot (Phase 3 regenerate),
    rendered as empty placeholder structure.
  - **Unmistakable card separation** so editing reads as discrete per-scene.
  - **Strict 1:1**: a card edits exactly its own scene; nothing cross-card.

### Realtime ordering (explicit)
The editor **sorts scenes by `position` on render** — it does not append rows in
arrival order. Realtime INSERT delivery is **not** position-ordered, so
append-on-arrival would show scenes out of sequence; this is the natural thing to
code wrong, so it is called out. Incoming rows are merged into a keyed map and
the render sorts by `position` every time. Shots likewise render sorted by their
`position` within a scene.

### Realtime echo handling (echo-guard)
During generation the editor only receives INSERTs, so there is no conflict with
user edits. For user edits the guard is precise:
- **Ignore Realtime UPDATEs for a card while it is dirty** (an edit is pending or
  an autosave is in flight) — this is what makes the echo of your own write a
  no-op and prevents clobbering the textarea mid-typing.
- **On successful autosave, clear the card's dirty flag**; the value you wrote is
  authoritative.
- Once not dirty, Realtime UPDATEs for that card apply normally again.

## 7. Brand seeding

A single seeded channel (e.g. name "Studio") with **minimal brand**: name,
primary colour + font (`brand_kit`), a placeholder voice (`voice_tts`), and
optional tone (`brand_voice`). Seeded idempotently by name (same pattern as the
Phase 1 render seed). The channel's name/tone feed the generation prompt; the
rest is present for later phases. No settings UI.

## 8. Files (anticipated)

| File | Purpose |
|---|---|
| `supabase/migrations/<ts>_phase2_script.sql` | Add `scenes`, `shots`, `jobs` to `supabase_realtime`; create the `upsert_scene_with_shots(...)` RPC. |
| `package.json` | Add `@anthropic-ai/sdk`. |
| `src/lib/env.server.ts` | Add `anthropic.apiKey` getter. |
| `src/lib/ai/anthropic.ts` | Server-only Anthropic client factory. |
| `src/lib/ai/script-generation.ts` | Prompt builder, Zod scene schema, NDJSON line parser, scene/shot→row mapping (pure, testable). |
| `src/lib/inngest/client.ts` | Add `ScriptGenerateData` type + event name. |
| `src/lib/inngest/functions/generate-script.ts` | The Inngest function (stream → validate → upsert → status). |
| `src/app/api/inngest/route.ts` | Register the new function. |
| `src/app/(app)/.../actions.ts` | `startScriptGeneration(prompt)` Tier-2 action (seed channel, create video, create job, emit event). |
| `src/app/(app)/dashboard/...` | Prompt box entry UI. |
| `src/app/(app)/videos/[id]/page.tsx` | Editor server component (first paint). |
| `src/app/(app)/videos/[id]/Editor.tsx` | Client editor (Realtime, autosave, status). |
| `src/app/(app)/videos/[id]/SceneCard.tsx` | The scene card (narration editable, shots read-only, reserved slots). |
| Test files | Unit tests for parser/schema/mapping. |

## 9. Testing

- **Unit (pure, TDD-friendly):**
  - NDJSON line parser: complete line; partial line buffered across deltas;
    multiple lines in one delta; malformed line skipped.
  - Zod scene schema: valid scene; missing/invalid `source`; missing
    `stockQuery` when `source='stock'`.
  - scene/shot → DB-row mapping (including `account_id`/`video_id`/`scene_id`
    wiring), driven by a fake delta stream.
- **Manual end-to-end** (as in Phase 1): run `next dev` (3001) + the Inngest dev
  server; type a prompt; watch cards stream in; edit a card; refresh to confirm
  persistence; confirm a forced generation error marks the job `failed` and the
  editor shows it.

## 10. Risks & mitigations

- **Model emits invalid NDJSON / pretty-printed JSON.** Mitigated by firm prompt
  instructions, a **pinned low temperature** (decided, Section 5), per-line Zod
  validation, and skip-and-count on a bad line.
- **Inngest retry duplicates rows.** Mitigated by the `upsert_scene_with_shots`
  RPC upserting on the natural unique keys inside one transaction.
- **Realtime echo clobbers an in-progress edit.** Mitigated by the dirty-card
  echo-guard (Section 6).
- **Text-stream vs structured-output API shape.** The one external unknown that
  could invalidate per-line parsing — **verified first** against the `claude-api`
  reference at implementation time, before the parser is built (Section 5).

## 11. Out of scope / future phases

Voice synthesis and `audio_status` lifecycle (Phase 3); composition spec and the
render connection (Phase 4); full channel/brand settings UI (Phase 8); cost
ledger entries and `model_routing` (later phases). Phase 2 records no
`cost_events` and creates no `script_revisions`.

**`videos.current_script_revision_id`** is **intentionally left null** in Phase 2
and nothing reads it expecting a value: the editor loads scenes directly from the
`scenes` table, consistent with scenes-as-source-of-truth. The pointer becomes
meaningful only once revisions exist (a later phase). This is deliberate, not an
oversight.
