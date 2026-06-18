import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseModelRouting, type ModelTask } from './model-routing';

// Load the account's task→model map once per job/request. Takes a client so it
// works from both the Inngest admin client and the RLS server client. Any read
// error → the code defaults (resolution must never block a render).
export async function loadModelRouting(
  client: SupabaseClient,
  accountId: string,
): Promise<Record<ModelTask, string>> {
  try {
    const { data } = await client
      .from('accounts')
      .select('model_routing')
      .eq('id', accountId)
      .maybeSingle();
    return parseModelRouting(data?.model_routing);
  } catch {
    return parseModelRouting({});
  }
}
