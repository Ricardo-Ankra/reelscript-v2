# Slice C2 — Brief-Driven Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed each shot's structured `VisualBrief` (from Slice C1) into the composition AI prompt — as an enriched, self-describing shot hint with an explicit *specific-entity* directive — so composition writes better stock queries and never substitutes generic stock for a specific named entity.

**Architecture:** A pure `formatShotHint(brief, description)` renders one enriched hint string per shot (structured subject/action/setting + framing/mood, plus a "SPECIFIC ENTITY — use the pinned/uploaded asset, do not substitute generic stock" suffix when `specificity === 'entity'`). `loadBrief` (render.ts) reads each shot's `visual_brief` and builds the scene's `shotHints` from `formatShotHint` instead of the raw `description`. The compose prompt (`buildCompositionUserPrompt`) and the agentic/procedural loops are otherwise unchanged — they already render `shotHints`.

**Scope note (supersedes the design's "provider registry"):** the original Slice C design proposed refactoring `resolve.ts` into an `AssetProvider` registry. That is **dropped as YAGNI** — resolution is already three separated paths in `render.ts` (pinned → `resolveResourceAssets`; stock → the agentic vision loop; procedural → primitives), the agentic loop is already the router, and Slice B + C1 already deliver "prefer the attached asset." C2 delivers the design's *intent* (brief-driven, entity-aware composition) with a minimal, low-risk change. See the design doc's "Update (2026-06-22)" note.

**Tech Stack:** TypeScript, node:test. (Compose prompt construction + the Inngest render loader.)

## Global Constraints

- **No schema change, no new dependency.** Reuses C1's `shots.visual_brief` + `parseVisualBrief`.
- **`formatShotHint(brief: VisualBrief | null, description: string): string`** — `null` brief → return `description` unchanged (back-compat: legacy/unbriefed shots compose exactly as today). With a brief: a core from non-empty `subject`/`action`/`setting` (comma-joined; falls back to `description` when all three are empty), then `framing`/`mood` in parentheses when present, then — only when `specificity === 'entity'` — a suffix: ` — SPECIFIC ENTITY (<"entity_name" | a specific named entity>): use the pinned/uploaded asset if present; do not substitute generic stock.`
- **The compose prompt structure is unchanged** — `buildCompositionUserPrompt` still renders `SceneBrief.shotHints` as the "shot intents" list; only the *content* of those strings is richer. Existing compose tests must stay green.
- **The agentic/procedural loops, Gate 1, Gate 2, `needsStock`, pins, and the render path are unchanged.** A shot pinned to a resource is still surfaced via `pinnedResources` (Slice B) AND now carries the entity directive in its hint — reinforcing, not replacing.
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **`render.ts` (the Inngest loader) is not unit-tested** — verified by `tsc` + `lint` + `build`; the pure `formatShotHint` carries the tested logic.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

**Modify:**
- `src/lib/composition/compose.ts` — add the pure `formatShotHint`.
- `src/lib/composition/compose.test.ts` — test `formatShotHint`.
- `src/lib/inngest/functions/render.ts` — `loadBrief` selects `visual_brief` and builds `shotHints` via `formatShotHint`.

---

### Task 1: `formatShotHint` (pure)

**Files:**
- Modify: `src/lib/composition/compose.ts`
- Test: `src/lib/composition/compose.test.ts`

**Interfaces:**
- Consumes: `VisualBrief` (`@/lib/videos/visual-brief`).
- Produces: `formatShotHint(brief: VisualBrief | null, description: string): string`.

- [ ] **Step 1: Add the failing test**

Append to `src/lib/composition/compose.test.ts` (add `formatShotHint` to the existing import from `./compose.ts`, or add an import line if the file imports nothing from it yet):

```ts
test('formatShotHint: null brief returns the description unchanged', () => {
  assert.equal(formatShotHint(null, 'a city street at night'), 'a city street at night');
});

test('formatShotHint: generic brief renders core + framing/mood, no entity suffix', () => {
  const hint = formatShotHint(
    {
      subject: 'a city street',
      action: 'cars passing',
      setting: 'night, rain',
      framing: 'wide',
      mood: 'moody',
      specificity: 'generic',
      entity_name: null,
      recommended_source: 'stock',
    },
    'fallback',
  );
  assert.equal(hint, 'a city street, cars passing, night, rain (wide; moody)');
  assert.ok(!hint.includes('SPECIFIC ENTITY'));
});

test('formatShotHint: entity brief appends the named entity directive', () => {
  const hint = formatShotHint(
    {
      subject: 'Rivian R2',
      action: 'driving',
      setting: 'coastal road',
      framing: '',
      mood: '',
      specificity: 'entity',
      entity_name: 'Rivian R2',
      recommended_source: 'upload',
    },
    'fallback',
  );
  assert.match(hint, /^Rivian R2, driving, coastal road/);
  assert.match(hint, /SPECIFIC ENTITY \("Rivian R2"\)/);
  assert.match(hint, /do not substitute generic stock/);
});

test('formatShotHint: entity brief without a name uses the generic entity phrase', () => {
  const hint = formatShotHint(
    {
      subject: 's',
      action: '',
      setting: '',
      framing: '',
      mood: '',
      specificity: 'entity',
      entity_name: null,
      recommended_source: 'upload',
    },
    'fallback',
  );
  assert.match(hint, /SPECIFIC ENTITY \(a specific named entity\)/);
});

test('formatShotHint: brief with all-empty descriptive fields falls back to the description', () => {
  const hint = formatShotHint(
    {
      subject: '',
      action: '',
      setting: '',
      framing: '',
      mood: '',
      specificity: 'generic',
      entity_name: null,
      recommended_source: 'stock',
    },
    'fallback desc',
  );
  assert.equal(hint, 'fallback desc');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: FAIL — `formatShotHint` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/composition/compose.ts`, add the import near the top (with the other imports):

```ts
import type { VisualBrief } from '@/lib/videos/visual-brief';
```

and add the function (e.g. right before `buildCompositionUserPrompt`):

```ts
// Render one shot's intent for the composition prompt. With a visual brief (Slice C1)
// it produces a richer, entity-aware hint than the terse description: subject/action/
// setting as the core, framing/mood as qualifiers, and — for a specific named entity —
// an explicit directive to use the pinned/uploaded asset rather than generic stock.
// A null brief (legacy/unbriefed shot) returns the description unchanged.
export function formatShotHint(brief: VisualBrief | null, description: string): string {
  if (!brief) return description;
  const core =
    [brief.subject, brief.action, brief.setting]
      .map((p) => p.trim())
      .filter(Boolean)
      .join(', ') || description.trim();
  const qualifiers = [brief.framing, brief.mood].map((p) => p.trim()).filter(Boolean);
  let hint = qualifiers.length ? `${core} (${qualifiers.join('; ')})` : core;
  if (brief.specificity === 'entity') {
    const name = brief.entity_name ? `"${brief.entity_name}"` : 'a specific named entity';
    hint += ` — SPECIFIC ENTITY (${name}): use the pinned/uploaded asset if present; do not substitute generic stock.`;
  }
  return hint || description;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: PASS (existing compose tests + the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/composition/compose.ts src/lib/composition/compose.test.ts
git commit -m "feat(composition): formatShotHint — brief-driven, entity-aware shot hints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `loadBrief` builds shot hints from the brief (full gate)

**Files:**
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes: `formatShotHint` (`@/lib/composition/compose`, Task 1); `parseVisualBrief` (`@/lib/videos/visual-brief`, Slice C1).

No unit test (the Inngest loader). This task runs the FULL gate.

- [ ] **Step 1: Add the imports**

In `src/lib/inngest/functions/render.ts`, add `formatShotHint` to the existing `@/lib/composition/compose` import (the file already imports `type SceneBrief` and others from it — add `formatShotHint` to that import list). Add a new import for the parser:

```ts
import { parseVisualBrief } from '@/lib/videos/visual-brief';
```

- [ ] **Step 2: Select `visual_brief` in the shots read**

In `loadBrief`, the shots query currently is:

```ts
    const { data: shotRows } = await admin
      .from('shots')
      .select('scene_id, description, position, source, resource_id')
      .in('scene_id', ids)
      .order('position');
```

Add `visual_brief`:

```ts
    const { data: shotRows } = await admin
      .from('shots')
      .select('scene_id, description, position, source, resource_id, visual_brief')
      .in('scene_id', ids)
      .order('position');
```

- [ ] **Step 3: Build the hint from the brief**

In the same loop, the hint is currently pushed as the raw description:

```ts
    for (const sh of shotRows ?? []) {
      const list = shotsByScene.get(sh.scene_id as string) ?? [];
      list.push(sh.description as string);
      shotsByScene.set(sh.scene_id as string, list);
```

Change the pushed value to the enriched hint:

```ts
    for (const sh of shotRows ?? []) {
      const list = shotsByScene.get(sh.scene_id as string) ?? [];
      list.push(formatShotHint(parseVisualBrief(sh.visual_brief), sh.description as string));
      shotsByScene.set(sh.scene_id as string, list);
```

(The rest of the loop — `source === 'resource'` pin/`needsStock` handling — is unchanged.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS (including the new `formatShotHint` tests in `compose.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add "src/lib/inngest/functions/render.ts"
git commit -m "feat(render): compose from brief-driven shot hints (loadBrief)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (slice C2 = brief-driven composition, per the design's 2026-06-22 update):**
- Surface the structured `VisualBrief` to the composition AI → Tasks 1 (formatter) + 2 (loadBrief wiring). ✓
- Explicit specific-entity directive ("use the pinned/uploaded asset, do not substitute generic stock") → Task 1's entity suffix. ✓
- Better stock queries from the richer intent → the enriched hint feeds the agentic loop's query authoring (no loop change needed). ✓
- Provider-registry refactor → **correctly dropped (YAGNI), recorded in the design update.** ✓
- Back-compat: null brief → description unchanged → compose identical to today → existing videos/tests unaffected. ✓
- No schema change; pins/Gate 1/Gate 2/needsStock/render path unchanged → honored (only the hint string content changes). ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Both code steps show complete code; the loadBrief change shows the exact before/after for the query and the loop push. ✓

**3. Type consistency:** `formatShotHint(brief: VisualBrief | null, description: string): string` (Task 1) is called in `loadBrief` as `formatShotHint(parseVisualBrief(sh.visual_brief), sh.description as string)` (Task 2) — `parseVisualBrief` returns `VisualBrief | null`, matching the first param. `SceneBrief.shotHints` stays `string[]` (unchanged), so `buildCompositionUserPrompt` and every downstream consumer are untouched. ✓
