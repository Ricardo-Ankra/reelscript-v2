import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '../env.server';
import { resolveProviderKey } from '../credentials/store';
import { searchPexels } from './pexels';
import { searchPixabay } from './pixabay';
import { dedupeCandidates, searchCacheKey, type StockCandidate, type StockSearchParams } from './candidate';

const SEARCH_CACHE_TTL_DAYS = 7;

// A channel "has stock" iff at least one provider key is configured. Drives the
// degradation branch (spec 8.9) and whether the agentic loop offers the tool.
export function hasStockKeys(): boolean {
  return Boolean(serverEnv.pexels.apiKey || serverEnv.pixabay.apiKey);
}

// Per-account stock keys: a stored credential (non-invalid) else the env var. Used to
// decide whether stock is available AND which key each provider call uses.
export async function resolveStockKeys(
  client: SupabaseClient,
  accountId: string,
): Promise<{ pexels?: string; pixabay?: string }> {
  const [pexels, pixabay] = await Promise.all([
    resolveProviderKey(client, accountId, 'pexels'),
    resolveProviderKey(client, accountId, 'pixabay'),
  ]);
  return {
    pexels: pexels ?? serverEnv.pexels.apiKey,
    pixabay: pixabay ?? serverEnv.pixabay.apiKey,
  };
}

// Search both providers (those with keys), merge + dedupe, behind the 7-day
// search-result cache (spec 13.6) so repeated/identical searches don't re-pay the
// providers. A provider error degrades to that provider returning nothing.
export async function searchStock(
  admin: SupabaseClient,
  accountId: string,
  params: StockSearchParams,
  keys: { pexels?: string; pixabay?: string },
): Promise<StockCandidate[]> {
  const queryHash = searchCacheKey({ ...params, source: 'stock' });
  const nowIso = new Date().toISOString();

  const { data: cached } = await admin
    .from('asset_search_cache')
    .select('results, expires_at')
    .eq('account_id', accountId)
    .eq('query_hash', queryHash)
    .maybeSingle();
  if (cached && (cached.expires_at as string) > nowIso) {
    return cached.results as StockCandidate[];
  }

  const [pex, pix] = await Promise.all([
    searchPexels(params, keys.pexels).catch(() => [] as StockCandidate[]),
    searchPixabay(params, keys.pixabay).catch(() => [] as StockCandidate[]),
  ]);
  // Interleave so both providers are visible among the first candidates.
  const merged: StockCandidate[] = [];
  for (let i = 0; i < Math.max(pex.length, pix.length); i++) {
    if (pex[i]) merged.push(pex[i]);
    if (pix[i]) merged.push(pix[i]);
  }
  const deduped = dedupeCandidates(merged);

  const expiresAt = new Date(Date.now() + SEARCH_CACHE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  await admin
    .from('asset_search_cache')
    .upsert(
      { account_id: accountId, query_hash: queryHash, results: deduped, expires_at: expiresAt },
      { onConflict: 'account_id,query_hash' },
    );
  return deduped;
}
