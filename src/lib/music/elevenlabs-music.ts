import 'server-only';
import { serverEnv } from '../env.server';

// ElevenLabs Music API (Phase 6) — generates the instrumental beds that seed a
// channel's music library (spec 4.2.3; Pexels Audio is discontinued, so we generate
// instead). Reuses the existing ELEVENLABS_API_KEY. This is the ONLY place music is
// generated — reroll is reselection from the seeded library, never regeneration — so
// spend stays confined to the one-off seed run.
//
// OPEN ITEM (confirm at run time): /v1/music may stream/return audio synchronously
// (the simple case handled here) or enqueue an async job. If your account's endpoint
// is async, adapt this to poll the job before returning bytes.

const BASE = 'https://api.elevenlabs.io/v1';

export interface ComposeMusicParams {
  prompt: string;
  lengthMs: number; // 3000..600000 per the API
  outputFormat?: string; // e.g. 'mp3_44100_128'
}

export async function composeMusic(p: ComposeMusicParams): Promise<Buffer> {
  const res = await fetch(`${BASE}/music`, {
    method: 'POST',
    headers: { 'xi-api-key': serverEnv.elevenlabs.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: p.prompt,
      music_length_ms: p.lengthMs,
      force_instrumental: true,
      ...(p.outputFormat ? { output_format: p.outputFormat } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs Music ${res.status}: ${body.slice(0, 500)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('ElevenLabs Music returned empty audio');
  return buf;
}
