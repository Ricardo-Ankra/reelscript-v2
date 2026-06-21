import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { totalCost, sumByVideo, formatUsd, type CostEvent } from '@/lib/costs/aggregate';

// Account cost rollup (Phase 8). RLS scopes both reads to the caller's account.
// The grand total counts every cost event (including any with a null video_id);
// the per-video rows cover videos that still exist.
export default async function CostsPage() {
  const supabase = await createClient();

  const { data: videos } = await supabase
    .from('videos')
    .select('id, title, created_at')
    .order('created_at', { ascending: false });

  const { data: costRows } = await supabase.from('cost_events').select('video_id, cost_usd');
  const events: CostEvent[] = (costRows ?? []).map((r) => ({
    videoId: (r.video_id as string | null) ?? null,
    renderId: null,
    operation: '',
    costUsd: Number(r.cost_usd ?? 0),
  }));

  const byVideo = sumByVideo(events);
  const grand = totalCost(events);
  const rows = videos ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="text-xs opacity-60">Estimated — from recorded usage.</p>
        </div>
        <span className="text-lg font-medium">{formatUsd(grand)} total</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm opacity-70">No videos yet.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {rows.map((v) => (
            <li key={v.id as string} className="flex items-baseline justify-between px-4 py-3">
              <Link href={`/videos/${v.id}`} className="text-sm underline">
                {(v.title as string | null) ?? 'Untitled'}
              </Link>
              <span className="text-sm">{formatUsd(byVideo.get(v.id as string) ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
