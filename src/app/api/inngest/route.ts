import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { renderVideo } from '@/lib/inngest/functions/render';
import { generateScript } from '@/lib/inngest/functions/generate-script';
import { synthesizeVoice } from '@/lib/inngest/functions/synthesize-voice';

// Node runtime: the render function uses @remotion/lambda + the AWS SDK, the script
// function uses the Anthropic SDK, and voice synthesis writes audio bytes to R2.
export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo, generateScript, synthesizeVoice],
});
