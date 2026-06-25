import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_LOOKS,
  DEFAULT_COLOR_LOOK,
  LOOK_LABELS,
  buildGradeFilter,
  buildGradeArgs,
  type ColorLook,
} from './looks.ts';

test('COLOR_LOOKS lists every look and DEFAULT is neutral', () => {
  assert.deepEqual([...COLOR_LOOKS], ['none', 'neutral', 'warm', 'cool', 'punch']);
  assert.equal(DEFAULT_COLOR_LOOK, 'neutral');
  for (const l of COLOR_LOOKS) assert.equal(typeof LOOK_LABELS[l], 'string');
});

test('buildGradeFilter returns null for none and unknown ids', () => {
  assert.equal(buildGradeFilter('none'), null);
  assert.equal(buildGradeFilter('bogus' as ColorLook), null);
});

test('buildGradeFilter returns a non-empty -vf chain per named look', () => {
  const neutral = buildGradeFilter('neutral');
  assert.ok(neutral && neutral.includes('eq='));

  const warm = buildGradeFilter('warm');
  assert.ok(warm && warm.includes('colorbalance=') && warm.includes('rm=0.04'));

  const cool = buildGradeFilter('cool');
  assert.ok(cool && cool.includes('colorbalance=') && cool.includes('bs=0.04'));

  const punch = buildGradeFilter('punch');
  assert.ok(punch && punch.includes('eq=') && punch.includes('contrast=1.12'));
});

test('look filter chains contain no spaces (argv-safe)', () => {
  for (const l of ['neutral', 'warm', 'cool', 'punch'] as ColorLook[]) {
    const f = buildGradeFilter(l);
    assert.ok(f && !f.includes(' '), `${l} filter must be space-free`);
  }
});

test('buildGradeArgs re-encodes video with the filter and copies audio', () => {
  const args = buildGradeArgs({ inPath: 'in.mp4', outPath: 'out.mp4', filter: 'eq=contrast=1.06' });
  const joined = args.join(' ');
  assert.ok(joined.includes('-vf eq=contrast=1.06'));
  assert.ok(joined.includes('-c:a copy'));
  assert.ok(joined.includes('-c:v libx264'));
  assert.ok(joined.includes('-movflags +faststart'));
  assert.equal(args[args.length - 1], 'out.mp4');
  assert.equal(args[0], '-y');
  const i = args.indexOf('-i');
  assert.equal(args[i + 1], 'in.mp4');
});
