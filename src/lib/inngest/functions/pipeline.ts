import { inngest } from '@/lib/inngest/client';
import type { PipelineStartData } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { runGate } from '@/lib/inngest/run-gate';
import { generateShots } from '@/lib/inngest/functions/generate-shots';
import { ingestShots } from '@/lib/inngest/functions/ingest-shots';
import { renderVideo } from '@/lib/inngest/functions/render';

// Master orchestration (V2 Slice 6a). From a voiced video: fan out generation + ingest
// (step.invoke, parallel — they touch disjoint shot kinds and populate clip_key/footage_key
// the render reads), fan in, run the G1 storyboard gate (only when there are generative
// shots to review), then invoke the render (which carries the automated gate2 + the opt-in
// G2 preview gate + music/finalize and completes the job). One pipeline job owns the run;
// the master jobId is threaded into every child so a jobs/cancel cancels the whole tree.
export const reelscriptPipeline = inngest.createFunction(
  {
    id: 'reelscript-pipeline',
    retries: 2,
    triggers: [{ event: 'pipeline/start' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, step }: { event: { data: unknown }; step: any }) => {
    const { jobId, videoId, accountId, renderId } = event.data as PipelineStartData;
    const admin = createAdminClient();

    await step.run('mark-running', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'generating' }).eq('id', jobId);
    });

    // Fan-out → fan-in. Both children get the master jobId (cancel cascade). They are
    // idempotent (re-runs only touch shots whose key is still null), so a retry is safe.
    await Promise.all([
      step.invoke('run-generation', { function: generateShots, data: { videoId, accountId, jobId } }),
      step.invoke('run-ingest', { function: ingestShots, data: { videoId, accountId, jobId } }),
    ]);

    // G1 storyboard gate — only when there is a storyboard to review (≥1 generative shot).
    const hasStoryboard = await step.run('check-storyboard', async () => {
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return false;
      const { count } = await admin
        .from('shots')
        .select('id', { count: 'exact', head: true })
        .in('scene_id', sceneIds)
        .eq('kind', 'generative');
      return (count ?? 0) > 0;
    });

    if (hasStoryboard) {
      const decision = await runGate(step, admin, { jobId, kind: 'storyboard' });
      if (decision === 'reject') {
        await step.run('reject-storyboard', async () => {
          const error = { phase: 'storyboard_gate', message: 'Storyboard rejected by operator' };
          await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
          await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
        });
        return { jobId, failed: 'storyboard_gate' as const };
      }
      await step.run('resume-after-storyboard', async () => {
        await admin.from('jobs').update({ status: 'running', phase: 'rendering' }).eq('id', jobId);
      });
    }

    // Render: reuses compose-with-segments + automated gate2 + grade + G2 + music/finalize.
    // Invoked with the master jobId → it drives THIS job through the render phases + completion
    // (and its G2 pauses THIS job). renderVideo owns failure/completion; the master returns.
    await step.invoke('run-render', { function: renderVideo, data: { jobId, renderId, videoId } });

    return { jobId, ok: true as const };
  },
);
