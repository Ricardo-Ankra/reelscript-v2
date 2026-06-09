import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { renderVideo, renderSample } from '@/lib/inngest/functions/render';
import { generateScript } from '@/lib/inngest/functions/generate-script';
import { synthesizeVoice } from '@/lib/inngest/functions/synthesize-voice';

// Node runtime: the render function uses @remotion/lambda + the AWS SDK, the script
// and composition steps use the Anthropic SDK, and voice synthesis writes audio
// bytes to R2.
export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo, renderSample, generateScript, synthesizeVoice],
});
