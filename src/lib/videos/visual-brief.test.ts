import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisualBrief } from './visual-brief.ts';

test('parseVisualBrief: full entity brief round-trips', () => {
  const b = parseVisualBrief({
    subject: 'Rivian R2',
    action: 'driving on a coastal road',
    setting: 'sunset, Pacific coast',
    framing: 'wide tracking shot',
    mood: 'aspirational',
    specificity: 'entity',
    entity_name: 'Rivian R2',
    recommended_source: 'upload',
  });
  assert.deepEqual(b, {
    subject: 'Rivian R2',
    action: 'driving on a coastal road',
    setting: 'sunset, Pacific coast',
    framing: 'wide tracking shot',
    mood: 'aspirational',
    specificity: 'entity',
    entity_name: 'Rivian R2',
    recommended_source: 'upload',
  });
});

test('parseVisualBrief: missing fields get defaults', () => {
  const b = parseVisualBrief({ subject: 'a city street' });
  assert.equal(b?.subject, 'a city street');
  assert.equal(b?.action, '');
  assert.equal(b?.specificity, 'generic');
  assert.equal(b?.recommended_source, 'stock');
  assert.equal(b?.entity_name, null);
});

test('parseVisualBrief: invalid specificity/source fall back', () => {
  const b = parseVisualBrief({ specificity: 'nonsense', recommended_source: 'wat' });
  assert.equal(b?.specificity, 'generic');
  assert.equal(b?.recommended_source, 'stock');
});

test('parseVisualBrief: entity_name dropped unless specificity is entity', () => {
  const b = parseVisualBrief({ specificity: 'generic', entity_name: 'Rivian R2' });
  assert.equal(b?.entity_name, null);
  const e = parseVisualBrief({ specificity: 'entity', entity_name: '  Rivian R2  ' });
  assert.equal(e?.entity_name, 'Rivian R2');
  const blank = parseVisualBrief({ specificity: 'entity', entity_name: '   ' });
  assert.equal(blank?.entity_name, null);
});

test('parseVisualBrief: null / non-object / garbage → null', () => {
  assert.equal(parseVisualBrief(null), null);
  assert.equal(parseVisualBrief(undefined), null);
  assert.equal(parseVisualBrief('x'), null);
  assert.equal(parseVisualBrief(42), null);
});
