'use client';

import { useState } from 'react';
import {
  type VisualBrief,
  type Specificity,
  type RecommendedSource,
  SPECIFICITIES,
  RECOMMENDED_SOURCES,
} from '@/lib/videos/visual-brief';

const EMPTY: VisualBrief = {
  subject: '',
  action: '',
  setting: '',
  framing: '',
  mood: '',
  specificity: 'generic',
  entity_name: null,
  recommended_source: 'stock',
};

// Per-shot brief editor: a collapsed summary that expands to a compact form.
// Save hands the edited brief up; the parent persists + updates state.
export function ShotBriefEditor({
  brief,
  onSave,
}: {
  brief: VisualBrief | null;
  onSave: (brief: VisualBrief) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VisualBrief>(brief ?? EMPTY);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<VisualBrief>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const normalized: VisualBrief = {
        ...draft,
        entity_name:
          draft.specificity === 'entity' && draft.entity_name && draft.entity_name.trim()
            ? draft.entity_name.trim()
            : null,
      };
      await onSave(normalized);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const summary = brief
    ? `${brief.specificity}${brief.entity_name ? ` · ${brief.entity_name}` : ''}`
    : 'no brief';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(brief ?? EMPTY);
          setOpen(true);
        }}
        className="shrink-0 rounded border border-black/10 px-1 py-px text-[10px] opacity-70 enabled:hover:bg-black/[0.04] dark:border-white/10 dark:enabled:hover:bg-white/[0.06]"
        title="Edit the visual brief"
      >
        Brief: {summary}
      </button>
    );
  }

  const field = (label: string, key: 'subject' | 'action' | 'setting' | 'framing' | 'mood') => (
    <label className="flex flex-col gap-0.5">
      <span className="opacity-50">{label}</span>
      <input
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<VisualBrief>)}
        className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
      />
    </label>
  );

  return (
    <div className="mt-1 w-full space-y-1.5 rounded-md border border-black/10 p-2 text-[10px] dark:border-white/10">
      <div className="grid grid-cols-2 gap-1.5">
        {field('Subject', 'subject')}
        {field('Action', 'action')}
        {field('Setting', 'setting')}
        {field('Framing', 'framing')}
        {field('Mood', 'mood')}
        <label className="flex flex-col gap-0.5">
          <span className="opacity-50">Specificity</span>
          <select
            value={draft.specificity}
            onChange={(e) => set({ specificity: e.target.value as Specificity })}
            className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
          >
            {SPECIFICITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {draft.specificity === 'entity' && (
          <label className="flex flex-col gap-0.5">
            <span className="opacity-50">Entity name</span>
            <input
              value={draft.entity_name ?? ''}
              onChange={(e) => set({ entity_name: e.target.value })}
              className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
            />
          </label>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="opacity-50">Recommended source</span>
          <select
            value={draft.recommended_source}
            onChange={(e) => set({ recommended_source: e.target.value as RecommendedSource })}
            className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
          >
            {RECOMMENDED_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded border border-black/15 px-2 py-px font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy ? 'Saving…' : 'Save brief'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="opacity-60 hover:opacity-100">
          Cancel
        </button>
      </div>
    </div>
  );
}
