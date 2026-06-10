import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAssetId, dedupeCandidates, searchCacheKey, type StockCandidate } from './candidate.ts';

const cand = (assetId: string): StockCandidate => ({
  assetId,
  provider: 'pexels',
  kind: 'image',
  externalId: assetId,
  thumbnailUrl: 't',
  downloadUrl: 'd',
  width: 1920,
  height: 1080,
  attribution: 'Photo by X on Pexels',
});

test('makeAssetId: stable provider-kind-id form', () => {
  assert.equal(makeAssetId('pexels', 'image', 12345), 'pexels-image-12345');
  assert.equal(makeAssetId('pixabay', 'video', '9'), 'pixabay-video-9');
});

test('dedupeCandidates: drops repeats, keeps first + order', () => {
  const out = dedupeCandidates([cand('a'), cand('b'), cand('a'), cand('c')]);
  assert.deepEqual(out.map((c) => c.assetId), ['a', 'b', 'c']);
});

test('searchCacheKey: stable + normalizes query case/whitespace', () => {
  const a = searchCacheKey({ source: 'stock', query: 'Coffee Cup ', kind: 'image', orientation: 'portrait', minWidth: 1080 });
  const b = searchCacheKey({ source: 'stock', query: 'coffee cup', kind: 'image', orientation: 'portrait', minWidth: 1080 });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('searchCacheKey: distinct shapes → distinct keys', () => {
  const a = searchCacheKey({ source: 'stock', query: 'cat', kind: 'image' });
  const b = searchCacheKey({ source: 'stock', query: 'cat', kind: 'video' });
  assert.notEqual(a, b);
});
