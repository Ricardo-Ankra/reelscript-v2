// Caption building (Phase 6, spec 4.2.1 / 8.5). A *system-generated* layer,
// independent of the composition AI: the full narration, word-for-word, aligned to
// the ElevenLabs character timings already persisted on scenes.word_alignments.
//
// Pure (no react, no server-only, no network) so the same segmentation feeds the
// burnt-in CaptionTrack AND the SRT/VTT sidecars — the two can't drift — and it is
// unit-testable like the Phase 2/3 generation split.
//
// Two consumers, one source:
//   * spec.captions  — the BURNT track (suppressed during kinetic spans, §collision).
//   * SRT/VTT        — the accessibility sidecars (always the FULL narration, 4.2.1).
import type { TtsAlignment } from '../voice/alignment';

export interface CaptionSegment {
  fromFrame: number; // absolute, from the start of the whole video
  toFrame: number; // exclusive end; always > fromFrame
  text: string;
}

// brand_kit.caption_style (4.2.1). Position/size/legibility are the renderer's
// concern; only maxCharsPerLine affects segmentation, so it is the one field the
// builder reads. The rest travel to CaptionTrack.tsx.
export interface CaptionStyle {
  position?: 'bottom' | 'top';
  fontSizePx?: number;
  maxCharsPerLine?: number;
  background?: boolean; // scrim behind the text
  outline?: boolean; // stroke around glyphs
}

export const DEFAULT_MAX_CHARS_PER_LINE = 32;

// A time window in frames (kinetic spans, for suppression).
export interface FrameSpan {
  fromFrame: number;
  toFrame: number;
}

// One scene's caption inputs: its persisted alignment (or null = silent scene) and
// its absolute start frame in the assembled video.
export interface SceneCaptionInput {
  alignment: TtsAlignment | null | undefined;
  startFrame: number;
}

interface Word {
  text: string;
  startSec: number;
  endSec: number;
}

// Reconstruct word-level timings from the character-level ElevenLabs alignment:
// accumulate non-whitespace characters into a word; a whitespace char closes it.
// A word's start is its first char's start time, its end its last char's end time.
export function reconstructWords(alignment: TtsAlignment): Word[] {
  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];
  const words: Word[] = [];
  let cur: Word | null = null;
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

// Greedily pack words into lines no longer than maxChars (joined with single
// spaces). A single word longer than the limit becomes its own line rather than
// being dropped.
function packLines(words: Word[], maxChars: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let len = 0;
  for (const w of words) {
    const add = (line.length === 0 ? 0 : 1) + w.text.length;
    if (line.length > 0 && len + add > maxChars) {
      lines.push(line);
      line = [];
      len = 0;
    }
    line.push(w);
    len += line.length === 1 ? w.text.length : add;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function secToFrame(sec: number, fps: number): number {
  return Math.round(sec * fps);
}

// Build the full caption track across all scenes. Each scene's word timings are
// scene-relative (its audio starts at the scene's first frame), so we add the
// scene's absolute startFrame. Silent scenes (no alignment) contribute nothing.
export function buildCaptions(
  scenes: SceneCaptionInput[],
  opts: { fps: number; maxCharsPerLine?: number },
): CaptionSegment[] {
  const maxChars = opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const segments: CaptionSegment[] = [];
  for (const scene of scenes) {
    if (!scene.alignment) continue;
    const words = reconstructWords(scene.alignment);
    if (words.length === 0) continue;
    for (const line of packLines(words, maxChars)) {
      const text = line.map((w) => w.text).join(' ');
      const from = scene.startFrame + secToFrame(line[0].startSec, opts.fps);
      let to = scene.startFrame + secToFrame(line[line.length - 1].endSec, opts.fps);
      if (to <= from) to = from + 1; // every caption shows for at least one frame
      segments.push({ fromFrame: from, toFrame: to, text });
    }
  }
  return segments;
}

// Burnt-track suppression (§collision prevention): drop any caption segment whose
// window overlaps an active kinetic span, so the big kinetic word and its caption
// echo never show at once. Sidecars keep the FULL track — this is burn-in only.
export function suppressDuringSpans(
  segments: CaptionSegment[],
  spans: FrameSpan[],
): CaptionSegment[] {
  if (spans.length === 0) return segments;
  return segments.filter(
    (seg) => !spans.some((sp) => seg.fromFrame < sp.toFrame && sp.fromFrame < seg.toFrame),
  );
}

// --- sidecar formats (4.2.1: always exported) ------------------------------

function frameToTimestamp(frame: number, fps: number, comma: boolean): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const sep = comma ? ',' : '.';
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

export function toSrt(segments: CaptionSegment[], fps: number): string {
  return (
    segments
      .map((seg, i) => {
        const start = frameToTimestamp(seg.fromFrame, fps, true);
        const end = frameToTimestamp(seg.toFrame, fps, true);
        return `${i + 1}\n${start} --> ${end}\n${seg.text}`;
      })
      .join('\n\n') + (segments.length ? '\n' : '')
  );
}

export function toVtt(segments: CaptionSegment[], fps: number): string {
  const cues = segments
    .map((seg) => {
      const start = frameToTimestamp(seg.fromFrame, fps, false);
      const end = frameToTimestamp(seg.toFrame, fps, false);
      return `${start} --> ${end}\n${seg.text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${cues}${segments.length ? '\n' : ''}`;
}
