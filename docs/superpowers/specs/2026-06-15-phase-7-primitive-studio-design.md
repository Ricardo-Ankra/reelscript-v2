# Phase 7 — Primitive authoring studio — Design

**Status:** COMPLETE & verified (backend e2e) 2026-06-15 — incl. step 2 (brand gate +
auto-fix); studio UI browser review is the operator's pending pass (proposed 2026-06-15)
**Build plan phase:** Phase 7 ("the library becomes extensible from the frontend")
**Milestone:** **author a new primitive by describing it, watch it pass the gates, and
have the composition AI use it in the next video.**

## 1. Goal & scope

Make the primitive library extensible from the UI: describe a primitive → the AI drafts
contract-compliant code → authoring gates validate it once → it's saved, the Remotion
site re-bundles, and the composition AI can place it in the next render. "AI emits
recipes, not output" still holds — the *one* place AI-authored code exists is here,
validated once at authoring time, never at render time (spec intro / §9).

Three operator answers shaped this scope:
1. **3 gates first** — lint + compile + smoke for the milestone. The **brand stress-kit
   gate** and the **bounded auto-fix loop** land as **Phase-7 step 2** (still Phase 7,
   sequenced after the spine works).
2. **Overwrite the single site** on re-bundle — defer the §9.7 "pin in-flight renders to
   their site version" guarantee (low risk: quick renders, single operator).
3. **Lightweight code editor** — a styled textarea, no Monaco dependency.

### In scope (the milestone slice)
- **Dynamic-bundle spine** — the core enabler: take primitive *code as a string* →
  bundle a Remotion site that includes it → render a still on Lambda. Powers both the
  smoke gate and the live re-bundle.
- **The primitive skill** (`SKILL.md` + the contract + the `KeyStatRing` worked example)
  — the drafting system prompt that makes first drafts usually gate-passing (§9.5).
- **`draftPrimitive`** (spec 9.5) — NL instruction → `{ code, proposedSchema }`, Opus +
  the skill. Nothing saved/trusted here.
- **Gates (3 of 4, spec 9.6):** **lint** (static AST of the contract — the security
  boundary), **compile** (esbuild bundle-success), **smoke** (render sample props on the
  isolated Lambda, not-blank). Per-gate results + failing-frame key.
- **The studio UI** (§9.4) — three panes: Draft-with-AI chat · code editor (textarea) ·
  preview + live gate results. Save-to-library disabled until gates pass.
- **`savePrimitive`** — enforce `assertSchemaEvolution` (§9.3, already in `contract.ts`),
  bump version, emit `primitive/deploy`.
- **`primitive/deploy` Inngest job** — regenerate the registry from all active DB
  primitives + the starter set, bundle, deploy (overwrite siteName `reelscript`), mark
  `deployed_version`. On deploy failure: keep the primitive validated-but-not-deployed,
  surface the error (`bundle_deploy` class, spec 15.1).
- **Compose integration** — the compose prompt + Gate 1 read a **combined registry**
  (starter + active+deployed DB primitives), so the AI can place the new brick and Gate 1
  validates against its schema. Record `primitive_usages` at compose time.

### Explicitly deferred (anticipated, not built)
- **Brand-integration stress-kit gate** + **bounded auto-fix loop** (§9.6/9.6.1) →
  Phase-7 step 2 (next, once the spine + 3 gates work).
- **In-flight render pinning / versioned sites** (§9.7) — overwrite for V1.
- **Full library list view + lifecycle UI** (archive/restore/delete with usage gating,
  §9.8) — `setPrimitiveStatus` is specced; build the minimal save+list, defer the rich
  filters/archive UI unless the milestone needs it.
- **Full `tsc` type-check** as the compile gate — V1 uses esbuild bundle-success.
- **Monaco editor**, **Realtime gate streaming** — textarea + request/response for V1.
- Starter-set expansion (Audio, Group, LowerThird, ImageWithPan, VideoClip per §9.9) —
  demand-driven later; the milestone is about authoring a *new* one.

## 2. Decisions (proposed — flagged ones ⚑)

| Decision | Choice | Rationale |
|---|---|---|
| Dynamic bundle ⚑ | A server module bundles a Remotion site from primitive **code strings** written into a temp source tree + a generated registry, via `@remotion/bundler` `bundle()` → `deploySite`. | The one capability the studio rests on. De-risked first (Phase-1 pattern). |
| Smoke gate ⚑ | Bundle an **isolated harness** site (just the candidate + a `GateHarness` composition rendering it with sample props under a brand-kit `ThemeContext`), deploy to a throwaway `siteName=gate-<hash>`, `renderStillOnLambda` mid-frame, reuse `frameLooksBlank`. | Untrusted code executes ONLY in the Lambda render sandbox (no secrets/DB/R2-write), spec 9.6. |
| Lint (security boundary) ⚑ | Static AST via the **TypeScript compiler API**: enforce `IMPORT_WHITELIST`, no `Math.random`/`Date.now`/`performance.now`/`new Date()`, no `fetch`/`XHR`/dynamic `import()`/`eval`, no hardcoded hex colours or px frame dims, media via Remotion `<Img>`/`<OffthreadVideo>`. | The documented lint contract in `contract.ts` becomes executable. `typescript` (already a devDep) becomes a runtime dep for the linter. |
| Compile gate | **esbuild bundle-success** (the bundle step compiles the candidate; surfaces syntax/import/most errors). Full `tsc` type-check is a refinement. | Fast inline feedback; the bundle has to succeed for smoke anyway. |
| Sample props | Generated from the prop schema: defaults where present, else a typed sample per `type` (string→"Sample", number→1, enum→first value, token→'accent', asset→a tiny baked test asset). | Drives preview + smoke without the AI inventing props. |
| Drafting model | **Opus** + the primitive skill (spec 3.4 / 9.5), pinned in code; compose stays Sonnet. `model_routing` is Phase 8. | Spec: primitive drafting uses Opus with the skill loaded. |
| Registry → DB-driven ⚑ | At bundle time, generate the registry from the **starter set + active DB primitives**; `compose.ts`/`gate1.ts` read a **combined registry** (today they hardcode `STARTER_REGISTRY`). | The AI can only place primitives that exist in the deployed bundle. |
| Deployed-set tracking ⚑ | Migration adds `primitives.deployed_version int`; the deploy job sets it = `version` on success. Compose offers **active primitives with `deployed_version = version`**. | A save whose deploy failed stays validated-but-not-deployed and is NOT offered to compose (spec 15.1 `bundle_deploy`). |
| Re-bundle | **Overwrite** `siteName=reelscript`; `serveUrl` is unchanged (deterministic per siteName), so no per-render serveUrl column. | Operator's call; in-flight pinning deferred. |
| Save guard | `savePrimitive` re-runs gates server-side (don't trust the client) + `assertSchemaEvolution` before persisting. | The gate result is advisory until the server re-verifies. |
| Code editor | **Textarea-based** editor (no dependency). | Operator's call; Monaco later. |
| Usage gating | `setPrimitiveStatus` delete rejected when `primitive_usages` non-empty; archive always allowed (kept in bundle, hidden from compose). | Spec 9.8; minimal UI, full filters deferred. |

## 3. Architecture & data flow

```
STUDIO (account-level, spec 9.1/9.4):
  Draft pane → draftPrimitive({instruction, currentCode?})
     Opus + primitive SKILL (contract + token system + KeyStatRing example)
     → { code, proposedSchema }                          (nothing saved/trusted)
  Editor pane → user edits code/schema freely
  Gates pane → runPrimitiveGates({code, propSchema}) (re-run on edit; smoke on demand):
     1. lint   — static AST (server, safe): whitelist imports, no banned calls,
                 tokens-not-literals, no hardcoded dims         [SECURITY BOUNDARY]
     2. compile— esbuild bundle the candidate alone; success = pass
     3. smoke  — bundleGateSite(code, sampleProps, brandKit) → deploy gate-<hash>
                 → renderStillOnLambda(mid) → not-blank          [isolated sandbox]
     → { passed, gates[], failingFrameR2Key? }
  Save (enabled only when gates pass) → savePrimitive:
     server RE-RUNS gates + assertSchemaEvolution(old, new schema)
     → upsert primitives(code, prop_schema, version+1, status='active')
     → emit primitive/deploy

primitive/deploy (Inngest, spec 9.7):
  read all active primitives → generate registry (starter + DB code) → bundle →
  deploySite(siteName 'reelscript')  → on success: set deployed_version=version (all)
                                     → on failure: roll back (site unchanged), mark
                                       primitive not-deployed, surface bundle_deploy

COMPOSE (spec 8.x, extended):
  registry = starter ∪ { active primitives WHERE deployed_version = version }
  buildCompositionSystemPrompt(registry) — AI sees the new brick's aiFacingSchema
  Gate 1 validates instances against the combined registry
  on render: insert primitive_usages(primitive_id, video_id)  (drives usage gating)
```

## 4. Files (high level)
- **migration** `..._phase7_primitives.sql` — `primitives.deployed_version int`.
- **bundle spine** `src/lib/primitives/bundle.ts` (server-only): `bundleGateSite`,
  `renderGateStill`, `deployLiveSite(primitives)`; a temp source tree + generated
  registry; reuses `deploy-remotion` plumbing.
- **lint** `src/lib/primitives/lint.ts` (pure, TS-compiler AST, tested) — the contract
  rules from `contract.ts` made executable.
- **gates** `src/lib/primitives/gates.ts` (server) — orchestrates lint → compile →
  smoke; `src/lib/primitives/sample-props.ts` (pure, tested).
- **skill** `src/lib/primitives/skill/SKILL.md` + the drafting prompt builder
  `src/lib/ai/primitive-draft.ts` (pure prompt + parse, tested).
- **server actions** `src/app/(app)/primitives/actions.ts` — `draftPrimitive`,
  `runPrimitiveGates`, `savePrimitive`, `setPrimitiveStatus`.
- **studio UI** `src/app/(app)/primitives/` — list page + `[id]/Studio.tsx` (three
  panes, textarea editor, gate results, Remotion `<Player>` preview).
- **deploy job** `src/lib/inngest/functions/deploy-primitive.ts` + event in `client.ts`.
- **compose/gate1** — `loadRegistry()` (starter ∪ deployed DB primitives) threaded into
  `buildCompositionSystemPrompt`/`validateSpec`/`render.ts`; usage insert.
- **remotion** a `GateHarness` composition + a registry generator the bundler consumes.

## 5. Build order (each demonstrable; central risk first)
1. **Dynamic-bundle spine** — feed a hand-written primitive *string* → bundle (starter +
   it) → deploy → render a still on Lambda showing it. The Phase-1-style de-risk.
2. **Lint + compile + sample-props + the primitive skill** — pure/static, unit-tested;
   `draftPrimitive` drafts a contract-compliant primitive that passes lint+compile.
3. **Smoke gate + `runPrimitiveGates`** — wire the isolated harness bundle+render; gates
   return live per-gate results + a failing frame.
4. **Studio UI** — three panes; draft → edit → gates → Save (gated).
5. **Save → `primitive/deploy` live re-bundle** + **compose/Gate-1 combined registry** +
   usage tracking.
6. **Milestone E2E** (Section 7). Then Phase-7 step 2: brand stress kit + bounded auto-fix.

## 6. Open items to confirm at build time
- **Bundling on the server** — `@remotion/bundler` `bundle()` writing to `/tmp` + the
  generated registry/temp source tree; how it runs inside an Inngest/Vercel Node step
  (timeout/memory) vs offloading to Lambda. Confirm the gate-site deploy + cleanup path.
- **Lint AST coverage** — the exact TS-compiler visitor rules for each forbidden pattern;
  err toward false-positives (reject) over false-negatives (the security boundary).
- **`draftPrimitive` wiring** — Opus + the SKILL as a cached system prompt; streaming
  vs request/response; structured `{code, proposedSchema}` extraction (carry the
  compose-loop lessons).
- **Combined-registry plumbing** — `compose.ts`/`gate1.ts` currently take `StarterRegistry`;
  generalize to a loaded registry without breaking the Phase 4–6 tests.

## 7. Milestone verification
In the studio: describe a primitive the starter set lacks (e.g. "a labelled progress bar
that fills to a percent"). The AI drafts it with the skill; **lint, compile, and smoke
pass** (the preview renders it with sample props). **Save** → `primitive/deploy`
re-bundles + redeploys; `deployed_version` is set. Then create a video whose content
suits it, **Generate Video**, and confirm the composition AI **places the new primitive**
(it appears in the spec's instances and renders in the MP4), with a `primitive_usages`
row recorded. A second authored primitive with a deliberately broken draft (e.g. a
`fetch` call) is **rejected by lint** with a clear reason — the security boundary holds.
