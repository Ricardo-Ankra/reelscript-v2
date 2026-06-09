import 'server-only';
import { serverEnv } from '../env.server';
import {
  decodeTtsResponse,
  type TtsAlignment,
  type TtsRawResponse,
  type VoiceSettings,
} from './alignment';

// Server-only ElevenLabs client. One simple REST call per scene against the
// with-timestamps endpoint (no SDK dependency — the endpoint is trivial). The
// caller passes text already run through the fallback voice profile (tags stripped,
// <pause> → SSML break); this module just synthesizes it.
//
// Phase 3 keeps failure handling minimal: a non-2xx throws with status + body so
// the Inngest function's retries/onFailure surface it. The full taxonomy
// (Retry-After honouring, quota-pause/resume) is Phase 9 (spec 15).

export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

// A well-known premade public voice ("Rachel"), so the seeded channel synthesizes
// out of the box without the user choosing one. Swapped for a real selection when
// the voice UI lands (Phase 8). Resolution prefers the channel's own voice_tts and
// only falls back to this when it is unset or the Phase-2 'placeholder'.
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export type { VoiceSettings };

export type SynthesizeParams = {
  text: string;
  voiceId: string;
  modelId?: string;
  voiceSettings?: VoiceSettings;
};

export type SynthesisResult = {
  audio: Buffer;
  alignment: TtsAlignment;
  durationSeconds: number;
};

export async function synthesize(params: SynthesizeParams): Promise<SynthesisResult> {
  const { text, voiceId, modelId = ELEVENLABS_DEFAULT_MODEL, voiceSettings } = params;

  const res = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': serverEnv.elevenlabs.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as TtsRawResponse;
  return decodeTtsResponse(json);
}
