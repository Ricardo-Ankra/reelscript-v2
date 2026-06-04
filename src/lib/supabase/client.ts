import { createBrowserClient } from '@supabase/ssr';
import { env } from '@/lib/env';

// Browser-side Supabase client. Uses the anon key and is always subject to RLS:
// every read/write it performs is scoped to the signed-in user's account by the
// policies in the schema. This is Tier 1 of the API surface (docs/api).
export function createClient() {
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
