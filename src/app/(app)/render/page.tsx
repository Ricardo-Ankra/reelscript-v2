import { createClient } from '@/lib/supabase/server';
import { RenderPanel } from './RenderPanel';

// Phase 1 render-spine proof: trigger a render of the hand-written spec, watch it
// progress, and play the resulting MP4 from a signed R2 URL.
export default async function RenderPage() {
  const supabase = await createClient();
  const { data: renders } = await supabase
    .from('renders')
    .select('id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Render spine</h1>
        <p className="text-sm opacity-70">
          Phase 1 — a hand-written composition spec rendered on Lambda, played here
          from R2.
        </p>
      </div>

      <RenderPanel />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Recent renders</h2>
        {renders && renders.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {renders.map((r) => (
              <li key={r.id} className="flex gap-3">
                <span className="font-mono opacity-40">{r.id.slice(0, 8)}</span>
                <span className="font-mono">{r.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm opacity-60">No renders yet.</p>
        )}
      </section>
    </div>
  );
}
