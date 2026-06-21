import { Inngest } from 'inngest';
import type { VideoConfig, BrandContext } from '@/lib/ai/script-generation';
import type { VoiceSettings } from '@/lib/voice/alignment';

// render/start drives the full composition pipeline (Phase 4): the spec doesn't
// exist yet — it's composed inside the job. Carries the job + render rows and the
// video to compose from (spec 13.1 / api-surface InngestEvents).
export type RenderStartData = { jobId: string; renderId: string; videoId: string };

// render/sample is the Phase-1 debug harness: render a pre-stored spec by pointer,
// no AI. Kept as the only no-AI path to exercise the Lambda spine in isolation.
export type RenderSampleData = { renderId: string; specKey: string };

// music/remux drives the Phase-6 audio-only re-mux (spec 10.1): the dedicated ffmpeg
// Lambda mixes the render's chosen track onto its voiceover-only base MP4, producing
// the final output WITHOUT a re-render. Emitted by the render pipeline when music is
// on, and by the Music panel on reroll/replace. jobId is set when a render job owns
// the remux (pipeline path); the standalone reroll path runs without a job row.
export type MusicRemuxData = {
  renderId: string;
  accountId: string;
  videoId: string;
  jobId?: string;
};

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
  // When true, the worker WIPES the video's existing scenes before streaming the new
  // ones (regenerate-in-place). Set ONLY by regenerateVideo; absent for initial gen.
  replace?: boolean;
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

// primitive/deploy re-bundles the Remotion site so a newly-saved (or edited) primitive
// reaches Lambda (Phase 7, spec 9.7). It re-bundles ALL the account's active primitives,
// so the payload only needs the account + the triggering primitive/version (for the job
// record + marking deployed_version on success).
export type PrimitiveDeployData = {
  jobId: string;
  accountId: string;
  primitiveId: string;
  version: number;
};

// jobs/cancel requests cancellation of an in-flight run by jobId. Each cancellable
// function declares cancelOn matching this event on data.jobId; the cancel action
// also marks the job row cancelled. accountId is carried for logging/parity. We use
// the non-deprecated `if` expression form (event = the original trigger, async = the
// cancel event); `match` is deprecated in this inngest version.
export type JobCancelData = { jobId: string; accountId: string };

export const inngest = new Inngest({ id: 'reelscript' });
