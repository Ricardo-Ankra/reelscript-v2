import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cacheAssetBytes } from './cache';
import type { StockResolution } from '../composition/compose';
import type { AssetManifestEntry } from '../composition/spec';

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
