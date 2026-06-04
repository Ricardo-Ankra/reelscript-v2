import { Inngest } from 'inngest';

// render/start carries the render row id and the R2 key of its stored spec; the
// worker signs the spec URL at render start (spec 10.3).
export type RenderStartData = { renderId: string; specKey: string };

export const inngest = new Inngest({ id: 'reelscript' });
