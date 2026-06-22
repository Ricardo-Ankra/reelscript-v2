'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import {
  buildGenerateConfig,
  buildBrandContext,
  validateRegenerateInput,
} from '@/lib/videos/regenerate';
import { parseVideoSettings } from '@/lib/videos/settings';

const IN_PROGRESS = 'A job is already in progress for this video.';

// Re-run script generation for an existing video (regenerate-in-place). Performs NO
// destructive op — it persists the prompt + new length, then enqueues a
// script/generate job with replace:true; the worker does the wipe (so a crash before
// enqueue destroys nothing). Script-only: the operator then synthesizes + renders.
export async function regenerateVideo(
  videoId: string,
  input: { prompt: string; targetLengthSeconds: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateRegenerateInput(input);
  if (!valid.ok) return valid;
  const { prompt, targetLengthSeconds } = valid.value;

  const supabase = await createClient();

  // Friendly guard (the DB unique index is the authoritative stop).
  const { data: inflight } = await supabase
    .from('jobs')
    .select('id')
    .eq('video_id', videoId)
    .in('type', ['script_generation', 'voice_synthesis', 'render'])
    .in('status', ['queued', 'running'])
    .limit(1);
  if (inflight && inflight.length > 0) return { ok: false, reason: IN_PROGRESS };

  const { data: video } = await supabase
    .from('videos')
    .select('account_id, channel_id, settings')
    .eq('id', videoId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'video not found' };
  const accountId = video.account_id as string;

  const { data: channel } = await supabase
    .from('channels')
    .select('name, brand_voice')
    .eq('id', video.channel_id as string)
    .maybeSingle();
  // Channel is REQUIRED — never fabricate a brand name (would generate off-brand
  // silently). A missing channel/name is a surfaced error, not a default.
  if (!channel || typeof channel.name !== 'string') return { ok: false, reason: 'channel not found' };

  // Persist (non-destructive): prompt + new length. Settings via the atomic RPC.
  // NOTE: this persists BEFORE the enqueue. If the enqueue then fails with a non-23505
  // error, the stored prompt/target_length are "ahead" of the still-current old scenes
  // until the operator retries successfully. Non-destructive and self-correcting on a
  // successful regenerate — named here so it isn't surprising in testing.
  const { error: promptErr } = await supabase.from('videos').update({ prompt }).eq('id', videoId);
  if (promptErr) return { ok: false, reason: promptErr.message };
  const { error: mergeErr } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: { target_length: targetLengthSeconds },
  });
  if (mergeErr) return { ok: false, reason: mergeErr.message };

  // Enqueue (DB index enforces single in-flight) — the last action step.
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, type: 'script_generation', status: 'queued' })
    .select('id')
    .single();
  if (jobErr || !job) {
    if (jobErr?.code === '23505') return { ok: false, reason: IN_PROGRESS };
    return { ok: false, reason: jobErr?.message ?? 'could not queue generation' };
  }

  const config = buildGenerateConfig(video.settings, targetLengthSeconds);
  const brand = buildBrandContext(channel as { name: string; brand_voice?: unknown });

  await inngest.send({
    name: 'script/generate',
    data: { jobId: job.id as string, videoId, accountId, prompt, config, brand, replace: true },
  });

  return { ok: true };
}

// One-click retry of a failed/cancelled generation: re-run script generation with
// the video's STORED prompt + length (no operator input). Delegates to
// regenerateVideo (replace:true), which guards an in-flight job and wipes any
// partial scenes from the cancelled run.
export async function retryGeneration(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: video } = await supabase
    .from('videos')
    .select('prompt, settings')
    .eq('id', videoId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'Video not found.' };

  const prompt = typeof video.prompt === 'string' ? video.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: 'This video has no prompt to retry.' };

  const targetLengthSeconds = parseVideoSettings(video.settings).target_length;
  return regenerateVideo(videoId, { prompt, targetLengthSeconds });
}
