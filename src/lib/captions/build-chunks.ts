// buildCaptionChunks (caption emphasis revision, 2026-06-16) — the merge step the
// render pipeline calls per scene: chunk the canonical spoken words for timing,
// then attach the validated emphasis annotations onto the words they target.
//
// Emphasis indices are positions in the scene's canonical spoken-word list
// (tokenize.ts). chunkWords groups that same list without splitting/merging/
// dropping any word (the load-bearing agreement invariant), so the k-th word
// flattened across chunks is token k — emphasis attaches by that global index.
//
// Pure (no react, no server-only, no network).
import { chunkWords, type ChunkOptions } from './chunks';
import type { SpokenWord } from './tokenize';
import type { CaptionChunk, WordEmphasis } from './types';

export function buildCaptionChunks(
  words: SpokenWord[],
  emphasis: WordEmphasis[],
  opts: ChunkOptions,
): CaptionChunk[] {
  const chunks = chunkWords(words, opts);
  if (emphasis.length === 0) return chunks;

  const byIndex = new Map<number, WordEmphasis>();
  for (const e of emphasis) byIndex.set(e.index, e);

  let globalIndex = 0;
  for (const chunk of chunks) {
    for (const word of chunk.words) {
      const e = byIndex.get(globalIndex);
      if (e) word.emphasis = e;
      globalIndex++;
    }
  }
  return chunks;
}
