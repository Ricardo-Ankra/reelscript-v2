import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipPrompt } from './prompt.ts';
import { parseCameraSpec, parseLightingSpec } from '../videos/cinematography.ts';
import { parseVisualBrief } from '../videos/visual-brief.ts';

test('buildClipPrompt front-loads shot size, spaces the move, ends with the negative', () => {
  const brief = parseVisualBrief({ subject: 'a turbine', action: 'spinning', setting: 'a wind farm', specificity: 'generic', recommended_source: 'generate' })!;
  const camera = parseCameraSpec({ shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 24, dof: 'deep' })!;
  const lighting = parseLightingSpec({ palette: 'cool blue' })!;
  const p = buildClipPrompt(brief, camera, lighting);
  assert.ok(p.startsWith('WS low angle, 24mm lens, deep depth of field.'));
  assert.match(p, /a turbine\. spinning\. a wind farm\./);
  assert.match(p, /Camera: orbit 360, smooth and deliberate\./); // underscores spaced
  assert.ok(p.endsWith('Negative: no text, no logo, no warped anatomy, no smeared motion blur.'));
});
