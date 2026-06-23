import { type ParsedRenderError, phaseLabel } from '@/lib/errors/render-error';

// Presentational card for a normalized composition/render error: a phase badge,
// the message, any QA issues as a list, and the smoke frame inline when present.
// Degrades gracefully — each section renders only when its data is present.
export function RenderErrorCard({ error }: { error: ParsedRenderError }) {
  const label = phaseLabel(error.phase);
  return (
    <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
      <div className="flex flex-wrap items-center gap-2">
        {label && (
          <span className="shrink-0 rounded-full border border-red-500/40 px-2 py-0.5 text-xs font-medium">
            {label}
          </span>
        )}
        <span className="font-medium">{error.message}</span>
      </div>
      {error.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {error.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {error.frameUrl && (
        <a href={error.frameUrl} target="_blank" rel="noreferrer" className="block w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={error.frameUrl}
            alt="Frame that failed QA"
            className="max-h-48 w-auto rounded-md border border-red-500/30"
          />
        </a>
      )}
    </div>
  );
}
