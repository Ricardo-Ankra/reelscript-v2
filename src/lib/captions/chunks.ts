// chunkWords (caption emphasis revision, 2026-06-16) — replaces the old
// line-packing (packLines). Groups the canonical spoken-word list into short
// caption chunks (~2–5 words) for the DOAC-style word-by-word reveal.
//
// Consumes the canonical tokenizer's output (tokenize.ts) — it never
// reconstructs words from the alignment itself, preserving the load-bearing
// invariant that emphasis indices and chunk words refer to the same list.
//
// Pure (no react, no server-only, no network).
import type { SpokenWord } from './tokenize';
import type { CaptionChunk, CaptionWord } from './types';

export const DEFAULT_MAX_WORDS_PER_CHUNK = 5;
export const DEFAULT_MAX_CHARS_PER_CHUNK = 24;
export const DEFAULT_PAUSE_GAP_SEC = 0.35;

export interface ChunkOptions {
  fps: number;
  startFrame?: number; // scene's absolute start frame in the assembled video
  maxWords?: number;
  maxChars?: number;
  pauseGapSec?: number;
}

const CLAUSE_PUNCT = /[.,?!;]$/;

function secToFrame(sec: number, fps: number): number {
  return Math.round(sec * fps);
}

// Chars a chunk would occupy if `word` joined it: existing text + a space + word.
function widthWith(current: SpokenWord[], word: SpokenWord): number {
  const existing = current.reduce((n, w, i) => n + w.text.length + (i === 0 ? 0 : 1), 0);
  return existing + (current.length === 0 ? 0 : 1) + word.text.length;
}

export function chunkWords(words: SpokenWord[], opts: ChunkOptions): CaptionChunk[] {
  const startFrame = opts.startFrame ?? 0;
  const maxWords = opts.maxWords ?? DEFAULT_MAX_WORDS_PER_CHUNK;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS_PER_CHUNK;
  const pauseGap = opts.pauseGapSec ?? DEFAULT_PAUSE_GAP_SEC;

  // 1) Group tokens into chunks (token space), then convert to frames.
  const groups: SpokenWord[][] = [];
  let group: SpokenWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = i > 0 ? words[i - 1] : null;

    if (group.length > 0) {
      const pause = prev ? word.startSec - prev.endSec > pauseGap : false;
      const prevPunct = prev ? CLAUSE_PUNCT.test(prev.text) : false;
      const tooManyWords = group.length >= maxWords;
      const tooWide = widthWith(group, word) > maxChars;
      if (pause || prevPunct || tooManyWords || tooWide) {
        groups.push(group);
        group = [];
      }
    }
    group.push(word);
  }
  if (group.length > 0) groups.push(group);

  // 2) Convert each group to a CaptionChunk with absolute frames.
  const chunks: CaptionChunk[] = groups.map((g) => {
    const captionWords: CaptionWord[] = g.map((word) => ({
      text: word.text,
      fromFrame: startFrame + secToFrame(word.startSec, opts.fps),
      toFrame: startFrame + secToFrame(word.endSec, opts.fps),
    }));
    return {
      fromFrame: captionWords[0].fromFrame,
      toFrame: captionWords[captionWords.length - 1].toFrame,
      words: captionWords,
    };
  });

  // 3) Hold each chunk until the next one begins (covers pauses); the last chunk
  //    holds to its last word's end.
  for (let i = 0; i < chunks.length - 1; i++) {
    chunks[i].toFrame = chunks[i + 1].fromFrame;
  }
  return chunks;
}
