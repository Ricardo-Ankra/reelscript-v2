// Pure model-routing core (Phase 8 — account model routing). No react/server/network.
// The single source of truth for the default model ids (anthropic.ts imports these),
// the routable task list, and the selectable Anthropic allowlist.

export const MODEL_TASKS = [
  'script_generation',
  'video_composition',
  'caption_emphasis',
  'primitive_drafting',
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

// Today's pins. Changing one here changes the code default for that task everywhere.
export const DEFAULT_MODELS: Record<ModelTask, string> = {
  script_generation: 'claude-opus-4-8',
  video_composition: 'claude-sonnet-4-6',
  caption_emphasis: 'claude-haiku-4-5-20251001',
  primitive_drafting: 'claude-opus-4-8',
};

// Selectable Anthropic models (id + label). Every DEFAULT_MODELS value must appear
// here (a unit test guards this).
export const MODEL_ALLOWLIST: readonly { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, cheap)' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];

const ALLOWED = new Set(MODEL_ALLOWLIST.map((m) => m.id));

// Resolve stored routing → a complete task→id map. A stored id is used only if it
// is allowlisted, else the task's default. Unknown keys are ignored.
export function parseModelRouting(raw: unknown): Record<ModelTask, string> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    const v = o[task];
    out[task] = typeof v === 'string' && ALLOWED.has(v) ? v : DEFAULT_MODELS[task];
  }
  return out;
}

// Validate a form submission → the object to store. Requires all four tasks, each
// an allowlisted id.
export function validateModelRoutingForm(
  input: unknown,
): { ok: true; value: Record<ModelTask, string> } | { ok: false; reason: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    const v = o[task];
    if (typeof v !== 'string' || !ALLOWED.has(v)) {
      return { ok: false, reason: `Pick a valid model for ${task.replace(/_/g, ' ')}.` };
    }
    out[task] = v;
  }
  return { ok: true, value: out };
}
