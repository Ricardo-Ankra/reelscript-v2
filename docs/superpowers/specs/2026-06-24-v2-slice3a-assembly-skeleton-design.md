# Reelscript V2 — Slice 3a: Assembly skeleton — Design

> **Reelscript V2 program, Slice 3 (assembly spine — `FinalTimeline`), sub-slice 3a.**
> Slice 3 turns the render from "the AI composes primitives per scene" into a clip-assembly
> timeline that sequences pre-rendered shot artifacts — generative clips (Slice 1b
> `clip_key`), conformed live-action footage (Slice 2b `footage_key`), and motion-graphics
> (the existing primitive path) — plus master LUT + match-grade + overlays + captions +
> VO-first audio. A **spike** (below) confirmed the two technical pillars, and Slice 3 is
> decomposed into **3a (assembly skeleton: sequence clips/footage as timeline segments,
> this doc)** and **3b (color: master LUT + match-grade ffmpeg post-pass)**. 3a is
> additive and **consumes** the keys 1b/2b already write; it changes nothing in voice
> synthesis, captions, music re-mux, script-gen, generation, or ingest.

## 0. Spike findings (the technical foundation)

Slice 3 was flagged "needs a spike." Two pillars, both confirmed viable:

1. **Assembly (Remotion):** `<OffthreadVideo src={signedUrl} trimBefore trimAfter
   playbackRate/>` inside `<Sequence from=…>` sequences and trims **external MP4s**
   frame-accurately (Remotion docs' "different segments at different speeds" snippet is the
   FinalTimeline pattern). External signed URLs are already how voiceover/media reach the
   renderer; Lambda renders video layers. So generative clips + conformed footage become
   sequenced `OffthreadVideo` segments **coexisting** with the existing primitive/scene
   model. (Remotion 4.0.472; `<OffthreadVideo>` from core.)
2. **Color (deferred to 3b, but the path is proven):** Remotion's bundled ffmpeg is a
   minimal build (no `lavfi`), so grading does **not** run in Remotion. It runs as an
   ffmpeg **post-pass** on the dedicated ffmpeg Lambda (johnvansickle static — full filters
   incl. `lut3d`/`eq`/`colorbalance`), reusing Slice 2's generalized argv executor + the
   existing music-re-mux post-pass pattern. No fragile WebGL, no new infra.

**Resulting architecture:** extend the existing render spine — the composition spec gains
clip/footage **segments**; `ReelComposition` renders them as `OffthreadVideo` sequences
alongside primitives (VO-first timing); after the Remotion base render, 3b adds an ffmpeg
color post-pass, then the existing music re-mux runs. Captions + attribution/disclosure
overlays already ride composition-wide, so they layer over the assembled timeline unchanged.

## 1. Context & locked decisions

- **Program runtime/data decisions** are locked in the V2 program (existing Next.js +
  Supabase + RLS + Inngest + Remotion Lambda + R2). See
  `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **3a decisions (this doc):**
  1. **Scene-driven timeline; shots partition the scene's VO.** Scenes stay the voiceover
     unit (one VO + word-aligned captions per scene, as today). A scene's shots become the
     visual sub-segments that partition that scene's existing `durationInFrames`. Clips slot
     *under* the existing structure rather than replacing it — voice synthesis, caption
     timing, and the spine are untouched.
  2. **Generative/live-action shots bypass AI composition.** A shot with a `clip_key`/
     `footage_key` is the visual itself → placed deterministically as a full-frame
     `OffthreadVideo` segment, no compose-AI call. Only motion-graphics/stock shots keep
     going through the AI primitive composition (today's path).
  3. **VO-fit = trim-long / freeze-hold-short.** If a clip's native duration ≥ its allotted
     frames → trim (`trimAfter`); if shorter → play fully then freeze the last frame for the
     remainder. Predictable, no speed/motion artifacts.
  4. **Mixed scenes = "A-lite".** A shot with a `clip_key`/`footage_key` is **dropped from
     the compose hints** (so the AI doesn't compose it) and renders as a full-frame segment
     over its sub-range; the scene's remaining stock/gfx shots compose as today (spanning the
     scene underneath, visible in the non-clip windows). Confining each non-clip shot's
     primitives to its own sub-range is **deferred** (needs compose to know sub-ranges).
- Sandbox build: no concern for DB migration / data loss. **3a needs no migration** —
  it consumes existing columns (`shots.kind/clip_key/footage_key/duration_seconds`).

## 2. Goal & non-goals

**Goal.** Assemble a video whose shots carry generated clips / conformed footage: those
shots render as full-frame, VO-fit `OffthreadVideo` segments sequenced under the scene's
voiceover + caption track, coexisting with legacy primitive/stock composition. Produces an
assembled base MP4 of clips + footage + gfx + VO + captions via the existing render spine.

**Non-goals (deferred).** No color grade / master LUT / match-grade (3b). No
sub-range-confined primitive composition (clips occlude; later slice). No first/last-frame
chaining. No new audio model — VO and music are unchanged (music still the re-mux). No
change to voice synthesis, captions, the music re-mux, script-gen, generation (1b), or
ingest (2b). Legacy videos (no shot has a clip/footage key) render **byte-identically**.

## 3. Current state (anchors)

- `src/lib/composition/spec.ts` — `CompositionSpec` (`version: 2`): `metadata`, baked
  `theme`, `assets: AssetManifestEntry[]` (`kind: 'audio'|'image'|'video'`, `r2Key` durable
  + render-time `url`), `scenes: CompositionScene[]` (`durationInFrames`, `voiceover`,
  `captionFocus`, `instances: PrimitiveInstance[]`), `captions`, `captionStyle`,
  `captionEmphasis`. **3a adds `CompositionScene.segments?`.**
- `remotion/ReelComposition.tsx` — renders each scene as a `<Sequence from={sceneOffset}
  durationInFrames>` with per-scene `<Audio>` (voiceover) + `instances.map` of primitives +
  the composition-wide `<AnimatedCaptionTrack>` and attribution overlay. `sceneOffsets`
  computed purely. **3a adds segment rendering inside each scene's Sequence.**
- `src/lib/inngest/functions/render.ts` `loadBrief` (≈430–560) — loads scenes ordered by
  position; `durationInFrames = round(duration_seconds*fps)`; loads shots per scene
  **only to build `shotHints` text + pins + `needsStock`** (shots are *not* placed today);
  pushes voiceover assets; builds `SceneBrief[]`. Compose maps brief → `CompositionScene`.
  **3a extends the shot read to `kind/clip_key/footage_key/duration_seconds/position`,
  resolves keys to video manifest assets, and emits `scene.segments` + excludes clip/footage
  shots from `shotHints`.**
- `src/lib/assets/resolve.ts` — `resolveResourceAssets`/`resolveStockAssets` produce
  `AssetManifestEntry[]` (durable `r2Key`; render-time `url` signed later). **3a adds a
  resolver for clip/footage keys → video manifest entries** (own content, no attribution).
- `remotion/primitives/Video.tsx` — the existing Remotion video primitive (reference for
  `OffthreadVideo` usage already in the bundle).
- Render-time signing: the durable spec carries `r2Key` only; a render-start pass signs all
  manifest entries' `url`. **3a's segment assets ride that same signing path** (they are
  ordinary `kind:'video'` manifest entries).

## 4. Data model — `src/lib/composition/spec.ts`

Add a segment type + the scene field. Additive; legacy specs omit `segments`.

```ts
export interface ShotSegment {
  shotId: string;          // provenance/debug; not used by the renderer's timing
  from: number;            // start frame WITHIN the scene (0 = scene start)
  durationInFrames: number;// the shot's allotted span (tiles the scene exactly)
  assetId: string;         // a kind:'video' manifest entry (resolved clip_key/footage_key)
  fit: 'trim' | 'freeze';  // trim: clip ≥ allotted; freeze: clip < allotted (hold last frame)
  sourceDurationInFrames: number; // the clip's native length in frames (for the freeze split)
}

export interface CompositionScene {
  // …existing fields…
  /** Ordered clip/footage shot segments tiling this scene (Slice 3a). Absent/empty ⇒ the
   *  scene renders via the legacy primitive path only. Segments render full-frame above
   *  primitives. */
  segments?: ShotSegment[];
}
```

`fit` + `sourceDurationInFrames` are precomputed in `loadBrief` (pure decision from probe/
clip facts) so the renderer stays declarative: it never inspects media to decide trim vs
freeze.

## 5. Timing core — `src/lib/composition/assembly.ts` (+ test)

Pure, unit-tested (the only logic-heavy, testable part of 3a):

```ts
export interface ShotTiming { shotId: string; from: number; durationInFrames: number }

// Partition a scene's frames among its shots proportionally to each shot's duration_seconds,
// guaranteeing the parts tile [0, sceneFrames) exactly (no gap/overflow): floor each, then
// hand the rounding remainder to the last shot. Equal split if all weights are 0/absent.
export function partitionSceneFrames(
  sceneFrames: number,
  shots: { shotId: string; durationSeconds: number }[],
): ShotTiming[];

// Decide VO-fit for one segment from native vs allotted frames.
// native >= allotted → 'trim'; native < allotted → 'freeze'.
export function fitForSegment(nativeFrames: number, allottedFrames: number): 'trim' | 'freeze';
```

Tested: partition sums exactly to `sceneFrames` for arbitrary weights incl. zeros and a
single shot; remainder lands on the last shot; `fitForSegment` boundary (native == allotted
→ trim). `sourceDurationInFrames = round(probe.durationSec * fps)` for footage; for a
generative clip without a probe, the clip's known generation duration (or a conservative
default that forces `trim`) — the plan pins the exact source.

## 6. Render-path integration — `render.ts` `loadBrief`

1. Extend the per-scene shot read to `kind, clip_key, footage_key, duration_seconds,
   position` (ordered by position).
2. A shot is **assembly-backed** iff it has a non-null `clip_key` (generative) or
   `footage_key` (live-action). For each scene:
   - `partitionSceneFrames(sceneDurationInFrames, allShots)` → per-shot `{from,duration}`.
   - For each assembly-backed shot: resolve its key → a `kind:'video'` manifest asset
     (durable `r2Key`; signed at render start like every other asset); compute
     `sourceDurationInFrames` + `fit`; push a `ShotSegment`.
   - **Exclude assembly-backed shots from `shotHints`** (A-lite) so compose ignores them.
3. Non-assembly shots keep flowing into `shotHints`/pins exactly as today; a scene with no
   assembly-backed shots emits no `segments` and is byte-identical.
4. The new resolver lives in `resolve.ts` (`resolveSegmentAssets(admin, accountId,
   keys[]) → AssetManifestEntry[]`, own content, no attribution), mirroring
   `resolveResourceAssets`.

## 7. Renderer — `remotion/ReelComposition.tsx`

Inside each scene's `<Sequence from={sceneOffset} durationInFrames>`, after the voiceover
`<Audio>` and before/under nothing relevant, render segments **above** primitives:

```tsx
{scene.segments?.map((seg) => {
  const url = assetUrl(seg.assetId);
  if (!url) return null; // durable (unsigned) spec ⇒ no playback, like voiceover
  return (
    <Sequence key={seg.shotId} from={seg.from} durationInFrames={seg.durationInFrames} layout="none">
      <AbsoluteFill style={{ zIndex: SEGMENT_LAYER }}>
        {/* Clips are muted — the render is VO-first; the per-scene <Audio> owns sound. */}
        {seg.fit === 'trim' ? (
          <OffthreadVideo src={url} trimAfter={seg.durationInFrames} muted />
        ) : (
          // freeze-hold: play the clip, then Freeze its last source frame for the tail
          <>
            <Sequence durationInFrames={seg.sourceDurationInFrames} layout="none">
              <OffthreadVideo src={url} muted />
            </Sequence>
            <Sequence from={seg.sourceDurationInFrames} layout="none">
              <Freeze frame={seg.sourceDurationInFrames - 1}>
                <OffthreadVideo src={url} muted />
              </Freeze>
            </Sequence>
          </>
        )}
      </AbsoluteFill>
    </Sequence>
  );
})}
```

`SEGMENT_LAYER` sits above primitive instance layers (primitives use `inst.layer`; segments
use a constant above the max). The exact `<Freeze>`/last-frame mechanism is verified during
implementation (the plan pins it against Remotion 4.0.472); the spike confirmed the
sequencing/trim primitives this builds on.

## 8. Testing

- **Unit (node:test):** `partitionSceneFrames` (exact tiling incl. zero/equal weights,
  remainder on last, single shot) + `fitForSegment` (trim/freeze boundary) +
  `resolveSegmentAssets` shape (manifest entry per key, no attribution). The `loadBrief`
  segment-emission + `shotHints` exclusion is exercised through the existing render
  drive-path (`loadBrief` is server-only, like today).
- **Render/assembly:** verified via the existing `drive:render` operator path on a video
  whose shots carry `clip_key`/`footage_key` (Remotion render is not unit-tested — matches
  the spine). The freeze-hold + trim rendering is eyeballed there.
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration.**

## 9. Backward compatibility

Additive: a new optional `CompositionScene.segments`, a new pure `assembly.ts`, a new
`resolveSegmentAssets`, a `loadBrief` extension, and segment rendering in `ReelComposition`.
A video where no shot has a `clip_key`/`footage_key` produces no `segments`, identical
`shotHints`, and a byte-identical spec + render. The durable spec gains `segments` (with
`r2Key`-backed assets); a re-signed render-time copy plays them. Voice synthesis, captions,
attribution/disclosure overlays, the music re-mux, script-gen, generation (1b), and ingest
(2b) are untouched.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/composition/spec.ts` (modify) | add `ShotSegment` + `CompositionScene.segments?` |
| `src/lib/composition/assembly.ts` (+ test) (create) | `partitionSceneFrames`, `fitForSegment` |
| `src/lib/assets/resolve.ts` (modify) (+ test) | `resolveSegmentAssets(keys) → manifest entries` |
| `src/lib/inngest/functions/render.ts` (modify) | `loadBrief`: emit `segments`, exclude assembly shots from `shotHints` |
| `remotion/ReelComposition.tsx` (modify) | render `segments` (trim / freeze-hold) above primitives |

## 11. Open items (resolved-by-default; flagged for the plan)

- **Generative clip native duration:** footage has a probe (`durationSec`); a generative
  clip's native length isn't stored. The plan pins the source: prefer a stored/known clip
  duration; absent one, set `sourceDurationInFrames ≥ allotted` so `fit` is always `trim`
  (never a bad freeze). A follow-up can probe generated clips if precise freeze is wanted.
- **`<Freeze>` exact API** on Remotion 4.0.472 is verified at implementation time; the
  trim/sequence primitives it composes are spike-confirmed.
- **Segment layering:** segments are full-frame and occlude primitives in their sub-range
  (A-lite). Sub-range-confined primitive composition is a later slice.
- **Audio:** unchanged — per-scene voiceover `<Audio>`; music stays in the re-mux. Clip
  audio tracks are **muted** (the design renders VO-first; a clip's own audio is out of
  scope for 3a — note `muted` on segment `OffthreadVideo` if clips carry audio).
