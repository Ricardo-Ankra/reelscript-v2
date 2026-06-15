import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRESS_THEMES, stressProps } from './stress-kit.ts';
import type { PropSchema } from './contract.ts';

test('STRESS_THEMES cover light + dark and carry every colour token', () => {
  assert.ok(STRESS_THEMES.length >= 2);
  const names = STRESS_THEMES.map((s) => s.name);
  assert.ok(names.includes('very-light') && names.includes('very-dark'));
  for (const { theme } of STRESS_THEMES) {
    for (const tok of ['background', 'foreground', 'primary', 'secondary', 'accent', 'bodyText']) {
      assert.ok((theme.colors as Record<string, string>)[tok], tok);
    }
    assert.ok(theme.fonts.display.length > 10); // intentionally long font names
  }
});

test('stressProps: strings overflow, numbers respect declared defaults', () => {
  const schema: PropSchema = [
    { name: 'label', type: 'string', state: 'active', required: true },
    { name: 'percent', type: 'number', state: 'active', default: 70 },
    { name: 'count', type: 'number', state: 'active', required: true },
    { name: 'mode', type: 'enum', state: 'active', enumValues: ['a', 'b'], required: true },
  ];
  const p = stressProps(schema);
  assert.ok((p.label as string).length > 40); // overflowing text
  assert.equal(p.percent, 70); // respects default (stays in range)
  assert.equal(p.count, 100); // extreme when no default
  assert.equal(p.mode, 'a');
});
