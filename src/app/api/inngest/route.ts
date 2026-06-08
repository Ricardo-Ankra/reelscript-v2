import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { renderVideo } from '@/lib/inngest/functions/render';
import { generateScript } from '@/lib/inngest/functions/generate-script';

// Node runtime: the render function uses @remotion/lambda + the AWS SDK, and the
// script function uses the Anthropic SDK.
export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo, generateScript],
});
