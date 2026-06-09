// Composition prompt-building + parsing (pure; the Sonnet call lives in the render
// Inngest function, like Phase 2's script-generation.ts vs generate-script.ts).
//
// Division of labour (spec 8.1/8.3): the AI authors ONLY the per-scene visual
// instances — it picks primitives, props, layering, and timing. Everything else in
// the spec (baked theme, audio-derived scene durations, voiceover bindings, asset
// manifest, metadata) is system-assembled around the AI's output, so the AI can't
// break the brand snapshot or the voice sync. Gate 1 then validates the assembly.
import type { Theme, PrimitiveInstance } from '../primitives/contract';
import { aiFacingSchema } from '../primitives/contract';
import type { StarterRegistry } from '../primitives/starter';
import { STARTER_REGISTRY } from '../primitives/starter';
import type {
  CompositionSpec,
  CompositionMetadata,
  AssetManifestEntry,
} from './spec';

export interface SceneBrief {
  id: string;
  position: number;
  narration: string;
  shotHints: string[]; // the shots' descriptions/intents from the script
  durationInFrames: number; // system-fixed, from the synthesized audio
  voiceoverAssetId?: string; // manifest id for this scene's audio
}

export interface CompositionBrief {
  metadata: CompositionMetadata;
  theme: Theme;
  assets: AssetManifestEntry[];
  scenes: SceneBrief[];
}

// What the AI returns: per-scene instance lists, nothing else.
export interface AiComposition {
  scenes: { sceneId: string; instances: PrimitiveInstance[] }[];
}

// --- prompts ----------------------------------------------------------------

export function buildCompositionSystemPrompt(
  registry: StarterRegistry = STARTER_REGISTRY,
): string {
  const primitives = Object.entries(registry)
    .map(([name, prim]) => {
      const props = aiFacingSchema(prim.propSchema)
        .map((p) => {
          const bits: string[] = [p.type];
          if (p.type === 'enum') bits.push(`one of ${JSON.stringify(p.enumValues)}`);
          if (p.type === 'token') bits.push(`a theme ${p.tokenGroup ?? 'colors'} token`);
          const req = p.required && p.default === undefined ? 'required' : `default ${JSON.stringify(p.default)}`;
          return `      - ${p.name} (${bits.join(', ')}; ${req})${p.description ? ` — ${p.description}` : ''}`;
        })
        .join('\n');
      return `  • ${name} — ${prim.meta.description}\n    props:\n${props}`;
    })
    .join('\n');

  return [
    'You are the composition engine for a short-form video studio. You arrange',
    'on-screen visuals for each scene of a video by emitting primitive INSTANCES.',
    'You do NOT write code, set durations, or choose the voiceover — those are fixed.',
    '',
    'Available primitives (use ONLY these, and ONLY the props listed):',
    primitives,
    '',
    'Rules:',
    '- Colour/token props must name a theme token from the provided theme (never a hex).',
    '- Every scene needs a background — start each scene with a FullBleed (layer 0).',
    "- Layer instances bottom-up with integer `layer` (higher = in front).",
    '- Each instance has `startFrame` (≥0, relative to the scene) and `durationInFrames`',
    '  (>0). startFrame + durationInFrames must NOT exceed the scene duration.',
    '- Keep on-screen text short enough to read; the narration is spoken, not shown verbatim.',
    '- Compose from these graphic/typographic primitives only (no stock footage yet).',
    '',
    'Output ONLY a single JSON object, no prose, no markdown fences:',
    '{"scenes":[{"sceneId":"<id>","instances":[',
    '  {"primitive":"FullBleed","props":{"colorToken":"background"},"layer":0,"startFrame":0,"durationInFrames":<sceneDuration>},',
    '  {"primitive":"Text","props":{"text":"...","colorToken":"foreground","fontSizePx":84,"align":"center"},"layer":1,"startFrame":6,"durationInFrames":<...>}',
    ']}]}',
  ].join('\n');
}

export function buildCompositionUserPrompt(brief: CompositionBrief): string {
  const theme = brief.theme;
  const colorTokens = Object.keys(theme.colors).join(', ');
  const scenes = brief.scenes
    .map((s) => {
      const hints = s.shotHints.length ? s.shotHints.map((h) => `    - ${h}`).join('\n') : '    (none)';
      return [
        `Scene ${s.position} (sceneId "${s.id}", durationInFrames ${s.durationInFrames}):`,
        `  narration: ${JSON.stringify(s.narration)}`,
        `  shot intents:`,
        hints,
      ].join('\n');
    })
    .join('\n\n');

  return [
    `Video: ${brief.metadata.width}x${brief.metadata.height} @ ${brief.metadata.fps}fps.`,
    `Theme colour tokens: ${colorTokens}. Fonts: display=${theme.fonts.display}, body=${theme.fonts.body}.`,
    '',
    'Compose visuals for each scene below. Emit instances for every scene, keyed by its',
    'sceneId, with timing within that scene\'s durationInFrames.',
    '',
    scenes,
  ].join('\n');
}

// --- parsing + assembly -----------------------------------------------------

// Parse the AI's JSON (tolerating accidental ```json fences) into AiComposition.
// Returns null on malformed JSON or wrong shape; Gate 1 does the deep validation.
export function parseComposition(text: string): AiComposition | null {
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/i, '')
    .trim();
  const candidate = stripped.startsWith('{') ? stripped : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as AiComposition).scenes)) {
    return null;
  }
  const scenes = (parsed as AiComposition).scenes;
  for (const s of scenes) {
    if (!s || typeof s.sceneId !== 'string' || !Array.isArray(s.instances)) return null;
  }
  return { scenes };
}

// Assemble the full, durable (key-based) spec from the AI's instances + the brief.
// Scenes the AI omitted get an empty instance list (Gate 1 will flag them).
export function assembleSpec(ai: AiComposition, brief: CompositionBrief): CompositionSpec {
  const instancesByScene = new Map(ai.scenes.map((s) => [s.sceneId, s.instances]));
  return {
    version: 2,
    metadata: brief.metadata,
    theme: brief.theme,
    assets: brief.assets,
    scenes: brief.scenes.map((s) => ({
      id: s.id,
      durationInFrames: s.durationInFrames,
      ...(s.voiceoverAssetId ? { voiceover: { assetId: s.voiceoverAssetId } } : {}),
      instances: instancesByScene.get(s.id) ?? [],
    })),
  };
}
