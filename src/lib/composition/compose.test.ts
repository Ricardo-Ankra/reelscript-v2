import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompositionSystemPrompt,
  buildCompositionUserPrompt,
  parseComposition,
  assembleSpec,
  type CompositionBrief,
} from './compose.ts';
import type { Theme } from '../primitives/contract.ts';

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
