'use server';

import { createClient } from '@/lib/supabase/server';
import { signedGetUrl } from '@/lib/r2';
import { inngest } from '@/lib/inngest/client';
import { estimateSynthesisCost } from '@/lib/voice/estimate';
import { DEFAULT_VOICE_ID, ELEVENLABS_DEFAULT_MODEL } from '@/lib/voice/elevenlabs';
import { voiceSettingsFromTts } from '@/lib/channels/voice';

// Phase 3 voice synthesis surface (spec 6.4). estimateSynthesis is the inline
// pre-pay cost preview; synthesizeScenes kicks off the Inngest job; getSceneAudioUrl
// hands the editor a short-lived signed URL to play a scene's audio from R2.

// Scenes that "Synthesize all" targets: audio that doesn't yet match the script.
const SYNTH_TARGET_STATUSES = ['not_synthesized', 'stale'];

async function requireAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data: account, error } = await supabase.from('accounts').select('id').single();
  if (error || !account) throw new Error(`No account: ${error?.message ?? 'not found'}`);
  return account.id as string;
}

// The scene ids to synthesize: an explicit selection, else every stale /
// not_synthesized scene in the video (ordered).
async function resolveTargetSceneIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  videoId: string,
  sceneIds?: string[],
): Promise<string[]> {
  if (sceneIds && sceneIds.length > 0) return sceneIds;
  const { data } = await supabase
    .from('scenes')
    .select('id')
    .eq('video_id', videoId)
    .in('audio_status', SYNTH_TARGET_STATUSES)
    .order('position');
  return (data ?? []).map((r) => r.id as string);
}

// Inline cost estimate (spec 6.4). Uses RAW narration length (pre-fallback) — an
// upper-bound preview; the ledger records the actual characters sent.
export async function estimateSynthesis(
  videoId: string,
  sceneIds?: string[],
): Promise<{ characters: number; estimatedUsd: number; sceneCount: number }> {
  const supabase = await createClient();
  const ids = await resolveTargetSceneIds(supabase, videoId, sceneIds);
  if (ids.length === 0) return { characters: 0, estimatedUsd: 0, sceneCount: 0 };
  const { data } = await supabase.from('scenes').select('narration').in('id', ids);
  const narrations = (data ?? []).map((r) => (r.narration as string) ?? '');
  return { ...estimateSynthesisCost(narrations), sceneCount: narrations.length };
}

// Kick off synthesis. Resolves the voice from the channel (falling back to the
// default public voice if unset / the Phase-2 placeholder), creates the job row,
// and emits voice/synthesize. A no-op (no job) when nothing is stale /
// not_synthesized, so "Synthesize all" can't create an empty job.
export async function synthesizeScenes(
  videoId: string,
  sceneIds?: string[],
): Promise<{ jobId: string } | { nothingToDo: true }> {
  const supabase = await createClient();
  const accountId = await requireAccountId(supabase);

  const ids = await resolveTargetSceneIds(supabase, videoId, sceneIds);
  if (ids.length === 0) return { nothingToDo: true };

  // Resolve the voice from the video's channel.
  const { data: video, error: vErr } = await supabase
    .from('videos')
    .select('channel_id, channels(voice_tts)')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const voiceTts =
    ((video.channels as { voice_tts?: { voice_id?: string; model?: string } } | null)
      ?.voice_tts) ?? {};
  const voiceId =
    voiceTts.voice_id && voiceTts.voice_id !== 'placeholder' ? voiceTts.voice_id : DEFAULT_VOICE_ID;
  const modelId = voiceTts.model ?? ELEVENLABS_DEFAULT_MODEL;

  const created = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, type: 'voice_synthesis', status: 'queued' })
    .select('id')
    .single();
  if (created.error || !created.data) throw new Error(`create job: ${created.error?.message}`);
  const jobId = created.data.id as string;

  const settings = voiceSettingsFromTts(voiceTts);
  await inngest.send({
    name: 'voice/synthesize',
    data: {
      jobId,
      videoId,
      accountId,
      sceneIds: ids,
      voice: { voiceId, modelId, ...(settings ? { settings } : {}) },
    },
  });

  return { jobId };
}

// Short-lived signed URL to play a scene's audio. 300s is comfortably longer than
// any scene's audio, so a listen-through or replay never expires mid-play.
export async function getSceneAudioUrl(sceneId: string): Promise<{ url: string | null }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('scenes')
    .select('audio_r2_key')
    .eq('id', sceneId)
    .single();
  const key = data?.audio_r2_key as string | null | undefined;
  if (!key) return { url: null };
  return { url: await signedGetUrl(key, 300) };
}
