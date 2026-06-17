// Caption sidecar formatting (SRT/VTT) + the caption style type.
//
// As of the caption emphasis revision (2026-06-16) the burnt track is the animated
// CaptionChunk[] (see types.ts / build-chunks.ts / AnimatedCaptionTrack); the
// per-word tokenizer is tokenize.ts. This module is now just the brand caption
// style and the always-exported accessibility sidecars, derived from the same
// chunks so the burnt track and the sidecars cannot drift.
//
// Pure (no react, no server-only, no network).
import type { CaptionChunk } from './types';

export interface CaptionSegment {
  fromFrame: number; // absolute, from the start of the whole video
  toFrame: number; // exclusive end; always > fromFrame
  text: string;
}

// brand_kit.caption_style (4.2.1). Position/size/legibility are the renderer's
// concern; maxCharsPerLine feeds the chunker. The rest travel to the renderer.
export interface CaptionStyle {
  position?: 'bottom' | 'top';
  fontSizePx?: number;
  maxCharsPerLine?: number;
  background?: boolean; // scrim behind the text
  outline?: boolean; // stroke around glyphs
}

// Flatten caption chunks into one cue each for the SRT/VTT sidecars (emphasis is
// burn-only; sidecars are plain text).
export function chunksToSegments(chunks: CaptionChunk[]): CaptionSegment[] {
  return chunks.map((c) => ({
    fromFrame: c.fromFrame,
    toFrame: c.toFrame > c.fromFrame ? c.toFrame : c.fromFrame + 1,
    text: c.words.map((w) => w.text).join(' '),
  }));
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
