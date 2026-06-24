// Pure ffprobe-JSON normalizer (V2 Slice 2a). Never throws — every field defaults so a
// missing/garbage probe yields zeros rather than crashing the ingest pipeline (2b).
// RawProbe is the loose shape ffprobe emits; ProbeResult is the typed digest 2b uses.

export interface RawProbe {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

export interface ProbeResult {
  width: number; // first video stream width (0 if none)
  height: number; // first video stream height (0 if none)
  durationSec: number; // format.duration, else first stream duration, else 0
  fps: number; // avg_frame_rate "num/den" rounded (0 if none/0-den)
  hasAudio: boolean; // any stream codec_type === 'audio'
  rotation: number; // normalized to {0,90,180,270}; metadata only (not re-applied)
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function parseFps(v: unknown): number {
  if (typeof v !== 'string' || !v.includes('/')) return 0;
  const [n, d] = v.split('/');
  const den = Number(d);
  const numr = Number(n);
  if (!Number.isFinite(den) || den === 0 || !Number.isFinite(numr)) return 0;
  return Math.round(numr / den);
}

function normalizeRotation(deg: number): number {
  const r = ((Math.round(deg) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

function videoStream(raw: RawProbe): Record<string, unknown> | null {
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  return streams.find((x) => x && x.codec_type === 'video') ?? null;
}

function rotationOf(vs: Record<string, unknown> | null): number {
  if (!vs) return 0;
  const sdl = vs.side_data_list;
  if (Array.isArray(sdl)) {
    for (const sd of sdl) {
      if (sd && typeof sd === 'object' && 'rotation' in sd) {
        return normalizeRotation(num((sd as Record<string, unknown>).rotation));
      }
    }
  }
  const tags = vs.tags;
  if (tags && typeof tags === 'object' && 'rotate' in tags) {
    return normalizeRotation(num((tags as Record<string, unknown>).rotate));
  }
  return 0;
}

export function parseProbe(raw: RawProbe): ProbeResult {
  const vs = videoStream(raw);
  const fmtDur = raw.format ? num(raw.format.duration) : 0;
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  return {
    width: vs ? num(vs.width) : 0,
    height: vs ? num(vs.height) : 0,
    durationSec: fmtDur > 0 ? fmtDur : vs ? num(vs.duration) : 0,
    fps: vs ? parseFps(vs.avg_frame_rate ?? vs.r_frame_rate) : 0,
    hasAudio: streams.some((x) => x && x.codec_type === 'audio'),
    rotation: rotationOf(vs),
  };
}
