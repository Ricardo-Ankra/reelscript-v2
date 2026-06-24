import type {
  GenerationProvider,
  StillRequest,
  StillResult,
  ClipRequest,
  ClipSubmit,
  ClipStatus,
} from './provider';

export interface FakeConfig {
  pollsUntilReady?: number; // checkClip returns 'pending' this many times, then 'completed' (default 2)
  stillUrl?: string;        // overrides the seed-derived still url
  clipUrl?: string;         // default 'https://fake.local/clip.mp4'
}

export interface FakeProvider extends GenerationProvider {
  failNext(): void; // the next submitted clip will report 'failed' on check
}

// A stateful in-memory test double (NOT pure) that simulates the async clip lifecycle
// so 1b's durable poll can be proven headlessly.
export function createFakeProvider(config: FakeConfig = {}): FakeProvider {
  const pollsUntilReady = config.pollsUntilReady ?? 2;
  const clipUrl = config.clipUrl ?? 'https://fake.local/clip.mp4';
  let counter = 0;
  const polls = new Map<string, number>();
  const failed = new Set<string>();
  let failArmed = false;

  return {
    async generateStill(req: StillRequest): Promise<StillResult> {
      const url = config.stillUrl ?? `https://fake.local/still/${req.seed ?? 'noseed'}.png`;
      return { url };
    },
    async submitClip(req: ClipRequest): Promise<ClipSubmit> {
      const requestId = `fake-${req.model}-${counter++}`;
      polls.set(requestId, 0);
      if (failArmed) {
        failed.add(requestId);
        failArmed = false;
      }
      return { requestId };
    },
    async checkClip(requestId: string): Promise<ClipStatus> {
      if (failed.has(requestId)) return { state: 'failed', error: 'fake failure' };
      const n = (polls.get(requestId) ?? 0) + 1;
      polls.set(requestId, n);
      if (n > pollsUntilReady) return { state: 'completed', mediaUrl: clipUrl };
      return { state: 'pending' };
    },
    failNext() {
      failArmed = true;
    },
  };
}
