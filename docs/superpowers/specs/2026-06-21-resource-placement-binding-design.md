# Resource placement + compose binding — design (slice 2 of 2)

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — channel resources, slice 2 of 2
**Status:** design approved, ready for implementation plan

## Context

Slice 1 (2026-06-21) shipped the **resource library UI** — the operator can
upload/auto-tag/edit/delete a channel's image+video resources. But placement is
still dormant: shots are read-only in the editor, and the compose AI is never told
which resource to use.

What already exists (Phase 5):

- **Schema:** `shots.source shot_source` (`stock|resource|procedural`, default
  `stock`) + `shots.resource_id` (FK → `channel_resources`, `on delete set null`).
  `videos.channel_id` links a video to its channel (so the resource library to
  offer is the video's channel's).
- **`render.ts` `loadBrief`** already reads each shot's `source`/`resource_id`:
  `source='resource'` + a `resource_id` adds to a global `resourceIdSet`;
  `source='stock'` sets `needsStock`. After compose-start, `resolveResourceAssets`
  turns those ids into manifest entries (`resourceAssetId(id) = 'resource-<id>'`,
  `{ id, kind, r2Key }`) merged into `brief.assets`.
- **Both compose paths** (`agenticCompose`, `proceduralCompose`) build their user
  message from `buildCompositionUserPrompt(brief)`.

The gap: (a) no UI to set a shot's `source='resource'`; (b) the compose prompt
lists scene narration + shot intents but **never the pinned resources** (their
`resource-<id>` assetId, kind, or description), so the AI can't place them.

## Goal

Let the operator pin a channel resource to a shot in the video editor, and have the
composition AI (both agentic and procedural) place that exact resource as the
scene's primary visual.

## Scope

**In scope:**

- **Placement:** a per-shot resource picker in the video editor that sets
  `shots.source='resource'` + `resource_id` (or clears back to `source='stock'`,
  `resource_id=null`), backed by a pure validator + a server action.
- **Binding (strong pin):** `SceneBrief` carries per-scene pinned resources;
  `buildCompositionUserPrompt` emits a directive instructing the AI to place each
  pinned resource as the scene's primary visual; `loadBrief` populates the pins.

**Out of scope (YAGNI):**

- Reordering / adding / deleting shots; editing shot descriptions.
- Exposing `source='procedural'` in the UI (pin → `resource`, clear → `stock`).
- A `resource_tagging` cost_event (still deferred).
- Any schema change/migration (the columns + FK already exist).
- Channel-resource library management (slice 1, shipped).

## Architecture

Two coupled halves. Placement writes `shots.source`/`resource_id`; binding makes
the AI honor them. Both compose paths run through `buildCompositionUserPrompt`, so
the binding lives in the brief + prompt — no separate "forced placement" code path
(keeps the "AI emits the recipe" principle).

### Half A — shot placement

**Pure core — `src/lib/resources/shot-placement.ts` (unit-tested):**

```ts
// Normalize a picker choice into the shot's stored source/resource_id. A non-empty
// id pins (source='resource'); null/empty clears back to stock.
export function validateShotResource(
  input: { resourceId: string | null },
): { source: 'resource'; resourceId: string } | { source: 'stock'; resourceId: null };
```

Rule: `resourceId` a non-empty string → `{ source: 'resource', resourceId }`;
otherwise → `{ source: 'stock', resourceId: null }`.

**Server action — `src/app/(app)/videos/[id]/shot-actions.ts` (`'use server'`):**

```ts
export async function setShotResource(
  shotId: string,
  resourceId: string | null,
): Promise<{ ok: true; source: 'resource' | 'stock' } | { ok: false; reason: string }>;
```

`validateShotResource` → resolve account from session → direct RLS
`update(shots).set({ source, resource_id }).eq('id', shotId).eq('account_id',
accountId).select('id')` → empty/`error` → `{ ok:false }` (`'Shot not found.'` on no
row, no phantom save); else `{ ok:true, source }`. RLS already scopes the shot to the
caller; the picker only offers the video's channel resources.

### UI — `page.tsx` + `Editor.tsx` + `SceneCard.tsx`

- `videos/[id]/page.tsx`: read `videos.channel_id`, then the channel's resources
  (RLS `channel_resources` where `channel_id = <video.channel_id>` → `{ id, kind,
  description }[]`), and pass them to `<Editor>`.
- `Editor.tsx`: thread the `resources` list down to each `SceneCard`; on a pin
  change, call `setShotResource` and update the shot's local `source`/`resource_id`.
- `SceneCard.tsx`: each shot gains a small `<select>` — options are "Use stock"
  (clear) + one per channel resource (`description` (or filename) + kind). Selecting
  pins; the shot's `source` badge reflects `stock` vs `resource`. Shots stay
  otherwise read-only (this is the single editable control on a shot). The `Shot`
  type gains `resource_id: string | null`.

### Half B — compose binding (strong pin)

**Pure — `src/lib/composition/compose.ts`:**

```ts
export interface SceneBrief {
  // ...existing...
  pinnedResources?: { assetId: string; kind: 'image' | 'video'; description: string }[];
}
```

`buildCompositionUserPrompt(brief)` — for each scene that has `pinnedResources`,
append a directive after its shot intents, e.g.:

```
  PINNED resources (you MUST place these as this scene's primary visual —
  an Image/Video at layer 0, fit "cover"; do NOT search stock for this scene's
  background):
    - resource-<id> (<kind>): <description>
```

A one-line note in `buildCompositionSystemPrompt`'s stock section: pinned resources
take precedence over stock for their scene. No change to `AssetManifestEntry` (the
description rides in the prompt only; the manifest entry stays `{ id, kind, r2Key }`).

**`render.ts` `loadBrief`:** while iterating shots, for each `source='resource'` shot
with a non-null `resource_id`, look up that resource's `kind` + `description` (one
batched select of the scene's resources, or reuse the per-id lookup) and push
`{ assetId: resourceAssetId(resource_id), kind, description }` onto that scene's
`pinnedResources`. The global `resourceIds` collection (for `resolveResourceAssets`)
is unchanged, so the bytes still land in `brief.assets` and the `resource-<id>` the
AI references is a valid manifest entry (Gate 1 passes).

## Data flow

```
editor → pick resource for a shot → setShotResource(shotId, resourceId)
       → shots.source='resource', resource_id   (or clear → 'stock', null)
render loadBrief → per-scene pinnedResources {assetId,kind,description}
                 + global resourceIds (unchanged)
   → resolveResourceAssets merges bytes into brief.assets
   → buildCompositionUserPrompt emits the strong pin directive per scene
   → agentic OR procedural compose places resource-<id> as the scene visual
   → Gate 1 validates the asset-ref (resource entry already in the manifest)
```

## Error handling

- `setShotResource` → `{ ok:false, reason }` on RLS error; no-row → "Shot not
  found." The editor shows the reason and leaves the prior selection.
- A pinned resource deleted after pinning: the FK `on delete set null` clears
  `resource_id`, leaving `source='resource'` with a null id. `loadBrief` skips a
  null `resource_id` (no pin emitted, no broken manifest ref) — harmless; the scene
  falls back to procedural/stock for that shot.
- Empty channel library → the picker shows only "Use stock".
- The strong-pin directive is prompt text; if the AI still omits a pinned asset,
  Gate 1/Gate 2 behave exactly as today (no new failure mode introduced).

## Back-compatibility

- Additive. Videos with no resource-pinned shots produce a byte-identical brief +
  prompt (no `pinnedResources` → no directive). The agentic/procedural split,
  stock search, and Gate 1/2 are unchanged.
- `shots` rows default `source='stock'`; existing videos are unaffected until the
  operator pins something.
- Reuses `resolveResourceAssets` + the render-time resource pre-resolution unchanged.

## Testing

- **Unit (`src/lib/resources/shot-placement.test.ts`):** `validateShotResource` —
  a non-empty id → `{ source:'resource', resourceId }`; null/`''` → `{ source:'stock',
  resourceId:null }`.
- **Unit (`src/lib/composition/compose.test.ts`):** `buildCompositionUserPrompt`
  emits the pin directive (the `resource-<id>` + description) for a scene with
  `pinnedResources`, and omits it for a scene without; existing prompt assertions
  stay green.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds.
- **Manual / app-run e2e:** pin a channel resource to a shot in the editor → its
  badge flips to `resource` and persists on reload → render with stock keys ON
  (agentic) → the pinned asset is the scene's visual → render with stock keys OFF
  (procedural) → the pinned asset still appears → clear the pin → the scene returns
  to stock/procedural.

## Open questions

None. Per-shot placement, strong-pin binding via the shared prompt (both compose
paths), and no-migration reuse of the existing resolution path are settled.
