import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelCreateOptions } from '@/lib/videos/create-settings';
import { NewVideoForm } from './NewVideoForm';

// Channel-scoped New Video setup screen. The channel is fixed by ?channel=; a
// missing/unknown/not-owned id (RLS miss) redirects Home. Options prefill from the
// channel's full stored defaults; every option is overridable per video before
// generation.
export default async function NewVideoPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>;
}) {
  const { channel: channelId } = await searchParams;
  if (!channelId) redirect('/');

  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, defaults')
    .eq('id', channelId)
    .maybeSingle();
  if (!channel) redirect('/');

  const initial = parseChannelCreateOptions(channel.defaults);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New video</h1>
        <p className="text-sm opacity-70">{channel.name as string}</p>
      </div>
      <NewVideoForm channelId={channel.id as string} initial={initial} />
    </div>
  );
}
