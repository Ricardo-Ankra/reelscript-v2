import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { PromptBox } from './PromptBox';

// Phase 0 stub dashboard. Its job is to prove the spine works end-to-end:
// the session resolves, and a Tier 1 RLS-scoped read returns this user's own
// account row (provisioned by the handle_new_user trigger at signup).
export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: account, error } = await supabase
    .from('accounts')
    .select('id, name, created_at')
    .maybeSingle();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New video</h1>
        <p className="text-sm opacity-70">
          Type a prompt and watch the script generate scene by scene.
        </p>
        <Link href="/render" className="mt-2 inline-block text-sm underline">
          Go to the render spine →
        </Link>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <PromptBox />
      </section>

      <section className="space-y-2 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
        <h2 className="font-medium">Session</h2>
        <p>
          <span className="opacity-60">User ID:</span> {user?.id}
        </p>
        <p>
          <span className="opacity-60">Email:</span> {user?.email}
        </p>
      </section>

      <section className="space-y-2 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
        <h2 className="font-medium">Account (RLS-scoped read)</h2>
        {account ? (
          <>
            <p>
              <span className="opacity-60">Account ID:</span> {account.id}
            </p>
            <p>
              <span className="opacity-60">Name:</span> {account.name}
            </p>
          </>
        ) : (
          <p className="text-amber-600">
            No account row visible{error ? `: ${error.message}` : ''}. The
            handle_new_user trigger should have created one at signup.
          </p>
        )}
      </section>
    </div>
  );
}
