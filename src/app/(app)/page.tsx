import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewChannelForm } from './channels/NewChannelForm';

// Home = the channels surface. Channel cards (each → its Videos tab) + inline create.
// Video creation starts from inside a channel (its Videos tab), not here.
export default async function HomePage() {
  const supabase = await createClient();
  const { data: channels } = await supabase
    .from('channels')
    .select('id, name')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  const list = channels ?? [];

  const ids = list.map((c) => c.id as string);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: vids } = await supabase.from('videos').select('channel_id').in('channel_id', ids);
    for (const v of vids ?? []) {
      const c = v.channel_id as string;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="text-sm opacity-70">
          Each channel carries its own brand. Open one to see its videos.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <NewChannelForm />
      </section>

      {list.length === 0 ? (
        <p className="text-sm opacity-70">No channels yet. Create your first one above.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const n = counts.get(c.id as string) ?? 0;
            return (
              <li key={c.id as string}>
                <Link
                  href={`/channels/${c.id}`}
                  className="block rounded-lg border border-black/10 p-4 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                >
                  <div className="font-medium">{c.name as string}</div>
                  <div className="text-sm opacity-60">
                    {n} video{n === 1 ? '' : 's'}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
