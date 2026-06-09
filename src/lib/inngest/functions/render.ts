import {
  renderMediaOnLambda,
  getRenderProgress,
  type AwsRegion,
} from '@remotion/lambda/client';
import { inngest, type RenderStartData, type RenderSampleData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env.server';
import { putObject, signedGetUrl } from '@/lib/r2';
import { anthropic, COMPOSITION_MODEL } from '@/lib/ai/anthropic';
import { bakeTheme } from '@/lib/composition/theme';
import {
  buildCompositionSystemPrompt,
  buildCompositionUserPrompt,
  parseComposition,
  assembleSpec,
  type CompositionBrief,
  type SceneBrief,
} from '@/lib/composition/compose';
import { validateSpec, formatGate1Feedback, type Gate1Error } from '@/lib/composition/gate1';
import type { CompositionSpec, AssetManifestEntry } from '@/lib/composition/spec';

// =============================================================================
// Phase 4 — the render pipeline (spec 13.1). One function: compose → gate1 →
// storeSpec(durable) → resolveAssets(ephemeral signed) → Lambda spine → finalize.
// Each await step.run is a durable checkpoint (spec 15.2): a later failure never
// re-pays an earlier step. Compose validation-failure is handled (render marked
// failed, audio + revision untouched), not thrown, so it never re-pays the AI.
// =============================================================================

const GATE1_RETRY_BUDGET = 2; // initial + 2 retries (spec 11.1)
const SONNET_USD_PER_1M_IN = 3;
const SONNET_USD_PER_1M_OUT = 15;

export const renderVideo = inngest.createFunction(
  {
    id: 'render-video',
    retries: 2,
    triggers: [{ event: 'render/start' }],
    onFailure: async ({ event, error }) => {
      // Terminal failure: mark the render + job failed with the error preserved.
      // The snapshot revision and synthesized audio are never touched (spec 15.2).
      const data = event.data.event.data as RenderStartData;
      const admin = createAdminClient();
      await admin
        .from('renders')
        .update({ status: 'failed', error: { message: error.message } })
        .eq('id', data.renderId);
      await admin
        .from('jobs')
        .update({ status: 'failed', phase: 'failed', error: { message: error.message } })
        .eq('id', data.jobId);
    },
  },
  async ({ event, step }) => {
    const { jobId, renderId, videoId } = event.data as RenderStartData;
    const admin = createAdminClient();
    const region = serverEnv.aws.region as AwsRegion;
    const functionName = serverEnv.remotion.functionName;

    const setPhase = (phase: string) =>
      step.run(`phase-${phase}`, async () => {
        await admin.from('jobs').update({ status: 'running', phase }).eq('id', jobId);
        await admin.from('renders').update({ status: statusForPhase(phase) }).eq('id', renderId);
      });

    // --- compose + Gate 1 (one checkpoint; internal budget-2 retry) ----------
    await setPhase('composing');
    const composed = await step.run('compose', async () => {
      const brief = await loadBrief(admin, videoId);
      const system = buildCompositionSystemPrompt();
      const user = buildCompositionUserPrompt(brief);

      const messages: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'user', content: user },
      ];
      let tokensIn = 0;
      let tokensOut = 0;
      let errors: Gate1Error[] = [];

      for (let attempt = 0; attempt <= GATE1_RETRY_BUDGET; attempt++) {
        // max_tokens must comfortably exceed the thinking + JSON output: adaptive
        // thinking tokens count against max_tokens, and at 16k Sonnet could burn the
        // whole budget thinking and emit NO text (empty → forced retry). 32k gives
        // headroom; effort 'medium' reins in over-thinking on what is a structured
        // arrangement task (composition is layout, not deep reasoning) — together
        // they make the first attempt succeed quickly instead of after a wasted ~4min.
        const stream = anthropic().messages.stream({
          model: COMPOSITION_MODEL,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          system,
          messages,
        });
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'max_tokens') {
          // Ran out of room before finishing the JSON — surface it rather than
          // letting it look like a malformed-output retry.
          throw new Error('Composition hit max_tokens before completing the spec JSON.');
        }
        tokensIn += msg.usage.input_tokens ?? 0;
        tokensOut += msg.usage.output_tokens ?? 0;
        const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

        const ai = parseComposition(text);
        if (ai) {
          const spec = assembleSpec(ai, brief);
          const result = validateSpec(spec, brief.theme);
          if (result.ok) {
            await writeCompositionCost(admin, videoId, renderId, tokensIn, tokensOut);
            return { ok: true as const, spec };
          }
          errors = result.errors;
        } else {
          errors = [{ rule: 'json', detail: 'Output was not a single valid JSON object.' }];
        }
        // Feed the structured failure back and retry (within budget).
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: `Your composition failed validation:\n${formatGate1Feedback(errors)}\nReturn ONLY the corrected JSON.`,
        });
      }
      await writeCompositionCost(admin, videoId, renderId, tokensIn, tokensOut);
      return { ok: false as const, errors };
    });

    if (!composed.ok) {
      // Handled validation failure — fail cleanly, never re-pay composition, and
      // leave the revision + synthesized audio intact (spec 15.2).
      await step.run('mark-compose-failed', async () => {
        const error = { phase: 'gate1', message: 'Spec failed validation after retries', gateErrors: composed.errors };
        await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
        await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
      });
      return { renderId, failed: 'gate1' as const, errors: composed.errors };
    }
    const durableSpec = composed.spec;

    // --- storeSpec (durable, key-based — the permanent record) ---------------
    await step.run('store-spec', async () => {
      const key = `specs/${renderId}.json`;
      await putObject(key, JSON.stringify(durableSpec), 'application/json');
      await admin.from('renders').update({ composition_spec_r2_key: key }).eq('id', renderId);
    });

    // --- resolveAssets (ephemeral signed copy Lambda fetches) ----------------
    await setPhase('resolving_assets');
    const renderSpecKey = await step.run('resolve-assets', async () => {
      const signed = await signSpecAssets(durableSpec);
      const key = `specs/${renderId}.render.json`;
      await putObject(key, JSON.stringify(signed), 'application/json');
      return key;
    });

    // --- Lambda spine (Phase 1, unchanged except concurrency cap) ------------
    await setPhase('rendering');
    const total = durableSpec.metadata.durationInFrames;
    const outputUrl = await runLambdaSpine(step, {
      renderSpecKey,
      region,
      functionName,
      framesPerLambda: Math.max(Math.ceil(total / 4), 50), // cap chunk concurrency
    });

    // --- finalize ------------------------------------------------------------
    await step.run('finalize', async () => {
      const res = await fetch(outputUrl.url);
      if (!res.ok) throw new Error(`fetch rendered mp4: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const key = `renders/${renderId}.mp4`;
      await putObject(key, bytes, 'video/mp4');

      const { data: renderRow } = await admin
        .from('renders')
        .select('account_id')
        .eq('id', renderId)
        .single();
      const accountId = renderRow?.account_id as string | undefined;
      if (accountId && outputUrl.costUsd > 0) {
        await admin.from('cost_events').insert({
          account_id: accountId,
          video_id: videoId,
          render_id: renderId,
          operation: 'render',
          provider: 'aws_lambda',
          units: total,
          cost_usd: outputUrl.costUsd,
        });
      }

      await admin
        .from('renders')
        .update({ status: 'complete', output_r2_key: key, render_date: new Date().toISOString() })
        .eq('id', renderId);
      await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);
      await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
    });

    return { renderId, ok: true };
  },
);

// --- Phase-1 sample harness (debug-only, no AI) ------------------------------
export const renderSample = inngest.createFunction(
  { id: 'render-sample', retries: 2, triggers: [{ event: 'render/sample' }] },
  async ({ event, step }) => {
    const { renderId, specKey } = event.data as RenderSampleData;
    const region = serverEnv.aws.region as AwsRegion;
    const functionName = serverEnv.remotion.functionName;
    const admin = createAdminClient();

    await step.run('mark-rendering', async () => {
      const { error } = await admin.from('renders').update({ status: 'rendering' }).eq('id', renderId);
      if (error) throw new Error(`mark-rendering: ${error.message}`);
    });

    const out = await runLambdaSpine(step, { renderSpecKey: specKey, region, functionName });

    await step.run('store-mp4-in-r2', async () => {
      const res = await fetch(out.url);
      if (!res.ok) throw new Error(`fetch rendered mp4: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const key = `renders/${renderId}.mp4`;
      await putObject(key, bytes, 'video/mp4');
      const { error } = await admin
        .from('renders')
        .update({ status: 'complete', output_r2_key: key, render_date: new Date().toISOString() })
        .eq('id', renderId);
      if (error) throw new Error(`finalize: ${error.message}`);
    });

    return { renderId, ok: true };
  },
);

// =============================================================================
// helpers
// =============================================================================

function statusForPhase(phase: string): string {
  switch (phase) {
    case 'composing':
      return 'composing';
    case 'resolving_assets':
      return 'resolving_assets';
    case 'rendering':
      return 'rendering';
    default:
      return 'queued';
  }
}

const DIMS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

// Load everything the composition needs from the DB and shape it into a brief.
async function loadBrief(
  admin: ReturnType<typeof createAdminClient>,
  videoId: string,
): Promise<CompositionBrief> {
  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('settings, channels(brand_kit)')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);

  const settings = (video.settings as Record<string, unknown>) ?? {};
  const fps = (settings.fps as number) ?? 30;
  const ratio = (settings.aspect_ratio as string) ?? '9:16';
  const { width, height } = DIMS[ratio] ?? DIMS['9:16'];
  const theme = bakeTheme((video.channels as { brand_kit?: unknown } | null)?.brand_kit as never);

  const { data: sceneRows } = await admin
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_r2_key')
    .eq('video_id', videoId)
    .order('position');
  const scenes = sceneRows ?? [];
  const ids = scenes.map((s) => s.id as string);

  const shotsByScene = new Map<string, string[]>();
  if (ids.length) {
    const { data: shotRows } = await admin
      .from('shots')
      .select('scene_id, description, position')
      .in('scene_id', ids)
      .order('position');
    for (const sh of shotRows ?? []) {
      const list = shotsByScene.get(sh.scene_id as string) ?? [];
      list.push(sh.description as string);
      shotsByScene.set(sh.scene_id as string, list);
    }
  }

  const assets: AssetManifestEntry[] = [];
  const briefScenes: SceneBrief[] = scenes.map((s) => {
    const position = s.position as number;
    const durationSeconds = Number(s.duration_seconds) || 2;
    const durationInFrames = Math.max(Math.round(durationSeconds * fps), 1);
    let voiceoverAssetId: string | undefined;
    if (s.audio_r2_key) {
      voiceoverAssetId = `vo-${position}`;
      assets.push({ id: voiceoverAssetId, kind: 'audio', r2Key: s.audio_r2_key as string });
    }
    return {
      id: s.id as string,
      position,
      narration: (s.narration as string) ?? '',
      shotHints: shotsByScene.get(s.id as string) ?? [],
      durationInFrames,
      voiceoverAssetId,
    };
  });

  const durationInFrames = briefScenes.reduce((sum, s) => sum + s.durationInFrames, 0);
  return { metadata: { width, height, fps, durationInFrames }, theme, assets, scenes: briefScenes };
}

// Produce the ephemeral render-time spec: same shape, asset urls signed.
async function signSpecAssets(spec: CompositionSpec): Promise<CompositionSpec> {
  const assets = await Promise.all(
    spec.assets.map(async (a) => ({ ...a, url: await signedGetUrl(a.r2Key, 60 * 60 * 6) })),
  );
  return { ...spec, assets };
}

async function writeCompositionCost(
  admin: ReturnType<typeof createAdminClient>,
  videoId: string,
  renderId: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const costUsd = (tokensIn / 1_000_000) * SONNET_USD_PER_1M_IN + (tokensOut / 1_000_000) * SONNET_USD_PER_1M_OUT;
  const { data: renderRow } = await admin.from('renders').select('account_id').eq('id', renderId).single();
  const accountId = renderRow?.account_id as string | undefined;
  if (!accountId) return;
  await admin.from('cost_events').insert({
    account_id: accountId,
    video_id: videoId,
    render_id: renderId,
    operation: 'composition',
    provider: 'anthropic',
    units: tokensIn + tokensOut,
    cost_usd: costUsd,
  });
}

type SpineParams = {
  renderSpecKey: string;
  region: AwsRegion;
  functionName: string;
  framesPerLambda?: number;
};

// Invoke Lambda by signed-spec pointer, poll to completion, return the output URL
// + accrued render cost. framesPerLambda caps chunk concurrency under the AWS
// account limit (a lightweight stand-in for the Phase-9 governor).
async function runLambdaSpine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  params: SpineParams,
): Promise<{ url: string; costUsd: number }> {
  const invoked = await step.run('invoke-lambda', async () => {
    const specUrl = await signedGetUrl(params.renderSpecKey, 60 * 60 * 6);
    const res = await renderMediaOnLambda({
      region: params.region,
      functionName: params.functionName,
      serveUrl: serverEnv.remotion.serveUrl,
      composition: 'Reel',
      inputProps: { specUrl },
      codec: 'h264',
      privacy: 'private',
      ...(params.framesPerLambda ? { framesPerLambda: params.framesPerLambda } : {}),
    });
    return { lambdaRenderId: res.renderId, bucketName: res.bucketName };
  });

  const MAX_POLLS = 150;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const progress = await step.run(`poll-${attempt}`, async () => {
      const p = await getRenderProgress({
        renderId: invoked.lambdaRenderId,
        bucketName: invoked.bucketName,
        functionName: params.functionName,
        region: params.region,
      });
      return {
        done: p.done,
        fatal: p.fatalErrorEncountered,
        errors: p.errors,
        outputFile: p.outputFile,
        costUsd: p.costs?.accruedSoFar ?? 0,
      };
    });
    if (progress.fatal) throw new Error(`Lambda render failed: ${JSON.stringify(progress.errors)}`);
    if (progress.done && progress.outputFile) {
      return { url: progress.outputFile, costUsd: progress.costUsd };
    }
    await step.sleep(`wait-${attempt}`, '3s');
  }
  throw new Error('Lambda render timed out');
}
