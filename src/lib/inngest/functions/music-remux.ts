import { inngest, type MusicRemuxData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { signedGetUrl, signedPutUrl } from '@/lib/r2';
import { buildRemuxArgs } from '@/lib/music/ffmpeg';
import { remuxIdempotencyKey, canonicalizeMusicParams, type MusicParams } from '@/lib/music/params';
import { invokeRemux } from '@/lib/music/remux-invoke';
import type { CompositionSpec } from '@/lib/composition/spec';

// Phase 6 audio-only re-mux (spec 10.1). Mix the render's chosen track onto its
// voiceover-only base MP4 with the dedicated ffmpeg Lambda, producing the final
// output — NO re-render. Emitted by the render pipeline (music on) and by the Music
// panel on reroll. Idempotent: an identical (base, track, canonical params) is a
// cache hit, so a no-op re-save costs nothing.
//
// Local paths the Lambda writes inputs to / reads outputs from (it's a dumb
// executor; the argv is built here from the tested ffmpeg.ts).
const IN_VIDEO = '/tmp/in.mp4';
const IN_MUSIC = '/tmp/bed.mp3';
const OUT_VIDEO = '/tmp/out.mp4';

// Rough Lambda cost for the ledger (2 GB function). The exact governor is Phase 9.
const REMUX_USD_PER_SEC = 0.0000333;

export const musicRemux = inngest.createFunction(
  {
    id: 'music-remux',
    retries: 2,
    triggers: [{ event: 'music/remux' }],
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data as MusicRemuxData;
      const admin = createAdminClient();
      const err = { phase: 'music_remux', message: error.message };
      await admin.from('renders').update({ status: 'failed', error: err }).eq('id', data.renderId);
      if (data.jobId) {
        await admin.from('jobs').update({ status: 'failed', phase: 'failed', error: err }).eq('id', data.jobId);
      }
    },
  },
  async ({ event, step }) => {
    const { renderId, videoId, accountId, jobId } = event.data as MusicRemuxData;
    const admin = createAdminClient();

    const loaded = await step.run('load', async () => {
      const { data: render, error } = await admin
        .from('renders')
        .select('base_output_r2_key, music_track_id, music_params, music_remux_key, output_r2_key, composition_spec_r2_key')
        .eq('id', renderId)
        .single();
      if (error || !render) throw new Error(`load render: ${error?.message ?? 'not found'}`);
      if (!render.base_output_r2_key) throw new Error('remux: render has no base_output_r2_key.');

      // No track selected ⇒ nothing to mix; the final IS the base. (Defensive — the
      // pipeline only emits this event when a track is set.)
      if (!render.music_track_id) {
        return { skip: 'no-track' as const, baseKey: render.base_output_r2_key as string };
      }

      const { data: track, error: tErr } = await admin
        .from('music_tracks')
        .select('r2_key')
        .eq('id', render.music_track_id as string)
        .single();
      if (tErr || !track?.r2_key) throw new Error(`load track: ${tErr?.message ?? 'no r2_key'}`);

      const params = canonicalizeMusicParams((render.music_params as Partial<MusicParams>) ?? {});
      const key = remuxIdempotencyKey(render.base_output_r2_key as string, render.music_track_id as string, params);
      const cacheHit = render.music_remux_key === key && !!render.output_r2_key;

      // Duration from the durable spec (metadata is authoritative).
      const specUrl = await signedGetUrl(render.composition_spec_r2_key as string, 60 * 30);
      const res = await fetch(specUrl);
      if (!res.ok) throw new Error(`fetch spec: ${res.status}`);
      const spec = (await res.json()) as CompositionSpec;
      const durationSec = spec.metadata.durationInFrames / spec.metadata.fps;

      return {
        skip: false as const,
        baseKey: render.base_output_r2_key as string,
        musicKey: track.r2_key as string,
        trackId: render.music_track_id as string,
        params,
        key,
        cacheHit,
        durationSec,
      };
    });

    // Cache hit or no track: ensure the render is finalized and stop (no Lambda spend).
    if (loaded.skip === 'no-track') {
      await step.run('finalize-base', async () => {
        await admin.from('renders').update({ status: 'complete', output_r2_key: loaded.baseKey }).eq('id', renderId);
        await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);
        if (jobId) await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
      });
      return { renderId, music: false as const };
    }
    if (loaded.cacheHit) {
      await step.run('finalize-cached', async () => {
        await admin.from('renders').update({ status: 'complete' }).eq('id', renderId);
        await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);
        if (jobId) await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
      });
      return { renderId, music: true as const, cached: true };
    }

    const outKey = `renders/${renderId}.mp4`;
    const mix = await step.run('remux', async () => {
      const [baseUrl, musicUrl, putUrl] = await Promise.all([
        signedGetUrl(loaded.baseKey, 60 * 60),
        signedGetUrl(loaded.musicKey, 60 * 60),
        signedPutUrl(outKey, 'video/mp4', 60 * 60),
      ]);
      const args = buildRemuxArgs({
        videoPath: IN_VIDEO,
        musicPath: IN_MUSIC,
        outPath: OUT_VIDEO,
        videoDurationSec: loaded.durationSec,
        params: loaded.params,
      });
      const result = await invokeRemux({
        args,
        inputs: { [IN_VIDEO]: baseUrl, [IN_MUSIC]: musicUrl },
        outputs: { [OUT_VIDEO]: putUrl },
      });
      if (!result.ok) throw new Error(`remux failed: ${result.error ?? 'unknown'}`);
      return { durationMs: result.durationMs ?? 0 };
    });

    await step.run('finalize', async () => {
      await admin
        .from('renders')
        .update({ status: 'complete', output_r2_key: outKey, music_remux_key: loaded.key, render_date: new Date().toISOString() })
        .eq('id', renderId);
      await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);

      const costUsd = (mix.durationMs / 1000) * REMUX_USD_PER_SEC;
      await admin.from('cost_events').insert({
        account_id: accountId,
        video_id: videoId,
        render_id: renderId,
        operation: 'music_remux',
        provider: 'aws_lambda',
        units: Math.round(loaded.durationSec),
        cost_usd: costUsd,
      });
      if (jobId) await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
    });

    return { renderId, music: true as const, cached: false };
  },
);
