import { Inngest } from 'inngest';
import type { VideoConfig, BrandContext } from '@/lib/ai/script-generation';

// render/start carries the render row id and the R2 key of its stored spec; the
// worker signs the spec URL at render start (spec 10.3).
export type RenderStartData = { renderId: string; specKey: string };

// script/generate carries everything the worker needs to generate without
// re-reading rows: the job to update, the target video + account, the user
// prompt, and the resolved config + brand (config sourced from video.settings).
export type ScriptGenerateData = {
  jobId: string;
  videoId: string;
  accountId: string;
  prompt: string;
  config: VideoConfig;
  brand: BrandContext;
};

export const inngest = new Inngest({ id: 'reelscript' });
