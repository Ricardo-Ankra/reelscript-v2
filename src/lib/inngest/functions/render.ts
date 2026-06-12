import type Anthropic from '@anthropic-ai/sdk';
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
  runAgenticComposition,
  collectReferencedAssetIds,
  collectKineticSpans,
  planStockResolution,
  SEARCH_STOCK_TOOL,
  type CompositionBrief,
  type SceneBrief,
  type KineticConfig,
  type LoopBlock,
} from '@/lib/composition/compose';
import { validateSpec, formatGate1Feedback, type Gate1Error } from '@/lib/composition/gate1';
import type { CompositionSpec, AssetManifestEntry } from '@/lib/composition/spec';
import { hasStockKeys, searchStock } from '@/lib/assets/search';
import type { StockCandidate } from '@/lib/assets/candidate';
import { resolveStockAssets, resolveResourceAssets } from '@/lib/assets/resolve';
import { runGate2 } from '@/lib/composition/gate2';
import {
  buildCaptions,
  suppressDuringSpans,
  reconstructWords,
  toSrt,
  toVtt,
  type SceneCaptionInput,
  type CaptionSegment,
  type CaptionStyle,
} from '@/lib/captions/segments';
import { selectMusicTrack, type MusicTrack } from '@/lib/music/select';
import { canonicalizeMusicParams, type MusicParams } from '@/lib/music/params';
import type { TtsAlignment } from '@/lib/voice/alignment';

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
    // Phase 5: branch the compose between the agentic stock-vision loop and the
    // Phase-4 procedural single-call. The no-key path IS the procedural one (spec 8.9).
    await setPhase('composing');
    const composed = await step.run('compose', async () => {
      const brief = await loadBrief(admin, videoId);

      // Pre-resolve explicit channel-resource shots (source='resource') into the
      // manifest — already uploaded, so just a key lookup (spec 8.8). Stock assets
      // are resolved later, after the loop picks them.
      const resourceEntries = brief.resourceIds.length
        ? await resolveResourceAssets(admin, brief.accountId, brief.resourceIds)
        : [];
      const briefWithResources: CompositionBrief = {
        ...brief,
        assets: [...brief.assets, ...resourceEntries],
      };

      const useStock = hasStockKeys() && brief.needsStock;
      let outcome = useStock
        ? await agenticCompose(briefWithResources, admin, brief.accountId)
        : await proceduralCompose(briefWithResources);

      // Degrade rather than hard-fail: an agentic path that can't produce a valid
      // stock composition falls back to one procedural pass (spec 8.9).
      if (!outcome.ok && useStock) {
        const fb = await proceduralCompose(briefWithResources);
        outcome = {
          ...fb,
          tokensIn: outcome.tokensIn + fb.tokensIn,
          tokensOut: outcome.tokensOut + fb.tokensOut,
          searches: outcome.searches,
        };
      }

      await writeCompositionCost(admin, videoId, renderId, outcome.tokensIn, outcome.tokensOut);
      if (outcome.searches > 0) {
        await writeCostEvent(admin, videoId, renderId, 'asset_search', 'stock', outcome.searches, 0);
      }
      if (!outcome.ok || !outcome.spec) {
        return { ok: false as const, errors: outcome.errors ?? [] };
      }

      // Captions (system-built, spec 8.5): full segments feed the SRT/VTT sidecars;
      // the BURNT track is the full set minus any segment overlapping a kinetic span
      // (collision prevention by construction). Music is NOT added to the spec — the
      // render stays voiceover-only and the ffmpeg re-mux owns music (spec 10.1).
      const spec = outcome.spec;
      let fullCaptions: CaptionSegment[] = [];
      if (brief.captionsEnabled) {
        fullCaptions = buildCaptions(brief.captionInputs, {
          fps: brief.metadata.fps,
          maxCharsPerLine: brief.maxCharsPerLine,
        });
        spec.captions = suppressDuringSpans(fullCaptions, collectKineticSpans(spec));
        if (brief.captionStyle) spec.captionStyle = brief.captionStyle;
      }

      return {
        ok: true as const,
        spec,
        midSceneIntent: midSceneIntent(briefWithResources, spec),
        captionsEnabled: brief.captionsEnabled,
        fullCaptions,
        musicTrackId: brief.musicTrackId,
        musicParams: brief.musicParams,
      };
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

    // Persist the music choice + mix params on the render (the re-mux + the Music
    // panel read these; null track ⇒ music off ⇒ no re-mux step).
    await step.run('persist-music', async () => {
      await admin
        .from('renders')
        .update({ music_track_id: composed.musicTrackId, music_params: composed.musicParams })
        .eq('id', renderId);
    });

    // --- resolveAssets (ephemeral signed copy Lambda fetches) ----------------
    await setPhase('resolving_assets');
    const renderSpecKey = await step.run('resolve-assets', async () => {
      const signed = await signSpecAssets(durableSpec);
      const key = `specs/${renderId}.render.json`;
      await putObject(key, JSON.stringify(signed), 'application/json');
      return key;
    });

    // --- Gate 2 (smoke still + vision QA, spec 11.2) -------------------------
    // Render one mid-video still on the signed spec, mechanical not-blank check +
    // one Claude-vision pass. A fail marks the render failed with the frame URL
    // preserved (no auto-fix loop — that's Phase 7).
    const gate2 = await step.run('gate2', async () => {
      const specUrl = await signedGetUrl(renderSpecKey, 60 * 60);
      const midFrame = Math.floor(durableSpec.metadata.durationInFrames / 2);
      const result = await runGate2({
        region,
        functionName,
        serveUrl: serverEnv.remotion.serveUrl,
        specUrl,
        midFrame,
        sceneIntent: composed.midSceneIntent,
      });
      const visionUsd =
        (result.tokensIn / 1_000_000) * SONNET_USD_PER_1M_IN +
        (result.tokensOut / 1_000_000) * SONNET_USD_PER_1M_OUT;
      await writeCostEvent(admin, videoId, renderId, 'smoke_frame', 'aws_lambda', 1, result.costUsd + visionUsd);
      return { pass: result.pass, issues: result.issues, frameUrl: result.frameUrl };
    });

    if (!gate2.pass) {
      await step.run('mark-gate2-failed', async () => {
        const error = { phase: 'gate2', message: 'Smoke frame failed QA', issues: gate2.issues, frameUrl: gate2.frameUrl };
        await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
        await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
      });
      return { renderId, failed: 'gate2' as const, issues: gate2.issues };
    }

    // --- Lambda spine (Phase 1, unchanged except concurrency cap) ------------
    await setPhase('rendering');
    const total = durableSpec.metadata.durationInFrames;
    const outputUrl = await runLambdaSpine(step, {
      renderSpecKey,
      region,
      functionName,
      framesPerLambda: Math.max(Math.ceil(total / 4), 50), // cap chunk concurrency
    });

    // --- finalize the BASE (voiceover-only, captions + kinetic burnt in) ------
    // The Lambda output is the base MP4 — NO music (spec 10.1). Music, if any, is
    // mixed onto it by the ffmpeg re-mux below.
    const baseKey = `renders/${renderId}.base.mp4`;
    await step.run('finalize-base', async () => {
      const res = await fetch(outputUrl.url);
      if (!res.ok) throw new Error(`fetch rendered mp4: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await putObject(baseKey, bytes, 'video/mp4');

      const { data: renderRow } = await admin.from('renders').select('account_id').eq('id', renderId).single();
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
      await admin.from('renders').update({ base_output_r2_key: baseKey }).eq('id', renderId);
    });

    // --- caption sidecars (always exported when captions are on, spec 4.2.1) ---
    if (composed.captionsEnabled) {
      await step.run('caption-sidecars', async () => {
        const fps = durableSpec.metadata.fps;
        await putObject(`captions/${renderId}.srt`, toSrt(composed.fullCaptions, fps), 'application/x-subrip');
        await putObject(`captions/${renderId}.vtt`, toVtt(composed.fullCaptions, fps), 'text/vtt');
      });
    }

    // --- music: re-mux onto the base (spec 10.1), or finalize the base as-is ---
    if (composed.musicTrackId) {
      await step.run('emit-remux', async () => {
        const { data: renderRow } = await admin.from('renders').select('account_id').eq('id', renderId).single();
        const accountId = renderRow?.account_id as string;
        await admin.from('renders').update({ status: 'encoding' }).eq('id', renderId);
        await admin.from('jobs').update({ status: 'running', phase: 'encoding' }).eq('id', jobId);
        // The remux function owns the final output + completing the job (spec 10.1).
        await inngest.send({ name: 'music/remux', data: { renderId, accountId, videoId, jobId } });
      });
      return { renderId, ok: true, music: true as const };
    }

    await step.run('finalize', async () => {
      await admin
        .from('renders')
        .update({ status: 'complete', output_r2_key: baseKey, render_date: new Date().toISOString() })
        .eq('id', renderId);
      await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);
      await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
    });

    return { renderId, ok: true, music: false as const };
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

// The brief plus the Phase-5 routing facts (account, stock need, resource ids) and
// the Phase-6 polish facts: caption inputs/style, and the music selection. Captions
// are built AFTER compose (suppression needs the kinetic spans), so loadBrief returns
// the raw per-scene inputs rather than finished segments.
type LoadedBrief = CompositionBrief & {
  accountId: string;
  needsStock: boolean;
  resourceIds: string[];
  captionsEnabled: boolean;
  captionStyle?: CaptionStyle;
  captionInputs: SceneCaptionInput[];
  maxCharsPerLine?: number;
  musicTrackId: string | null;
  musicParams: MusicParams;
};

// Load everything the composition needs from the DB and shape it into a brief.
async function loadBrief(
  admin: ReturnType<typeof createAdminClient>,
  videoId: string,
): Promise<LoadedBrief> {
  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('account_id, channel_id, settings, channels(brand_kit, defaults)')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  const channelId = video.channel_id as string;

  const settings = (video.settings as Record<string, unknown>) ?? {};
  const fps = (settings.fps as number) ?? 30;
  const ratio = (settings.aspect_ratio as string) ?? '9:16';
  const { width, height } = DIMS[ratio] ?? DIMS['9:16'];
  const channel = (video.channels as { brand_kit?: Record<string, unknown>; defaults?: Record<string, unknown> } | null) ?? {};
  const brandKit = channel.brand_kit ?? {};
  const channelDefaults = channel.defaults ?? {};
  const theme = bakeTheme(brandKit as never);

  // Phase-6 polish settings (no settings UI yet — Phase 8 — so these come from the
  // video's settings, then the channel defaults, then a code default).
  // Captions: per-video, defaulting on for 9:16/1:1 and off for 16:9 (spec 4.2.1).
  const captionsEnabled =
    typeof settings.captions_on === 'boolean' ? (settings.captions_on as boolean) : ratio !== '16:9';
  const captionStyle = (brandKit.caption_style as CaptionStyle | undefined) ?? undefined;
  // Kinetic usage off|sparing|liberal (spec 4.2.2).
  const kineticUsageRaw =
    (settings.kinetic_text_usage as string) ?? (channelDefaults.kinetic_text_usage as string) ?? 'sparing';
  const kinetic: KineticConfig = {
    enabled: kineticUsageRaw !== 'off',
    usage: kineticUsageRaw === 'liberal' ? 'liberal' : 'sparing',
  };
  // Music opt-in (spec 4.2.3) + the mix params (defaults until the Phase-8 panel).
  const musicOn =
    typeof settings.music_on === 'boolean'
      ? (settings.music_on as boolean)
      : typeof channelDefaults.music_on === 'boolean'
        ? (channelDefaults.music_on as boolean)
        : false;
  const mood = (settings.mood as string) ?? 'neutral';
  const musicParams = canonicalizeMusicParams((settings.music_params as Partial<MusicParams>) ?? {});

  const { data: sceneRows } = await admin
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_r2_key, word_alignments')
    .eq('video_id', videoId)
    .order('position');
  const scenes = sceneRows ?? [];
  const ids = scenes.map((s) => s.id as string);

  const shotsByScene = new Map<string, string[]>();
  let needsStock = false;
  const resourceIdSet = new Set<string>();
  if (ids.length) {
    const { data: shotRows } = await admin
      .from('shots')
      .select('scene_id, description, position, source, resource_id')
      .in('scene_id', ids)
      .order('position');
    for (const sh of shotRows ?? []) {
      const list = shotsByScene.get(sh.scene_id as string) ?? [];
      list.push(sh.description as string);
      shotsByScene.set(sh.scene_id as string, list);
      if (sh.source === 'resource' && sh.resource_id) {
        resourceIdSet.add(sh.resource_id as string);
      } else {
        needsStock = true; // 'stock' (the default) — this shot wants real footage
      }
    }
  }

  const assets: AssetManifestEntry[] = [];
  const captionInputs: SceneCaptionInput[] = [];
  let offset = 0; // cumulative absolute start frame
  const briefScenes: SceneBrief[] = scenes.map((s) => {
    const position = s.position as number;
    const durationSeconds = Number(s.duration_seconds) || 2;
    const durationInFrames = Math.max(Math.round(durationSeconds * fps), 1);
    let voiceoverAssetId: string | undefined;
    if (s.audio_r2_key) {
      voiceoverAssetId = `vo-${position}`;
      assets.push({ id: voiceoverAssetId, kind: 'audio', r2Key: s.audio_r2_key as string });
    }
    const alignment = (s.word_alignments as TtsAlignment | null) ?? null;
    captionInputs.push({ alignment, startFrame: offset });
    // Spoken words as SCENE-RELATIVE frame windows, for kinetic alignment.
    let words: SceneBrief['words'];
    if (kinetic.enabled && alignment) {
      words = reconstructWords(alignment).map((w) => ({
        t: w.text,
        s: Math.round(w.startSec * fps),
        e: Math.round(w.endSec * fps),
      }));
    }
    offset += durationInFrames;
    return {
      id: s.id as string,
      position,
      narration: (s.narration as string) ?? '',
      shotHints: shotsByScene.get(s.id as string) ?? [],
      durationInFrames,
      voiceoverAssetId,
      ...(words ? { words } : {}),
    };
  });

  const durationInFrames = offset;

  // Music selection (spec 4.2.3): pick from the channel's seeded library by mood. The
  // chosen id is mixed in by the ffmpeg re-mux, not baked into the render.
  let musicTrackId: string | null = null;
  if (musicOn) {
    const { data: trackRows } = await admin.from('music_tracks').select('id, mood_tags').eq('channel_id', channelId);
    const tracks: MusicTrack[] = (trackRows ?? []).map((t) => ({
      id: t.id as string,
      moodTags: (t.mood_tags as string[]) ?? [],
    }));
    musicTrackId = selectMusicTrack(mood, tracks)?.id ?? null;
  }

  return {
    metadata: { width, height, fps, durationInFrames },
    theme,
    assets,
    scenes: briefScenes,
    kinetic,
    accountId,
    needsStock,
    resourceIds: [...resourceIdSet],
    captionsEnabled,
    captionStyle,
    captionInputs,
    maxCharsPerLine: captionStyle?.maxCharsPerLine,
    musicTrackId,
    musicParams,
  };
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

// Generic cost_events writer (asset_search, smoke_frame, …). Looks the account up
// off the render row so callers don't have to thread it.
async function writeCostEvent(
  admin: ReturnType<typeof createAdminClient>,
  videoId: string,
  renderId: string,
  operation: string,
  provider: string,
  units: number,
  costUsd: number,
): Promise<void> {
  const { data } = await admin.from('renders').select('account_id').eq('id', renderId).single();
  const accountId = data?.account_id as string | undefined;
  if (!accountId) return;
  await admin.from('cost_events').insert({
    account_id: accountId,
    video_id: videoId,
    render_id: renderId,
    operation,
    provider,
    units,
    cost_usd: costUsd,
  });
}

// --- compose helpers (Phase 5) ---------------------------------------------

// What a compose attempt yields. Single shape (not a union) so the agentic→
// procedural fallback can spread + merge token counts cleanly.
type ComposeOutcome = {
  ok: boolean;
  spec?: CompositionSpec;
  errors?: Gate1Error[];
  tokensIn: number;
  tokensOut: number;
  searches: number;
};

// The Phase-4 procedural path: one Sonnet call (no tools), parse → assemble →
// Gate 1, with budget-2 validate-and-retry. brief already carries every resolved
// asset (audio + any pre-resolved resources).
async function proceduralCompose(brief: CompositionBrief): Promise<ComposeOutcome> {
  const system = buildCompositionSystemPrompt(); // stockEnabled defaults false
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildCompositionUserPrompt(brief) },
  ];
  let tokensIn = 0;
  let tokensOut = 0;
  let errors: Gate1Error[] = [];

  for (let attempt = 0; attempt <= GATE1_RETRY_BUDGET; attempt++) {
    // 32k headroom: adaptive thinking counts against max_tokens; effort 'medium'
    // reins in over-thinking on what is a structured arrangement task.
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
      throw new Error('Composition hit max_tokens before completing the spec JSON.');
    }
    tokensIn += msg.usage.input_tokens ?? 0;
    tokensOut += msg.usage.output_tokens ?? 0;
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

    const ai = parseComposition(text);
    if (ai) {
      const spec = assembleSpec(ai, brief);
      const result = validateSpec(spec, brief.theme);
      if (result.ok) return { ok: true, spec, tokensIn, tokensOut, searches: 0 };
      errors = result.errors;
    } else {
      errors = [{ rule: 'json', detail: 'Output was not a single valid JSON object.' }];
    }
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `Your composition failed validation:\n${formatGate1Feedback(errors)}\nReturn ONLY the corrected JSON.`,
    });
  }
  return { ok: false, errors, tokensIn, tokensOut, searches: 0 };
}

// The Phase-5 agentic path: the vision selection loop chooses stock, we resolve the
// referenced assets into the manifest, assemble → Gate 1. On failure we re-run the
// loop with the Gate-1 feedback (downloads are content-hash-cached, so cheap).
async function agenticCompose(
  brief: CompositionBrief,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
): Promise<ComposeOutcome> {
  let tokensIn = 0;
  let tokensOut = 0;
  let searches = 0;
  let errors: Gate1Error[] = [];
  let feedback: string | undefined;

  for (let attempt = 0; attempt <= GATE1_RETRY_BUDGET; attempt++) {
    const result = await runAgenticComposition(brief, {
      feedback,
      callModel: async (system, msgs) => {
        const stream = anthropic().messages.stream({
          model: COMPOSITION_MODEL,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          tools: [SEARCH_STOCK_TOOL as unknown as Anthropic.Tool],
          system,
          messages: msgs as unknown as Anthropic.MessageParam[],
        });
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'max_tokens') {
          throw new Error('Composition hit max_tokens before completing.');
        }
        return {
          content: msg.content as unknown as LoopBlock[],
          stopReason: msg.stop_reason,
          usage: { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 },
        };
      },
      searchStock: async (params) => {
        searches += 1;
        const candidates = await searchStock(admin, accountId, params);
        // Embed thumbnails as base64 so the vision model never has to fetch a URL
        // itself (some provider CDNs block Anthropic's fetcher; empty URLs 400).
        return attachThumbnails(candidates);
      },
    });
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;

    if (!result.ai) {
      feedback = 'You did not output a final JSON composition. Stop calling tools and return ONLY the JSON object now.';
      errors = [{ rule: 'json', detail: 'No final composition produced.' }];
      continue;
    }

    // Resolve only the stock assets the AI actually referenced, then validate.
    const plan = planStockResolution(collectReferencedAssetIds(result.ai), result.registry);
    const stockEntries = await resolveStockAssets(admin, accountId, plan);
    const fullBrief: CompositionBrief = { ...brief, assets: [...brief.assets, ...stockEntries] };
    const spec = assembleSpec(result.ai, fullBrief);
    const v = validateSpec(spec, brief.theme);
    if (v.ok) return { ok: true, spec, tokensIn, tokensOut, searches };
    errors = v.errors;
    feedback = `Your composition failed validation:\n${formatGate1Feedback(errors)}\nReturn ONLY the corrected JSON.`;
  }
  return { ok: false, errors, tokensIn, tokensOut, searches };
}

// Fetch each shown candidate's thumbnail server-side and attach it as base64 so the
// vision model gets the bytes inline. Tolerant + capped: candidates without a
// thumbnail, or whose thumbnail can't be fetched / is empty / is too large, are
// dropped (the model only picks from what it can actually see). Never persisted —
// the search-result cache stays free of base64.
// Anthropic rejects any image over 2000px per side in a many-image request. We can't
// resize without an image dependency, so read the dimensions from the PNG/JPEG header
// and drop anything too large (Pexels thumbnails are already bounded server-side via
// imgix; this is the universal safety net for other providers). Unknown formats pass.
const MAX_THUMB_DIM = 1990;
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    // PNG: IHDR width/height as big-endian uint32 at offsets 16/20.
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk markers to the SOF segment, which carries height then width.
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) {
        o += 1;
        continue;
      }
      const marker = buf[o + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

async function attachThumbnails(candidates: StockCandidate[], max = 6): Promise<StockCandidate[]> {
  const shown = candidates.slice(0, max).filter((c) => c.thumbnailUrl);
  const fetched = await Promise.all(
    shown.map(async (c): Promise<StockCandidate | null> => {
      try {
        const res = await fetch(c.thumbnailUrl);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 4_500_000) return null; // skip empty/oversized
        const dims = imageDimensions(buf);
        if (dims && (dims.w > MAX_THUMB_DIM || dims.h > MAX_THUMB_DIM)) return null; // too big for vision
        const ct = res.headers.get('content-type') || '';
        const mediaType = ct.includes('png')
          ? 'image/png'
          : ct.includes('webp')
            ? 'image/webp'
            : ct.includes('gif')
              ? 'image/gif'
              : 'image/jpeg';
        return { ...c, thumbnailBase64: buf.toString('base64'), thumbnailMediaType: mediaType };
      } catch {
        return null;
      }
    }),
  );
  return fetched.filter((c): c is StockCandidate => c !== null);
}

// The narration/intent of the scene covering the mid frame — Gate 2's "what should
// this moment show" context.
function midSceneIntent(brief: CompositionBrief, spec: CompositionSpec): string {
  const mid = Math.floor(spec.metadata.durationInFrames / 2);
  let acc = 0;
  for (const s of brief.scenes) {
    acc += s.durationInFrames;
    if (mid < acc) {
      const hints = s.shotHints.length ? ` Shots: ${s.shotHints.join('; ')}` : '';
      return `${s.narration}${hints}`.trim() || 'the video content';
    }
  }
  return brief.scenes[0]?.narration ?? 'the video content';
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
