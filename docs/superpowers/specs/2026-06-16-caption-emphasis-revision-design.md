# Caption emphasis revision — DOAC-style animated captions

**Date:** 2026-06-16
**Status:** Design approved; spec under review before implementation.
**Supersedes:** the Phase-6 two-track caption/kinetic split
(`docs/superpowers/specs/2026-06-12-phase-6-creative-polish-design.md`), the
`bounce`/`pop` closed enum on `KineticText`, and `kinetic_text_usage` as a
channel-level toggle.

## Summary

Replace the two-track text model (a plain lower-third `CaptionTrack` plus an
AI-placed `KineticText` primitive) with **one animated caption track** that
builds word-by-word in sync with the voice and carries emphasis inline — the
"Diary of a CEO" (DOAC) look. Emphasis is a **three-axis annotation**
(`role` / `tone` / `effect`) the AI emits per word; the renderer resolves each
axis deterministically. Timing comes from the existing
`scenes.word_alignments` (ElevenLabs character-level alignment, Phase 3) — the
same source that drove both prior tracks, so no new timing data is introduced.

`KineticText` is **retired by deprecation, not removal**: its prop schema is
marked `deprecated` so in-flight specs that still reference it do not hard-fail,
but the composition AI no longer places it and no new authoring path emits it.

## Governing-principle fit

This stays inside "the AI emits recipes, not output":

- The AI emits **labels** (three closed enums per emphasized word), never
  styling values or animation code.
- The renderer resolves labels deterministically: `role` → typography and
  `tone` → color from **baked brand tables**; `effect` → a function from a
  **code registry**.
- The render path executes only pre-validated code. New effects are authored
  **once** through the existing four authoring gates (the primitive-studio
  model), never generated per render.

## Pipeline

```
scenes.word_alignments ──┬── chunkWords()       (deterministic: timing + grouping)
                         └── emphasisPass()      (NEW: Haiku, per scene)
                                  │  → coherence validator (strips incoherent pairings)
                                  ▼
                          buildCaptionChunks()  → CaptionChunk[]
                                  ▼
                          spec.captions: CaptionChunk[]
                                  ▼
                          AnimatedCaptionTrack   (Remotion renderer)
```

Emphasis is computed at render-brief assembly time (ephemeral, exactly as
captions are today — recomputed per render, never persisted). If the emphasis
pass fails, times out, or returns nothing, captions render with **all-normal
words**. Emphasis never blocks a render.

The compose step (Sonnet) no longer receives per-word frame windows for
`KineticText` alignment and no longer places `KineticText` instances. That
prompt block and placement logic are removed.

## Canonical spoken-word tokenizer (load-bearing invariant)

`WordEmphasis.index` and `chunkWords` both refer to "the scene's spoken-word
list." These two consumers **must derive that list from one canonical
tokenizer** — they must not each reconstruct words from `word_alignments`
independently. If they tokenize differently, indices silently misalign and
emphasis lands on the wrong word.

**Invariant:** a single function (the canonical tokenizer, e.g.
`tokenizeSpokenWords(alignment)` — the one source replacing today's ad-hoc
`reconstructWords`) produces the ordered spoken-word list, each token carrying
its text and its `fromFrame`/`toFrame`. **Both** the emphasis-pass input
builder **and** `chunkWords` consume that exact list; `WordEmphasis.index` is an
index into it. No other code reconstructs words from `word_alignments`.

This must hold across the tricky cases: hyphenates (`well-being`), decimals
(`2.5`), contractions (`doesn't`), and em-dashes (`creatine—really`). The
tokenizer's decision on each (one token vs. several) is the canonical answer;
correctness only requires that **both consumers agree**, not which choice is
made. A unit test asserts the two consumers produce identical token boundaries
for a fixture set covering all four cases.

## Data model

Replaces `spec.captions?: CaptionSegment[]`:

```ts
type EmphasisRole   = 'key' | 'shout' | 'contrast' | 'number';      // → typography
type EmphasisTone   = 'positive' | 'negative' | 'neutral';          // → color
type EmphasisEffect = 'pop' | 'topple' | 'shatter' | 'shake'        // → animation
                    | 'rise' | 'zoom' | 'glitch';

interface WordEmphasis {
  index: number;            // word index within the scene's spoken-word list
  role: EmphasisRole;       // required on every emphasized word
  tone?: EmphasisTone;      // optional; omitted → neutral
  effect?: EmphasisEffect;  // optional; the RARE axis (see coherence validator)
}

interface CaptionWord {
  text: string;
  fromFrame: number;        // word pops in here (absolute frame)
  toFrame: number;          // spoken-word end (for active-state / travel effects)
  emphasis?: WordEmphasis;  // undefined → normal word
}

interface CaptionChunk {
  fromFrame: number;        // chunk first visible
  toFrame: number;          // chunk replaced
  words: CaptionWord[];
}

// spec.captions?: CaptionChunk[]
// spec.captionStyle? retained for band position + base size
```

## The three axes

Each emphasized word carries up to three orthogonal labels; the renderer
resolves each independently.

| Axis | AI emits | Resolves to | Source of truth |
|---|---|---|---|
| **role** | `key` / `shout` / `contrast` / `number` | font slot, weight, size×, italic | **brand table** (baked) |
| **tone** | `positive` / `negative` / `neutral` | color | **brand table** + theme tokens (baked) |
| **effect** | `pop` / `topple` / `shatter` / `shake` / `rise` / `zoom` / `glitch` | animation | **code registry** (gate-validated) |

`role` is required on every emphasized word; `tone` and `effect` are optional.
Example: `"broken"` → `{role:'shout', tone:'negative', effect:'shatter'}`
(large bold red word that breaks apart); `"boost"` →
`{role:'key', tone:'positive', effect:'rise'}` (green word that floats up).

### role → typography (brand-configurable)

Resolved from `brand_kit.caption_emphasis.roles`, baked into the theme
snapshot. Defaults (each field brand-overridable):

| role | font slot | weight | sizeMultiplier | italic |
|---|---|---|---|---|
| `key` | body | 700 | 1.15 | no |
| `shout` | display | 800 | 1.40 | no |
| `contrast` | body | 600 | 0.90 | yes |
| `number` | display | 800 | 1.50 | no |

### tone → color (brand-configurable, runs through the legibility bake)

Resolved from `brand_kit.caption_emphasis.tones`, baked into the snapshot.
Defaults: `positive` → `theme.colors.positive` (green), `negative` →
`theme.colors.negative` (red), `neutral` → `theme.colors.accent`.

The tone color is **not** applied to glyphs raw. It is routed through the
**existing legibility bake pass** (the same stroke/scrim/shadow step
`CaptionTrack` and `KineticText` already use), so:

- low contrast against the baked background is detected and corrected
  (stroke/scrim strength bumped, or color nudged toward a legible variant),
- color-blind-ambiguous pairings (e.g. a red/green that collapse under common
  CVD simulations) are caught at bake time rather than trusted blindly.

This keeps brand colors honored where legible and corrected where not, and
keeps the correction logic in one place.

### effect → animation (code registry, gate-validated, AI-selected)

`remotion/captions/effects/` is a registry mapping `effectName →
(progress: 0→1, wordGeometry) ⇒ { transform, opacity, clipPath }`. The AI picks
the effect whose **meaning** matches the word; the renderer runs the registered
function.

Starter set (Option 1, lean): `pop` (default), `topple` (rotate + fall),
`shatter` (glyph splits, halves fly apart), `shake`, `rise`, `zoom`, `glitch`.

**One trust class.** Every effect — including the hand-written starter set —
is a gate-validated artifact. There is **no hand-written exemption**: the
starter effects are seeded through the **same four gates** that studio-grown
effects pass:

- **lint** — security AST check (no disallowed APIs/imports),
- **compile** — esbuild bundle success,
- **smoke** — renders a sample word with the effect across `progress` without
  error and without clipping out of the caption band,
- **brand stress** — vision check that the effect stays legible across the
  brand stress kit (theme variations).

Growth path (later increment): new effects are authored through the primitive
authoring studio and, on passing the gates, join the same registry —
identical trust model to primitives. No render-time codegen, ever.

## Emphasis pass (new)

A small per-scene AI step, pinned to **Haiku 4.5** in code (`model_routing`
remains Phase 8). Pure prompt-builder + parser/validator; the network call is
the only impure part.

- **Input:** the scene's spoken-word list (`index` + `text`) and the scene's
  script context (so the model judges meaning and sentiment).
- **Output:** `WordEmphasis[]`.
- **Density:** driven by `caption_emphasis_density` (`off` → pass skipped, no
  emphasis; `sparing` → light; `liberal` → heavier). See the rename below.

### Authoring-time coherence validator

After the AI returns and before annotations reach `buildCaptionChunks`, a
deterministic validator enforces coherence (this runs at annotation /
"authoring" time, not in the renderer):

1. **`effect` is the rare axis.** Most emphasized words should carry `role` +
   `tone` only. The Haiku prompt is constrained to apply `effect` sparingly —
   reserved for words whose meaning has an obvious motion (e.g. "drop",
   "broken", "explode") — and the validator enforces a ceiling on the share of
   emphasized words that carry an `effect`, stripping the weakest-justified
   `effect` labels down to `role` + `tone` when the ceiling is exceeded.

   **Named constant:** `EMPHASIS_EFFECT_CEILING = 1/3` (≈ ⅓ of emphasized
   words may carry an `effect`). The validator computes the cap as
   `maxEffects = Math.max(1, Math.round(emphasizedCount * EMPHASIS_EFFECT_CEILING))`
   — the `Math.max(1, …)` floor guarantees a single emphasized word (e.g. a lone
   "broken") may still take an effect. When more `effect` labels than `maxEffects`
   survive, the validator keeps those on the highest-`role` words (`shout` >
   `number` > `key` > `contrast`) and strips the rest to `role` + `tone`. The
   **same constant** is referenced by both the validator and the Haiku prompt
   guidance — they must not drift.
2. **Strip incoherent `tone`↔`effect` pairings.** Semantically contradictory
   combinations are not passed to the renderer; the offending `effect` is dropped
   (the word keeps its `role` + `tone`). The full initial incoherent-pair map —
   the explicit, testable source the validator and its test share:

   | effect | inherent valence | disallowed tone(s) |
   |---|---|---|
   | `pop` | neutral | — (allowed with any tone) |
   | `zoom` | neutral | — (allowed with any tone) |
   | `rise` | positive (up / growth) | `negative` |
   | `topple` | negative (fall / collapse) | `positive` |
   | `shatter` | negative (break apart) | `positive` |
   | `glitch` | negative (malfunction / fake) | `positive` |
   | `shake` | negative (alarm / instability) | `positive` |

   `neutral` tone is coherent with every effect. `pop` and `zoom` are valence-free
   and coherent with every tone. Any (tone, effect) pair in the disallowed column
   drops the `effect`.
3. **Validate indices and enums.** Out-of-range indices and unknown enum values
   are dropped.

The validator never throws; it degrades a word toward `role`+`tone`, then toward
normal, rather than failing the pass.

The Haiku prompt is written to match these rules up front: it documents the
three axes, lists the effect vocabulary with one-line "use when" hints, states
that `effect` is rare and meaning-driven (citing the same `EMPHASIS_EFFECT_CEILING`
target so prompt and validator agree), names the disallowed `tone`↔`effect`
pairings from the table above, gives the sentiment→tone guidance (positive =
green-ish / negative = red-ish / dramatic), and instructs sparing density. The
validator is the backstop, not the primary control.

## Chunking (deterministic)

`chunkWords` replaces the line-packing (`packLines`). It groups reconstructed
words into chunks of ~2–5 words, breaking on:

- clause punctuation (`.` `,` `?` `!` `;`),
- a pause gap in the alignment (> ~0.35 s between adjacent words),
- a max words / max chars ceiling.

Each word retains its own `fromFrame` / `toFrame` from the alignment so the
renderer can reveal words progressively.

## Renderer — `AnimatedCaptionTrack`

Replaces `CaptionTrack` as the system caption layer; absorbs `KineticText`'s
role. For the current frame it:

1. finds the active `CaptionChunk` (`fromFrame ≤ frame < toFrame`),
2. wraps its words into lines (accounting for per-word size multipliers),
3. renders each word with `frame ≥ word.fromFrame` using a spring entrance
   keyed on `frame − word.fromFrame`, applying the resolved `effect(progress)`
   transform plus `role` typography and `tone` color,
4. sits in a **center-lower band** (larger and more central than the prior
   lower-third), configurable via `spec.captionStyle`,
5. applies the legibility bake (stroke + shadow; scrim optional) — including the
   tone-color correction described above.

Normal (non-emphasized) words use the base typography, foreground color, and a
soft fade-up entrance.

## Removals and deprecations

- **`KineticText`: deprecate, do not remove.** Its starter prop schema is set to
  `deprecated` state (not removed) so in-flight specs referencing it do not
  hard-fail. The composition AI no longer places it; no authoring path emits it.
- **Remove** `collectKineticSpans` and `suppressDuringSpans`.
- **Remove** the zone/temporal-suppression machinery — the layout zones that
  reserved upper/center for kinetic and lower-third for captions, and the
  per-frame caption suppression during kinetic spans. With a single text layer
  there is nothing to dodge; the caption band is the only text region.
- **Remove** the compose-time `KineticText` placement and the per-word
  frame-window block in the compose prompt.
- **SRT / VTT sidecars unchanged** — built from the same word timings,
  emphasis-agnostic, still always exported.

## Theme changes

Add two color tokens to the baked theme snapshot:

```ts
// Theme.colors gains:
positive: string;   // default green, brand-overridable via brand_kit
negative: string;   // default red, brand-overridable via brand_kit
```

Baked at render time alongside the existing tokens, so renders stay
self-contained. `tone` resolves through these tokens and then the legibility
bake (above).

Add `brand_kit.caption_emphasis`:

```ts
interface CaptionEmphasisConfig {
  roles?: Partial<Record<EmphasisRole, {
    font?: 'display' | 'body' | 'mono';
    weight?: number;
    sizeMultiplier?: number;
    italic?: boolean;
  }>>;
  tones?: Partial<Record<EmphasisTone, { color: string }>>;  // theme token name or hex
}
```

## Settings / schema change

**Rename, do not repurpose.** `kinetic_text_usage` →
`caption_emphasis_density`, values `off` / `sparing` / `liberal`. The rename
applies to both `videos.settings` and `channels.defaults`. A migration performs
the rename now (pre-launch, so no production data risk and no compatibility
shim). `captions_on` is unchanged.

## Testing

- **Pure / unit (`node --test`):** the **canonical tokenizer agreement test** —
  the emphasis-pass input builder and `chunkWords` produce identical token
  boundaries for a fixture set covering hyphenates, decimals, contractions, and
  em-dashes (the load-bearing invariant); `chunkWords`; `role`→typography and
  `tone`→color resolution; effect-registry sampling at fixed `progress` values
  (deterministic); the coherence validator (effect-ceiling enforcement against
  `EMPHASIS_EFFECT_CEILING`, incoherent-pair stripping against the full pair map,
  index/enum validation); the emphasis-pass prompt-builder and parser against
  fixtures (network call mocked).
- **Gates:** the starter effects pass lint / compile / smoke / brand-stress as
  part of seeding the registry (CI-runnable), proving the one-trust-class model.
- **Visual / e2e:** headless render + frame inspection via the existing
  `drive:render` / `inspect:render` helpers, confirming progressive reveal,
  role/tone styling, and a representative effect.

## Addendum — per-scene caption focus (2026-06-16)

Captions are positioned per VIDEO today (one baked `captionStyle`). A scene whose
point is the footage wants its captions out of the way; a scene whose point is the
words wants them central and large. So captions gain a per-scene **focus** — the
same label→style recipe as the emphasis axes.

- **Type:** `CaptionFocus = 'visual' | 'text' | 'balanced'`.
- **Source:** the compose AI emits one per scene (it both reads the narration and
  chooses the visual, so it is the right judge). Emitted as an optional
  `captionFocus` on each scene of the composition output; unknown/omitted →
  `balanced` (graceful, so existing specs are unaffected).
- **Flow:** `parseComposition` validates it → `AiComposition` → `assembleSpec`
  sets `CompositionScene.captionFocus` (Gate 1 accepts it) → `render.ts` tags each
  scene's `CaptionChunk`s with it (`CaptionChunk.focus`) → `AnimatedCaptionTrack`
  resolves the active chunk's focus to a vertical band + size scale.
- **Default mapping** (renderer, fixed in V1 — structured to become brand-config
  later, like the emphasis tables):

  | focus | vertical band | size scale |
  |---|---|---|
  | `text` | true center | ×1.05 |
  | `balanced` | center-lower (current default) | ×1.0 |
  | `visual` | lower third | ×0.85 |

  The scale multiplies the existing per-word `sizeMultiplier`, so emphasis sizing
  layers on top. If `caption_style.position` is `'top'`, captions stay top and only
  the size scale applies. Per-scene only — captions hold a stable position for the
  whole scene (no mid-scene shot moves).

## Out of scope (this revision)

- Authoring new effects through the studio UI (the growth path / Option 3) —
  the registry and gate-validation model are established here; the studio wiring
  is a later increment.
- `model_routing` (Phase 8) — the emphasis pass pins Haiku in code, consistent
  with the current Sonnet/Opus pinning pattern.
- Net-new emphasis fonts beyond the theme's display/body/mono slots — `role`
  selects among available slots; loading additional brand fonts is a separate
  brand-asset concern.
