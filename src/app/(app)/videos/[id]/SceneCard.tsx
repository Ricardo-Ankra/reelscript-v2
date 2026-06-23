'use client';

import { useRef, useState } from 'react';
import { SceneAssetUploader } from './SceneAssetUploader';
import { sceneAttachedResources } from '@/lib/resources/scene-tray';
import type { VisualBrief } from '@/lib/videos/visual-brief';

export type Shot = {
  id: string;
  position: number;
  description: string;
  source: string;
  stock_query: string | null;
  resource_id: string | null;
  visual_brief: VisualBrief | null;
};

export type ResourceOption = { id: string; kind: string; description: string };

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// One card == one scene: the autosave boundary AND the audio-staleness boundary
// (UI unit = data unit). Narration is editable; shots are read-only ("the AI's
// plan"). Phase 3 fills the two slots Phase 2 reserved: the status dot now reflects
// audio_status, and the action slot carries Synthesize / Re-synthesize / Listen.
export function SceneCard({
  position,
  narration,
  shots,
  saveState,
  audioStatus,
  hasAudio,
  synthesizing,
  onChange,
  onSynthesize,
  getAudioUrl,
  resources,
  channelId,
  onSetShotResource,
  onUploadAndAttach,
}: {
  position: number;
  narration: string;
  shots: Shot[];
  saveState: SaveState;
  audioStatus: string;
  hasAudio: boolean;
  synthesizing: boolean;
  onChange: (text: string) => void;
  onSynthesize: () => void;
  getAudioUrl: () => Promise<string | null>;
  resources: ResourceOption[];
  channelId: string;
  onSetShotResource: (shotId: string, resourceId: string | null) => void;
  onUploadAndAttach: (shotId: string, resource: ResourceOption) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);

  const listen = async () => {
    setLoadingAudio(true);
    try {
      const url = await getAudioUrl();
      if (url && audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } finally {
      setLoadingAudio(false);
    }
  };

  const dot = audioDot(audioStatus, synthesizing);
  const attached = sceneAttachedResources(shots, resources);

  return (
    <div className="relative rounded-xl border border-black/15 bg-black/[0.015] p-4 shadow-sm dark:border-white/15 dark:bg-white/[0.02]">
      {/* Header: scene number + audio status */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide opacity-50">
          Scene {position}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] opacity-50">{saveLabel(saveState)}</span>
          <span className="flex items-center gap-1 text-[11px] opacity-60" title={dot.label}>
            <span aria-hidden className={`h-2 w-2 rounded-full ${dot.className}`} />
            {dot.label}
          </span>
        </div>
      </div>

      {/* Editable narration — the scene's source of truth */}
      <textarea
        value={narration}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="w-full resize-y rounded-md border border-transparent bg-transparent p-2 text-sm leading-relaxed outline-none focus:border-black/20 dark:focus:border-white/20"
      />

      {/* Attached assets tray — derived from shots that have a resource pinned */}
      {attached.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-black/5 pt-2 text-[10px] dark:border-white/5">
          <span className="opacity-50">Attached:</span>
          {attached.map((a) => (
            <span
              key={a.shotId}
              className="rounded-full border border-black/10 px-1.5 py-px opacity-70 dark:border-white/10"
              title={`Shot ${a.shotPosition}: ${a.resource.description || '(untitled)'}`}
            >
              {(a.resource.description || '(untitled)').slice(0, 24)} ({a.resource.kind}) · shot {a.shotPosition}
            </span>
          ))}
        </div>
      )}

      {/* Shots — read-only, muted, clearly subordinate */}
      {shots.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 dark:border-white/5">
          {shots
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((shot) => (
              <li key={shot.id} className="flex items-start gap-2 text-xs opacity-60">
                <span className="opacity-70">▸</span>
                <span className="flex-1">{shot.description}</span>
                {resources.length > 0 && (
                  <select
                    value={shot.resource_id ?? ''}
                    onChange={(e) => onSetShotResource(shot.id, e.target.value || null)}
                    className="max-w-[10rem] truncate rounded border border-black/10 bg-transparent px-1 py-px text-[10px] dark:border-white/10"
                    title="Pin a channel resource (or use stock)"
                  >
                    <option value="">Use stock</option>
                    {resources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {(r.description || '(untitled)').slice(0, 40)} ({r.kind})
                      </option>
                    ))}
                  </select>
                )}
                <SceneAssetUploader
                  channelId={channelId}
                  onUploaded={(resource) => onUploadAndAttach(shot.id, resource)}
                />
              </li>
            ))}
        </ul>
      )}

      {/* Action slot: Synthesize / Re-synthesize + Listen */}
      <div className="mt-3 flex items-center gap-2 border-t border-black/5 pt-2 dark:border-white/5">
        <button
          type="button"
          disabled={synthesizing}
          onClick={onSynthesize}
          className="rounded-md border border-black/15 px-2 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {synthesizing
            ? 'Synthesizing…'
            : audioStatus === 'not_synthesized'
              ? 'Synthesize'
              : 'Re-synthesize'}
        </button>
        {hasAudio && (
          <button
            type="button"
            disabled={loadingAudio}
            onClick={listen}
            className="rounded-md border border-black/15 px-2 py-1 text-xs enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
          >
            {loadingAudio ? 'Loading…' : '▶ Listen'}
          </button>
        )}
        <audio ref={audioRef} className="hidden" preload="none" />
      </div>
    </div>
  );
}

function audioDot(status: string, synthesizing: boolean): { className: string; label: string } {
  if (synthesizing) return { className: 'bg-blue-500 animate-pulse', label: 'synthesizing' };
  switch (status) {
    case 'synthesized':
      return { className: 'bg-green-500', label: 'synthesized' };
    case 'stale':
      return { className: 'bg-amber-500', label: 'stale' };
    default:
      return { className: 'bg-black/15 dark:bg-white/15', label: 'no audio' };
  }
}

function saveLabel(s: SaveState): string {
  switch (s) {
    case 'saving':
      return 'saving…';
    case 'saved':
      return 'saved ✓';
    case 'error':
      return 'save failed';
    default:
      return '';
  }
}
