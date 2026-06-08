'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { SceneCard, type Shot } from './SceneCard';

export type SceneWithShots = {
  id: string;
  position: number;
  narration: string;
  duration_seconds: number | null;
  shots: Shot[];
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const ACTIVE = new Set(['queued', 'running']);

export function Editor({
  videoId,
  title,
  initialScenes,
  initialStatus,
}: {
  videoId: string;
  title: string;
  initialScenes: SceneWithShots[];
  initialStatus: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [scenes, setScenes] = useState<SceneWithShots[]>(initialScenes);
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

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
      .select('id, position, narration, duration_seconds')
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
          };
          setScenes((prev) => {
            const existing = prev.find((s) => s.id === row.id);
            if (existing) {
              if (dirty.current.has(row.id)) return prev; // ignore echo while editing
              return prev.map((s) =>
                s.id === row.id
                  ? { ...s, narration: row.narration, position: row.position, duration_seconds: row.duration_seconds }
                  : s,
              );
            }
            return [...prev, { ...row, shots: [] }];
          });
          if (payload.eventType === 'INSERT') void fetchShots(row.id);
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'jobs', filter: `video_id=eq.${videoId}` },
        (payload) => {
          const row = payload.new as { status?: string };
          if (row?.status) setStatus(row.status);
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

  const ordered = scenes.slice().sort((a, b) => a.position - b.position);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <StatusPill status={status} />
      </div>

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
              onChange={(text) => onNarrationChange(scene.id, text)}
            />
          ))}
        </div>
      )}
    </div>
  );
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
