import 'server-only';

// Server-only configuration. Accessed lazily via getters so a value that is not
// needed yet (e.g. the Remotion function name before the deploy step) does not
// throw at import time — only when actually used.
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required server env var: ${name} (see .env.example).`);
  }
  return v;
}

export const serverEnv = {
  get supabaseUrl() {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseSecretKey() {
    return required('SUPABASE_SECRET_KEY');
  },
  r2: {
    get accessKeyId() {
      return required('R2_ACCESS_KEY_ID');
    },
    get secretAccessKey() {
      return required('R2_SECRET_ACCESS_KEY');
    },
    get bucket() {
      return required('R2_BUCKET');
    },
    get endpoint() {
      return required('R2_ENDPOINT');
    },
  },
  aws: {
    get region() {
      return required('AWS_REGION');
    },
  },
  remotion: {
    get functionName() {
      return required('REMOTION_LAMBDA_FUNCTION_NAME');
    },
    get serveUrl() {
      return required('REMOTION_SERVE_URL');
    },
  },
  anthropic: {
    get apiKey() {
      return required('ANTHROPIC_API_KEY');
    },
  },
  elevenlabs: {
    get apiKey() {
      return required('ELEVENLABS_API_KEY');
    },
  },
  // Music re-mux Lambda (Phase 6, spec 10.1). A dedicated ffmpeg Lambda behind a
  // Function URL; the worker POSTs signed R2 in/out URLs + the ffmpeg argv and the
  // Lambda mixes music onto the voiceover-only base. Lazy getters so a render with
  // music off never needs these set.
  remux: {
    get url() {
      return required('REMUX_LAMBDA_URL');
    },
    get secret() {
      return required('REMUX_LAMBDA_SECRET');
    },
  },
  // Stock providers (Phase 5). Optional: a channel "has stock" only if the key is
  // set; absent keys drive the graceful-degradation path (spec 8.9). Read via
  // optional() so composition can branch on presence without throwing.
  pexels: {
    get apiKey() {
      return optional('PEXELS_API_KEY');
    },
  },
  pixabay: {
    get apiKey() {
      return optional('PIXABAY_API_KEY');
    },
  },
};

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
}
