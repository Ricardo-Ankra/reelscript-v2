import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewChannelForm } from './NewChannelForm';

// Lists the account's channels (RLS-scoped) with inline create. Each row links
// to the detail page (the brand editor is slice 2; today it's a shell). Order
// is created_at desc, id desc so "most recent" is deterministic.
export default async function ChannelsPage() {
  const supabase = await createClient();
  const { data: channels, error } = await supabase
    .from('channels')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  const list = channels ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="text-sm opacity-70">
          Each channel carries its own brand. Pick one when you create a video.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <NewChannelForm />
      </section>

      <section className="space-y-2">
        {error && (
          <p className="text-sm text-red-600">Could not load channels: {error.message}</p>
        )}
        {list.length === 0 ? (
          <p className="text-sm opacity-70">No channels yet. Create your first one above.</p>
        ) : (
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {list.map((c) => (
              <li key={c.id as string}>
                <Link
                  href={`/channels/${c.id}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="font-medium">{c.name as string}</span>
                  <span className="opacity-50">{c.status as string}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
