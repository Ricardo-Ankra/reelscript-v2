import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelBrand } from '@/lib/channels/brand';
import { parseCaptionEmphasis, defaultToneColors } from '@/lib/channels/caption-emphasis';
import { parseVoiceTts } from '@/lib/channels/voice';
import { VoiceEditor } from './VoiceEditor';
import { parseVideoDefaults } from '@/lib/channels/video-defaults';
import { VideoDefaultsEditor } from './VideoDefaultsEditor';
import { bakeTheme } from '@/lib/composition/theme';
import { BrandEditor } from './BrandEditor';
import { CaptionEmphasisEditor } from './CaptionEmphasisEditor';
import { signedGetUrl } from '@/lib/r2';
import { sanitizeLogos, type LogoSlot } from '@/lib/channels/logos';
import { LogosEditor } from './LogosEditor';
import { ResourcesEditor, type ResourceItem } from './ResourcesEditor';

// Channel brand + caption-emphasis editors (Phase 8 slices 2–3). RLS scopes the
// read; a miss (not found OR not owned) → 404. The parsers show current EFFECTIVE
// values; the two sections save independently.
export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_kit, brand_voice, defaults, voice_tts')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  const initial = parseChannelBrand({
    name: channel.name as string,
    brand_kit: channel.brand_kit,
    brand_voice: channel.brand_voice,
    defaults: channel.defaults,
  });

  const theme = bakeTheme(channel.brand_kit as never);
  const emphasisInitial = parseCaptionEmphasis(channel.brand_kit, theme);

  const logos = sanitizeLogos((channel.brand_kit as { logos?: unknown } | null)?.logos);
  const logoPreviewUrls: Partial<Record<LogoSlot, string>> = {};
  for (const [slot, key] of Object.entries(logos)) {
    logoPreviewUrls[slot as LogoSlot] = await signedGetUrl(key, 60 * 60);
  }

  const voiceInitial = parseVoiceTts(channel.voice_tts);
  const videoDefaultsInitial = parseVideoDefaults(channel.defaults);

  const { data: resourceRows } = await supabase
    .from('channel_resources')
    .select('id, kind, r2_key, original_filename, description, tags, created_at')
    .eq('channel_id', id)
    .order('created_at', { ascending: false });
  const resources: ResourceItem[] = await Promise.all(
    (resourceRows ?? []).map(async (r) => ({
      id: r.id as string,
      kind: (r.kind as string) === 'video' ? ('video' as const) : ('image' as const),
      description: (r.description as string | null) ?? '',
      tags: (r.tags as string[] | null) ?? [],
      filename: (r.original_filename as string | null) ?? '',
      previewUrl: r.r2_key ? await signedGetUrl(r.r2_key as string, 60 * 60) : null,
    })),
  );

  return (
    <div className="space-y-8">
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

      <hr className="border-black/10 dark:border-white/10" />

      <CaptionEmphasisEditor
        channelId={channel.id as string}
        initial={emphasisInitial}
        fonts={theme.fonts}
        followColors={defaultToneColors(theme)}
      />

      <hr className="border-black/10 dark:border-white/10" />

      <LogosEditor channelId={channel.id as string} initial={logos} initialPreviewUrls={logoPreviewUrls} />

      <hr className="border-black/10 dark:border-white/10" />

      <ResourcesEditor channelId={channel.id as string} initial={resources} />

      <hr className="border-black/10 dark:border-white/10" />

      <VoiceEditor channelId={channel.id as string} initial={voiceInitial} />

      <hr className="border-black/10 dark:border-white/10" />

      <VideoDefaultsEditor channelId={channel.id as string} initial={videoDefaultsInitial} />
    </div>
  );
}
