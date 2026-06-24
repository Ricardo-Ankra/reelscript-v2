// Pure helpers for script generation — no server-only imports, so they can be
// unit-tested directly. The Inngest worker composes these with the Anthropic
// client and the Supabase admin client.
import { z } from 'zod';
import { classifyBeat } from '../videos/classify-beat';

// --- The shape the model must emit, one scene per NDJSON line ----------------

// The visual brief the model authors per shot (camelCase in AI output; stored
// snake_case — see sceneToRpcArgs). Drives the editor, the readiness gate, and
// (slice C2) the resolver router.
export const generatedVisualBriefSchema = z.object({
  subject: z.string().default(''),
  action: z.string().default(''),
  setting: z.string().default(''),
  framing: z.string().default(''),
  mood: z.string().default(''),
  specificity: z.enum(['generic', 'entity', 'abstract', 'spokesperson']).default('generic'),
  entityName: z.string().optional(),
  recommendedSource: z.enum(['stock', 'upload', 'generate', 'primitive']).default('stock'),
});

// Cinematography the model authors for generative-bound shots (camelCase in AI
// output; stored snake_case via sceneToRpcArgs). Optional everywhere.
export const generatedCameraSchema = z.object({
  shotSize: z.enum(['ECU', 'CU', 'MS', 'WS', 'EWS', 'two_shot', 'OTS', 'POV']).default('MS'),
  angle: z.enum(['eye_level', 'low', 'high', 'dutch', 'aerial', 'overhead']).default('eye_level'),
  move: z.enum([
    'static', 'dolly_in', 'dolly_out', 'arc_left', 'arc_right', 'orbit_360',
    'crane_up', 'crane_down', 'tracking', 'pan_left', 'pan_right', 'tilt_up',
    'tilt_down', 'whip_pan', 'push_in', 'pull_back', 'handheld', 'bullet_time',
    'boom', 'snorricam', 'fpv_drone',
  ]).default('static'),
  lensMm: z.number().int().default(35),
  dof: z.enum(['shallow', 'deep', 'rack_focus']).default('shallow'),
  motionStrength: z.number().min(0).max(1).default(0.7),
});

export const generatedLightingSchema = z.object({
  key: z.string().default('soft key from frame left'),
  ratio: z.string().default('3:1'),
  timeOfDay: z.string().default('golden hour'),
  palette: z.string().default('teal shadows, warm highlights'),
  texture: z.string().default('subtle film grain'),
});

export const generatedShotSchema = z.object({
  position: z.number().int().positive(),
  description: z.string().default(''),
  source: z.enum(['stock', 'resource', 'procedural']).default('stock'),
  stockQuery: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  visualBrief: generatedVisualBriefSchema.optional(),
  camera: generatedCameraSchema.optional(),
  lighting: generatedLightingSchema.optional(),
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
  captions: true, // captions on by default (the animated caption track is the headline feature)
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
    p_shots: scene.shots.map((s) => {
      const specificity = s.visualBrief?.specificity ?? 'generic';
      const recommendedSource = s.visualBrief?.recommendedSource ?? 'stock';
      const kind = classifyBeat(specificity, recommendedSource);
      return {
        position: s.position,
        description: s.description,
        source: s.source,
        stock_query: s.stockQuery ?? null,
        duration_seconds: s.durationSeconds ?? null,
        visual_brief: s.visualBrief
          ? {
              subject: s.visualBrief.subject,
              action: s.visualBrief.action,
              setting: s.visualBrief.setting,
              framing: s.visualBrief.framing,
              mood: s.visualBrief.mood,
              specificity: s.visualBrief.specificity,
              entity_name:
                s.visualBrief.specificity === 'entity' ? (s.visualBrief.entityName ?? null) : null,
              recommended_source: s.visualBrief.recommendedSource,
            }
          : null,
        kind,
        camera_spec: s.camera
          ? {
              shot_size: s.camera.shotSize,
              angle: s.camera.angle,
              move: s.camera.move,
              lens_mm: s.camera.lensMm,
              dof: s.camera.dof,
              motion_strength: s.camera.motionStrength,
            }
          : null,
        lighting_spec: s.lighting
          ? {
              key: s.lighting.key,
              ratio: s.lighting.ratio,
              time_of_day: s.lighting.timeOfDay,
              palette: s.lighting.palette,
              texture: s.lighting.texture,
            }
          : null,
        provenance: {
          synthetic: kind === 'generative',
          source: null,
          model: null,
          seed: null,
          source_uri: null,
          created_at: null,
          operator: null,
        },
        hero: false,
        needs_speech: false,
        broadcast_4k: false,
      };
    }),
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
    '     "visualBrief": a structured description of the shot (author this for EVERY shot):',
    '        "subject": what is on screen, "action": what happens, "setting": where,',
    '        "framing": shot type (wide/close-up/aerial/screen-recording/…),',
    '        "mood": tone/lighting,',
    '        "specificity": one of "generic" (a generic concept stock can show),',
    '          "entity" (a SPECIFIC named real product/person/place stock cannot reliably show),',
    '          "abstract" (branded motion/stylized/data-viz), "spokesperson" (a talking head),',
    '        "entityName": the exact name (REQUIRED when specificity is "entity"),',
    '        "recommendedSource": one of "stock", "upload", "generate", "primitive"',
    '          (use "upload" when specificity is "entity" — only operator footage is reliable).',
    '     "camera" and "lighting" (author ONLY when recommendedSource is "generate"; omit otherwise):',
    '        "camera": { "shotSize": one of ECU/CU/MS/WS/EWS/two_shot/OTS/POV,',
    '          "angle": eye_level/low/high/dutch/aerial/overhead,',
    '          "move": EXACTLY ONE of static/dolly_in/dolly_out/arc_left/arc_right/orbit_360/',
    '            crane_up/crane_down/tracking/pan_left/pan_right/tilt_up/tilt_down/whip_pan/',
    '            push_in/pull_back/handheld/bullet_time/boom/snorricam/fpv_drone (never stack moves),',
    '          "lensMm": 24 wide / 35 standard / 85 portrait, "dof": shallow/deep/rack_focus,',
    '          "motionStrength": a number 0..1 }',
    '        "lighting": { "key", "ratio" (e.g. "3:1"), "timeOfDay", "palette", "texture" }',
    '',
    'Guidance: prefer "stock" for real footage (always give a stockQuery), and',
    '"procedural" for text/animation/diagrams. Keep 1-3 shots per scene. Be honest in',
    '"specificity": if a shot names a specific real product/person/place, mark it "entity".',
    '',
    'DELIVERY TAGS (optional, use SPARINGLY — at most one or two per scene, only',
    'where they genuinely improve delivery; most scenes need none):',
    '- Place an inline tag from this fixed set directly in the narration text:',
    '  <excited> <pause> <whisper> <emphatic> <calm> <curious> <serious>',
    '- They are non-spoken delivery directives, not words. <pause> inserts a short',
    '  beat; the others colour the surrounding delivery.',
    '- Use ONLY these exact tags (any other tag is ignored). Do not stack them.',
    '- Example: "This changes everything. <pause> <excited> Let us dig in."',
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
