import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompositionSystemPrompt,
  buildCompositionUserPrompt,
  parseComposition,
  assembleSpec,
  normalizeSearchParams,
  runAgenticComposition,
  buildStockToolResult,
  collectReferencedAssetIds,
  collectKineticSpans,
  planStockResolution,
  SEARCH_STOCK_TOOL,
  type CompositionBrief,
  type ModelTurn,
  type LoopMessage,
} from './compose.ts';
import { validateSpec } from './gate1.ts';
import type { Theme } from '../primitives/contract.ts';
import type { StockCandidate } from '../assets/candidate.ts';

const theme: Theme = {
  colors: { background: '#000', foreground: '#fff', primary: '#00f', secondary: '#003', accent: '#fa0', bodyText: '#eee' },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

const brief: CompositionBrief = {
  metadata: { width: 1080, height: 1920, fps: 30, durationInFrames: 150 },
  theme,
  assets: [
    { id: 'vo-1', kind: 'audio', r2Key: 'audio/s1.mp3' },
    { id: 'vo-2', kind: 'audio', r2Key: 'audio/s2.mp3' },
  ],
  scenes: [
    { id: 'scene-1', position: 1, narration: 'Hello there', shotHints: ['a sunrise'], durationInFrames: 90, voiceoverAssetId: 'vo-1' },
    { id: 'scene-2', position: 2, narration: 'Goodbye', shotHints: [], durationInFrames: 60, voiceoverAssetId: 'vo-2' },
  ],
};

test('system prompt lists the starter primitives and their props', () => {
  const sys = buildCompositionSystemPrompt();
  for (const name of ['Text', 'Shape', 'FullBleed']) assert.ok(sys.includes(name), name);
  assert.ok(sys.includes('colorToken'));
  assert.ok(/theme colors token/i.test(sys)); // token props described
});

test('user prompt carries each scene id, duration, narration, and theme tokens', () => {
  const u = buildCompositionUserPrompt(brief);
  assert.ok(u.includes('scene-1') && u.includes('scene-2'));
  assert.ok(u.includes('durationInFrames 90'));
  assert.ok(u.includes('Hello there'));
  assert.ok(u.includes('accent')); // a theme colour token is offered
});

test('parseComposition: plain JSON', () => {
  const r = parseComposition('{"scenes":[{"sceneId":"scene-1","instances":[]}]}');
  assert.ok(r);
  assert.equal(r.scenes[0].sceneId, 'scene-1');
});

test('parseComposition: tolerates ```json fences', () => {
  const r = parseComposition('```json\n{"scenes":[{"sceneId":"a","instances":[]}]}\n```');
  assert.ok(r);
  assert.equal(r.scenes[0].sceneId, 'a');
});

test('parseComposition: malformed JSON → null', () => {
  assert.equal(parseComposition('not json'), null);
});

test('parseComposition: wrong shape → null', () => {
  assert.equal(parseComposition('{"foo":1}'), null);
  assert.equal(parseComposition('{"scenes":[{"sceneId":1}]}'), null);
});

test('assembleSpec: maps instances by sceneId and bakes the rest', () => {
  const ai = {
    scenes: [
      {
        sceneId: 'scene-1',
        instances: [
          { primitive: 'FullBleed', props: { colorToken: 'background' }, layer: 0, startFrame: 0, durationInFrames: 90 },
        ],
      },
    ],
  };
  const spec = assembleSpec(ai, brief);
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.theme, theme);
  assert.equal(spec.assets.length, 2);
  assert.equal(spec.scenes[0].instances.length, 1);
  assert.deepEqual(spec.scenes[0].voiceover, { assetId: 'vo-1' });
  // scene-2 omitted by the AI → empty instances (Gate 1 will flag it)
  assert.deepEqual(spec.scenes[1].instances, []);
  assert.deepEqual(spec.scenes[1].voiceover, { assetId: 'vo-2' });
  assert.equal(spec.scenes[1].durationInFrames, 60);
});

// --- agentic selection loop ------------------------------------------------

const stockCandidate = (assetId: string): StockCandidate => ({
  assetId,
  provider: 'pexels',
  kind: 'image',
  externalId: assetId.split('-').pop() ?? '',
  thumbnailUrl: `https://img/${assetId}.jpg`,
  downloadUrl: `https://dl/${assetId}.jpg`,
  width: 1080,
  height: 1920,
  attribution: 'Photo by X on Pexels',
});

test('normalizeSearchParams: defaults to image + portrait, passes query', () => {
  assert.deepEqual(normalizeSearchParams({ query: 'sunrise', kind: 'video', orientation: 'landscape' }), {
    query: 'sunrise',
    kind: 'video',
    orientation: 'landscape',
  });
  // Garbage/missing fields fall back to safe defaults (image, portrait for 9:16).
  assert.deepEqual(normalizeSearchParams({ kind: 'bogus' }), { query: '', kind: 'image', orientation: 'portrait' });
});

test('buildStockToolResult: header + one text+image block pair per candidate', () => {
  const blocks = buildStockToolResult([stockCandidate('pexels-image-1'), stockCandidate('pexels-image-2')]);
  // 1 header + 2*(id line + image) = 5 blocks.
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[2].type, 'image');
  assert.ok(blocks[1].type === 'text' && blocks[1].text.includes('pexels-image-1'));
});

test('buildStockToolResult: empty candidates → a refine-the-query hint', () => {
  const blocks = buildStockToolResult([]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].type === 'text' && /refine/i.test(blocks[0].text));
});

test('runAgenticComposition: searches, sees candidates, then returns referenced assets', async () => {
  const searched: string[] = [];
  // Turn 1: model calls search_stock. Turn 2: it emits final JSON referencing a shown asset.
  const turns: ModelTurn[] = [
    {
      content: [
        { type: 'thinking', thinking: 'let me look for footage' },
        { type: 'tool_use', id: 'tu_1', name: SEARCH_STOCK_TOOL.name, input: { query: 'sunrise', kind: 'image' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    {
      content: [
        { type: 'text', text: '{"scenes":[{"sceneId":"scene-1","instances":[{"primitive":"Image","props":{"asset":"pexels-image-1"},"layer":0,"startFrame":0,"durationInFrames":90}]}]}' },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 200, outputTokens: 40 },
    },
  ];
  let call = 0;
  const seenHistories: LoopMessage[][] = [];
  const res = await runAgenticComposition(brief, {
    callModel: async (_system, messages) => {
      seenHistories.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return turns[call++];
    },
    searchStock: async (params) => {
      searched.push(`${params.kind}:${params.query}:${params.orientation}`);
      return [stockCandidate('pexels-image-1'), stockCandidate('pexels-image-2')];
    },
  });

  assert.equal(call, 2); // looped exactly twice
  assert.deepEqual(searched, ['image:sunrise:portrait']); // searched once, portrait default
  assert.equal(res.turns, 2);
  assert.equal(res.tokensIn, 300);
  assert.equal(res.tokensOut, 60);
  assert.ok(res.registry.has('pexels-image-1') && res.registry.has('pexels-image-2'));
  assert.equal(res.ai?.scenes[0].instances[0].props.asset, 'pexels-image-1');
  // The second model call saw the assistant tool_use turn AND the tool_result turn.
  const secondHistory = seenHistories[1];
  assert.equal(secondHistory[1].role, 'assistant'); // preserved tool_use + thinking
  assert.equal(secondHistory[2].role, 'user'); // the tool_result we fed back
});

test('runAgenticComposition: a no-tool first turn returns immediately (procedural choice)', async () => {
  let searches = 0;
  const res = await runAgenticComposition(brief, {
    callModel: async () => ({
      content: [{ type: 'text', text: '{"scenes":[{"sceneId":"scene-1","instances":[]}]}' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    }),
    searchStock: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(searches, 0);
  assert.equal(res.turns, 1);
  assert.ok(res.ai);
  assert.equal(res.registry.size, 0);
});

test('runAgenticComposition: exhausting the turn budget yields ai=null', async () => {
  const res = await runAgenticComposition(brief, {
    maxTurns: 3,
    callModel: async () => ({
      content: [{ type: 'tool_use', id: 'tu', name: SEARCH_STOCK_TOOL.name, input: { query: 'x', kind: 'image' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    searchStock: async () => [stockCandidate('pexels-image-9')],
  });
  assert.equal(res.ai, null);
  assert.equal(res.turns, 3);
  assert.equal(res.stopReason, 'max_turns');
});

// --- asset resolution ------------------------------------------------------

test('collectReferencedAssetIds: gathers asset-typed prop values across scenes', () => {
  const ai = {
    scenes: [
      {
        sceneId: 'scene-1',
        instances: [
          { primitive: 'Image', props: { asset: 'pexels-image-1', fit: 'cover' }, layer: 0, startFrame: 0, durationInFrames: 90 },
          { primitive: 'Text', props: { text: 'hi', colorToken: 'foreground' }, layer: 1, startFrame: 0, durationInFrames: 90 },
        ],
      },
      {
        sceneId: 'scene-2',
        instances: [{ primitive: 'Video', props: { asset: 'pexels-video-2' }, layer: 0, startFrame: 0, durationInFrames: 60 }],
      },
    ],
  };
  // Only the Image/Video `asset` props are collected — not Text's `text`.
  assert.deepEqual([...collectReferencedAssetIds(ai)].sort(), ['pexels-image-1', 'pexels-video-2']);
});

test('planStockResolution: keeps registry hits, drops non-candidates + dupes', () => {
  const reg = new Map([
    ['pexels-image-1', stockCandidate('pexels-image-1')],
    ['pexels-video-2', { ...stockCandidate('pexels-video-2'), kind: 'video' as const }],
  ]);
  const plan = planStockResolution(['pexels-image-1', 'pexels-image-1', 'resource-abc', 'pexels-video-2'], reg);
  assert.equal(plan.length, 2); // dup collapsed, unknown 'resource-abc' dropped
  assert.deepEqual(plan.map((p) => p.assetId), ['pexels-image-1', 'pexels-video-2']);
  assert.equal(plan[0].downloadUrl, 'https://dl/pexels-image-1.jpg');
  assert.equal(plan[1].kind, 'video');
});

test('resolution → manifest → Gate 1: a stock-referencing composition validates', () => {
  // Simulate the loop choosing a stock image for scene-1, then the resolution that
  // step 7 will run: plan → (download) → manifest entries merged into the brief.
  const ai = {
    scenes: [
      {
        sceneId: 'scene-1',
        instances: [
          { primitive: 'Image', props: { asset: 'pexels-image-1', fit: 'cover' }, layer: 0, startFrame: 0, durationInFrames: 90 },
          { primitive: 'Text', props: { text: 'Hi', colorToken: 'foreground', fontSizePx: 80, align: 'center' }, layer: 1, startFrame: 0, durationInFrames: 90 },
        ],
      },
      {
        sceneId: 'scene-2',
        instances: [{ primitive: 'FullBleed', props: { colorToken: 'primary' }, layer: 0, startFrame: 0, durationInFrames: 60 }],
      },
    ],
  };
  const registry = new Map([['pexels-image-1', stockCandidate('pexels-image-1')]]);
  const plan = planStockResolution(collectReferencedAssetIds(ai), registry);
  // Stand in for resolveStockAssets (which downloads): the manifest entry it returns.
  const stockEntries = plan.map((p) => ({ id: p.assetId, kind: p.kind, r2Key: `assets/${p.assetId}.jpg`, attribution: p.attribution }));

  const spec = assembleSpec(ai, { ...brief, assets: [...brief.assets, ...stockEntries] });
  assert.deepEqual(validateSpec(spec, theme), { ok: true });

  // Without the resolved entry in the manifest, Gate 1 rejects the dangling asset ref.
  const unresolved = assembleSpec(ai, brief);
  const res = validateSpec(unresolved, theme);
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.errors.some((e) => e.rule === 'asset-ref'));
});

test('runAgenticComposition: an unknown tool call is rejected, loop continues', async () => {
  const turns: ModelTurn[] = [
    { content: [{ type: 'tool_use', id: 'tu_bad', name: 'not_a_tool', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [{ type: 'text', text: '{"scenes":[]}' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  let call = 0;
  let searches = 0;
  let fedBack: LoopMessage[] = [];
  const res = await runAgenticComposition(brief, {
    callModel: async (_s, messages) => {
      fedBack = messages;
      return turns[call++];
    },
    searchStock: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(searches, 0); // unknown tool never hit searchStock
  assert.ok(res.ai);
  // The rejected tool_result was fed back as an error block.
  const toolResultTurn = fedBack[2];
  const block = (toolResultTurn.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.is_error, true);
});

// --- Phase 6: kinetic text prompt binding + span collection -----------------

test('system prompt forbids KineticText when kinetic is disabled', () => {
  const sys = buildCompositionSystemPrompt(undefined, { kinetic: { enabled: false, usage: 'sparing' } });
  assert.ok(/do not use the kinetictext/i.test(sys));
});

test('system prompt guides frame-aligned bounce|pop emphasis when kinetic is enabled', () => {
  const sys = buildCompositionSystemPrompt(undefined, { kinetic: { enabled: true, usage: 'sparing' } });
  assert.ok(/kinetic text/i.test(sys));
  assert.ok(sys.includes('bounce') && sys.includes('pop'));
  assert.ok(/sparingly/i.test(sys));
  assert.ok(/lower third is reserved for captions/i.test(sys));
});

test('user prompt lists spoken-word frame windows only when kinetic is enabled', () => {
  const kBrief: CompositionBrief = {
    ...brief,
    kinetic: { enabled: true, usage: 'sparing' },
    scenes: [{ ...brief.scenes[0], words: [{ t: 'Hello', s: 0, e: 12 }, { t: 'there', s: 12, e: 24 }] }, brief.scenes[1]],
  };
  const u = buildCompositionUserPrompt(kBrief);
  assert.ok(u.includes('Hello@0-12'));
  // disabled => no word windows
  assert.ok(!buildCompositionUserPrompt(brief).includes('@0-12'));
});

test('collectKineticSpans: absolute frame windows across scene offsets', () => {
  const spec = assembleSpec(
    {
      scenes: [
        { sceneId: 'scene-1', instances: [{ primitive: 'KineticText', props: { text: 'Hi' }, layer: 2, startFrame: 10, durationInFrames: 20 }] },
        { sceneId: 'scene-2', instances: [{ primitive: 'KineticText', props: { text: 'Bye' }, layer: 2, startFrame: 5, durationInFrames: 15 }] },
      ],
    },
    brief,
  );
  // scene-1 offset 0 → [10,30); scene-2 offset 90 → [95,110)
  assert.deepEqual(collectKineticSpans(spec), [
    { fromFrame: 10, toFrame: 30 },
    { fromFrame: 95, toFrame: 110 },
  ]);
});

test('collectKineticSpans: no KineticText → no spans', () => {
  const spec = assembleSpec({ scenes: [{ sceneId: 'scene-1', instances: [{ primitive: 'Text', props: { text: 'x' }, layer: 1, startFrame: 0, durationInFrames: 10 }] }] }, brief);
  assert.deepEqual(collectKineticSpans(spec), []);
});
