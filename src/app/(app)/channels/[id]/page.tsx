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
import { ChannelTabs } from './ChannelTabs';
import { deriveVideoStatus } from '@/lib/videos/status';

// Tabbed channel page. Videos (default) lists this channel's videos with a derived
// status + the sole "New video" entry; Settings holds the six brand/format editors.
// RLS scopes every read; a miss (not found OR not owned) → 404.
export default async function ChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const active: 'videos' | 'settings' = tab === 'settings' ? 'settings' : 'videos';

  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_kit, brand_voice, defaults, voice_tts')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  return (
    <div className="space-y-8">
      <Link href="/" className="text-sm underline opacity-70 hover:opacity-100">
        ← Home
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">
          Brand identity — colours, font, motion, voice, and video defaults.
        </p>
      </div>

      <ChannelTabs channelId={channel.id as string} active={active} />

      {active === 'videos' ? (
        <VideosTab channelId={channel.id as string} supabase={supabase} />
      ) : (
        <SettingsTab channel={channel} />
      )}
    </div>
  );
}

// --- Videos tab -------------------------------------------------------------

async function VideosTab({
  channelId,
  supabase,
}: {
  channelId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
}) {
  const { data: videoRows } = await supabase
    .from('videos')
    .select('id, title, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false });
  const videos = videoRows ?? [];
  const ids = videos.map((v) => v.id as string);

  // Latest script_generation job + latest render + scene presence per video (rows are
  // ordered desc; first seen per video_id is the latest). All RLS-scoped.
  const latestJob = new Map<string, string>();
  const latestRender = new Map<string, string>();
  const hasScenes = new Set<string>();
  if (ids.length) {
    const { data: jobRows } = await supabase
      .from('jobs')
      .select('video_id, status, created_at')
      .in('video_id', ids)
      .eq('type', 'script_generation')
      .order('created_at', { ascending: false });
    for (const j of jobRows ?? []) {
      const v = j.video_id as string;
      if (!latestJob.has(v)) latestJob.set(v, j.status as string);
    }
    const { data: renderRows } = await supabase
      .from('renders')
      .select('video_id, status, created_at')
      .in('video_id', ids)
      .order('created_at', { ascending: false });
    for (const r of renderRows ?? []) {
      const v = r.video_id as string;
      if (!latestRender.has(v)) latestRender.set(v, r.status as string);
    }
    const { data: sceneRows } = await supabase
      .from('scenes')
      .select('video_id')
      .in('video_id', ids);
    for (const s of sceneRows ?? []) hasScenes.add(s.video_id as string);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Videos</h2>
        <Link
          href={`/videos/new?channel=${channelId}`}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          + New video
        </Link>
      </div>

      {videos.length === 0 ? (
        <p className="text-sm opacity-70">No videos yet — create your first.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {videos.map((v) => {
            const vid = v.id as string;
            const { label } = deriveVideoStatus({
              scriptJobStatus: latestJob.get(vid) ?? null,
              hasScenes: hasScenes.has(vid),
              latestRenderStatus: latestRender.get(vid) ?? null,
            });
            const created = new Date(v.created_at as string).toLocaleDateString();
            return (
              <li key={vid}>
                <Link
                  href={`/videos/${vid}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{v.title as string}</span>
                  <span className="shrink-0 rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-70 dark:border-white/15">
                    {label}
                  </span>
                  <span className="shrink-0 opacity-50">{created}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- Settings tab (the existing six editors, unchanged) ---------------------

async function SettingsTab({
  channel,
}: {
  channel: { id: string; name: string; brand_kit: unknown; brand_voice: unknown; defaults: unknown; voice_tts: unknown };
}) {
  const id = channel.id as string;
  const supabase = await createClient();

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
      <BrandEditor channelId={id} initial={initial} />
      <hr className="border-black/10 dark:border-white/10" />
      <CaptionEmphasisEditor
        channelId={id}
        initial={emphasisInitial}
        fonts={theme.fonts}
        followColors={defaultToneColors(theme)}
      />
      <hr className="border-black/10 dark:border-white/10" />
      <LogosEditor channelId={id} initial={logos} initialPreviewUrls={logoPreviewUrls} />
      <hr className="border-black/10 dark:border-white/10" />
      <ResourcesEditor channelId={id} initial={resources} />
      <hr className="border-black/10 dark:border-white/10" />
      <VoiceEditor channelId={id} initial={voiceInitial} />
      <hr className="border-black/10 dark:border-white/10" />
      <VideoDefaultsEditor channelId={id} initial={videoDefaultsInitial} />
    </div>
  );
}
