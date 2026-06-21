import { inngest, type VoiceSynthesizeData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { putObject } from '@/lib/r2';
import { applyStoredProfile, defaultTagMappings, type TagMappings } from '@/lib/voice/profile';
import { estimateUsd } from '@/lib/voice/estimate';
import { synthesize } from '@/lib/voice/elevenlabs';
import { resolveProviderKey } from '@/lib/credentials/store';

// Voice synthesis (Phase 3, spec 6.4): synthesize each scene's narration to audio
// in R2, capture the character timings, and run the audio_status lifecycle. The
// jobs row is the single source of truth for status; per-scene flips reach the
// editor over Supabase Realtime (scenes is already published).
//
// CONCURRENCY: capped at 5 (spec 6.4) by processing scene steps in chunks of five.
// The full shared rate/concurrency governor is Phase 9 (spec 15.3).
//
// RESUMABILITY (spec 15.2): each scene is its own `step.run('synth-<id>')`, so a
// retry re-runs only the scenes that hadn't completed — Inngest memoises finished
// steps. Completed audio is never re-paid for.
//
// STALENESS CORRECTNESS: narration is captured before the ElevenLabs call and
// re-read after; if it changed mid-flight, the audio is for old text, so the scene
// is written 'stale' rather than 'synthesized' (spec 6.4).
const CONCURRENCY_CAP = 5;

export const synthesizeVoice = inngest.createFunction(
  {
    id: 'synthesize-voice',
    retries: 2,
    triggers: [{ event: 'voice/synthesize' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
    // After retries are exhausted, mark the job failed so the editor stops showing
    // "synthesizing" forever (Phase 1/2 lesson: surface failures). The full failure
    // taxonomy (quota-pause/resume, Retry-After) is Phase 9.
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data as VoiceSynthesizeData;
      const admin = createAdminClient();
      await admin
        .from('jobs')
        .update({ status: 'failed', phase: 'failed', error: { message: error.message } })
        .eq('id', data.jobId);
    },
  },
  async ({ event, step }) => {
    const { jobId, videoId, accountId, sceneIds, voice } = event.data as VoiceSynthesizeData;
    const admin = createAdminClient();

    await step.run('mark-running', async () => {
      const { error } = await admin
        .from('jobs')
        .update({ status: 'running', phase: 'synthesizing' })
        .eq('id', jobId);
      if (error) throw new Error(`mark-running: ${error.message}`);
    });

    let synthesized = 0;
    let skipped = 0;

    // Resolve the account's stored profile for the chosen model once (memoized as a
    // durable step → re-runs reuse it). Falls back to the built-in default mapping
    // when no row exists — identical to slice 1. The returned plain object is
    // Inngest-serializable.
    const mapping = (await step.run('load-voice-profile', async () => {
      const { data } = await admin
        .from('voice_profiles')
        .select('tag_mappings')
        .eq('account_id', accountId)
        .eq('elevenlabs_model_id', voice.modelId ?? '')
        .maybeSingle();
      return (data?.tag_mappings as TagMappings) ?? defaultTagMappings(voice.modelId ?? '');
    })) as TagMappings;

    // Resolve the account's ElevenLabs key once (plain await — NOT a step.run, so the
    // decrypted key never lands in Inngest step state). undefined → env fallback.
    const elevenLabsKey = await resolveProviderKey(admin, accountId, 'elevenlabs');

    // Chunks of five = the concurrency cap. Each scene is a durable checkpoint.
    for (let i = 0; i < sceneIds.length; i += CONCURRENCY_CAP) {
      const chunk = sceneIds.slice(i, i + CONCURRENCY_CAP);
      const results = await Promise.all(
        chunk.map((sceneId) =>
          step.run(`synth-${sceneId}`, async () => {
            // Capture narration at the start, so an edit mid-synthesis is detectable.
            const { data: before, error: loadErr } = await admin
              .from('scenes')
              .select('narration')
              .eq('id', sceneId)
              .single();
            if (loadErr || !before) {
              throw new Error(`load scene ${sceneId}: ${loadErr?.message ?? 'not found'}`);
            }
            const captured = before.narration as string;
            const { text, settings } = applyStoredProfile(captured, mapping, voice.settings);
            if (!text.trim()) return { skipped: true as const };

            const { audio, alignment, durationSeconds } = await synthesize({
              text,
              voiceId: voice.voiceId,
              modelId: voice.modelId,
              voiceSettings: settings,
              apiKey: elevenLabsKey,
            });

            // Stable key: re-synthesis overwrites in place (signed URLs change per
            // request, so the editor never serves stale bytes).
            const key = `audio/${sceneId}.mp3`;
            await putObject(key, audio, 'audio/mpeg');

            // Re-read narration: if it changed while we synthesized, the audio is
            // for old text → mark stale, not synthesized (spec 6.4 correctness).
            const { data: after } = await admin
              .from('scenes')
              .select('narration')
              .eq('id', sceneId)
              .single();
            const stillCurrent = (after?.narration as string | undefined) === captured;

            const { error: upErr } = await admin
              .from('scenes')
              .update({
                audio_r2_key: key,
                word_alignments: alignment,
                duration_seconds: durationSeconds, // authoritative once audio exists
                audio_status: stillCurrent ? 'synthesized' : 'stale',
              })
              .eq('id', sceneId);
            if (upErr) throw new Error(`update scene ${sceneId}: ${upErr.message}`);

            // Ledger: ACTUAL post-fallback characters sent (the estimate uses raw
            // narration length, so the two need not match exactly — by design).
            const { error: costErr } = await admin.from('cost_events').insert({
              account_id: accountId,
              video_id: videoId,
              operation: 'voice_synthesis',
              provider: 'elevenlabs',
              units: text.length,
              cost_usd: estimateUsd(text.length),
            });
            if (costErr) throw new Error(`cost event ${sceneId}: ${costErr.message}`);

            return { skipped: false as const };
          }),
        ),
      );
      for (const r of results) {
        if (r.skipped) skipped++;
        else synthesized++;
      }
    }

    await step.run('mark-complete', async () => {
      const { error } = await admin
        .from('jobs')
        .update({
          status: 'complete',
          phase: 'done',
          checkpoint: { scenesSynthesized: synthesized, scenesSkipped: skipped },
        })
        .eq('id', jobId);
      if (error) throw new Error(`mark-complete: ${error.message}`);
    });

    return { jobId, synthesized, skipped };
  },
);
