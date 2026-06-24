// The generation provider seam (V2 Slice 1a). Image generation is fast (await a
// result); video generation is the long async job 1b drives with a durable Inngest
// poll. Real Higgsfield / text-to-still adapters implement this when creds exist; the
// fake provider implements it for headless testing. Results are FETCHABLE URLs the
// pipeline streams to R2 (they expire ~1h).

export interface StillRequest {
  prompt: string;
  aspectRatio: string;            // '9:16' | '1:1' | '16:9'
  seed: number | null;
  styleRefUrl: string | null;     // a live_action sibling frame (Slice 2+); null for now
}
export interface StillResult {
  url: string;
}

export interface ClipRequest {
  prompt: string;
  imageUrl: string;               // the ingredient keyframe (a presigned R2 GET url)
  motionId: string;
  motionStrength: number;
  seed: number | null;
  model: string;                  // routed model, e.g. 'dop-preview'
}
export interface ClipSubmit {
  requestId: string;
}
export type ClipStatus =
  | { state: 'pending' }
  | { state: 'completed'; mediaUrl: string }
  | { state: 'failed'; error: string };

export interface ImageProvider {
  generateStill(req: StillRequest): Promise<StillResult>;
}
export interface VideoProvider {
  submitClip(req: ClipRequest): Promise<ClipSubmit>;
  checkClip(requestId: string): Promise<ClipStatus>;
}
export interface GenerationProvider extends ImageProvider, VideoProvider {}
