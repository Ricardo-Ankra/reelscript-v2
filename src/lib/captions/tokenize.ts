// Canonical spoken-word tokenizer (caption emphasis revision, 2026-06-16).
//
// LOAD-BEARING INVARIANT: this is the ONE source of the scene's spoken-word
// list. Both consumers — the emphasis-pass input builder (which produces
// WordEmphasis.index) and chunkWords (which groups words into caption chunks)
// — derive their word list from THIS function and nothing else. If two
// consumers tokenized independently they could disagree (hyphenates, decimals,
// contractions, em-dashes) and emphasis would land on the wrong word.
//
// Canonical rule: split on whitespace only. A run of non-whitespace characters
// is one token; a whitespace character closes the current token. So
// `well-being`, `2.5`, `doesn't`, and `creatine—really` (no internal
// whitespace) are each ONE token. The spec is explicit that the *choice* per
// case does not matter for correctness — only that both consumers agree — and
// agreement is guaranteed by routing both through this single function.
//
// Pure (no react, no server-only, no network), so it is unit-testable and feeds
// both the burnt caption track and the SRT/VTT sidecars without drift.
import type { TtsAlignment } from '../voice/alignment';

export interface SpokenWord {
  text: string;
  startSec: number; // first character's start time
  endSec: number; // last character's end time
}

export function tokenizeSpokenWords(alignment: TtsAlignment): SpokenWord[] {
  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];
  const words: SpokenWord[] = [];
  let cur: SpokenWord | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === undefined || /\s/.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = null;
      }
      continue;
    }
    const startSec: number = starts[i] ?? cur?.startSec ?? 0;
    const endSec: number = ends[i] ?? startSec;
    if (!cur) cur = { text: ch, startSec, endSec };
    else {
      cur.text += ch;
      cur.endSec = endSec;
    }
  }
  if (cur) words.push(cur);
  return words;
}
