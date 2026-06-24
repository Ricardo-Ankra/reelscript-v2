import type { ProbeResult } from './probe';

// Pure ffmpeg-argv builders for live-action ingest (V2 Slice 2a). The Lambda just runs
// the argv (mirrors src/lib/music/ffmpeg.ts), so the conform/keyframe recipes stay
// reviewable and unit-tested. Geometry is target-driven + ffmpeg runtime expressions —
// never app-side source-dim arithmetic. Rotation rides on ffmpeg's default autorotate.

export interface ConformInput {
  inPath: string;
  outPath: string;
  target: { width: number; height: number; fps: number };
  probe: ProbeResult;
  durationSec?: number; // trim output to N seconds from the start (in-point 0)
}

export interface KeyframeInput {
  inPath: string;
  outPath: string;
  atSec: number;
}

// Stable, ffmpeg-friendly float string (no exponent / trailing noise).
function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

export function buildConformArgs(input: ConformInput): string[] {
  const { inPath, outPath, target, probe, durationSec } = input;
  const vf = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    `fps=${target.fps}`,
  ].join(',');

  const args: string[] = ['-y', '-i', inPath, '-vf', vf];
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20');
  if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  if (typeof durationSec === 'number' && durationSec > 0) args.push('-t', f(durationSec));
  args.push('-movflags', '+faststart', outPath);
  return args;
}

export function buildKeyframeArgs(input: KeyframeInput): string[] {
  // -ss before -i = fast input seek; one frame out to a PNG still.
  return ['-y', '-ss', f(input.atSec), '-i', input.inPath, '-frames:v', '1', input.outPath];
}
