// Pure const — no server-only runtime, safe to import in client components.
export const CREDENTIAL_PROVIDERS = ['anthropic', 'elevenlabs', 'pexels', 'pixabay'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];
