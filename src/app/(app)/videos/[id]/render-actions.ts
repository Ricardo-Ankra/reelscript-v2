'use server';

import { createClient } from '@/lib/supabase/server';
import { signedGetUrl } from '@/lib/r2';
import { inngest } from '@/lib/inngest/client';
import { renderIdempotencyKey } from '@/lib/composition/idempotency';
import { GATE_PHASE } from '@/lib/gates/gate';

// Phase 4 "Generate Video" (spec 6.5). Validates completeness (no not_synthesized
// scenes; stale needs explicit override), snapshots the live scenes into an
// immutable revision, creates the render + job rows, and emits render/start. The
// composition pipeline (compose → gate1 → resolveAssets → render) runs in Inngest.

const RENDER_IN_FLIGHT = ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding'];
const MAX_REVISIONS = 20;

export type StartVideoRenderResult =
  | { renderId: string; jobId: string | null; reused: boolean }
  | { blocked: 'unsynthesized_scenes' | 'stale_scenes'; sceneIds: string[] };

type PrepareResult =
  | { ok: true; renderId: string; reusedJobId: string | null }
  | { blocked: 'unsynthesized_scenes' | 'stale_scenes'; sceneIds: string[] };

async function prepareRender(
  supabase: Awaited<ReturnType<typeof createClient>>,
  videoId: string,
  accountId: string,
  overrideStale: boolean,
): Promise<PrepareResult> {
  // Load scenes (+ shots) — the completeness gate and the revision snapshot.
  const { data: scenes } = await supabase
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_status, audio_r2_key, word_alignments')
    .eq('video_id', videoId)
    .order('position');
  const sceneRows = scenes ?? [];
  if (sceneRows.length === 0) throw new Error('No scenes to render.');

  const notSynth = sceneRows.filter((s) => s.audio_status === 'not_synthesized');
  if (notSynth.length > 0) return { blocked: 'unsynthesized_scenes', sceneIds: notSynth.map((s) => s.id as string) };
  const stale = sceneRows.filter((s) => s.audio_status === 'stale');
  if (stale.length > 0 && !overrideStale) return { blocked: 'stale_scenes', sceneIds: stale.map((s) => s.id as string) };

  const ids = sceneRows.map((s) => s.id as string);
  const { data: shotRows } = await supabase
    .from('shots')
    .select('id, scene_id, position, description, source, stock_query')
    .in('scene_id', ids)
    .order('position');
  const shotsByScene = new Map<string, unknown[]>();
  for (const sh of shotRows ?? []) {
    const list = shotsByScene.get(sh.scene_id as string) ?? [];
    list.push(sh);
    shotsByScene.set(sh.scene_id as string, list);
  }

  const content = {
    scenes: sceneRows.map((s) => ({
      id: s.id, position: s.position, narration: s.narration,
      duration_seconds: s.duration_seconds, audio_status: s.audio_status,
      shots: shotsByScene.get(s.id as string) ?? [],
    })),
  };
  const createdRev = await supabase
    .from('script_revisions')
    .insert({ account_id: accountId, video_id: videoId, content, edit_summary: overrideStale ? 'Render (stale audio accepted)' : 'Render' })
    .select('id')
    .single();
  if (createdRev.error || !createdRev.data) throw new Error(`snapshot: ${createdRev.error?.message}`);
  const revisionId = createdRev.data.id as string;

  const { data: revs } = await supabase
    .from('script_revisions').select('id').eq('video_id', videoId).order('created_at', { ascending: false });
  const stale_revs = (revs ?? []).slice(MAX_REVISIONS).map((r) => r.id as string);
  if (stale_revs.length) await supabase.from('script_revisions').delete().in('id', stale_revs);

  const idempotencyKey = renderIdempotencyKey(revisionId);
  const { data: existing } = await supabase
    .from('renders').select('id, status').eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existing && RENDER_IN_FLIGHT.includes(existing.status as string)) {
    const { data: job } = await supabase.from('jobs').select('id').eq('render_id', existing.id as string).maybeSingle();
    return { ok: true, renderId: existing.id as string, reusedJobId: (job?.id as string) ?? null };
  }

  const createdRender = await supabase
    .from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: revisionId, status: 'queued', idempotency_key: idempotencyKey })
    .select('id')
    .single();
  if (createdRender.error || !createdRender.data) throw new Error(`render insert: ${createdRender.error?.message}`);
  return { ok: true, renderId: createdRender.data.id as string, reusedJobId: null };
}

export async function startVideoRender(
  videoId: string,
  overrideStale = false,
): Promise<StartVideoRenderResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data: account, error: acctErr } = await supabase.from('accounts').select('id').single();
  if (acctErr || !account) throw new Error(`No account: ${acctErr?.message ?? 'not found'}`);
  const accountId = account.id as string;

  const prep = await prepareRender(supabase, videoId, accountId, overrideStale);
  if ('blocked' in prep) return prep;
  if (prep.reusedJobId) return { renderId: prep.renderId, jobId: prep.reusedJobId, reused: true };

  const createdJob = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: prep.renderId, type: 'render', status: 'queued' })
    .select('id').single();
  if (createdJob.error || !createdJob.data) throw new Error(`job insert: ${createdJob.error?.message}`);
  const jobId = createdJob.data.id as string;
  await inngest.send({ name: 'render/start', data: { jobId, renderId: prep.renderId, videoId } });
  return { renderId: prep.renderId, jobId, reused: false };
}

// V2 Slice 6a: the master pipeline entry point. Same preconditions + snapshot + render row
// as startVideoRender (via prepareRender), then a type='pipeline' job + pipeline/start. The
// pipeline fans out generation + ingest, runs the G1 storyboard gate, then the render.
export async function startPipelineRun(
  videoId: string,
  overrideStale = false,
): Promise<StartVideoRenderResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data: account, error: acctErr } = await supabase.from('accounts').select('id').single();
  if (acctErr || !account) throw new Error(`No account: ${acctErr?.message ?? 'not found'}`);
  const accountId = account.id as string;

  const prep = await prepareRender(supabase, videoId, accountId, overrideStale);
  if ('blocked' in prep) return prep;
  if (prep.reusedJobId) return { renderId: prep.renderId, jobId: prep.reusedJobId, reused: true };

  const createdJob = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: prep.renderId, type: 'pipeline', status: 'queued' })
    .select('id').single();
  if (createdJob.error || !createdJob.data) throw new Error(`job insert: ${createdJob.error?.message}`);
  const jobId = createdJob.data.id as string;
  await inngest.send({ name: 'pipeline/start', data: { jobId, videoId, accountId, renderId: prep.renderId } });
  return { renderId: prep.renderId, jobId, reused: false };
}

// Polled/subscribed by the editor; returns a signed playback URL once complete, plus the
// preview-gate state (the render's job paused at the preview gate) + a signed URL of the
// graded base for in-editor preview. Additive fields — existing callers ignore them.
export async function getRenderState(
  renderId: string,
): Promise<{
  status: string;
  url: string | null;
  error: unknown;
  awaitingPreview: boolean;
  previewUrl: string | null;
  jobId: string | null;
  awaitingStoryboard: boolean;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('renders')
    .select('status, output_r2_key, base_output_r2_key, error')
    .eq('id', renderId)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'render not found');

  let url: string | null = null;
  if (data.status === 'complete' && data.output_r2_key) {
    url = await signedGetUrl(data.output_r2_key as string, 60 * 60);
  }

  // Gate state lives on the job (status='paused' + phase). Surface it + the graded base.
  const { data: job } = await supabase
    .from('jobs')
    .select('id, status, phase')
    .eq('render_id', renderId)
    .maybeSingle();
  const awaitingPreview = job?.status === 'paused' && job?.phase === GATE_PHASE.preview;
  let previewUrl: string | null = null;
  if (awaitingPreview && data.base_output_r2_key) {
    previewUrl = await signedGetUrl(data.base_output_r2_key as string, 60 * 60);
  }
  const awaitingStoryboard = job?.status === 'paused' && job?.phase === GATE_PHASE.storyboard;

  return {
    status: data.status as string,
    url,
    error: data.error ?? null,
    awaitingPreview: Boolean(awaitingPreview),
    previewUrl,
    jobId: (job?.id as string | null) ?? null,
    awaitingStoryboard: Boolean(awaitingStoryboard),
  };
}
