# Reelscript V2 — Slice 3b: Color (master look) — Design

> **Reelscript V2 program, Slice 3 (assembly spine), sub-slice 3b.**
> Slice 3a shipped the assembly skeleton (clip/footage shots sequenced as timeline
> segments). 3b adds the **master color look**: a uniform, subtle, brand-consistent grade
> applied to the assembled render as an ffmpeg post-pass — reusing the same generalized
> ffmpeg-Lambda + base/final pattern as the music re-mux. Per-shot **match-grade** (true
> cross-shot consistency) stays deferred to a later slice.

## 0. Context & locked decisions

- **Program runtime/data** locked in the V2 program (Next.js + Supabase + RLS + Inngest +
  Remotion Lambda + R2). See `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Slice 3 spike (3a doc §0):** color runs as an **ffmpeg post-pass on the dedicated
  Lambda** (a generic argv executor), NOT in Remotion. 3b realizes that.
- **3b decisions (this doc):**
  1. **Master look only** — a single uniform grade for the whole video. Per-shot
     match-grade is deferred (architecturally different: per-clip pre-grade before assembly).
  2. **Mechanism = code-defined ffmpeg filter presets**, NOT sourced/`lut3d` `.cube` files.
     A "look" is a named set of grade params compiled to an ffmpeg `-vf` chain
     (`eq`/`colorbalance`/`curves`). Fully deterministic, no asset lifecycle, single input.
     **`lut3d`/`.cube` remains a clean future upgrade** (same render step, different argv +
     a `.cube` input) — the spike confirmed `lut3d` is available.
  3. **Subtle by design.** A master look is a stylistic top-coat, not a consistency-fixer;
     aggressive grades on heterogeneous AI/stock footage amplify mismatch. Presets are gentle.
  4. **Per-channel default, baked, overridable.** `color_look` rides the existing
     channel-defaults → `video.settings` machinery (like aspect/fps/captions/music). Default
     `neutral`, so an unconfigured channel still gets a tasteful grade with zero setup.
  5. **Degrade on failure.** If the grade pass fails (after the function's normal retries),
     the render uses the **ungraded base** as the result (logged) — the video stays
     watchable. Color is non-essential.
  6. **Whole-video uniform.** The grade applies to the entire final frame (clips +
     motion-graphics, under captions). Subtle, so graphics/captions stay clean.
- **No migration** — `color_look` lives in the existing `channels.defaults` + `video.settings`
  jsonb, exactly like the other six settings.

## 1. Goal & non-goals

**Goal.** Every render gets a subtle, deterministic, brand-consistent master color look,
selectable per channel (default `neutral`), applied as an ffmpeg `-vf` post-pass that
transforms the voiceover base MP4 into a graded base — leaving the music re-mux and the
rest of the spine untouched. The operator picks a look on the channel editor and can
override per video.

**Non-goals (deferred).** No per-shot match-grade. No operator-uploaded LUTs. No
`lut3d`/`.cube` (filter-chain only this slice). No per-segment grading. No new audio
behavior. No change to Remotion composition, captions, voice, script-gen, generation (1b),
ingest (2b), or assembly (3a) — 3b only post-processes the finished base MP4.

## 2. Current state (anchors)

- `src/lib/inngest/functions/render.ts` — `finalize-base` (≈296–317) writes the Lambda
  output to `baseKey = renders/<id>.base.mp4` and sets `renders.base_output_r2_key`. Then:
  music on ⇒ `emit-remux` sends `music/remux`; music off ⇒ `finalize` sets
  `output_r2_key = baseKey`. The video's `settings` (`aspect_ratio`/`fps`) are already read
  in the brief. **3b inserts a `grade-base` step between `finalize-base` and the
  music/finalize branch.**
- `src/lib/inngest/functions/music-remux.ts` — the ffmpeg post-pass precedent: loads
  `base_output_r2_key`, `buildRemuxArgs` → `invokeRemux({args, inputs, outputs})` → final.
  **3b consumes nothing here and changes nothing here** — the re-mux reads whatever
  `base_output_r2_key` points at (graded or not).
- `src/lib/music/remux-invoke.ts` — `invokeRemux({args, inputs (localPath→signed GET),
  outputs (localPath→signed PUT), outputContentType?})`. The grade pass reuses it verbatim.
- `src/lib/music/ffmpeg.ts` — `buildRemuxArgs`, the pure unit-tested argv pattern 3b mirrors.
- `src/lib/r2.ts` — `signedGetUrl`, `signedPutUrl`, `putObject`, `deleteObject`.
- `src/lib/videos/settings.ts` — `VideoSettings`/`VideoSettingsPatch`/`SETTINGS_DEFAULTS` +
  `sanitizeSettingsPatch`/`parseVideoSettings`. **3b adds `color_look` here**; it then flows
  through `create-settings.ts` (channel defaults ⊕ per-video override) automatically (DRY).
- `src/app/(app)/channels/[id]/BrandEditor.tsx` + `brand-actions.ts` — the channel editor
  that persists the captions/density/music defaults into `channels.defaults`. **3b adds the
  look select here.**
- `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` (+ its settings action) — the per-video
  panel for the same keys. **3b adds the per-video look override here.**
- Tests: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test`.

## 3. Look presets — `src/lib/color/looks.ts` (+ test)

Pure (no react/server/network), unit-tested. The single source of the look vocabulary.

```ts
export type ColorLook = 'none' | 'neutral' | 'warm' | 'cool' | 'punch';
export const COLOR_LOOKS: readonly ColorLook[] = ['none', 'neutral', 'warm', 'cool', 'punch'];
export const LOOK_LABELS: Record<ColorLook, string> = {
  none: 'None (no grade)',
  neutral: 'Neutral (clean)',
  warm: 'Warm cinematic',
  cool: 'Cool teal',
  punch: 'Punch (high contrast)',
};

// The ffmpeg -vf chain for a look, or null for 'none' / an unknown id (caller skips the
// grade entirely → byte-identical base). Subtle, broadcast-safe params.
export function buildGradeFilter(look: ColorLook): string | null;

// Pure argv for the grade pass: re-encode video with the filter, COPY audio (the base
// is voiceover-only — keep it bit-exact), faststart. Mirrors buildRemuxArgs/buildConformArgs.
export interface GradeInput { inPath: string; outPath: string; filter: string }
export function buildGradeArgs(input: GradeInput): string[];
```

- `buildGradeFilter`:
  - `none` (and any unknown id) → `null`.
  - `neutral` → a gentle lift, e.g. `eq=contrast=1.06:saturation=1.08:gamma=0.98`.
  - `warm` → `eq=…,colorbalance=rm=0.04:rh=0.03:bm=-0.03:bh=-0.04` (warm mids/highlights).
  - `cool` → `colorbalance` toward teal shadows + cool highlights + slight contrast.
  - `punch` → stronger `eq` contrast/saturation (+ a mild `curves` S-curve), still bounded.
  - Exact numbers are pinned in the plan; all kept subtle and within broadcast-safe ranges.
- `buildGradeArgs` → `['-y','-i',inPath,'-vf',filter,'-c:v','libx264','-pix_fmt','yuv420p',
  '-preset','veryfast','-crf','20','-c:a','copy','-movflags','+faststart',outPath]`.

Tested: `buildGradeFilter` returns null for `none`/unknown and a non-empty `-vf` string for
each named look (asserting the load-bearing filter token per look, e.g. `eq=`/`colorbalance=`);
`buildGradeArgs` contains `-vf <filter>`, `-c:a copy` (audio preserved), `-c:v libx264`,
`+faststart`, and ends with `outPath`.

## 4. Settings — `src/lib/videos/settings.ts` (+ test)

Additive: `color_look` joins the settings contract, so channel defaults + per-video override
inherit it through the existing `create-settings.ts` pipeline with no change there (DRY).

- `import { type ColorLook, COLOR_LOOKS } from '@/lib/color/looks';` (pure→pure).
- `VideoSettingsPatch` += `color_look?: ColorLook`; `VideoSettings` += `color_look: ColorLook`.
- `SETTINGS_DEFAULTS.color_look = 'neutral'`.
- `sanitizeSettingsPatch`: `if (COLOR_LOOKS.includes(p.color_look as ColorLook)) out.color_look = …`.
- `parseVideoSettings` picks it up via `sanitizeSettingsPatch` (no extra code).

Tested: a patch with a valid `color_look` survives sanitize; an invalid one is dropped;
`parseVideoSettings({})` → `color_look: 'neutral'`; a stored valid value round-trips.

## 5. Render integration — `render.ts` `grade-base` step

Insert immediately after `finalize-base` (base written, `base_output_r2_key` set) and
before the music/finalize branch. Thread the effective base key forward.

```ts
// Resolve the look from the video's settings (the channel default was merged into
// video.settings at creation). The main render function reads it with a small dedicated
// query (settings parsing today lives inside loadBrief/the compose step, so the grade step
// either does its own `videos.select('settings')` → parseVideoSettings, or the brief
// surfaces `colorLook` via the compose step's return — the plan picks; a direct read is
// simplest).
const look = parseVideoSettings(videoSettings).color_look;
let effectiveBaseKey = baseKey; // renders/<id>.base.mp4

const filter = buildGradeFilter(look);
if (filter) {
  effectiveBaseKey = await step.run('grade-base', async () => {
    try {
      const gradedKey = `renders/${renderId}.graded.mp4`;
      const [inUrl, outUrl] = await Promise.all([
        signedGetUrl(baseKey, 60 * 60),
        signedPutUrl(gradedKey, 'video/mp4', 60 * 60),
      ]);
      const args = buildGradeArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/out.mp4', filter });
      const result = await invokeRemux({ args, inputs: { '/tmp/in.mp4': inUrl }, outputs: { '/tmp/out.mp4': outUrl } });
      if (!result.ok) throw new Error(result.error ?? 'grade failed');
      await admin.from('renders').update({ base_output_r2_key: gradedKey }).eq('id', renderId);
      await deleteObject(baseKey).catch(() => {}); // best-effort cleanup of the ungraded base
      return gradedKey;
    } catch (e) {
      // Degrade: keep the ungraded base as the result; the video is still watchable.
      console.error(`grade-base degraded for render ${renderId}:`, e);
      return baseKey;
    }
  });
}
```

- The **music branch is unchanged** — `music/remux` reads `base_output_r2_key` from the DB
  (now the graded key) and mixes onto it.
- The **no-music `finalize`** must use `effectiveBaseKey` for `output_r2_key` (not the local
  `baseKey`), so a graded no-music render finalizes the graded file.
- `look === 'none'` (or unknown) ⇒ `filter` is null ⇒ the step is skipped ⇒ `base_output_r2_key`
  unchanged ⇒ **byte-identical to today**.
- `setPhase('grading')` is optional polish; reuse `rendering`/`encoding` to avoid a new
  enum value (the plan decides — no migration either way).

The grade pass is **best-effort** (try/catch degrades rather than throwing), so a transient
Lambda blip ships an ungraded — but complete — render. `invokeRemux` + the Lambda are not
unit-tested (AWS), matching the remux precedent; the grade is verified via `drive:render`.

## 6. UI

### 6.1 Channel default — `BrandEditor.tsx` + `brand-actions.ts`
Add a **Look** `<select>` (options from `LOOK_LABELS`) to the channel editor, persisted into
`channels.defaults.color_look` alongside the existing captions/density/music defaults (same
dirty-Save / no-phantom-save pattern the editor already uses). Prefill from the stored value
(default `neutral`).

### 6.2 Per-video override — `VideoSettingsPanel.tsx` + its action
Add the same Look `<select>` to the per-video panel; Save routes through the existing
settings action, which calls `sanitizeSettingsPatch` (now color-look-aware) — no new action
logic. Prefilled from the video's current `color_look`.

Both controls are a single dropdown; the `neutral` default means doing nothing still grades.

## 7. Testing

- **Unit (node:test):** `buildGradeFilter` (null for none/unknown; per-look filter token) +
  `buildGradeArgs` (vf + `-c:a copy` + libx264 + faststart + outPath); `settings.ts`
  (`color_look` sanitize valid/invalid + default `neutral` + round-trip). `create-settings`
  already covers channel-default ⊕ override generically (the new key flows through).
- **Render grade pass:** verified by the operator `drive:render` on a video with a non-`none`
  look (eyeball the graded result); the ffmpeg-Lambda I/O is not unit-tested (like remux).
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration.**

## 8. Backward compatibility

Additive. A render whose `color_look` is `none` (or any video pre-dating 3b, since
`parseVideoSettings` defaults to `neutral`… see note) routes through unchanged. **Behavioral
note:** because the default is `neutral` (a real, subtle grade), existing videos re-rendered
after 3b WILL get the neutral grade — this is the intended brand-consistency default, not a
regression, and it is subtle. A channel/video set to `none` is byte-identical to today. The
music re-mux, composition, captions, voice, and assembly paths are untouched; the grade is a
self-contained post-pass on the base MP4. No schema change.

## 9. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/color/looks.ts` (+ test) (create) | `ColorLook`/`COLOR_LOOKS`/`LOOK_LABELS`, `buildGradeFilter`, `buildGradeArgs` |
| `src/lib/videos/settings.ts` (modify) (+ test) | add `color_look` to the settings contract |
| `src/lib/inngest/functions/render.ts` (modify) | `grade-base` post-pass step (degrade-on-fail) |
| `src/app/(app)/channels/[id]/BrandEditor.tsx` + `brand-actions.ts` (modify) | channel-default Look select |
| `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` (+ action) (modify) | per-video Look override |

## 10. Open items (resolved-by-default; flagged for the plan)

- **Exact preset numbers** are pinned in the plan; all subtle + broadcast-safe. A look that
  reads too strong is tuned by adjusting the pure preset (no pipeline change).
- **`none` semantics:** `none` is the explicit "no grade" escape hatch (byte-identical);
  `neutral` is the zero-config default grade. Both are valid `color_look` values.
- **Phase label:** reuse an existing render phase for the grade step (no `job`/render-phase
  enum change); a dedicated `grading` label is optional future polish.
- **Ungraded-base cleanup** is best-effort (`deleteObject(baseKey).catch`), never fatal —
  a leftover `renders/<id>.base.mp4` is harmless if cleanup fails.
- **lut3d upgrade path:** a future slice can add `.cube`-backed looks by extending
  `buildGradeFilter`/`buildGradeArgs` to emit `lut3d` + carry the `.cube` as a second
  `invokeRemux` input — no change to the render step's shape.
