import {
  renderMediaOnLambda,
  getRenderProgress,
  type AwsRegion,
} from '@remotion/lambda/client';
import { inngest, type RenderStartData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env.server';
import { putObject, signedGetUrl } from '@/lib/r2';

// The render spine (spec 13.1, Phase 1 subset): sign the spec → invoke Lambda by
// pointer → wait for completion → copy the MP4 into R2 → update the render row.
// Each await step.run is a durable checkpoint (spec 15.2).
//
// COMPLETION STRATEGY (Phase 1): poll getRenderProgress. This is deliberately
// isolated in waitForLambdaCompletion() so swapping to the spec's wait-for-event
// + /api/webhooks/lambda-render pattern (spec 10.6) later is a contained change.
export const renderVideo = inngest.createFunction(
  { id: 'render-video', retries: 2, triggers: [{ event: 'render/start' }] },
  async ({ event, step }) => {
    const { renderId, specKey } = event.data as RenderStartData;
    const region = serverEnv.aws.region as AwsRegion;
    const functionName = serverEnv.remotion.functionName;
    const admin = createAdminClient();

    await step.run('mark-rendering', async () => {
      const { error } = await admin
        .from('renders')
        .update({ status: 'rendering' })
        .eq('id', renderId);
      if (error) throw new Error(`mark-rendering: ${error.message}`);
    });

    // Sign the spec URL at render start (not at enqueue) so a queue backlog can't
    // expire it (spec 10.3), then invoke Lambda with the pointer.
    const invoked = await step.run('invoke-lambda', async () => {
      const specUrl = await signedGetUrl(specKey, 60 * 60 * 6);
      const res = await renderMediaOnLambda({
        region,
        functionName,
        serveUrl: serverEnv.remotion.serveUrl,
        composition: 'Reel',
        inputProps: { specUrl },
        codec: 'h264',
        privacy: 'private',
      });
      return { lambdaRenderId: res.renderId, bucketName: res.bucketName };
    });

    const outputUrl = await waitForLambdaCompletion(step, {
      lambdaRenderId: invoked.lambdaRenderId,
      bucketName: invoked.bucketName,
      functionName,
      region,
    });

    await step.run('store-mp4-in-r2', async () => {
      const res = await fetch(outputUrl);
      if (!res.ok) throw new Error(`fetch rendered mp4: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const key = `renders/${renderId}.mp4`;
      await putObject(key, bytes, 'video/mp4');
      const { error } = await admin
        .from('renders')
        .update({
          status: 'complete',
          output_r2_key: key,
          render_date: new Date().toISOString(),
        })
        .eq('id', renderId);
      if (error) throw new Error(`finalize: ${error.message}`);
    });

    return { renderId, ok: true };
  },
);

// --- swap point: poll today, wait-for-event later --------------------------
type WaitParams = {
  lambdaRenderId: string;
  bucketName: string;
  functionName: string;
  region: AwsRegion;
};

// Returns the URL of the finished MP4 in Remotion's S3 output bucket.
async function waitForLambdaCompletion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  params: WaitParams,
): Promise<string> {
  const MAX_POLLS = 120; // ~6 min at 3s spacing
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const progress = await step.run(`poll-${attempt}`, async () => {
      const p = await getRenderProgress({
        renderId: params.lambdaRenderId,
        bucketName: params.bucketName,
        functionName: params.functionName,
        region: params.region,
      });
      return {
        done: p.done,
        fatal: p.fatalErrorEncountered,
        errors: p.errors,
        outputFile: p.outputFile,
        overallProgress: p.overallProgress,
      };
    });

    if (progress.fatal) {
      throw new Error(`Lambda render failed: ${JSON.stringify(progress.errors)}`);
    }
    if (progress.done && progress.outputFile) {
      return progress.outputFile;
    }
    await step.sleep(`wait-${attempt}`, '3s');
  }
  throw new Error('Lambda render timed out');
}
