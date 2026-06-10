import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { putObject } from '../r2';
import type { StockKind } from './candidate';

// File-bytes cache (spec 13.6): download a chosen asset once, store it in R2 under a
// content-hashed key, and reuse it for any future render that picks the same bytes.
// Returns the R2 key the manifest will point at (signed at render time).
export async function cacheAssetBytes(
  admin: SupabaseClient,
  accountId: string,
  downloadUrl: string,
  kind: StockKind,
): Promise<{ r2Key: string; contentHash: string }> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`download asset (${res.status}): ${downloadUrl.slice(0, 120)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('downloaded asset was empty');
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  const { data: existing } = await admin
    .from('asset_files')
    .select('r2_key')
    .eq('account_id', accountId)
    .eq('content_hash', contentHash)
    .maybeSingle();
  if (existing) return { r2Key: existing.r2_key as string, contentHash };

  const contentType = res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const ext = extFor(contentType, kind);
  const r2Key = `assets/${contentHash}.${ext}`;
  await putObject(r2Key, bytes, contentType);
  await admin.from('asset_files').insert({
    account_id: accountId,
    content_hash: contentHash,
    r2_key: r2Key,
    source: 'stock',
    original_url: downloadUrl,
    kind: kind === 'video' ? 'video' : 'image',
  });
  return { r2Key, contentHash };
}

function extFor(contentType: string, kind: StockKind): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  return kind === 'video' ? 'mp4' : 'jpg';
}
