import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from './gate1.ts';
import type { CompositionSpec } from './spec.ts';
import type { Theme } from '../primitives/contract.ts';

const theme: Theme = {
  colors: { background: '#000', foreground: '#fff', primary: '#00f', secondary: '#003', accent: '#fa0', bodyText: '#eee', positive: '#0f0', negative: '#f00' },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

// A valid baseline spec: 2 scenes (90 + 60 = 150 frames), one voiced.
function validSpec(): CompositionSpec {
  return {
    version: 2,
    metadata: { width: 1080, height: 1920, fps: 30, durationInFrames: 150 },
    theme,
    assets: [{ id: 'vo-1', kind: 'audio', r2Key: 'audio/s1.mp3' }],
    scenes: [
      {
        id: 'scene-1',
        durationInFrames: 90,
        voiceover: { assetId: 'vo-1' },
        instances: [
          { primitive: 'FullBleed', props: { colorToken: 'background' }, layer: 0, startFrame: 0, durationInFrames: 90 },
          { primitive: 'Text', props: { text: 'Hi', colorToken: 'foreground', fontSizePx: 90, align: 'center' }, layer: 1, startFrame: 4, durationInFrames: 86 },
        ],
      },
      {
        id: 'scene-2',
        durationInFrames: 60,
        instances: [{ primitive: 'Shape', props: { shape: 'line', colorToken: 'accent' }, layer: 0, startFrame: 0, durationInFrames: 60 }],
      },
    ],
  };
}

const rules = (r: ReturnType<typeof validateSpec>) => (r.ok ? [] : r.errors.map((e) => e.rule));

test('gate1: a valid spec passes', () => {
  assert.deepEqual(validateSpec(validSpec(), theme), { ok: true });
});

test('gate1: unknown primitive fails', () => {
  const s = validSpec();
  s.scenes[0].instances[1].primitive = 'Nope';
  const r = validateSpec(s, theme);
  assert.ok(rules(r).includes('unknown-primitive'));
});

test('gate1: missing required prop fails (props)', () => {
  const s = validSpec();
  delete (s.scenes[0].instances[1].props as Record<string, unknown>).text;
  assert.ok(rules(validateSpec(s, theme)).includes('props'));
});

test('gate1: hallucinated extra prop fails (strict)', () => {
  const s = validSpec();
  (s.scenes[0].instances[1].props as Record<string, unknown>).glow = true;
  assert.ok(rules(validateSpec(s, theme)).includes('props'));
});

test('gate1: unresolved token reference fails', () => {
  const s = validSpec();
  (s.scenes[0].instances[1].props as Record<string, unknown>).colorToken = 'fuchsia';
  const r = validateSpec(s, theme);
  assert.ok(rules(r).includes('token-ref'));
});

test('gate1: instance timing overflowing the scene fails', () => {
  const s = validSpec();
  s.scenes[0].instances[1].durationInFrames = 200; // 4 + 200 > 90
  assert.ok(rules(validateSpec(s, theme)).includes('timing'));
});

test('gate1: duration inconsistency fails', () => {
  const s = validSpec();
  s.metadata.durationInFrames = 999;
  assert.ok(rules(validateSpec(s, theme)).includes('duration-consistency'));
});

test('gate1: unresolved voiceover asset ref fails', () => {
  const s = validSpec();
  s.scenes[0].voiceover = { assetId: 'missing' };
  assert.ok(rules(validateSpec(s, theme)).includes('asset-ref'));
});

test('gate1: instance asset prop must resolve in the manifest', () => {
  const s = validSpec();
  // An Image referencing a real manifest asset passes; an unknown one fails.
  s.assets.push({ id: 'img-1', kind: 'image', r2Key: 'assets/x.jpg' });
  s.scenes[1].instances.push({ primitive: 'Image', props: { asset: 'img-1' }, layer: 1, startFrame: 0, durationInFrames: 60 });
  assert.deepEqual(validateSpec(s, theme), { ok: true });

  s.scenes[1].instances[1].props = { asset: 'img-missing' };
  assert.ok(rules(validateSpec(s, theme)).includes('asset-ref'));
});

test('gate1: errors carry structured scene/instance/prop detail', () => {
  const s = validSpec();
  (s.scenes[0].instances[1].props as Record<string, unknown>).colorToken = 'nope';
  const r = validateSpec(s, theme);
  assert.ok(!r.ok);
  const e = r.errors.find((x) => x.rule === 'token-ref');
  assert.equal(e?.scene, 0);
  assert.equal(e?.instance, 1);
  assert.equal(e?.prop, 'colorToken');
  assert.equal(e?.primitive, 'Text');
});
