import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { serverEnv } from '../env.server';

// Secret-key client: bypasses RLS (the secret key has BYPASSRLS). Server-only.
// Used by the Inngest worker, which has no user session, to write render/job
// rows. Never import this into client code.
export function createAdminClient() {
  return createClient(serverEnv.supabaseUrl, serverEnv.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
