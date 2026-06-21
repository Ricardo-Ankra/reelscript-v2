'use server';

import { createClient } from '@/lib/supabase/server';
import { validateShotResource } from '@/lib/resources/shot-placement';

// Pin a shot to a channel resource (source='resource' + resource_id) or clear it back
// to stock. Direct RLS write scoped by account_id, confirmed via .select('id') (no row
// → "Shot not found.", no phantom save). The editor's picker only offers the video's
// channel resources; RLS guarantees the shot is the caller's.
export async function setShotResource(
  shotId: string,
  resourceId: string | null,
): Promise<{ ok: true; source: 'resource' | 'stock' } | { ok: false; reason: string }> {
  const norm = validateShotResource({ resourceId });

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const { data, error } = await supabase
    .from('shots')
    .update({ source: norm.source, resource_id: norm.resourceId })
    .eq('id', shotId)
    .eq('account_id', account.id as string)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Shot not found.' };
  return { ok: true, source: norm.source };
}
