'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { anthropic, PRIMITIVE_DRAFT_MODEL } from '@/lib/ai/anthropic';
import { buildDraftSystemPrompt, buildDraftUserPrompt, parseDraft } from '@/lib/ai/primitive-draft';
import { runGates, type GateResult } from '@/lib/primitives/gates';
import { assertSchemaEvolution, type PropSchema, type PrimitiveMeta } from '@/lib/primitives/contract';

// Phase 7 primitive authoring surface (spec 9). draftPrimitive (Opus + the skill) and
// runPrimitiveGates (lint static + compile/smoke on the isolated Lambda) feed the studio;
// savePrimitive re-gates server-side, enforces schema evolution, and emits primitive/deploy.

async function requireAccountId(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data: account, error } = await supabase.from('accounts').select('id').single();
  if (error || !account) throw new Error(`No account: ${error?.message ?? 'not found'}`);
  return account.id as string;
}

export interface DraftPrimitiveResult {
  code: string;
  proposedSchema: PropSchema;
  meta: PrimitiveMeta;
}

// Draft or refine a primitive from a natural-language instruction. Nothing is saved or
// trusted — the gates gate (spec 9.5).
export async function draftPrimitive(input: {
  instruction: string;
  currentCode?: string;
  currentSchema?: PropSchema;
  feedback?: string;
}): Promise<DraftPrimitiveResult | { error: string }> {
  const msg = await anthropic().messages.create({
    model: PRIMITIVE_DRAFT_MODEL,
    max_tokens: 16000,
    system: buildDraftSystemPrompt(),
    messages: [{ role: 'user', content: buildDraftUserPrompt(input) }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const draft = parseDraft(text);
  if (!draft) return { error: 'The draft did not parse as a primitive. Try rephrasing the request.' };
  return draft;
}

export interface GatesResult {
  passed: boolean;
  gates: GateResult[];
  frameDataUrl?: string; // the smoke frame, inlined for the preview
}

// Run the authoring gates and inline the smoke frame as a data URL for the preview.
export async function runPrimitiveGates(input: { code: string; propSchema: PropSchema }): Promise<GatesResult> {
  const out = await runGates(input);
  let frameDataUrl: string | undefined;
  if (out.frameUrl) {
    try {
      const res = await fetch(out.frameUrl);
      if (res.ok) frameDataUrl = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch {
      /* preview is best-effort */
    }
  }
  return { passed: out.passed, gates: out.gates, frameDataUrl };
}

// Persist a gated primitive: RE-RUN the gates server-side (don't trust the client),
// enforce assertSchemaEvolution on an edit, bump the version, and emit primitive/deploy
// to re-bundle the site (spec 9.3 / 9.7).
export async function savePrimitive(input: {
  primitiveId?: string;
  code: string;
  propSchema: PropSchema;
  meta: PrimitiveMeta;
}): Promise<{ primitiveId: string; version: number; deployJobId: string } | { error: string }> {
  const supabase = await createClient();
  const accountId = await requireAccountId(supabase);

  const gates = await runGates({ code: input.code, propSchema: input.propSchema });
  if (!gates.passed) return { error: 'All gates must pass before saving.' };

  let primitiveId = input.primitiveId;
  let version = 1;

  if (primitiveId) {
    const { data: existing } = await supabase.from('primitives').select('prop_schema, version').eq('id', primitiveId).single();
    if (!existing) return { error: 'Primitive not found.' };
    try {
      assertSchemaEvolution(existing.prop_schema as PropSchema, input.propSchema);
    } catch (e) {
      return { error: (e as Error).message };
    }
    version = (existing.version as number) + 1;
    const { error } = await supabase
      .from('primitives')
      .update({ name: input.meta.name, description: input.meta.description, code: input.code, prop_schema: input.propSchema, version, status: 'active' })
      .eq('id', primitiveId);
    if (error) return { error: error.message };
  } else {
    const { data, error } = await supabase
      .from('primitives')
      .insert({ account_id: accountId, name: input.meta.name, description: input.meta.description, code: input.code, prop_schema: input.propSchema, version: 1, status: 'active' })
      .select('id')
      .single();
    if (error || !data) return { error: error?.message ?? 'Insert failed (is the name already taken?).' };
    primitiveId = data.id as string;
  }

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ account_id: accountId, type: 'primitive_deploy', status: 'queued' })
    .select('id')
    .single();
  if (jobErr || !job) return { error: `deploy job: ${jobErr?.message}` };
  const deployJobId = job.id as string;

  await inngest.send({ name: 'primitive/deploy', data: { jobId: deployJobId, accountId, primitiveId, version } });
  return { primitiveId, version, deployJobId };
}

// Archive (retire from new videos) / restore / delete (only at zero usage) — spec 9.8.
export async function setPrimitiveStatus(input: {
  primitiveId: string;
  action: 'archive' | 'restore' | 'delete';
}): Promise<{ ok: true } | { blocked: 'in_use'; usageCount: number } | { error: string }> {
  const supabase = await createClient();
  if (input.action === 'delete') {
    const { count } = await supabase
      .from('primitive_usages')
      .select('*', { count: 'exact', head: true })
      .eq('primitive_id', input.primitiveId);
    if ((count ?? 0) > 0) return { blocked: 'in_use', usageCount: count ?? 0 };
    const { error } = await supabase.from('primitives').delete().eq('id', input.primitiveId);
    return error ? { error: error.message } : { ok: true };
  }
  const { error } = await supabase
    .from('primitives')
    .update({ status: input.action === 'archive' ? 'archived' : 'active' })
    .eq('id', input.primitiveId);
  return error ? { error: error.message } : { ok: true };
}

// Polled by the studio after Save to show the re-bundle finishing.
export async function getDeployState(jobId: string): Promise<{ status: string }> {
  const supabase = await createClient();
  const { data } = await supabase.from('jobs').select('status').eq('id', jobId).single();
  return { status: (data?.status as string) ?? 'unknown' };
}
