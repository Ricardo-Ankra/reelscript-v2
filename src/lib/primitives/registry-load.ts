import 'server-only';
import type { createAdminClient } from '../supabase/admin';
import { STARTER_REGISTRY, type StarterRegistry, type StarterPrimitive } from './starter';
import type { PropSchema } from './contract';

// Build the COMPOSE registry (Phase 7): the starter set plus the account's authored
// primitives that are active AND deployed (in the live bundle). Schemas only — no code
// execution. `compose.ts`/`gate1.ts` read this so the AI sees the new bricks and Gate 1
// validates against their schemas; the render bundle carries the matching code (9.7).
//
// A primitive is offered only when `deployed_version = version` — a save whose deploy
// failed stays validated-but-not-deployed and is NOT offered (spec 15.1 bundle_deploy).
export async function loadComposeRegistry(
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
): Promise<StarterRegistry> {
  const { data } = await admin
    .from('primitives')
    .select('name, description, version, prop_schema, deployed_version')
    .eq('account_id', accountId)
    .eq('status', 'active');

  const db: Record<string, StarterPrimitive> = {};
  for (const row of data ?? []) {
    const name = row.name as string;
    if (STARTER_REGISTRY[name]) continue; // never shadow a starter
    if (row.deployed_version == null || row.deployed_version !== row.version) continue; // not in the live bundle
    db[name] = {
      propSchema: (row.prop_schema as PropSchema) ?? [],
      meta: { name, description: (row.description as string) ?? '', version: (row.version as number) ?? 1 },
    };
  }
  return { ...STARTER_REGISTRY, ...db };
}
