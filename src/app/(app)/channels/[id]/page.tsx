import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Channel detail SHELL. Slice 2 fills this with the brand-identity editor
// (colors, font, motion, brand-voice tone, defaults). For now: the name plus
// a placeholder. RLS scopes the read; a miss (not found OR not owned) → 404.
export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  return (
    <div className="space-y-6">
      <Link href="/channels" className="text-sm underline opacity-70 hover:opacity-100">
        ← Channels
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">Brand settings — coming next.</p>
      </div>
    </div>
  );
}
