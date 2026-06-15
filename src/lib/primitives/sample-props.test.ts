import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSampleProps } from './sample-props.ts';
import type { PropSchema } from './contract.ts';

test('generateSampleProps: prefers declared defaults', () => {
  const schema: PropSchema = [
    { name: 'fontSizePx', type: 'number', state: 'active', default: 96 },
    { name: 'align', type: 'enum', state: 'active', enumValues: ['left', 'center'], default: 'center' },
  ];
  assert.deepEqual(generateSampleProps(schema), { fontSizePx: 96, align: 'center' });
});

test('generateSampleProps: synthesizes per-type samples when no default', () => {
  const schema: PropSchema = [
    { name: 'label', type: 'string', state: 'active', required: true },
    { name: 'progress', type: 'number', state: 'active', required: true },
    { name: 'animation', type: 'enum', state: 'active', enumValues: ['pop', 'fade'], required: true },
    { name: 'colorToken', type: 'token', tokenGroup: 'colors', state: 'active', required: true },
    { name: 'fontToken', type: 'token', tokenGroup: 'fonts', state: 'active', required: true },
    { name: 'asset', type: 'asset', state: 'active', required: true },
    { name: 'bold', type: 'boolean', state: 'active', required: true },
  ];
  const p = generateSampleProps(schema);
  assert.equal(typeof p.label, 'string');
  assert.ok((p.label as string).length > 0);
  assert.equal(p.progress, 1);
  assert.equal(p.animation, 'pop'); // first enum value
  assert.equal(p.colorToken, 'accent'); // valid colour token
  assert.equal(p.fontToken, 'display'); // valid font token
  assert.equal(p.asset, 'sample-asset');
  assert.equal(p.bold, true);
});

test('generateSampleProps: includes deprecated props (validation view), skips removed', () => {
  const schema: PropSchema = [
    { name: 'a', type: 'string', state: 'active', default: 'x' },
    { name: 'legacy', type: 'boolean', state: 'deprecated', default: false },
    { name: 'gone', type: 'string', state: 'removed' },
  ];
  const p = generateSampleProps(schema);
  assert.ok('a' in p && 'legacy' in p);
  assert.ok(!('gone' in p));
});
