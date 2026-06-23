'use server';

import { createClient } from '@/lib/supabase/server';
import { signedGetUrl } from '@/lib/r2';
import { inngest } from '@/lib/inngest/client';
import { renderIdempotencyKey } from '@/lib/composition/idempotency';

// Phase 4 "Generate Video" (spec 6.5). Validates completeness (no not_synthesized
// scenes; stale needs explicit override), snapshots the live scenes into an
// immutable revision, creates the render + job rows, and emits render/start. The
// composition pipeline (compose → gate1 → resolveAssets → render) runs in Inngest.

const RENDER_IN_FLIGHT = ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding'];
const MAX_REVISIONS = 20;

export type StartVideoRenderResult =
  | { renderId: string; jobId: string | null; reused: boolean }
  | { blocked: 'unsynthesized_scenes' | 'stale_scenes'; sceneIds: string[] };

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

  // Load scenes (+ shots) — the completeness gate and the revision snapshot.
  const { data: scenes } = await supabase
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_status, audio_r2_key, word_alignments')
    .eq('video_id', videoId)
    .order('position');
  const sceneRows = scenes ?? [];
  if (sceneRows.length === 0) throw new Error('No scenes to render.');

  // Completeness gate (spec 6.4): no not_synthesized; stale requires override.
  const notSynth = sceneRows.filter((s) => s.audio_status === 'not_synthesized');
  if (notSynth.length > 0) {
    return { blocked: 'unsynthesized_scenes', sceneIds: notSynth.map((s) => s.id as string) };
  }
  const stale = sceneRows.filter((s) => s.audio_status === 'stale');
  if (stale.length > 0 && !overrideStale) {
    return { blocked: 'stale_scenes', sceneIds: stale.map((s) => s.id as string) };
  }

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

  // Snapshot narration AS-IS (honest: a stale override records the new text even
  // though the audio is older — spec 7.1).
  const content = {
    scenes: sceneRows.map((s) => ({
      id: s.id,
      position: s.position,
      narration: s.narration,
      duration_seconds: s.duration_seconds,
      audio_status: s.audio_status,
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

  // Prune to the last 20 revisions (spec 7.1).
  const { data: revs } = await supabase
    .from('script_revisions')
    .select('id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });
  const stale_revs = (revs ?? []).slice(MAX_REVISIONS).map((r) => r.id as string);
  if (stale_revs.length) await supabase.from('script_revisions').delete().in('id', stale_revs);

  // Idempotency: reuse only an in-flight render for this revision (so an explicit
  // re-render after completion still makes a new version — spec 7.2).
  const idempotencyKey = renderIdempotencyKey(revisionId);
  const { data: existing } = await supabase
    .from('renders')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing && RENDER_IN_FLIGHT.includes(existing.status as string)) {
    const { data: job } = await supabase
      .from('jobs')
      .select('id')
      .eq('render_id', existing.id as string)
      .maybeSingle();
    return { renderId: existing.id as string, jobId: (job?.id as string) ?? null, reused: true };
  }

  const createdRender = await supabase
    .from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: revisionId, status: 'queued', idempotency_key: idempotencyKey })
    .select('id')
    .single();
  if (createdRender.error || !createdRender.data) throw new Error(`render insert: ${createdRender.error?.message}`);
  const renderId = createdRender.data.id as string;

  const createdJob = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: renderId, type: 'render', status: 'queued' })
    .select('id')
    .single();
  if (createdJob.error || !createdJob.data) throw new Error(`job insert: ${createdJob.error?.message}`);
  const jobId = createdJob.data.id as string;

  await inngest.send({ name: 'render/start', data: { jobId, renderId, videoId } });
  return { renderId, jobId, reused: false };
}

// Polled/subscribed by the editor; returns a signed playback URL once complete.
export async function getRenderState(
  renderId: string,
): Promise<{ status: string; url: string | null; error: unknown }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('renders')
    .select('status, output_r2_key, error')
    .eq('id', renderId)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'render not found');
  let url: string | null = null;
  if (data.status === 'complete' && data.output_r2_key) {
    url = await signedGetUrl(data.output_r2_key as string, 60 * 60);
  }
  return {
    status: data.status as string,
    url,
    error: data.error ?? null,
  };
}
