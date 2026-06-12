import { canonicalizeMusicParams, type MusicParams } from './params';

// ffmpeg argument builder for the music re-mux (Phase 6, spec 10.1). PURE — it only
// produces the argv the ffmpeg Lambda runs; the Lambda itself fetches the base MP4
// (voiceover baked in, NO music) + the chosen track, runs ffmpeg, and uploads the
// final. Kept here, unit-tested, so the filter graph is reviewable without invoking
// AWS.
//
// The graph (spec 10.1 "handling ducking"):
//   [1:a] music → crop(in-point via -ss) → volume → fade in/out          → [m]
//   [m][0:a] sidechaincompress (key = voiceover) ducks the music         → [duck]
//   [0:a][duck] amix keeps the voiceover full and lays the ducked bed under it
// Video is stream-copied (-c:v copy): the picture is untouched, so a music change is
// an audio-only re-mux in seconds, never a re-render.
//
// Looping: when loop is on and the bed is shorter than the video, -stream_loop -1
// repeats it and -t bounds the output to the video length. NOTE (open item): a hard
// loop seam can click; a loop-point crossfade is the planned refinement — verify the
// seam during the Lambda checkpoint and slot acrossfade in here if audible.

export interface RemuxArgsInput {
  videoPath: string; // local path to the base MP4 (voiceover, no music)
  musicPath: string; // local path to the chosen track
  outPath: string; // local path to write the final MP4
  videoDurationSec: number; // bounds the looped/faded bed
  params: Partial<MusicParams> | null | undefined;
}

// Map duckingDepth 0..1 → sidechaincompress ratio ~1..20 (deeper = more ducking).
function duckRatio(depth: number): number {
  return Math.round((1 + depth * 19) * 100) / 100;
}

// Trim a float to a stable, ffmpeg-friendly string (no exponent, no trailing noise).
function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

export function buildRemuxArgs(input: RemuxArgsInput): string[] {
  const p = canonicalizeMusicParams(input.params);
  const dur = Math.max(0, input.videoDurationSec);
  const fadeOutStart = Math.max(0, dur - p.fadeOutSec);

  const musicChain = [
    `volume=${f(p.masterVolume)}`,
    `afade=t=in:st=0:d=${f(p.fadeInSec)}`,
    `afade=t=out:st=${f(fadeOutStart)}:d=${f(p.fadeOutSec)}`,
  ].join(',');

  const filter = [
    `[1:a]${musicChain}[m]`,
    `[m][0:a]sidechaincompress=threshold=0.03:ratio=${f(duckRatio(p.duckingDepth))}:attack=20:release=300[duck]`,
    `[0:a][duck]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
  ].join(';');

  const args: string[] = ['-y'];
  // Main input: the base video (voiceover in 0:a).
  args.push('-i', input.videoPath);
  // Music input: crop in-point with -ss, optionally loop, BEFORE -i (input options).
  if (p.cropStartSec > 0) args.push('-ss', f(p.cropStartSec));
  if (p.loop) args.push('-stream_loop', '-1');
  args.push('-i', input.musicPath);

  args.push('-filter_complex', filter);
  args.push('-map', '0:v', '-map', '[aout]');
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', f(dur));
  args.push('-movflags', '+faststart');
  args.push(input.outPath);
  return args;
}
