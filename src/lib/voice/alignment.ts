// Pure parsing for the ElevenLabs with-timestamps response (no secrets, no
// network — kept separate from elevenlabs.ts so it is unit-testable; the server
// client carries `server-only` and cannot be imported by the node test runner).
//
// Shape confirmed against the live docs (POST /v1/text-to-speech/{voice_id}/
// with-timestamps): base64 audio + character-level alignment in SECONDS.

export type TtsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

// ElevenLabs voice settings (override the voice's stored defaults for one request).
// Lives here (pure) so the Inngest event payload type can reference it without
// importing the server-only client.
export type VoiceSettings = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
};

export type TtsRawResponse = {
  audio_base64?: string;
  alignment?: TtsAlignment | null;
  normalized_alignment?: TtsAlignment | null;
};

// The spoken duration is the last character's end time. This becomes the
// authoritative scenes.duration_seconds once audio exists (overwriting Phase 2's
// model estimate) — composition/kinetic-text timing reads it in later phases.
export function durationFromAlignment(alignment: TtsAlignment): number {
  const ends = alignment.character_end_times_seconds;
  if (!ends || ends.length === 0) return 0;
  return ends[ends.length - 1];
}

// Decode the raw JSON into the audio bytes + alignment + measured duration. Throws
// if the expected fields are absent rather than silently writing empty audio.
export function decodeTtsResponse(raw: TtsRawResponse): {
  audio: Buffer;
  alignment: TtsAlignment;
  durationSeconds: number;
} {
  if (!raw.audio_base64) throw new Error('ElevenLabs response missing audio_base64');
  if (!raw.alignment) throw new Error('ElevenLabs response missing alignment');
  const audio = Buffer.from(raw.audio_base64, 'base64');
  if (audio.length === 0) throw new Error('ElevenLabs returned empty audio');
  return {
    audio,
    alignment: raw.alignment,
    durationSeconds: durationFromAlignment(raw.alignment),
  };
}
