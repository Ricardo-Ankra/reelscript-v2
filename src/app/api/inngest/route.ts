import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { renderVideo, renderSample } from '@/lib/inngest/functions/render';
import { generateScript } from '@/lib/inngest/functions/generate-script';
import { synthesizeVoice } from '@/lib/inngest/functions/synthesize-voice';
import { musicRemux } from '@/lib/inngest/functions/music-remux';
import { deployPrimitive } from '@/lib/inngest/functions/deploy-primitive';
import { generateShots } from '@/lib/inngest/functions/generate-shots';
import { ingestShots } from '@/lib/inngest/functions/ingest-shots';
import { reelscriptPipeline } from '@/lib/inngest/functions/pipeline';

// Node runtime: the render function uses @remotion/lambda + the AWS SDK, the script
// and composition steps use the Anthropic SDK, and voice synthesis writes audio
// bytes to R2.
export const runtime = 'nodejs';

// Give the Inngest serve function the full Vercel budget: the longest Vercel-side step
// is the Anthropic compose call (render + music re-mux run off-Vercel on Lambda). 300s
// is the current Vercel default; declaring it is explicit + future-proof against default
// changes. (Slice 7a — production deploy.)
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo, renderSample, generateScript, synthesizeVoice, musicRemux, deployPrimitive, generateShots, ingestShots, reelscriptPipeline],
});
