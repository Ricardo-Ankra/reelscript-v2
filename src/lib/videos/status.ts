// Pure derivation of a video's display status from its latest job/render rows
// (Phase 8 — navigation overhaul). No react/server/network. The string sets are
// copied verbatim from the render/job vocabulary (render-actions.ts in-flight phases;
// jobs.status = queued|running|complete|failed). Total: always returns a status.

export type VideoStatus =
  | 'generating'
  | 'draft'
  | 'rendering'
  | 'ready'
  | 'script_failed'
  | 'render_failed';

export interface VideoStatusInputs {
  scriptJobStatus?: string | null; // latest script_generation job status
  hasScenes: boolean;
  latestRenderStatus?: string | null; // latest render status, if any
}

const RENDER_IN_FLIGHT = ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding'];

const LABELS: Record<VideoStatus, string> = {
  generating: 'Generating script',
  draft: 'Draft',
  rendering: 'Rendering',
  ready: 'Ready',
  script_failed: 'Script failed',
  render_failed: 'Render failed',
};

export function deriveVideoStatus(i: VideoStatusInputs): { status: VideoStatus; label: string } {
  const render = i.latestRenderStatus ?? null;
  let status: VideoStatus;
  if (render === 'complete') status = 'ready';
  else if (render && RENDER_IN_FLIGHT.includes(render)) status = 'rendering';
  else if (render === 'failed') status = 'render_failed';
  else if (i.scriptJobStatus === 'failed') status = 'script_failed';
  else if ((i.scriptJobStatus === 'queued' || i.scriptJobStatus === 'running') && !i.hasScenes) status = 'generating';
  else if (i.hasScenes) status = 'draft';
  else status = 'generating';
  return { status, label: LABELS[status] };
}
