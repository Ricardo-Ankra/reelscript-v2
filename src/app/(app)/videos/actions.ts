'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import {
  DEFAULT_VIDEO_CONFIG,
  type VideoConfig,
  type BrandContext,
} from '@/lib/ai/script-generation';

// One seeded channel with minimal brand (name, primary colour, font, voice).
// Seeded, not a settings UI (Phase 2). The brand informs the generation prompt.
const SEED_CHANNEL = 'Studio';
const SEED_BRAND = {
  brand_kit: { colors: { primary: '#E2725B' }, typography: { font: 'Poppins' } },
  voice_tts: { voice_id: 'placeholder', model: 'eleven_multilingual_v2' },
  brand_voice: { tone: 'clear, friendly, concise' },
};

// video.settings is the single source of truth for config; the same values are
// copied into the generation event so the worker need not re-read the row.
const SEED_VIDEO_SETTINGS = {
  aspect_ratio: DEFAULT_VIDEO_CONFIG.aspectRatio,
  target_length: DEFAULT_VIDEO_CONFIG.targetLengthSeconds,
  fps: DEFAULT_VIDEO_CONFIG.fps,
  captions_on: DEFAULT_VIDEO_CONFIG.captions,
  music_on: DEFAULT_VIDEO_CONFIG.music,
};

// Prompt → new video → generation job. Returns the video id so the caller can
// open the editor, where scenes stream in over Realtime.
export async function startScriptGeneration(
  prompt: string,
): Promise<{ videoId: string; jobId: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Enter a prompt.');

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

  // Seed the channel (idempotent by name).
  let channelId: string;
  let tone: string | undefined;
  const existingChannel = await supabase
    .from('channels')
    .select('id, brand_voice')
    .eq('name', SEED_CHANNEL)
    .maybeSingle();
  if (existingChannel.data) {
    channelId = existingChannel.data.id as string;
    tone = (existingChannel.data.brand_voice as { tone?: string } | null)?.tone;
  } else {
    const ins = await supabase
      .from('channels')
      .insert({ account_id: accountId, name: SEED_CHANNEL, ...SEED_BRAND })
      .select('id')
      .single();
    if (ins.error || !ins.data) throw new Error(`seed channel: ${ins.error?.message}`);
    channelId = ins.data.id as string;
    tone = SEED_BRAND.brand_voice.tone;
  }

  // Create the video with config baked into settings (written once).
  const title = trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  const createdVideo = await supabase
    .from('videos')
    .insert({
      account_id: accountId,
      channel_id: channelId,
      title,
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
  const brand: BrandContext = { channelName: SEED_CHANNEL, tone };

  await inngest.send({
    name: 'script/generate',
    data: { jobId, videoId, accountId, prompt: trimmed, config, brand },
  });

  return { videoId, jobId };
}
