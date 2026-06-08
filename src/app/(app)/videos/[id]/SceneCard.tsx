'use client';

export type Shot = {
  id: string;
  position: number;
  description: string;
  source: string;
  stock_query: string | null;
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// One card == one scene. The card is the autosave boundary and (in Phase 4) the
// audio-staleness boundary — UI unit and data unit are the same. Narration is
// editable; shots are read-only ("the AI's plan"). The status corner and action
// slot are laid out now (empty) so Phase 3 (regenerate) and Phase 4 (audio
// status) drop in without restructuring the card.
export function SceneCard({
  position,
  narration,
  shots,
  saveState,
  onChange,
}: {
  position: number;
  narration: string;
  shots: Shot[];
  saveState: SaveState;
  onChange: (text: string) => void;
}) {
  return (
    <div className="relative rounded-xl border border-black/15 bg-black/[0.015] p-4 shadow-sm dark:border-white/15 dark:bg-white/[0.02]">
      {/* Header: scene number + reserved status corner (Phase 4 audio status) */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide opacity-50">
          Scene {position}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] opacity-50">{saveLabel(saveState)}</span>
          {/* reserved: audio-status indicator slot */}
          <span aria-hidden className="h-2 w-2 rounded-full bg-black/10 dark:bg-white/10" />
        </div>
      </div>

      {/* Editable narration — the scene's source of truth */}
      <textarea
        value={narration}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="w-full resize-y rounded-md border border-transparent bg-transparent p-2 text-sm leading-relaxed outline-none focus:border-black/20 dark:focus:border-white/20"
      />

      {/* Shots — read-only, muted, clearly subordinate (editable in Phase 3) */}
      {shots.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 dark:border-white/5">
          {shots
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((shot) => (
              <li key={shot.id} className="flex items-start gap-2 text-xs opacity-60">
                <span className="opacity-70">▸</span>
                <span className="flex-1">{shot.description}</span>
                <span className="rounded-full border border-black/10 px-1.5 py-px text-[10px] dark:border-white/10">
                  {shot.source}
                </span>
              </li>
            ))}
        </ul>
      )}

      {/* reserved: per-card action slot (Phase 3 regenerate). Empty in Phase 2. */}
    </div>
  );
}

function saveLabel(s: SaveState): string {
  switch (s) {
    case 'saving':
      return 'saving…';
    case 'saved':
      return 'saved ✓';
    case 'error':
      return 'save failed';
    default:
      return '';
  }
}
