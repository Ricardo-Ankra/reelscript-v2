import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

// Server-side Supabase client (Server Components, Server Actions, Route
// Handlers). Reads/writes the session from the request cookies. Still the anon
// key — RLS applies — so this never bypasses account isolation. The service-role
// client (RLS bypass) is a separate, server-only concern introduced for the
// Inngest worker in a later phase.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where setting cookies is not
            // allowed. Safe to ignore: the middleware refreshes the session.
          }
        },
      },
    },
  );
}
