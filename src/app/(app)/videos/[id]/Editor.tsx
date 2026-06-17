'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { SceneCard, type Shot } from './SceneCard';
import { estimateSynthesisCost } from '@/lib/voice/estimate';
import { synthesizeScenes, getSceneAudioUrl } from './voice-actions';
import { startVideoRender, getRenderState } from './render-actions';
import { MusicPanel } from './MusicPanel';
import { VideoSettingsPanel } from './VideoSettingsPanel';

export type SceneWithShots = {
  id: string;
  position: number;
  narration: string;
  duration_seconds: number | null;
  audio_status: string;
  audio_r2_key: string | null;
  shots: Shot[];
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const ACTIVE = new Set(['queued', 'running']);
// Scenes whose audio doesn't match the current script — what "Synthesize all" targets.
const SYNTH_TARGET = new Set(['not_synthesized', 'stale']);

export function Editor({
  videoId,
  title,
  initialScenes,
  initialStatus,
  initialSettings,
  initialPrompt,
}: {
  videoId: string;
  title: string;
  initialScenes: SceneWithShots[];
  initialStatus: string | null;
  initialSettings: Record<string, unknown>;
  initialPrompt: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [scenes, setScenes] = useState<SceneWithShots[]>(initialScenes);
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // Scene ids with synthesis in flight (set on click, cleared as audio lands or the
  // voice job ends). Drives the per-card "Synthesizing…" state.
  const [synthesizing, setSynthesizing] = useState<Set<string>>(new Set());
  // Render state (Phase 4): the active render id + its polled status/output.
  const [renderId, setRenderId] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderElapsed, setRenderElapsed] = useState(0); // seconds, ticked while active

  // Echo-guard: scenes with an in-flight/pending edit. While a scene id is here,
  // Realtime UPDATEs for it are ignored so we don't clobber the textarea.
  const dirty = useRef<Set<string>>(new Set());
  // Latest local text per scene, so an in-flight save only clears dirty if no
  // newer edit has superseded it.
  const latestText = useRef<Map<string, string>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const fetchShots = useCallback(
    async (sceneId: string) => {
      const { data } = await supabase
        .from('shots')
        .select('id, position, description, source, stock_query')
        .eq('scene_id', sceneId)
        .order('position');
      if (!data) return;
      setScenes((prev) =>
        prev.map((s) => (s.id === sceneId ? { ...s, shots: data as Shot[] } : s)),
      );
    },
    [supabase],
  );

  // Reconcile against the authoritative DB state. Runs once the subscription is
  // live to close the gap between the server's initial fetch and subscribe (rows
  // written in that window get no Realtime replay). Preserves locally-dirty
  // narration so it can't clobber an in-progress edit.
  const reconcile = useCallback(async () => {
    const { data: sceneRows } = await supabase
      .from('scenes')
      .select('id, position, narration, duration_seconds, audio_status, audio_r2_key')
      .eq('video_id', videoId)
      .order('position');
    if (!sceneRows) return;

    const ids = sceneRows.map((r) => r.id as string);
    const shotsByScene = new Map<string, Shot[]>();
    if (ids.length) {
      const { data: shotRows } = await supabase
        .from('shots')
        .select('id, scene_id, position, description, source, stock_query')
        .in('scene_id', ids)
        .order('position');
      for (const sh of shotRows ?? []) {
        const list = shotsByScene.get(sh.scene_id as string) ?? [];
        list.push(sh as unknown as Shot);
        shotsByScene.set(sh.scene_id as string, list);
      }
    }

    setScenes((prev) => {
      const prevById = new Map(prev.map((s) => [s.id, s]));
      return sceneRows.map((r) => {
        const id = r.id as string;
        const existing = prevById.get(id);
        const narration =
          existing && dirty.current.has(id) ? existing.narration : (r.narration as string);
        return {
          id,
          position: r.position as number,
          narration,
          duration_seconds: (r.duration_seconds as number | null) ?? null,
          audio_status: (r.audio_status as string) ?? 'not_synthesized',
          audio_r2_key: (r.audio_r2_key as string | null) ?? null,
          shots: shotsByScene.get(id) ?? existing?.shots ?? [],
        };
      });
    });
  }, [supabase, videoId]);

  // Realtime: rows appear as the generator writes them. We sort by position on
  // render (delivery is NOT position-ordered — appending on arrival is wrong).
  useEffect(() => {
    const channel = supabase
      .channel(`editor:${videoId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'scenes', filter: `video_id=eq.${videoId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string };
            setScenes((prev) => prev.filter((s) => s.id !== old.id));
            return;
          }
          const row = payload.new as {
            id: string;
            position: number;
            narration: string;
            duration_seconds: number | null;
            audio_status: string;
            audio_r2_key: string | null;
          };
          setScenes((prev) => {
            const existing = prev.find((s) => s.id === row.id);
            if (existing) {
              // Audio fields (status/key/duration) always merge — so the staleness
              // flip shows live even mid-edit — but narration is held while dirty so
              // the echo can't clobber the textarea.
              return prev.map((s) =>
                s.id === row.id
                  ? {
                      ...s,
                      narration: dirty.current.has(row.id) ? s.narration : row.narration,
                      position: row.position,
                      duration_seconds: row.duration_seconds,
                      audio_status: row.audio_status ?? s.audio_status,
                      audio_r2_key: row.audio_r2_key ?? s.audio_r2_key,
                    }
                  : s,
              );
            }
            return [
              ...prev,
              {
                ...row,
                audio_status: row.audio_status ?? 'not_synthesized',
                audio_r2_key: row.audio_r2_key ?? null,
                shots: [],
              },
            ];
          });
          // A scene reaching 'synthesized' is done — drop its in-flight spinner.
          if (row.audio_status === 'synthesized') {
            setSynthesizing((prev) => {
              if (!prev.has(row.id)) return prev;
              const next = new Set(prev);
              next.delete(row.id);
              return next;
            });
          }
          if (payload.eventType === 'INSERT') void fetchShots(row.id);
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'jobs', filter: `video_id=eq.${videoId}` },
        (payload) => {
          const row = payload.new as { status?: string; type?: string };
          // Script-generation drives the header status pill.
          if (row?.type === 'script_generation' && row.status) setStatus(row.status);
          // A finished/failed voice job clears any remaining in-flight spinners.
          if (
            row?.type === 'voice_synthesis' &&
            (row.status === 'complete' || row.status === 'failed')
          ) {
            setSynthesizing(new Set());
          }
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void reconcile();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, videoId, fetchShots, reconcile]);

  const save = useCallback(
    async (sceneId: string, text: string) => {
      setSaveStates((prev) => ({ ...prev, [sceneId]: 'saving' }));
      const { error } = await supabase.from('scenes').update({ narration: text }).eq('id', sceneId);
      if (error) {
        setSaveStates((prev) => ({ ...prev, [sceneId]: 'error' }));
        return;
      }
      // Clear dirty only if this save reflects the latest local text; otherwise a
      // newer edit is still pending and must keep guarding against echoes.
      if (latestText.current.get(sceneId) === text) {
        dirty.current.delete(sceneId);
        setSaveStates((prev) => ({ ...prev, [sceneId]: 'saved' }));
      }
    },
    [supabase],
  );

  const onNarrationChange = useCallback(
    (sceneId: string, text: string) => {
      dirty.current.add(sceneId);
      latestText.current.set(sceneId, text);
      setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, narration: text } : s)));
      setSaveStates((prev) => ({ ...prev, [sceneId]: 'idle' }));
      const existing = timers.current.get(sceneId);
      if (existing) clearTimeout(existing);
      timers.current.set(
        sceneId,
        setTimeout(() => save(sceneId, text), 700),
      );
    },
    [save],
  );

  // Synthesize an explicit set of scenes (or all stale/not-synthesized when no ids).
  const runSynthesis = useCallback(
    async (sceneIds: string[] | undefined, optimisticIds: string[]) => {
      if (optimisticIds.length === 0) return;
      setSynthesizing((prev) => new Set([...prev, ...optimisticIds]));
      try {
        const res = await synthesizeScenes(videoId, sceneIds);
        if ('nothingToDo' in res) setSynthesizing(new Set());
      } catch {
        setSynthesizing(new Set()); // surface failure by clearing the spinner
      }
    },
    [videoId],
  );

  const getAudioUrl = useCallback(async (sceneId: string) => {
    const { url } = await getSceneAudioUrl(sceneId);
    return url;
  }, []);

  // Generate Video: snapshot + compose + render. Handles the completeness gate —
  // a stale-scenes block prompts for an explicit override (honest mismatch).
  const handleGenerate = useCallback(async () => {
    setRenderError(null);
    const begin = (renderId: string) => {
      setRenderId(renderId);
      setRenderStatus('queued');
      setRenderUrl(null);
      setRenderElapsed(0);
    };
    const res = await startVideoRender(videoId, false);
    if (!('blocked' in res)) {
      begin(res.renderId);
      return;
    }
    if (res.blocked === 'unsynthesized_scenes') {
      setRenderError('Synthesize every scene before rendering.');
      return;
    }
    // stale_scenes — ask for an explicit override, then retry once.
    if (confirm('Some scenes have stale audio (edited since synthesis). Render with the existing audio anyway?')) {
      const retry = await startVideoRender(videoId, true);
      if ('blocked' in retry) setRenderError('Render is still blocked.');
      else begin(retry.renderId);
    }
  }, [videoId]);

  // Poll the render until it completes (gives us the signed playback URL too).
  useEffect(() => {
    if (!renderId) return;
    if (renderStatus === 'complete' || renderStatus === 'failed') return;
    let active = true;
    const tick = async () => {
      try {
        const s = await getRenderState(renderId);
        if (!active) return;
        setRenderStatus(s.status);
        if (s.url) setRenderUrl(s.url);
        if (s.status === 'failed') setRenderError(s.error ?? 'Render failed.');
      } catch {
        /* transient; keep polling */
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [renderId, renderStatus]);

  const ordered = scenes.slice().sort((a, b) => a.position - b.position);
  const targets = scenes.filter((s) => SYNTH_TARGET.has(s.audio_status));
  const estimate = estimateSynthesisCost(targets.map((s) => s.narration));
  const anySynthesizing = synthesizing.size > 0;
  const unsynthesized = scenes.filter((s) => s.audio_status === 'not_synthesized').length;
  const renderActive =
    renderStatus != null && renderStatus !== 'complete' && renderStatus !== 'failed';
  const canRender = scenes.length > 0 && unsynthesized === 0 && !renderActive;

  // Tick the elapsed-seconds counter once a second while a render is active.
  useEffect(() => {
    if (!renderActive) return;
    const id = setInterval(() => setRenderElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [renderActive]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <StatusPill status={status} />
      </div>

      {ordered.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
          <span className="opacity-70">
            {targets.length === 0
              ? 'All scenes synthesized.'
              : `${targets.length} scene${targets.length === 1 ? '' : 's'} to voice · ${estimate.characters} chars · ≈ $${estimate.estimatedUsd.toFixed(3)}`}
          </span>
          <button
            type="button"
            disabled={targets.length === 0 || anySynthesizing}
            onClick={() => runSynthesis(undefined, targets.map((s) => s.id))}
            className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
          >
            {anySynthesizing ? 'Synthesizing…' : 'Synthesize all'}
          </button>
        </div>
      )}

      {ordered.length > 0 && (
        <VideoSettingsPanel videoId={videoId} initialSettings={initialSettings} initialPrompt={initialPrompt} />
      )}

      {ordered.length > 0 && (
        <div className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 dark:border-white/10 dark:bg-white/[0.02]">
          <div className="flex items-center justify-between text-xs">
            <span className="opacity-70">
              {renderActive
                ? `${renderPhaseLabel(renderStatus)} · ${formatElapsed(renderElapsed)}`
                : renderStatus === 'complete'
                  ? 'Video ready.'
                  : unsynthesized > 0
                    ? `Synthesize all ${unsynthesized} remaining scene${unsynthesized === 1 ? '' : 's'} to render`
                    : 'Compose & render the video with voiceover'}
            </span>
            <button
              type="button"
              disabled={!canRender}
              onClick={() => handleGenerate()}
              className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
            >
              {renderActive ? 'Generating…' : 'Generate Video'}
            </button>
          </div>
          {renderError && <p className="text-xs text-red-600">{renderError}</p>}
          {renderUrl && (
            <video
              key={renderUrl}
              src={renderUrl}
              controls
              className="w-full rounded-md border border-black/10 dark:border-white/10"
            />
          )}
          {/* Phase 6: reroll/replace music + master volume → audio-only re-mux. Self-
              contained; renders nothing until a completed render + a seeded library. */}
          <MusicPanel videoId={videoId} onUpdated={(url) => setRenderUrl(url)} />
        </div>
      )}

      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-8 text-center text-sm opacity-60 dark:border-white/15">
          {status && ACTIVE.has(status)
            ? 'Generating — scenes will appear here as they are written…'
            : 'No scenes yet.'}
        </p>
      ) : (
        <div className="space-y-3">
          {ordered.map((scene) => (
            <SceneCard
              key={scene.id}
              position={scene.position}
              narration={scene.narration}
              shots={scene.shots}
              saveState={saveStates[scene.id] ?? 'idle'}
              audioStatus={scene.audio_status}
              hasAudio={scene.audio_r2_key != null}
              synthesizing={synthesizing.has(scene.id)}
              onChange={(text) => onNarrationChange(scene.id, text)}
              onSynthesize={() => runSynthesis([scene.id], [scene.id])}
              getAudioUrl={() => getAudioUrl(scene.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Friendly labels for the render lifecycle (renders.status, set per pipeline phase).
// Composition is the genuinely slow step (~1–2 min, thinking-enabled), so its label
// says so — paired with the elapsed timer it reads as progressing, not frozen.
function renderPhaseLabel(status: string | null): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'composing':
      return 'Composing with AI (~1–2 min)…';
    case 'resolving_assets':
      return 'Preparing assets…';
    case 'validating':
      return 'Validating…';
    case 'rendering':
      return 'Rendering on Lambda…';
    case 'encoding':
      return 'Encoding…';
    default:
      return 'Working…';
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const label =
    status === 'complete'
      ? 'Generated'
      : status === 'failed'
        ? 'Generation failed'
        : ACTIVE.has(status)
          ? 'Generating…'
          : status;
  const tone =
    status === 'failed'
      ? 'border-red-500/40 bg-red-500/10 text-red-600'
      : status === 'complete'
        ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
        : 'border-black/15 bg-black/[0.03] opacity-70 dark:border-white/15 dark:bg-white/[0.03]';
  return <span className={`rounded-full border px-2.5 py-1 text-xs ${tone}`}>{label}</span>;
}
