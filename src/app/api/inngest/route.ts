import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { renderVideo } from '@/lib/inngest/functions/render';

// Node runtime: the render function uses @remotion/lambda + the AWS SDK.
export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo],
});
