// Pure helpers for script generation — no server-only imports, so they can be
// unit-tested directly. The Inngest worker composes these with the Anthropic
// client and the Supabase admin client.
import { z } from 'zod';

// --- The shape the model must emit, one scene per NDJSON line ----------------
export const generatedShotSchema = z.object({
  position: z.number().int().positive(),
  description: z.string().default(''),
  source: z.enum(['stock', 'resource', 'procedural']).default('stock'),
  stockQuery: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

export const generatedSceneSchema = z.object({
  position: z.number().int().positive(),
  narration: z.string().min(1),
  durationSeconds: z.number().positive().optional(),
  shots: z.array(generatedShotSchema).default([]),
});

export type GeneratedScene = z.infer<typeof generatedSceneSchema>;

// --- Video config (single source of truth: video.settings) -------------------
export type VideoConfig = {
  aspectRatio: string; // e.g. "9:16"
  targetLengthSeconds: number;
  fps: number;
  captions: boolean;
  music: boolean;
};

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  aspectRatio: '9:16',
  targetLengthSeconds: 30,
  fps: 30,
  captions: false,
  music: false,
};

export type BrandContext = {
  channelName: string;
  tone?: string;
};

// --- NDJSON line accumulator -------------------------------------------------
// Feed it raw text deltas; it returns complete (newline-terminated) lines and
// buffers any partial trailing text until its newline arrives. flush() returns
// whatever remains once the stream ends.
export function createNdjsonAccumulator() {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) lines.push(line);
      }
      return lines;
    },
    flush(): string[] {
      const line = buffer.trim();
      buffer = '';
      return line ? [line] : [];
    },
  };
}

// Parse + validate a single NDJSON line into a scene. Returns null on any
// malformed line (the worker counts these and continues).
export function parseSceneLine(line: string): GeneratedScene | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const result = generatedSceneSchema.safeParse(json);
  return result.success ? result.data : null;
}

// Map a validated scene to the upsert_scene_with_shots RPC arguments. Shots use
// snake_case keys to match what the SQL function reads from the jsonb array.
export function sceneToRpcArgs(scene: GeneratedScene, accountId: string, videoId: string) {
  return {
    p_account_id: accountId,
    p_video_id: videoId,
    p_position: scene.position,
    p_narration: scene.narration,
    p_duration_seconds: scene.durationSeconds ?? null,
    p_shots: scene.shots.map((s) => ({
      position: s.position,
      description: s.description,
      source: s.source,
      stock_query: s.stockQuery ?? null,
      duration_seconds: s.durationSeconds ?? null,
    })),
  };
}

// --- Prompt construction -----------------------------------------------------
export function buildSystemPrompt(): string {
  return [
    'You are a scriptwriter for short-form vertical videos.',
    'You turn a prompt into a sequence of scenes, each with narration and a few shots.',
    '',
    'OUTPUT FORMAT — read carefully:',
    '- Output ONLY NDJSON: one JSON object per line, one object per scene.',
    '- Do NOT wrap the output in an array, code fences, or any prose.',
    '- Each line must be a complete, valid JSON object on a single line.',
    '',
    'Each scene object has exactly these fields:',
    '  "position": integer starting at 1, increasing by 1 per scene',
    '  "narration": the spoken voiceover for the scene (one or two sentences)',
    '  "durationSeconds": estimated spoken length of the narration, in seconds',
    '  "shots": array of shot objects, each:',
    '     "position": integer starting at 1 within the scene',
    '     "description": what is on screen (the visual intent)',
    '     "source": one of "stock", "resource", or "procedural"',
    '     "stockQuery": a short search query (include only when source is "stock")',
    '',
    'Guidance: prefer "stock" for real footage (always give a stockQuery), and',
    '"procedural" for text/animation/diagrams. Keep 1-3 shots per scene.',
  ].join('\n');
}

export function buildUserPrompt(
  userPrompt: string,
  brand: BrandContext,
  config: VideoConfig,
): string {
  const lines = [
    `Channel: ${brand.channelName}`,
  ];
  if (brand.tone) lines.push(`Brand tone: ${brand.tone}`);
  lines.push(
    `Format: ${config.aspectRatio} vertical video, ~${config.targetLengthSeconds}s total, ${config.fps}fps.`,
    'Make the scene durations add up to roughly the target length.',
    '',
    'Video prompt:',
    userPrompt,
  );
  return lines.join('\n');
}
