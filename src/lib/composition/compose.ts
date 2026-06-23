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
import type { StockCandidate, StockSearchParams } from '../assets/candidate';
import type { CaptionFocus } from '../captions/types';
import type { VisualBrief } from '@/lib/videos/visual-brief';

const CAPTION_FOCUSES: readonly CaptionFocus[] = ['visual', 'text', 'balanced'];

export interface SceneBrief {
  id: string;
  position: number;
  narration: string;
  shotHints: string[]; // the shots' descriptions/intents from the script
  durationInFrames: number; // system-fixed, from the synthesized audio
  voiceoverAssetId?: string; // manifest id for this scene's audio
  // Channel resources pinned to this scene's shots (source='resource'). The AI MUST
  // place these as the scene's primary visual (see buildCompositionUserPrompt).
  pinnedResources?: { assetId: string; kind: 'image' | 'video'; description: string }[];
}

export interface CompositionBrief {
  metadata: CompositionMetadata;
  theme: Theme;
  assets: AssetManifestEntry[];
  scenes: SceneBrief[];
  // The primitive registry the AI may compose with (Phase 7): starter set ∪ the
  // account's active+deployed authored primitives. Omitted ⇒ STARTER_REGISTRY.
  registry?: StarterRegistry;
}

// What the AI returns: per-scene instance lists, nothing else.
export interface AiComposition {
  scenes: { sceneId: string; captionFocus?: CaptionFocus; instances: PrimitiveInstance[] }[];
}

// --- prompts ----------------------------------------------------------------

// The stock-search tool the composition AI calls during the agentic loop (spec 8.8).
export const SEARCH_STOCK_TOOL = {
  name: 'search_stock',
  description:
    'Search Pexels/Pixabay for real photos or video footage to use as a scene background or visual. Returns candidates WITH thumbnails you can look at; choose the best fit by its assetId and reference it in an Image or Video instance. Call this for shots that want real footage; refine the query if nothing fits.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms describing the visual you want (concrete nouns work best).' },
      kind: { type: 'string', enum: ['image', 'video'], description: "'image' for a still, 'video' for footage." },
      orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: 'Match the video aspect — portrait for 9:16.' },
    },
    required: ['query', 'kind'],
  },
} as const;

// An Anthropic content block (text or image); the tool result mixes both so the
// model can read the candidate ids AND see their thumbnails. Image source is base64
// when the thumbnail was pre-fetched server-side (preferred), else a URL.
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } };

// Build the search_stock tool result: a header + per-candidate (id line + thumbnail
// image) so the vision model can look and pick. Capped to bound vision tokens. A
// candidate with neither a base64 thumbnail nor a URL is shown without an image.
export function buildStockToolResult(candidates: StockCandidate[], max = 6): ContentBlock[] {
  if (candidates.length === 0) {
    return [{ type: 'text', text: 'No candidates found. Refine the query, try the other kind, or compose this shot procedurally with Shape/Text.' }];
  }
  const blocks: ContentBlock[] = [
    { type: 'text', text: `Found ${candidates.length} candidates (showing ${Math.min(max, candidates.length)}). Pick by assetId:` },
  ];
  for (const c of candidates.slice(0, max)) {
    blocks.push({ type: 'text', text: `assetId="${c.assetId}" — ${c.kind} ${c.width}x${c.height}, ${c.attribution}` });
    if (c.thumbnailBase64) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: c.thumbnailMediaType ?? 'image/jpeg', data: c.thumbnailBase64 } });
    } else if (c.thumbnailUrl) {
      blocks.push({ type: 'image', source: { type: 'url', url: c.thumbnailUrl } });
    }
  }
  return blocks;
}

export function buildCompositionSystemPrompt(
  registry: StarterRegistry = STARTER_REGISTRY,
  opts: { stockEnabled?: boolean } = {},
): string {
  const primitives = Object.entries(registry)
    // A primitive with no active props is not offered (e.g. the deprecated
    // KineticText — captions now own emphasis). It stays renderable for in-flight
    // specs, but the AI is never shown it, so no new spec places it.
    .filter(([, prim]) => aiFacingSchema(prim.propSchema).length > 0)
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

  const backgroundRule = opts.stockEnabled
    ? '- Backgrounds: prefer REAL footage — search_stock for a fitting photo/video and place it as an Image or Video at layer 0 (fit "cover"). Use a solid FullBleed only when no candidate fits or for a deliberately graphic scene.'
    : '- Every scene needs a background — start each scene with a FullBleed (layer 0). Compose from these graphic/typographic primitives only (no stock footage available).';

  const stockSection = opts.stockEnabled
    ? [
        '',
        'Stock footage (agentic):',
        '- For each scene, decide if real footage strengthens it; if so call search_stock',
        '  (orientation portrait for 9:16), LOOK at the returned thumbnails, and choose the',
        '  best candidate by its assetId — good composition/mood, not a cliché, no watermark.',
        '- Reference the chosen assetId in an Image (still) or Video (footage) instance.',
        '- Refine the query or try the other kind if nothing fits; fall back to a graphic',
        '  scene (Shape/Text on a FullBleed) rather than forcing a bad match.',
        '- When done searching, output the final JSON (no tool call).',
      ]
    : [];

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
    backgroundRule,
    '- If a scene lists PINNED resources, you MUST use them as its primary visual (Image/Video',
    '  at layer 0) and not search stock for that scene — a pin is an explicit operator choice.',
    "- Layer instances bottom-up with integer `layer` (higher = in front).",
    '- Each instance has `startFrame` (≥0, relative to the scene) and `durationInFrames`',
    '  (>0). startFrame + durationInFrames must NOT exceed the scene duration.',
    '- Keep on-screen text short enough to read; the narration is spoken, not shown verbatim.',
    '',
    'Captions (the system burns these in — you must leave room for them):',
    '- Animated captions show the SPOKEN words, with emphasis, low-to-centre of frame.',
    '  They are the PRIMARY on-screen text. Do NOT add a Text primitive that repeats or',
    '  paraphrases the narration (e.g. a headline of what is being said) — the captions',
    '  already show it; doing so double-prints and collides.',
    '- Keep focal instances (Text, bars/charts, large Shapes) OUT of the caption band.',
    '  Full-frame backgrounds at layer 0 (Image/Video/FullBleed) are fine underneath.',
    '- The Text primitive renders CENTRED vertically (only `align` is horizontal), so a',
    '  Text headline sits exactly where centred captions go. Use Text sparingly — for a',
    '  label or a title on a scene with little/no narration — not as a headline over captions.',
    '  If you DO place a centred Text, set that scene\'s captionFocus to "visual" so the',
    '  captions sit in the lower third, clear of it.',
    '- Set each scene\'s "captionFocus" to place the caption band by what the scene leads with:',
    '    "visual"  → footage is the point: captions drop to the lower third and shrink.',
    '                Best when you place striking Image/Video. Keep the rest of the frame clear.',
    '    "text"    → the words are the point (a claim, hook, punchline): captions sit centre,',
    '                larger. Do NOT also place a centred Text here — the captions ARE that text.',
    '    "balanced" (default, omit the field) → captions sit lower-centre; avoid centred Text',
    '                that reaches the lower half of the frame.',
    ...stockSection,
    '',
    'Final answer: output ONLY a single JSON object, no prose, no markdown fences:',
    '{"scenes":[{"sceneId":"<id>","captionFocus":"visual|text|balanced","instances":[',
    '  {"primitive":"Image","props":{"asset":"<assetId>","fit":"cover"},"layer":0,"startFrame":0,"durationInFrames":<sceneDuration>},',
    '  {"primitive":"Text","props":{"text":"...","colorToken":"foreground","fontSizePx":84,"align":"center"},"layer":1,"startFrame":6,"durationInFrames":<...>}',
    ']}]}',
    '(captionFocus is optional — omit it for "balanced".)',
  ].join('\n');
}

// Render one shot's intent for the composition prompt. With a visual brief (Slice C1)
// it produces a richer, entity-aware hint than the terse description: subject/action/
// setting as the core, framing/mood as qualifiers, and — for a specific named entity —
// an explicit directive to use the pinned/uploaded asset rather than generic stock.
// A null brief (legacy/unbriefed shot) returns the description unchanged.
export function formatShotHint(brief: VisualBrief | null, description: string): string {
  if (!brief) return description;
  const core =
    [brief.subject, brief.action, brief.setting]
      .map((p) => p.trim())
      .filter(Boolean)
      .join(', ') || description.trim();
  const qualifiers = [brief.framing, brief.mood].map((p) => p.trim()).filter(Boolean);
  let hint = qualifiers.length ? `${core} (${qualifiers.join('; ')})` : core;
  if (brief.specificity === 'entity') {
    const name = brief.entity_name ? `"${brief.entity_name}"` : 'a specific named entity';
    hint += ` — SPECIFIC ENTITY (${name}): use the pinned/uploaded asset if present; do not substitute generic stock.`;
  }
  return hint || description;
}

export function buildCompositionUserPrompt(brief: CompositionBrief): string {
  const theme = brief.theme;
  const colorTokens = Object.keys(theme.colors).join(', ');
  const scenes = brief.scenes
    .map((s) => {
      const hints = s.shotHints.length ? s.shotHints.map((h) => `    - ${h}`).join('\n') : '    (none)';
      const lines = [
        `Scene ${s.position} (sceneId "${s.id}", durationInFrames ${s.durationInFrames}):`,
        `  narration: ${JSON.stringify(s.narration)}`,
        `  shot intents:`,
        hints,
      ];
      if (s.pinnedResources && s.pinnedResources.length > 0) {
        lines.push(
          '  PINNED resources (you MUST place these as this scene\'s primary visual — an',
          '  Image/Video at layer 0, fit "cover"; do NOT search stock for this scene\'s background):',
          ...s.pinnedResources.map((r) => `    - ${r.assetId} (${r.kind}): ${r.description}`),
        );
      }
      return lines.join('\n');
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
    // captionFocus is optional; drop an unknown value (renderer defaults to balanced).
    if (s.captionFocus !== undefined && !CAPTION_FOCUSES.includes(s.captionFocus)) {
      delete s.captionFocus;
    }
  }
  return { scenes };
}

// --- agentic selection loop (spec 8.8) -------------------------------------
//
// The composition becomes a manual tool-use loop when the channel has stock keys:
// Sonnet (vision) calls search_stock, LOOKS at the candidate thumbnails returned as
// image content blocks, and picks the best fit by assetId — refining the query until
// it emits the final JSON. We own the loop (not the SDK tool-runner) so we can cache,
// govern, and accumulate the candidate registry the system resolves afterwards.
//
// The model call and the stock search are injected so the orchestration is pure and
// unit-testable offline (pure-vs-server split, like Phase 2/3). render.ts supplies the
// real Sonnet stream + searchStock at integration time.

// A content block the model emits or we send back (Anthropic message shape, kept
// minimal so this module needs no SDK import). Unknown block types pass through
// verbatim so thinking blocks survive in history (adaptive thinking interleaves them).
export type LoopBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

export interface LoopMessage {
  role: 'user' | 'assistant';
  content: string | LoopBlock[];
}

// One model turn (the subset of an Anthropic Message we act on).
export interface ModelTurn {
  content: LoopBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgenticDeps {
  // Run one model turn given the system prompt + running message history.
  callModel: (system: string, messages: LoopMessage[]) => Promise<ModelTurn>;
  // Search stock (system side: cache → providers), mapping the tool input to params.
  searchStock: (params: StockSearchParams) => Promise<StockCandidate[]>;
  maxTurns?: number; // safety cap on tool round-trips (default 8)
  onSearch?: (params: StockSearchParams, count: number) => void; // observability hook
  feedback?: string; // Gate-1 feedback from a prior attempt, appended to the seed turn
}

export interface AgenticResult {
  ai: AiComposition | null; // null if the loop never produced parseable JSON
  registry: Map<string, StockCandidate>; // every candidate shown, by assetId
  tokensIn: number;
  tokensOut: number;
  turns: number;
  stopReason: string | null;
}

// Coerce a search_stock tool input into validated StockSearchParams.
export function normalizeSearchParams(input: Record<string, unknown>): StockSearchParams {
  const kind = input.kind === 'video' ? 'video' : 'image';
  const orientation =
    input.orientation === 'landscape' || input.orientation === 'square' ? input.orientation : 'portrait';
  return {
    query: typeof input.query === 'string' ? input.query : '',
    kind,
    orientation,
  };
}

// Run the agentic selection loop. Returns the AI's composition + the candidate
// registry (so the system can resolve only the assetIds the AI actually referenced).
export async function runAgenticComposition(
  brief: CompositionBrief,
  deps: AgenticDeps,
): Promise<AgenticResult> {
  const composeRegistry = brief.registry ?? STARTER_REGISTRY;
  const system = buildCompositionSystemPrompt(composeRegistry, { stockEnabled: true });
  const userPrompt = deps.feedback
    ? `${buildCompositionUserPrompt(brief)}\n\n${deps.feedback}`
    : buildCompositionUserPrompt(brief);
  const messages: LoopMessage[] = [{ role: 'user', content: userPrompt }];
  const registry = new Map<string, StockCandidate>();
  const maxTurns = deps.maxTurns ?? 8;
  let tokensIn = 0;
  let tokensOut = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await deps.callModel(system, messages);
    tokensIn += res.usage.inputTokens;
    tokensOut += res.usage.outputTokens;
    // Preserve the FULL assistant content (text + thinking + tool_use) in history —
    // interleaved thinking blocks must survive across tool turns or the API rejects them.
    messages.push({ role: 'assistant', content: res.content });

    const toolUses = res.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // No tool call → this turn is the final answer. Parse the JSON from its text.
      const text = res.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { ai: parseComposition(text), registry, tokensIn, tokensOut, turns: turn + 1, stopReason: res.stopReason };
    }

    // Execute each search_stock call and feed the candidates (with thumbnails) back.
    const toolResults: LoopBlock[] = [];
    for (const tu of toolUses) {
      if (tu.name !== SEARCH_STOCK_TOOL.name) {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: [{ type: 'text', text: `Unknown tool: ${tu.name}` }] });
        continue;
      }
      const params = normalizeSearchParams(tu.input);
      const candidates = await deps.searchStock(params);
      for (const c of candidates) registry.set(c.assetId, c);
      deps.onSearch?.(params, candidates.length);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: buildStockToolResult(candidates) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Exhausted the turn budget without a final answer.
  return { ai: null, registry, tokensIn, tokensOut, turns: maxTurns, stopReason: 'max_turns' };
}

// --- asset resolution (spec 8.3 / 13.6) ------------------------------------
//
// After the loop, the AI's instances reference assetIds in `asset`-typed props. We
// resolve ONLY the ids it actually used (not every candidate it browsed): collect the
// referenced ids, plan which are stock candidates to download, and the server side
// (assets/resolve.ts) downloads+caches them into manifest entries. Pure here; the
// download/R2 side lives in a server module.

// Walk the AI's instances and collect every value sitting in an `asset`-typed prop
// (per the primitive schema). These are the asset ids the render must resolve.
export function collectReferencedAssetIds(
  ai: AiComposition,
  registry: StarterRegistry = STARTER_REGISTRY,
): Set<string> {
  const ids = new Set<string>();
  for (const scene of ai.scenes) {
    for (const inst of scene.instances) {
      const prim = registry[inst.primitive];
      if (!prim) continue;
      for (const def of prim.propSchema) {
        if (def.type !== 'asset') continue;
        const v = (inst.props ?? {})[def.name];
        if (typeof v === 'string') ids.add(v);
      }
    }
  }
  return ids;
}

// One chosen stock asset to download into the manifest.
export interface StockResolution {
  assetId: string;
  kind: StockCandidate['kind'];
  downloadUrl: string;
  attribution: string;
}

// Of the referenced ids, keep the ones that are stock candidates (in the loop's
// registry), de-duped. Ids not in the registry are resources or hallucinations:
// resources resolve separately; a hallucinated id simply won't be in the manifest,
// so Gate 1's asset-ref check fails it (the AI can't invent media).
export function planStockResolution(
  referenced: Iterable<string>,
  candidates: Map<string, StockCandidate>,
): StockResolution[] {
  const plan: StockResolution[] = [];
  const seen = new Set<string>();
  for (const id of referenced) {
    if (seen.has(id)) continue;
    const c = candidates.get(id);
    if (!c) continue;
    seen.add(id);
    plan.push({ assetId: id, kind: c.kind, downloadUrl: c.downloadUrl, attribution: c.attribution });
  }
  return plan;
}

// Assemble the full, durable (key-based) spec from the AI's instances + the brief.
// Scenes the AI omitted get an empty instance list (Gate 1 will flag them).
export function assembleSpec(ai: AiComposition, brief: CompositionBrief): CompositionSpec {
  const byScene = new Map(ai.scenes.map((s) => [s.sceneId, s]));
  return {
    version: 2,
    metadata: brief.metadata,
    theme: brief.theme,
    assets: brief.assets,
    scenes: brief.scenes.map((s) => {
      const ai = byScene.get(s.id);
      return {
        id: s.id,
        durationInFrames: s.durationInFrames,
        ...(s.voiceoverAssetId ? { voiceover: { assetId: s.voiceoverAssetId } } : {}),
        ...(ai?.captionFocus ? { captionFocus: ai.captionFocus } : {}),
        instances: ai?.instances ?? [],
      };
    }),
  };
}

