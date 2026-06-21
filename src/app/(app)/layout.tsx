import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signout } from '../(auth)/actions';

// Auth-gated application shell. Every route under (app) requires a session;
// the middleware redirects unauthenticated requests, and this is the
// belt-and-braces server-side check.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
        <nav className="flex items-center gap-4">
          <Link href="/dashboard" className="font-semibold">
            Reelscript
          </Link>
          <Link href="/primitives" className="text-sm opacity-70 hover:opacity-100">
            Primitives
          </Link>
          <Link href="/channels" className="text-sm opacity-70 hover:opacity-100">
            Channels
          </Link>
          <Link href="/costs" className="text-sm opacity-70 hover:opacity-100">
            Costs
          </Link>
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Settings
          </Link>
        </nav>
        <div className="flex items-center gap-4 text-sm">
          <span className="opacity-70">{user.email}</span>
          <form action={signout}>
            <button type="submit" className="underline">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
