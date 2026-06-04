import { z } from 'zod';

// Public, browser-safe configuration. These are the only env vars the app shell
// needs in Phase 0. NEXT_PUBLIC_* values must be referenced statically (not via
// a dynamic key) so Next can inline them into the client bundle at build time.
//
// Uses Supabase's newer API keys: the publishable key (sb_publishable_…) sits
// where the legacy anon key did. Server-only secrets (SUPABASE_SECRET_KEY plus
// R2/AWS/Inngest/provider keys) are deliberately NOT imported here — they belong
// to server-only code added in later phases and must never reach the client.
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

const parsed = schema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(
    `Invalid environment configuration:\n${issues}\n` +
      `Copy .env.example to .env.local and fill in the values.`,
  );
}

export const env = parsed.data;
