import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '../env.server';
import { encryptSecret, decryptSecret } from './crypto';
import { CREDENTIAL_PROVIDERS, type CredentialProvider } from './providers';

// Per-account API credential store (Phase 8). Encrypt-at-rest over the deployed
// api_credentials table (RLS-scoped). resolveProviderKey gives a consumer the
// account's key, falling back (caller-side) to the env var on undefined.

// Re-export for consumers that import from this module.
export { CREDENTIAL_PROVIDERS, type CredentialProvider };

// Single key per provider: a fixed sentinel label (NULLs are distinct under the
// unique constraint, so we use '' to make "one per provider" enforceable).
const LABEL = '';

// Encrypt + upsert (status reset to 'unverified'); returns the row id, or null when
// no account matched. Never returns the plaintext.
export async function saveCredential(
  client: SupabaseClient,
  accountId: string,
  provider: CredentialProvider,
  plaintext: string,
): Promise<string | null> {
  const encrypted = encryptSecret(plaintext, serverEnv.credentials.encryptionKey);
  const { data, error } = await client
    .from('api_credentials')
    .upsert(
      {
        account_id: accountId,
        provider,
        label: LABEL,
        encrypted_value: encrypted,
        status: 'unverified',
        last_validated_at: null,
      },
      { onConflict: 'account_id,provider,label' },
    )
    .select('id')
    .single();
  if (error || !data) return null;
  return data.id as string;
}

// The account's stored key for a provider, decrypted, when a row exists AND its
// status is not 'invalid'. Any failure (no row, missing env key, decrypt error) →
// undefined, so a consumer cleanly falls back to its env var.
export async function resolveProviderKey(
  client: SupabaseClient,
  accountId: string,
  provider: CredentialProvider,
): Promise<string | undefined> {
  try {
    const { data } = await client
      .from('api_credentials')
      .select('encrypted_value, status')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .eq('label', LABEL)
      .maybeSingle();
    if (!data || data.status === 'invalid' || !data.encrypted_value) return undefined;
    return decryptSecret(data.encrypted_value as string, serverEnv.credentials.encryptionKey);
  } catch {
    return undefined;
  }
}

// One cheap authenticated call per provider → is the key live? Network/non-2xx → false.
export async function validateProviderKey(
  provider: CredentialProvider,
  apiKey: string,
): Promise<boolean> {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      return res.ok;
    }
    if (provider === 'elevenlabs') {
      const res = await fetch('https://api.elevenlabs.io/v1/models', {
        headers: { 'xi-api-key': apiKey },
      });
      return res.ok;
    }
    if (provider === 'pexels') {
      const res = await fetch('https://api.pexels.com/v1/search?query=test&per_page=1', {
        headers: { Authorization: apiKey },
      });
      return res.ok;
    }
    // pixabay
    const res = await fetch(
      `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=test&per_page=3`,
    );
    return res.ok;
  } catch {
    return false;
  }
}
