import { inngest, type ScriptGenerateData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { anthropic } from '@/lib/ai/anthropic';
import { loadModelRouting } from '@/lib/ai/model-routing.server';
import { resolveProviderKey } from '@/lib/credentials/store';
import { deleteObject } from '@/lib/r2';
import {
  buildSystemPrompt,
  buildUserPrompt,
  createNdjsonAccumulator,
  parseSceneLine,
  sceneToRpcArgs,
} from '@/lib/ai/script-generation';

// The script spine (Phase 2): stream Opus as NDJSON (one scene per line), and
// for each valid line upsert the scene + its shots atomically via the
// upsert_scene_with_shots RPC. Rows reach the editor over Supabase Realtime as
// they're written. Malformed lines are counted, not fatal. The jobs row is the
// single source of truth for status; counts land in jobs.checkpoint.
//
// Opus 4.8 has no temperature knob — NDJSON reliability comes from the firm
// prompt, adaptive thinking kept ON (reasoning stays in thinking blocks, never
// the text stream), and per-line validation.
export const generateScript = inngest.createFunction(
  {
    id: 'generate-script',
    retries: 1,
    triggers: [{ event: 'script/generate' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
    // After retries are exhausted, mark the job failed so the editor stops
    // showing "generating" forever (Phase 1 lesson: surface failures).
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data as ScriptGenerateData;
      const admin = createAdminClient();
      await admin
        .from('jobs')
        .update({ status: 'failed', phase: 'failed', error: { message: error.message } })
        .eq('id', data.jobId);
    },
  },
  async ({ event, step }) => {
    const { jobId, videoId, accountId, prompt, config, brand, replace } =
      event.data as ScriptGenerateData;
    const admin = createAdminClient();

    await step.run('mark-running', async () => {
      const { error } = await admin
        .from('jobs')
        .update({ status: 'running', phase: 'generating' })
        .eq('id', jobId);
      if (error) throw new Error(`mark-running: ${error.message}`);
    });

    const models = await step.run('load-model-routing', () =>
      loadModelRouting(admin, accountId),
    );

    // Stream + insert in one durable step. On retry it re-streams; the RPC
    // upserts on natural keys so rows converge rather than duplicate.
    const counts = await step.run('stream-and-insert', async () => {
      // Clear-first (regenerate-in-place): wipe the video's existing scenes before
      // streaming new ones. INSIDE this step (not its own step.run) so an Inngest
      // retry of a partial stream re-deletes the partial scenes first. Guarded by
      // replace — initial generation skips this entirely.
      if (replace) {
        const { data: existing } = await admin.from('scenes').select('id').eq('video_id', videoId);
        const ids = (existing ?? []).map((r) => r.id as string);
        console.log(`[regenerate] clearing ${ids.length} scenes for video ${videoId}`);
        for (const id of ids) {
          try {
            await deleteObject(`audio/${id}.mp3`);
          } catch (e) {
            console.warn(`[regenerate] audio delete failed for ${id}: ${(e as Error).message}`);
          }
        }
        const { error: delErr } = await admin.from('scenes').delete().eq('video_id', videoId);
        if (delErr) throw new Error(`clear scenes: ${delErr.message}`);
      }

      let written = 0;
      let skipped = 0;
      const acc = createNdjsonAccumulator();

      const handle = async (line: string) => {
        const scene = parseSceneLine(line);
        if (!scene) {
          skipped++;
          return;
        }
        const { error } = await admin.rpc(
          'upsert_scene_with_shots',
          sceneToRpcArgs(scene, accountId, videoId),
        );
        if (error) throw new Error(`upsert scene ${scene.position}: ${error.message}`);
        written++;
      };

      const anthropicKey = await resolveProviderKey(admin, accountId, 'anthropic');
      const stream = anthropic(anthropicKey).messages.stream({
        model: models.script_generation,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(prompt, brand, config) }],
      });

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          for (const line of acc.push(ev.delta.text)) await handle(line);
        }
      }
      for (const line of acc.flush()) await handle(line);

      return { written, skipped };
    });

    await step.run('mark-complete', async () => {
      const { error } = await admin
        .from('jobs')
        .update({
          status: 'complete',
          phase: 'done',
          checkpoint: { scenesWritten: counts.written, skippedLines: counts.skipped },
        })
        .eq('id', jobId);
      if (error) throw new Error(`mark-complete: ${error.message}`);
    });

    return { jobId, ...counts };
  },
);
