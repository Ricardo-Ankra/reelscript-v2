import type { GenerationProvider } from './provider';
import { createFakeProvider } from './fake-provider';

// Resolve the generation provider — the single swap point (V2 Slice 1b). Default 'fake'
// (headless, no creds). Real adapters (a text→still image model + Higgsfield clips) drop
// in here behind the same seam when credentials exist — orchestration never changes.
//
// When 'fake', optional GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL fixtures are threaded into
// the fake so the drive script can make streamUrlToR2 round-trip offline with data: URLs.
// These must live in the dev-server env (.env.local) because the Inngest function builds
// its provider in that process. Unset in normal runs → the fake's built-in defaults.
export function getGenerationProvider(): GenerationProvider {
  const which = process.env.GENERATION_PROVIDER ?? 'fake';
  switch (which) {
    case 'fake':
      return createFakeProvider({
        stillUrl: process.env.GEN_FAKE_STILL_URL,
        clipUrl: process.env.GEN_FAKE_CLIP_URL,
      });
    case 'higgsfield':
      throw new Error('GENERATION_PROVIDER=higgsfield not configured yet (no adapter)');
    default:
      throw new Error(`Unknown GENERATION_PROVIDER: ${which}`);
  }
}
