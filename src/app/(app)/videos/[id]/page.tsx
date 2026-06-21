import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Editor, type SceneWithShots } from './Editor';
import type { Shot } from './SceneCard';
import { VideoCostsPanel } from './VideoCostsPanel';
import type { CostEvent } from '@/lib/costs/aggregate';

// Editor server component: first paint of the video + any scenes/shots already
// written. The client Editor then subscribes to Realtime for streaming inserts
// and edits. RLS scopes every query to the signed-in user's account.
export default async function VideoEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: video } = await supabase
    .from('videos')
    .select('id, title, settings, prompt')
    .eq('id', id)
    .maybeSingle();
  if (!video) notFound();

  const { data: sceneRows } = await supabase
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_status, audio_r2_key')
    .eq('video_id', id)
    .order('position');

  const scenes: SceneWithShots[] = (sceneRows ?? []).map((s) => ({
    id: s.id as string,
    position: s.position as number,
    narration: s.narration as string,
    duration_seconds: (s.duration_seconds as number | null) ?? null,
    audio_status: (s.audio_status as string) ?? 'not_synthesized',
    audio_r2_key: (s.audio_r2_key as string | null) ?? null,
    shots: [],
  }));

  if (scenes.length > 0) {
    const { data: shotRows } = await supabase
      .from('shots')
      .select('id, scene_id, position, description, source, stock_query')
      .in(
        'scene_id',
        scenes.map((s) => s.id),
      )
      .order('position');
    const byScene = new Map<string, Shot[]>();
    for (const row of shotRows ?? []) {
      const list = byScene.get(row.scene_id as string) ?? [];
      list.push({
        id: row.id as string,
        position: row.position as number,
        description: row.description as string,
        source: row.source as string,
        stock_query: (row.stock_query as string | null) ?? null,
      });
      byScene.set(row.scene_id as string, list);
    }
    for (const scene of scenes) scene.shots = byScene.get(scene.id) ?? [];
  }

  const { data: job } = await supabase
    .from('jobs')
    .select('status')
    .eq('video_id', id)
    .eq('type', 'script_generation')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: costRows } = await supabase
    .from('cost_events')
    .select('render_id, operation, cost_usd')
    .eq('video_id', id)
    .order('created_at');
  const costEvents: CostEvent[] = (costRows ?? []).map((r) => ({
    videoId: id,
    renderId: (r.render_id as string | null) ?? null,
    operation: r.operation as string,
    costUsd: Number(r.cost_usd ?? 0),
  }));

  return (
    <div className="space-y-6">
      <Editor
        videoId={id}
        title={video.title as string}
        initialScenes={scenes}
        initialStatus={(job?.status as string | null) ?? null}
        initialSettings={(video.settings as Record<string, unknown>) ?? {}}
        initialPrompt={(video.prompt as string | null) ?? ''}
      />
      <VideoCostsPanel events={costEvents} />
    </div>
  );
}
