import { totalCost, costByRender, formatUsd, type CostEvent } from '@/lib/costs/aggregate';

// Presentational server component (display-only): the video's lifetime cost and a
// per-render breakdown itemized by operation, plus a "Script & voice" bucket for
// the events not tied to a render (script generation + voice synthesis).
export function VideoCostsPanel({ events }: { events: CostEvent[] }) {
  const lifetime = totalCost(events);
  const renders = costByRender(events);

  return (
    <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Costs</h2>
        <span className="text-sm font-medium">{formatUsd(lifetime)} lifetime</span>
      </div>
      <p className="text-xs opacity-60">Estimated — from recorded usage.</p>

      {events.length === 0 ? (
        <p className="text-sm opacity-70">No costs recorded yet.</p>
      ) : (
        <div className="space-y-3">
          {renders.map((r) => (
            <div key={r.renderId ?? 'pre-render'} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm font-medium">
                <span>{r.renderId === null ? 'Script & voice' : `Render ${r.renderId.slice(0, 8)}`}</span>
                <span>{formatUsd(r.costUsd)}</span>
              </div>
              <ul className="space-y-0.5 pl-3 text-sm opacity-80">
                {r.byOperation.map((op) => (
                  <li key={op.operation} className="flex items-baseline justify-between">
                    <span>{op.operation}</span>
                    <span>{formatUsd(op.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
