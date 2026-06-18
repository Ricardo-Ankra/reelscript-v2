'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import {
  DEFAULT_VIDEO_CONFIG,
  type VideoConfig,
  type BrandContext,
} from '@/lib/ai/script-generation';

// video.settings is the single source of truth for config; the same values are
// copied into the generation event so the worker need not re-read the row.
const SEED_VIDEO_SETTINGS = {
  aspect_ratio: DEFAULT_VIDEO_CONFIG.aspectRatio,
  target_length: DEFAULT_VIDEO_CONFIG.targetLengthSeconds,
  fps: DEFAULT_VIDEO_CONFIG.fps,
  captions_on: DEFAULT_VIDEO_CONFIG.captions,
  music_on: DEFAULT_VIDEO_CONFIG.music,
};

// Prompt + chosen channel → new video → generation job. Returns the video id so
// the caller can open the editor, where scenes stream in over Realtime. The
// channel is required and RLS-verified — no channel is ever auto-created.
export async function startScriptGeneration(
  prompt: string,
  channelId: string,
): Promise<{ videoId: string; jobId: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Enter a prompt.');
  // Required-channel contract (also covers a stale client during the rollout):
  if (typeof channelId !== 'string' || !channelId.trim()) {
    throw new Error('Pick a channel to generate a video.');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { data: account, error: acctErr } = await supabase
    .from('accounts')
    .select('id')
    .single();
  if (acctErr || !account) throw new Error(`No account: ${acctErr?.message ?? 'not found'}`);
  const accountId = account.id as string;

  // Resolve the chosen channel. RLS scopes the read to this account, so a miss
  // covers both not-found and not-owned.
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_voice')
    .eq('id', channelId)
    .maybeSingle();
  if (!channel) throw new Error('Channel not found.');
  const tone = (channel.brand_voice as { tone?: string } | null)?.tone;

  // Create the video with config baked into settings (written once).
  const title = trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  const createdVideo = await supabase
    .from('videos')
    .insert({
      account_id: accountId,
      channel_id: channel.id as string,
      title,
      prompt: trimmed,
      settings: SEED_VIDEO_SETTINGS,
    })
    .select('id')
    .single();
  if (createdVideo.error || !createdVideo.data) {
    throw new Error(`create video: ${createdVideo.error?.message}`);
  }
  const videoId = createdVideo.data.id as string;

  // Create the job row (single source of truth for generation status).
  const createdJob = await supabase
    .from('jobs')
    .insert({
      account_id: accountId,
      video_id: videoId,
      type: 'script_generation',
      status: 'queued',
    })
    .select('id')
    .single();
  if (createdJob.error || !createdJob.data) {
    throw new Error(`create job: ${createdJob.error?.message}`);
  }
  const jobId = createdJob.data.id as string;

  const config: VideoConfig = {
    aspectRatio: SEED_VIDEO_SETTINGS.aspect_ratio,
    targetLengthSeconds: SEED_VIDEO_SETTINGS.target_length,
    fps: SEED_VIDEO_SETTINGS.fps,
    captions: SEED_VIDEO_SETTINGS.captions_on,
    music: SEED_VIDEO_SETTINGS.music_on,
  };
  const brand: BrandContext = { channelName: channel.name as string, tone };

  await inngest.send({
    name: 'script/generate',
    data: { jobId, videoId, accountId, prompt: trimmed, config, brand },
  });

  return { videoId, jobId };
}
