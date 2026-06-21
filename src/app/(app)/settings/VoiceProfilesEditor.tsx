'use client';

import { useState } from 'react';
import { EMOTION_TAGS, type EmotionTag } from '@/lib/voice/emotion';
import { defaultTagMappings, type TagMappings, type TagMode } from '@/lib/voice/profile';
import type { CatalogModel } from '@/lib/voice/elevenlabs';
import { loadModelCatalog, saveVoiceProfile, deleteVoiceProfile } from './voice-profile-actions';

export type ProfileBlock = { modelId: string; modelName: string; mapping: TagMappings };

const MODES: { value: TagMode; label: string }[] = [
  { value: 'strip', label: 'Strip (+ nudge)' },
  { value: 'audio_tag', label: 'Audio tag' },
  { value: 'ssml_break', label: 'SSML break' },
];

// One model's editable 7-tag table + Save / Delete. Dirty-tracked; mirrors the
// other account/channel editors.
function ProfileCard({
  block,
  onDeleted,
}: {
  block: ProfileBlock;
  onDeleted: (modelId: string) => void;
}) {
  const [mapping, setMapping] = useState<TagMappings>(block.mapping);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(tag: EmotionTag, next: Partial<{ mode: TagMode; value: string; nudge: { stability?: number; style?: number } }>) {
    setMapping((m) => {
      const cur = m[tag] ?? { mode: 'strip' as TagMode };
      return { ...m, [tag]: { ...cur, ...next } };
    });
    setDirty(true);
    setSaved(false);
  }

  function patchNudge(tag: EmotionTag, axis: 'stability' | 'style', raw: string) {
    setMapping((m) => {
      const cur = m[tag] ?? { mode: 'strip' as TagMode };
      const nudge = { ...(cur.nudge ?? {}) };
      if (raw === '') delete nudge[axis];
      else nudge[axis] = Number(raw);
      return { ...m, [tag]: { ...cur, nudge } };
    });
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveVoiceProfile(block.modelId, block.modelName, mapping);
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

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteVoiceProfile(block.modelId);
      if (res.ok) onDeleted(block.modelId);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{block.modelName}</div>
          <div className="text-xs opacity-60">{block.modelId}</div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-sm text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      <div className="space-y-2">
        {EMOTION_TAGS.map((tag) => {
          const m = mapping[tag] ?? { mode: 'strip' as TagMode };
          return (
            <div key={tag} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 font-mono text-xs">{tag}</span>
              <select
                value={m.mode}
                onChange={(e) => patch(tag, { mode: e.target.value as TagMode })}
                className="rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
              >
                {MODES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              {m.mode === 'audio_tag' && (
                <input
                  type="text"
                  value={m.value ?? ''}
                  onChange={(e) => patch(tag, { value: e.target.value })}
                  placeholder="[excited]"
                  className="w-32 rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
                />
              )}

              {m.mode === 'strip' && (
                <>
                  <label className="flex items-center gap-1 text-xs opacity-70">
                    stab
                    <input
                      type="number"
                      step="0.05"
                      min="-1"
                      max="1"
                      value={m.nudge?.stability ?? ''}
                      onChange={(e) => patchNudge(tag, 'stability', e.target.value)}
                      className="w-16 rounded border border-black/15 bg-transparent px-1 py-1 dark:border-white/15"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs opacity-70">
                    style
                    <input
                      type="number"
                      step="0.05"
                      min="-1"
                      max="1"
                      value={m.nudge?.style ?? ''}
                      onChange={(e) => patchNudge(tag, 'style', e.target.value)}
                      className="w-16 rounded border border-black/15 bg-transparent px-1 py-1 dark:border-white/15"
                    />
                  </label>
                </>
              )}
            </div>
          );
        })}
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

export function VoiceProfilesEditor({ initial }: { initial: ProfileBlock[] }) {
  const [blocks, setBlocks] = useState<ProfileBlock[]>(initial);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLoadModels() {
    setBusy(true);
    setError(null);
    try {
      const res = await loadModelCatalog();
      if (res.ok) setModels(res.models);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onAdd() {
    if (!picked || !models) return;
    if (blocks.some((b) => b.modelId === picked)) {
      setError('A profile for that model already exists below.');
      return;
    }
    const model = models.find((m) => m.id === picked);
    if (!model) return;
    setError(null);
    setBlocks((bs) => [
      ...bs,
      { modelId: model.id, modelName: model.name, mapping: defaultTagMappings(model.id) },
    ]);
    setPicked('');
  }

  function onDeleted(modelId: string) {
    setBlocks((bs) => bs.filter((b) => b.modelId !== modelId));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Voice profiles</h2>
        <p className="text-sm opacity-70">
          How each emotion tag is rendered, per ElevenLabs model. A model with no profile uses the
          built-in defaults.
        </p>
      </div>

      {blocks.length === 0 && <p className="text-sm opacity-60">No custom profiles yet.</p>}

      <div className="space-y-4">
        {blocks.map((b) => (
          <ProfileCard key={b.modelId} block={b} onDeleted={onDeleted} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        {models === null ? (
          <button
            type="button"
            onClick={onLoadModels}
            disabled={busy}
            className="rounded border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/15"
          >
            {busy ? 'Loading…' : 'Add profile'}
          </button>
        ) : (
          <>
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              <option value="">Select a model…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onAdd}
              disabled={!picked}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            >
              Add
            </button>
          </>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
