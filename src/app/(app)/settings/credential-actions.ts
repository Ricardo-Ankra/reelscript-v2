'use server';

import { createClient } from '@/lib/supabase/server';
import {
  CREDENTIAL_PROVIDERS,
  saveCredential,
  resolveProviderKey,
  validateProviderKey,
  type CredentialProvider,
} from '@/lib/credentials/store';

function isProvider(p: string): p is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(p);
}

async function accountId(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string | null> {
  const { data } = await supabase.from('accounts').select('id').maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Encrypt + store a provider key (status reset to 'unverified').
export async function saveProviderCredential(
  provider: string,
  plaintext: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  if (typeof plaintext !== 'string' || plaintext.trim() === '') {
    return { ok: false, reason: 'Enter a key.' };
  }
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };
  try {
    const saved = await saveCredential(supabase, id, provider, plaintext.trim());
    if (!saved) return { ok: false, reason: 'Could not save the credential.' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Encryption is not configured (CREDENTIALS_ENCRYPTION_KEY).' };
  }
}

// Decrypt the stored key, validate it against the provider, persist the verdict.
export async function testProviderCredential(
  provider: string,
): Promise<{ ok: true; status: 'valid' | 'invalid' } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };

  const key = await resolveProviderKey(supabase, id, provider);
  if (!key) return { ok: false, reason: 'No stored key to test (or it could not be decrypted).' };

  const valid = await validateProviderKey(provider, key);
  const status: 'valid' | 'invalid' = valid ? 'valid' : 'invalid';
  const { data, error } = await supabase
    .from('api_credentials')
    .update({ status, last_validated_at: new Date().toISOString() })
    .eq('account_id', id)
    .eq('provider', provider)
    .select('id');
  if (error || !data || data.length === 0) return { ok: false, reason: 'Credential not found.' };
  return { ok: true, status };
}

// Remove a stored credential.
export async function deleteProviderCredential(
  provider: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };
  const { data, error } = await supabase
    .from('api_credentials')
    .delete()
    .eq('account_id', id)
    .eq('provider', provider)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Credential not found.' };
  return { ok: true };
}
