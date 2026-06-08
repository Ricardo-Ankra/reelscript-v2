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
};
