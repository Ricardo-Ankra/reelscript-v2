'use server';

import { createClient } from '@/lib/supabase/server';
import { validateChannelName } from '@/lib/channels/validate';
import { DEFAULT_VOICE_ID, ELEVENLABS_DEFAULT_MODEL } from '@/lib/voice/elevenlabs';

export type CreateChannelResult =
  | { ok: true; channelId: string }
  | { ok: false; reason: string };

// Creates a channel under the signed-in account with safe defaults so it
// renders before the brand editor (slice 2) exists — bakeTheme backfills the
// full DEFAULT_THEME from an empty brand_kit. NEVER calls redirect(): the
// discriminated-union return must survive; the client routes on ok:true.
export async function createChannel(name: string): Promise<CreateChannelResult> {
  const valid = validateChannelName(name);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'Not signed in.' };

  // accounts: RLS scopes to owner_user_id = auth.uid() and accounts_owner_idx is
  // UNIQUE on owner_user_id, so a session sees at most one account. maybeSingle()
  // turns the zero-row edge (e.g. signup-trigger race) into a clean null →
  // friendly reason, never a thrown PostgREST error.
  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  // The channels INSERT is independently RLS-checked: policy acct_isolation has
  // `with check (auth_owns_account(account_id))`, so account_id must belong to
  // the caller — the insert can't smuggle another account's id.
  const { data, error } = await supabase
    .from('channels')
    .insert({
      account_id: account.id as string,
      name: valid.value,
      brand_kit: {},
      brand_voice: {},
      voice_tts: { voice_id: DEFAULT_VOICE_ID, model: ELEVENLABS_DEFAULT_MODEL },
      defaults: {},
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, reason: `Could not create channel: ${error?.message ?? 'unknown'}` };
  }

  return { ok: true, channelId: data.id as string };
}
