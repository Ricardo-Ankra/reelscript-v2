'use client';

import { useState } from 'react';
import { saveModelRouting } from './model-routing-actions';
import { MODEL_TASKS, MODEL_ALLOWLIST, type ModelTask } from '@/lib/ai/model-routing';

const TASK_LABELS: Record<ModelTask, string> = {
  script_generation: 'Script generation',
  video_composition: 'Composition & vision',
  caption_emphasis: 'Caption emphasis',
  primitive_drafting: 'Primitive drafting',
};

// Account model-routing editor (Phase 8). One Anthropic model per task; one
// dirty-tracked Save. Mirrors the channel editors.
export function ModelRoutingEditor({ initial }: { initial: Record<ModelTask, string> }) {
  const [form, setForm] = useState<Record<ModelTask, string>>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(task: ModelTask, id: string) {
    setForm((f) => ({ ...f, [task]: id }));
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveModelRouting(form);
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Model routing</h2>
        <p className="text-sm opacity-70">Which Anthropic model each task uses.</p>
      </div>

      <div className="space-y-3">
        {MODEL_TASKS.map((task) => (
          <label key={task} className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">{TASK_LABELS[task]}</span>
            <select
              value={form[task]}
              onChange={(e) => patch(task, e.target.value)}
              className="rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {MODEL_ALLOWLIST.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
