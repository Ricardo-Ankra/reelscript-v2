'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { putObject, signedGetUrl } from '@/lib/r2';
import { inngest } from '@/lib/inngest/client';
import { specIdempotencyKey } from '@/lib/composition/idempotency';
import type { CompositionSpec } from '@/lib/composition/spec';
import sampleSpecJson from '@/lib/composition/sample-spec.json';

const sampleSpec = sampleSpecJson as unknown as CompositionSpec;

const SEED_CHANNEL = 'Phase 1 Sandbox';
const SEED_VIDEO = 'Render spine proof';

// Starts a render of the hand-written sample spec under the signed-in user's
// account. Phase 1 seeds the minimal channel/video/script_revision needed to
// satisfy the renders FKs (throwaway scaffolding, not real content), stores the
// spec in R2, creates the render row, and emits render/start. Idempotent on the
// spec hash (spec 10.5): the same spec returns the existing render.
export async function startSampleRender(): Promise<{ renderId: string; reused: boolean }> {
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

  // Seed channel (carries the baked theme as its brand_kit for realism).
  let channelId: string;
  const existingChannel = await supabase
    .from('channels')
    .select('id')
    .eq('name', SEED_CHANNEL)
    .maybeSingle();
  if (existingChannel.data) {
    channelId = existingChannel.data.id as string;
  } else {
    const ins = await supabase
      .from('channels')
      .insert({ account_id: accountId, name: SEED_CHANNEL, brand_kit: sampleSpec.theme })
      .select('id')
      .single();
    if (ins.error || !ins.data) throw new Error(`seed channel: ${ins.error?.message}`);
    channelId = ins.data.id as string;
  }

  // Seed video.
  let videoId: string;
  const existingVideo = await supabase
    .from('videos')
    .select('id')
    .eq('channel_id', channelId)
    .eq('title', SEED_VIDEO)
    .maybeSingle();
  if (existingVideo.data) {
    videoId = existingVideo.data.id as string;
  } else {
    const ins = await supabase
      .from('videos')
      .insert({ account_id: accountId, channel_id: channelId, title: SEED_VIDEO })
      .select('id')
      .single();
    if (ins.error || !ins.data) throw new Error(`seed video: ${ins.error?.message}`);
    videoId = ins.data.id as string;
  }

  // Seed a placeholder script revision (renders.script_revision_id is NOT NULL).
  let revisionId: string;
  const existingRev = await supabase
    .from('script_revisions')
    .select('id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRev.data) {
    revisionId = existingRev.data.id as string;
  } else {
    const ins = await supabase
      .from('script_revisions')
      .insert({
        account_id: accountId,
        video_id: videoId,
        content: { placeholder: true },
        edit_summary: 'Phase 1 placeholder',
      })
      .select('id')
      .single();
    if (ins.error || !ins.data) throw new Error(`seed revision: ${ins.error?.message}`);
    revisionId = ins.data.id as string;
  }

  const idempotencyKey = specIdempotencyKey(sampleSpec);

  // Reuse an existing (non-failed) render for this spec.
  const existingRender = await supabase
    .from('renders')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingRender.data && existingRender.data.status !== 'failed') {
    return { renderId: existingRender.data.id as string, reused: true };
  }

  // Store the spec in R2; the worker signs its URL at render start.
  const specKey = `specs/${idempotencyKey}.json`;
  await putObject(specKey, JSON.stringify(sampleSpec), 'application/json');

  const created = await supabase
    .from('renders')
    .insert({
      account_id: accountId,
      video_id: videoId,
      script_revision_id: revisionId,
      composition_spec_r2_key: specKey,
      status: 'queued',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();
  if (created.error || !created.data) throw new Error(`render insert: ${created.error?.message}`);
  const renderId = created.data.id as string;

  await inngest.send({ name: 'render/sample', data: { renderId, specKey } });

  revalidatePath('/render');
  return { renderId, reused: false };
}

// Polled by the client until the render completes; returns a signed playback URL
// once the MP4 is in R2.
export async function getRenderState(
  renderId: string,
): Promise<{ status: string; url: string | null; error: string | null }> {
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
    error: data.error ? JSON.stringify(data.error) : null,
  };
}
