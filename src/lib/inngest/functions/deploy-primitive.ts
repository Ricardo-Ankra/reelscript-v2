import { inngest, type PrimitiveDeployData } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { deployLiveSite } from '@/lib/primitives/bundle';

// primitive/deploy (Phase 7, spec 9.7): re-bundle the Remotion site so the account's
// authored primitives reach Lambda. Re-bundles ALL active primitives; on success marks
// every active primitive deployed_version = version (so compose offers them). On failure
// (bundle_deploy, spec 15.1) the live site is unchanged (rollback is implicit) and the
// primitive stays validated-but-not-deployed — surfaced via the job.
export const deployPrimitive = inngest.createFunction(
  {
    id: 'deploy-primitive',
    retries: 1,
    triggers: [{ event: 'primitive/deploy' }],
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data as PrimitiveDeployData;
      const admin = createAdminClient();
      await admin
        .from('jobs')
        .update({ status: 'failed', phase: 'failed', failure_class: 'bundle_deploy', error: { message: error.message } })
        .eq('id', data.jobId);
    },
  },
  async ({ event, step }) => {
    const { jobId, accountId } = event.data as PrimitiveDeployData;
    const admin = createAdminClient();

    await step.run('mark-running', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'bundling' }).eq('id', jobId);
    });

    // Load every active primitive's code (the full set baked into the bundle).
    const actives = await step.run('load-actives', async () => {
      const { data, error } = await admin
        .from('primitives')
        .select('id, name, code, version')
        .eq('account_id', accountId)
        .eq('status', 'active');
      if (error) throw new Error(`load primitives: ${error.message}`);
      return (data ?? []).map((p) => ({ id: p.id as string, name: p.name as string, code: p.code as string, version: p.version as number }));
    });

    // Re-bundle + deploy over the live site. NB: not wrapped in step.run because the
    // bundler writes the temp workspace and must complete in one pass (no memoised resume).
    await deployLiveSite(actives.map((p) => ({ name: p.name, code: p.code })));

    await step.run('mark-deployed', async () => {
      // Each active primitive is now in the live bundle at its current version.
      for (const p of actives) {
        await admin.from('primitives').update({ deployed_version: p.version }).eq('id', p.id);
      }
      await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
    });

    return { jobId, deployed: actives.length };
  },
);
