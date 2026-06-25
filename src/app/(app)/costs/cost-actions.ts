'use server';

import { createClient } from '@/lib/supabase/server';
import { parseCostBudgetInput } from '@/lib/costs/budget';

// Set the account's monthly cost cap + enforcement toggle (V2 Slice 6b). Writes
// the two pre-existing accounts columns directly under RLS (the accounts_owner
// policy scopes the write to the caller's own row). capUsd null/'' clears the cap.
export async function setCostBudget(
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = parseCostBudgetInput(input);
  if ('error' in parsed) return { ok: false, reason: parsed.error };

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const { error } = await supabase
    .from('accounts')
    .update({
      monthly_cost_alert_usd: parsed.capUsd,
      monthly_cost_alert_on: parsed.enabled,
    })
    .eq('id', account.id as string);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
