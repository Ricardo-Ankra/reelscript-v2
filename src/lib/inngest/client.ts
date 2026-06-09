import { Inngest } from 'inngest';
import type { VideoConfig, BrandContext } from '@/lib/ai/script-generation';
import type { VoiceSettings } from '@/lib/voice/alignment';

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

// voice/synthesize carries the job to update, the target video + account, the
// exact scenes to synthesize (resolved server-side: stale + not_synthesized when
// the user picks "all"), and the resolved voice so the worker need not re-read the
// channel. Per-scene status flips stream over Realtime (spec 6.4).
export type VoiceSynthesizeData = {
  jobId: string;
  videoId: string;
  accountId: string;
  sceneIds: string[];
  voice: { voiceId: string; modelId?: string; settings?: VoiceSettings };
};

export const inngest = new Inngest({ id: 'reelscript' });
