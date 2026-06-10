import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cacheAssetBytes } from './cache';
import type { StockResolution } from '../composition/compose';
import type { AssetManifestEntry } from '../composition/spec';

// Stable manifest asset id for a channel resource (no provider/external id like stock).
export function resourceAssetId(resourceId: string): string {
  return `resource-${resourceId}`;
}

// Execute a stock-resolution plan (the chosen assetIds the AI referenced): download
// each once into the content-hashed R2 file cache and return the manifest entries the
// spec will carry. The r2Key is the durable pointer; the render-time copy signs it.
// Attribution rides along for the licensing overlay (spec 8.6). Sequential so two
// identical assets in one render don't race on the same content_hash insert.
export async function resolveStockAssets(
  admin: SupabaseClient,
  accountId: string,
  plan: StockResolution[],
): Promise<AssetManifestEntry[]> {
  const entries: AssetManifestEntry[] = [];
  for (const r of plan) {
    const { r2Key } = await cacheAssetBytes(admin, accountId, r.downloadUrl, r.kind);
    entries.push({ id: r.assetId, kind: r.kind, r2Key, attribution: r.attribution });
  }
  return entries;
}

// Resolve explicit channel-resource shots (source='resource') into manifest entries.
// The resource bytes are already in R2 (uploaded once) — just look up the r2_key by
// id; no download. Own content, so no attribution. Missing/foreign resources throw so
// the pipeline can degrade rather than silently render a dangling ref.
export async function resolveResourceAssets(
  client: SupabaseClient,
  accountId: string,
  resourceIds: string[],
): Promise<AssetManifestEntry[]> {
  const unique = [...new Set(resourceIds)];
  const entries: AssetManifestEntry[] = [];
  for (const resourceId of unique) {
    const { data, error } = await client
      .from('channel_resources')
      .select('r2_key, kind')
      .eq('id', resourceId)
      .eq('account_id', accountId)
      .single();
    if (error || !data || !data.r2_key) throw new Error(`resolve resource ${resourceId}: ${error?.message ?? 'no r2_key'}`);
    const kind = data.kind === 'video' ? 'video' : 'image';
    entries.push({ id: resourceAssetId(resourceId), kind, r2Key: data.r2_key as string });
  }
  return entries;
}
