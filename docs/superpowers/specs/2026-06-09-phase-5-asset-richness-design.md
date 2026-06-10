# Phase 5 — Asset richness — Design

**Status:** proposed 2026-06-09
**Build plan phase:** Phase 5 ("videos use real, well-chosen media")
**Milestone:** videos pull real footage and images the AI chose **by looking at
candidates**, and a channel with no stock keys still produces a complete
graphic/typographic video.

## 1. Goal & scope

Enrich the working spine with real media. The Phase-4 single composition call
becomes an **agentic vision loop**: for shots that need stock, Claude calls a
stock-search tool, *looks at* the candidate thumbnails, and picks the best fit —
refining the query if nothing works (spec 8.8). Chosen media is downloaded, cached,
and rendered by new Image/Video primitives. A second gate (Gate 2) renders a smoke
frame and vision-checks it. When a channel has no stock keys, shots **degrade
gracefully** to channel resources, then to procedural primitives — never a hard fail
(spec 8.9). All confirmed by your three answers: **Pexels + Pixabay**, **include
resource upload + auto-tag**, **include Gate 2**.

### In scope (the full build-plan Phase 5)
- **Pexels + Pixabay** integration (env-var keys): unified stock search (image +
  video) returning candidates with thumbnails, orientation/min-width filters.
- **Agentic asset selection with vision** (spec 8.8): the compose step runs a
  tool-use loop — `search_stock` tool → candidate thumbnails as vision content →
  Claude picks by external id, refines query. Scoped to stock-needing shots without a
  strong resource match.
- **New primitives**: `Image` (still + Ken-Burns pan) and `Video` (trimmed footage,
  fit, mute), plus `FullBleed` extended to back an image/video. Prop type `asset`;
  the renderer resolves asset ids → signed URLs via an `AssetContext`.
- **Asset resolution + caches**: search-result cache (`asset_search_cache`, 7-day
  TTL, keyed on hash(source,query,kind,orientation,min_width)) and file-bytes cache
  (`asset_files`, content-hashed R2 keys); chosen media downloaded once, reused.
- **Gate 2** (spec 11.2): one mid-video still on Lambda → mechanical (not blank) +
  Claude-vision QA (matches intent, no overflow/clash); surface failures (no auto-fix
  loop yet — that's Phase 7).
- **Channel resource upload + fast auto-tag** (spec 4.3 / 13.5): signed R2 PUT +
  `channel_resources` row; a single fast Claude-vision call → description + tags; an
  explicit `source='resource'` shot uses its resource and skips the stock loop.
- **Graceful degradation** (spec 8.9): no stock keys (or no usable candidate) → a
  matching channel resource → else procedural (Text/Shape/FullBleed, the Phase-4
  path). A shot never hard-fails for missing stock.

### Explicitly deferred (anticipated, not built)
- The **full rate/concurrency governor** (Phase 9) — Phase 5 uses a simple cap; the
  search-result cache absorbs most repeat load.
- **Captions, kinetic text, music + remux** (Phase 6).
- The **auto-fix loop on Gate-2 failure** (Phase 7) — Phase 5 surfaces the failing
  frame; no automated repair.
- The full **resource library UI** with search/tag/type filters (Phase 8) — Phase 5
  ships a minimal upload + tag, enough for the fallback chain.
- **`model_routing`** (Phase 8) — vision/selection pinned to Sonnet in code.
- `api_credentials` table (Phase 8) — Pexels/Pixabay keys are env vars.

## 2. Decisions (proposed — flagged ones ⚑)

| Decision | Choice | Rationale |
|---|---|---|
| Provider keys | **Env vars `PEXELS_API_KEY` + `PIXABAY_API_KEY`** | Matches Anthropic/ElevenLabs; defer `api_credentials` to Phase 8. A channel "has stock" iff the relevant key is set. |
| Stock search | **One unified `searchStock({query,kind,orientation,minWidth})`** dispatching to both providers; candidates merged + de-duped | Two adapters (`pexels.ts`, `pixabay.ts`), one tool surface. Image + video supported. |
| Agentic selection ⚑ | **Manual tool-use loop in the compose step**: Sonnet (vision) + a `search_stock` tool whose result embeds candidate **thumbnails as image content blocks**; Claude emits final instances + the asset ids it chose | Spec 8.8's "look at candidates with vision and pick." Manual loop (not the SDK tool-runner) so we control caching, the governor, and the final structured output. Confirm vision+tool+thinking specifics via the `claude-api` skill at build. |
| Vision/selection model | **`claude-sonnet-4-6`** (the composition model; supports vision + tool use), pinned | One model for compose + selection + Gate-2 QA; `model_routing` is Phase 8. |
| Asset id scheme | Candidates get a stable `assetId` = `${provider}-${kind}-${externalId}`; the AI references it in `asset` props; the system maps id → chosen candidate → download | The tool accumulates a returned-candidate registry so the system can resolve only the ids the AI actually used. |
| New primitives | **`Image`, `Video`** added; **`FullBleed`** gains an optional `asset`; renderer resolves `asset` ids via a new **`AssetContext`** (manifest map), like `ThemeContext` | A primitive can't be handed a signed URL at author time — it looks the asset up by id at render. Requires a **Remotion site redeploy** (new primitives in the bundle). |
| Caches | **Both**: `asset_search_cache` (7-day TTL) checked before any provider call; `asset_files` (content-hash) checked before any R2 upload | Prevents re-paying providers and re-downloading bytes (spec 13.6). |
| Gate 2 ⚑ | **`renderStillOnLambda` at the mid frame** → not-blank check + one Claude-vision pass; on fail mark the render failed with the frame preserved (no auto-fix) | Spec 11.2. Auto-fix loop is Phase 7. Adds a `cost_events('smoke_frame')` row. |
| Resource match | Honor an explicit `source='resource'` shot (use its `resource_id` → signed R2) and **skip the stock loop**; tag-based "strong match" heuristic kept minimal | Spec 8.8 ("a shot already matched to a specific resource skips the loop"). |
| Resource upload | `createResourceUpload` (signed R2 PUT + row) + `confirmResourceUpload` (one fast Claude-vision tag → description + tags) | Spec 4.3 / 13.5; the fast synchronous tag, not the Batch API. |
| Degradation | **No stock key ⇒ run the Phase-4 procedural path** (no `search_stock` tool offered); a shot with no usable candidate falls back to resource → procedural | Spec 8.9. The no-key path is exactly the verified Phase-4 behaviour, so half the milestone already holds. |
| Gate 1 | **Extend the asset-ref check** to validate every instance `asset`-typed prop resolves in the manifest (today it only checks `scene.voiceover`) | Keeps the AI from referencing media that isn't in the manifest. |
| Attribution ⚑ | **Capture `attribution` per asset in the manifest now**; render a **minimal attribution overlay** (unique attributions over the final ~90 frames) | Spec 8.6 ("non-optional in V1 for licensing"). The richer treatment can wait, but stock requires attribution the moment it ships. |

## 3. Architecture & data flow

```
render-video compose step (Phase 5):
  hasStock = channel has a Pexels/Pixabay key AND ≥1 shot needs stock
  if !hasStock → Phase-4 single-call procedural compose (unchanged)
  else → AGENTIC LOOP (Sonnet, vision + tools):
     tools: [ search_stock(query, kind, orientation) ]
     loop:
        Claude calls search_stock → searchStock() (cache → providers)
            → tool_result = candidate list + each thumbnail as an image block
              (each candidate carries a stable assetId; registry[assetId]=candidate)
        … Claude looks, refines, picks …
        Claude returns final JSON: per-scene instances (asset props = chosen assetIds)
  → assemble spec (instances + brief), collect referenced assetIds
  → resolve each asset:
        resource shots → channel_resources.r2_key
        stock assetIds → registry[id].downloadUrl → file-bytes cache (sha256 → R2)
        → manifest entry { id, kind, r2Key, attribution }
  → Gate 1 (structural + token + asset-ref + timing)  [budget-2 retry]

  storeSpec (durable, key-based)  →  Gate 2 (smoke still + vision)  →
  resolveAssets (sign every r2Key)  →  Lambda spine  →  finalize (+ cost_events)

renderer: <Image>/<Video>/<FullBleed asset> resolve their asset id → signed URL via
  AssetContext(spec.assets); attribution overlay over the final frames.

resources: createResourceUpload → client PUTs to R2 → confirmResourceUpload (fast
  Claude-vision tag) → channel_resources{description,tags}.
```

## 4. Files (high level)
- **env** `src/lib/env.server.ts` — `pexels.apiKey`, `pixabay.apiKey` (+ `.env.example`).
- **assets lib** `src/lib/assets/{pexels,pixabay}.ts` (server), `search.ts`
  (dispatch + dedupe + search cache), `cache.ts` (file-bytes cache: sha256→R2→
  `asset_files`), `candidate.ts` (pure types + assetId helpers, tested).
- **primitives** `src/lib/primitives/starter.ts` (+ Image/Video/FullBleed schemas,
  `asset` props); `remotion/primitives/{Image,Video}.tsx` + registry; extend
  `FullBleed.tsx`; new `AssetContext` in `theme-context.ts`; `ReelComposition`
  provides it + renders the attribution overlay.
- **composition** `src/lib/composition/compose.ts` — the `search_stock` tool schema,
  tool-result builder (thumbnails as image blocks), and the selection prompt; extend
  `gate1.ts` asset-ref; `spec.ts` manifest entry gains `attribution`.
- **pipeline** `src/lib/inngest/functions/render.ts` — agentic-vs-procedural compose,
  asset resolution, Gate 2 step (`renderStillOnLambda`), cost_events.
- **resources** `src/app/(app)/.../resource-actions.ts` (upload/confirm) + a minimal
  upload control; `src/lib/ai/vision.ts` (fast tag + Gate-2 QA, pure prompt builders).
- **migration** — likely none (`asset_search_cache`, `asset_files`,
  `channel_resources` exist); RLS already covers them.

## 5. Build order (each independently demonstrable)
1. **Stock providers + search + caches** — `pexels.ts`/`pixabay.ts`/`search.ts`/
   `cache.ts`; pure candidate/cache helpers unit-tested; a live search smoke once keys
   are set.
2. **Image/Video primitives + AssetContext + redeploy** — prove a hand-written spec
   referencing a real downloaded stock image *and* video renders on Lambda (extends
   the Phase-4 audio proof with media).
3. **Agentic selection loop** — `search_stock` tool + vision; verify Claude searches,
   views thumbnails, and returns instances referencing chosen assets (the centerpiece;
   confirm vision+tool wiring via `claude-api`).
4. **Asset resolution + manifest + Gate 1 asset-ref** — download/cache chosen stock +
   resources → manifest; validate.
5. **Gate 2** — mid-frame still + Claude-vision QA; surface failures.
6. **Resource upload + fast tag** — signed PUT + vision tag + the resource-skips-stock
   path + minimal UI.
7. **Pipeline integration + degradation** — wire agentic/procedural branch, attribution
   overlay, cost_events; the no-key path stays the Phase-4 procedural render.
8. **End-to-end milestone** (Section 7).

## 6. Open items to confirm at build time
- **Vision + tool-use + thinking wiring** for the agentic loop (image content blocks
  in tool results, manual loop vs tool-runner, max_tokens headroom) — confirm via the
  `claude-api` skill before building step 3. (Carry the Phase-4 lesson: budget output
  tokens well above the JSON, effort tuned to the task.)
- **Provider response shapes** (Pexels `/v1/search` + `/videos/search`; Pixabay
  `/api/` + `/api/videos/`) — confirm field names live before wiring the adapters.
- **`renderStillOnLambda`** signature/output for Gate 2.

## 7. Milestone verification
With Pexels + Pixabay keys set: prompt → script → synthesize → **Generate Video** →
the compose step searches stock, the logs/▶ show Claude choosing from real candidates,
and the rendered MP4 shows **real footage/images** under the voiceover with an
attribution overlay. Then, on a channel with the keys removed, the same flow still
produces a **complete graphic/typographic video** (procedural primitives) with no hard
failure. Gate 2's smoke frame passes; `cost_events` shows composition, smoke_frame,
asset_search, and render lines.
