// Pure stock-asset types + helpers (no secrets/network), shared by the provider
// adapters, the search dispatcher, and the agentic selection loop. Unit-testable.
import { createHash } from 'node:crypto';

export type StockKind = 'image' | 'video';
export type StockProvider = 'pexels' | 'pixabay';

// One search result the AI can be shown and the system can later download.
export interface StockCandidate {
  assetId: string; // stable, AI-facing id: `${provider}-${kind}-${externalId}`
  provider: StockProvider;
  kind: StockKind;
  externalId: string;
  thumbnailUrl: string; // small image shown to the vision model (video → poster frame)
  downloadUrl: string; // best file to fetch into R2 at resolve time
  width: number;
  height: number;
  attribution: string; // e.g. "Photo by Jane Doe on Pexels" (spec 8.6)
}

export interface StockSearchParams {
  query: string;
  kind: StockKind;
  orientation?: 'landscape' | 'portrait' | 'square';
  minWidth?: number;
}

export function makeAssetId(provider: StockProvider, kind: StockKind, externalId: string | number): string {
  return `${provider}-${kind}-${externalId}`;
}

// De-dupe by assetId, preserving order (first occurrence wins).
export function dedupeCandidates(candidates: StockCandidate[]): StockCandidate[] {
  const seen = new Set<string>();
  const out: StockCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.assetId)) continue;
    seen.add(c.assetId);
    out.push(c);
  }
  return out;
}

// Deterministic key for the search-result cache (spec 13.6): hash of the search
// shape, so identical searches (any provider) share a cache row.
export function searchCacheKey(params: StockSearchParams & { source: string }): string {
  const norm = [
    params.source,
    params.query.trim().toLowerCase(),
    params.kind,
    params.orientation ?? '',
    params.minWidth ?? '',
  ].join('|');
  return createHash('sha256').update(norm).digest('hex');
}
