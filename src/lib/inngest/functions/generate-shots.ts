import { inngest } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { signedGetUrl, streamUrlToR2 } from '@/lib/r2';
import { getGenerationProvider } from '@/lib/generation/provider-factory';
import type { GenerationProvider } from '@/lib/generation/provider';
import { resolveMotion } from '@/lib/generation/motion-presets';
import { buildClipPrompt, buildStillPrompt } from '@/lib/generation/prompt';
import { route } from '@/lib/generation/router';
import { videoSeed } from '@/lib/generation/seed';
import { parseVisualBrief } from '@/lib/videos/visual-brief';
import { parseCameraSpec, parseLightingSpec, type Provenance } from '@/lib/videos/cinematography';

const MAX_POLLS = 150;

type GenShot = {
  id: string;
  visual_brief: unknown;
  camera_spec: unknown;
  lighting_spec: unknown;
  hero: boolean;
  needs_speech: boolean;
  broadcast_4k: boolean;
};

// Generate a keyframe still + Higgsfield clip for each generative shot of a video,
// durably (V2 Slice 1b). The clip lifecycle is async (submit → poll), mirroring
// render.ts's runLambdaSpine. Fires only on an explicit generation/run event; the
// master pipeline (Slice 6) wires it in later. cancelOn mirrors the other job functions.
export const generateShots = inngest.createFunction(
  {
    id: 'generate-shots',
    retries: 2,
    triggers: [{ event: 'generation/run' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  async ({ event, step }) => {
    const { videoId } = event.data as { videoId: string; accountId: string; jobId?: string };
    const admin = createAdminClient();
    const provider = getGenerationProvider();
    const seed = videoSeed(videoId);

    // Aspect ratio for the keyframe still, from the video settings (default 9:16).
    const aspectRatio = await step.run('load-video', async () => {
      const { data, error } = await admin.from('videos').select('settings').eq('id', videoId).single();
      if (error || !data) throw new Error(`load video: ${error?.message ?? 'not found'}`);
      const settings = (data.settings ?? {}) as Record<string, unknown>;
      return (settings.aspect_ratio as string) ?? '9:16';
    });

    // Generative shots = kind 'generative' shots in this video's scenes with no clip yet
    // (so re-runs are idempotent). Shots have no video_id → resolve via scene ids.
    const shots = await step.run('load-shots', async () => {
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return [] as GenShot[];
      const { data, error } = await admin
        .from('shots')
        .select('id, visual_brief, camera_spec, lighting_spec, hero, needs_speech, broadcast_4k')
        .in('scene_id', sceneIds)
        .eq('kind', 'generative')
        .is('clip_key', null);
      if (error) throw new Error(`load shots: ${error.message}`);
      return (data ?? []) as GenShot[];
    });

    for (const shot of shots) {
      await runGenerationSpine(step, provider, admin, shot, seed, aspectRatio);
    }

    return { generated: shots.length };
  },
);

// One generative shot: keyframe still → submit clip → durable poll → finalize. Each
// external touch is its own durable step.run so a mid-shot failure resumes in place.
async function runGenerationSpine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  provider: GenerationProvider,
  admin: ReturnType<typeof createAdminClient>,
  shot: GenShot,
  seed: number,
  aspectRatio: string,
): Promise<void> {
  // Never-throw parsers; a script-gen'd generative shot has camera/lighting, but default
  // if absent ({} → defaults, never null).
  const brief = parseVisualBrief(shot.visual_brief) ?? parseVisualBrief({})!;
  const camera = parseCameraSpec(shot.camera_spec) ?? parseCameraSpec({})!;
  const lighting = parseLightingSpec(shot.lighting_spec) ?? parseLightingSpec({})!;

  // 1. Keyframe still → R2 → shots.keyframe_first_key.
  const keyframeKey = await step.run(`keyframe-${shot.id}`, async () => {
    const prompt = buildStillPrompt(brief, camera, lighting);
    const { url } = await provider.generateStill({ prompt, aspectRatio, seed, styleRefUrl: null });
    const key = `generation/${shot.id}/keyframe.png`;
    // NOTE: shots.keyframe_first_key = this per-shot GENERATED keyframe. Distinct from
    // entities.keyframe_key (1a, unused in 1b) — the future per-recurring-entity anchor
    // for seed-locking + reference-image carry.
    await streamUrlToR2(url, key, 'image/png');
    const { error } = await admin.from('shots').update({ keyframe_first_key: key }).eq('id', shot.id);
    if (error) throw new Error(`write keyframe key for shot ${shot.id}: ${error.message}`);
    return key;
  });

  // 2. Submit the clip (keyframe + motion + routed model + per-video seed).
  const submit = await step.run(`submit-${shot.id}`, async () => {
    const imageUrl = await signedGetUrl(keyframeKey, 3600);
    const { motionId, motionStrength } = resolveMotion(camera);
    const clipPrompt = buildClipPrompt(brief, camera, lighting);
    const engine = route({
      kind: 'generative',
      camera,
      hero: shot.hero,
      needs_speech: shot.needs_speech,
      broadcast_4k: shot.broadcast_4k,
    });
    const model = engine.replace('higgsfield.', '');
    const { requestId } = await provider.submitClip({
      prompt: clipPrompt,
      imageUrl,
      motionId,
      motionStrength,
      seed,
      model,
    });
    return { requestId, model };
  });

  // 3. Durable poll to completion (mirrors runLambdaSpine).
  let mediaUrl: string | null = null;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const status = await step.run(`poll-${shot.id}-${attempt}`, () => provider.checkClip(submit.requestId));
    if (status.state === 'failed') throw new Error(`clip failed for shot ${shot.id}: ${status.error}`);
    if (status.state === 'completed') {
      mediaUrl = status.mediaUrl;
      break;
    }
    await step.sleep(`wait-${shot.id}-${attempt}`, '3s');
  }
  if (!mediaUrl) throw new Error(`clip generation timed out for shot ${shot.id}`);
  const resolvedUrl: string = mediaUrl;

  // 4. Finalize: clip → R2 → shots.clip_key + routed_model + provenance.
  await step.run(`finalize-${shot.id}`, async () => {
    const clipKey = `generation/${shot.id}/clip.mp4`;
    await streamUrlToR2(resolvedUrl, clipKey, 'video/mp4');
    const provenance: Provenance = {
      synthetic: true,
      source: `higgsfield:${submit.model}`,
      model: submit.model,
      seed,
      source_uri: null,
      created_at: null,
      operator: null,
    };
    const { error } = await admin
      .from('shots')
      .update({ clip_key: clipKey, routed_model: submit.model, provenance })
      .eq('id', shot.id);
    if (error) throw new Error(`finalize shot ${shot.id}: ${error.message}`);
  });
}
