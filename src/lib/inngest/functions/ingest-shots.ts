import { inngest } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { signedGetUrl, signedPutUrl } from '@/lib/r2';
import { invokeProbe, invokeRemux } from '@/lib/music/remux-invoke';
import { parseProbe } from '@/lib/ingest/probe';
import { buildConformArgs, buildKeyframeArgs, buildImageConformArgs, styleRefAt } from '@/lib/ingest/ffmpeg';

type IngestShot = { id: string; resource_id: string; duration_seconds: number | null };
type Target = { width: number; height: number; fps: number };

const DIMS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

// Conform every uploaded/resource live-action shot of a video to the target dims/fps,
// durably (V2 Slice 2b). Mirrors generate-shots.ts: fires only on an explicit ingest/run
// event nothing sends yet (Slice 6 wires it); cancelOn mirrors the other job functions.
// Each external touch is its own durable step.run namespaced by shot UUID.
export const ingestShots = inngest.createFunction(
  {
    id: 'ingest-shots',
    retries: 2,
    triggers: [{ event: 'ingest/run' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  async ({ event, step }) => {
    const { videoId, accountId } = event.data as { videoId: string; accountId: string; jobId?: string };
    const admin = createAdminClient();

    const target = await step.run('load-video', async () => {
      const { data, error } = await admin.from('videos').select('settings').eq('id', videoId).single();
      if (error || !data) throw new Error(`load video: ${error?.message ?? 'not found'}`);
      const settings = (data.settings ?? {}) as Record<string, unknown>;
      const ratio = (settings.aspect_ratio as string) ?? '9:16';
      const { width, height } = DIMS[ratio] ?? DIMS['9:16'];
      const fps = (settings.fps as number) ?? 30;
      return { width, height, fps } as Target;
    });

    // Live-action, resource-pinned shots not yet conformed (idempotent on footage_key).
    // Shots have no video_id → resolve via scene ids.
    const shots = await step.run('load-shots', async () => {
      const { data: scenes, error: scenesError } = await admin.from('scenes').select('id').eq('video_id', videoId);
      if (scenesError) throw new Error(`load scenes: ${scenesError.message}`);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return [] as IngestShot[];
      const { data, error } = await admin
        .from('shots')
        .select('id, resource_id, duration_seconds')
        .in('scene_id', sceneIds)
        .eq('kind', 'live_action')
        .eq('source', 'resource')
        .not('resource_id', 'is', null)
        .is('footage_key', null);
      if (error) throw new Error(`load shots: ${error.message}`);
      return (data ?? []) as IngestShot[];
    });

    for (const shot of shots) {
      await runIngestSpine(step, admin, accountId, shot, target);
    }

    return { ingested: shots.length };
  },
);

// One resource shot: resolve → (video: probe → conform → keyframe) | (image: reframe).
// Per-step DB writes so a mid-shot failure resumes without re-conforming.
async function runIngestSpine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  shot: IngestShot,
  target: Target,
): Promise<void> {
  const resource = await step.run(`resolve-${shot.id}`, async () => {
    const { data, error } = await admin
      .from('channel_resources')
      .select('r2_key, kind')
      .eq('id', shot.resource_id)
      .eq('account_id', accountId)
      .single();
    if (error || !data || !data.r2_key) {
      throw new Error(`resolve resource ${shot.resource_id} for shot ${shot.id}: ${error?.message ?? 'no r2_key'}`);
    }
    return { r2Key: data.r2_key as string, kind: data.kind === 'video' ? 'video' : 'image' };
  });

  if (resource.kind === 'image') {
    await step.run(`conform-image-${shot.id}`, async () => {
      const inUrl = await signedGetUrl(resource.r2Key);
      const outKey = `ingest/${shot.id}/footage.png`;
      const outUrl = await signedPutUrl(outKey, 'image/png');
      const args = buildImageConformArgs({
        inPath: '/tmp/in',
        outPath: '/tmp/out.png',
        target: { width: target.width, height: target.height },
      });
      await invokeRemux({ args, inputs: { '/tmp/in': inUrl }, outputs: { '/tmp/out.png': outUrl }, outputContentType: 'image/png' });
      // The conformed still IS its own styleRef — no separate keyframe extraction.
      const { error } = await admin.from('shots').update({ footage_key: outKey, style_ref_key: outKey }).eq('id', shot.id);
      if (error) throw new Error(`write image footage for shot ${shot.id}: ${error.message}`);
      return outKey;
    });
    return;
  }

  // Video: probe → conform (reframe + normalize + trim + autorotate) → styleRef keyframe.
  const probe = await step.run(`probe-${shot.id}`, async () => {
    const url = await signedGetUrl(resource.r2Key);
    return parseProbe(await invokeProbe(url));
  });

  const footageKey = await step.run(`conform-${shot.id}`, async () => {
    const inUrl = await signedGetUrl(resource.r2Key);
    const outKey = `ingest/${shot.id}/footage.mp4`;
    const outUrl = await signedPutUrl(outKey, 'video/mp4');
    const args = buildConformArgs({
      inPath: '/tmp/in',
      outPath: '/tmp/out.mp4',
      target,
      probe,
      durationSec: shot.duration_seconds ?? undefined,
    });
    await invokeRemux({ args, inputs: { '/tmp/in': inUrl }, outputs: { '/tmp/out.mp4': outUrl }, outputContentType: 'video/mp4' });
    const { error } = await admin.from('shots').update({ footage_key: outKey }).eq('id', shot.id);
    if (error) throw new Error(`write footage for shot ${shot.id}: ${error.message}`);
    return outKey;
  });

  await step.run(`keyframe-${shot.id}`, async () => {
    const inUrl = await signedGetUrl(footageKey);
    const styleKey = `ingest/${shot.id}/styleref.png`;
    const outUrl = await signedPutUrl(styleKey, 'image/png');
    const args = buildKeyframeArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/out.png', atSec: styleRefAt(shot.duration_seconds) });
    await invokeRemux({ args, inputs: { '/tmp/in.mp4': inUrl }, outputs: { '/tmp/out.png': outUrl }, outputContentType: 'image/png' });
    const { error } = await admin.from('shots').update({ style_ref_key: styleKey }).eq('id', shot.id);
    if (error) throw new Error(`write styleRef for shot ${shot.id}: ${error.message}`);
  });
}
