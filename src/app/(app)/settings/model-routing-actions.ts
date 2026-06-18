'use server';

import { createClient } from '@/lib/supabase/server';
import { validateModelRoutingForm } from '@/lib/ai/model-routing';

// Persist the account's model routing via set_account_model_routing (writes the
// caller's own account by auth.uid()). The RPC returns the id, or null when no row
// matched — a failure, not a phantom "Saved".
export async function saveModelRouting(
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateModelRoutingForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_account_model_routing', {
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Account not found.' };
  return { ok: true };
}
