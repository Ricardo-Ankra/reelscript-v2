import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelBrand } from '@/lib/channels/brand';
import { BrandEditor } from './BrandEditor';

// Channel brand editor (Phase 8 slice 2). RLS scopes the read; a miss (not found
// OR not owned) → 404. parseChannelBrand shows current EFFECTIVE values.
export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_kit, brand_voice, defaults')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  const initial = parseChannelBrand({
    name: channel.name as string,
    brand_kit: channel.brand_kit,
    brand_voice: channel.brand_voice,
    defaults: channel.defaults,
  });

  return (
    <div className="space-y-6">
      <Link href="/channels" className="text-sm underline opacity-70 hover:opacity-100">
        ← Channels
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">
          Brand identity — colours, font, motion, voice, and video defaults.
        </p>
      </div>
      <BrandEditor channelId={channel.id as string} initial={initial} />
    </div>
  );
}
