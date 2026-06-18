import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FONT_ALLOWLIST, fontSubpath, isBrandFont } from './fonts.ts';

test('FONT_ALLOWLIST: non-empty and includes Poppins (renderer prior default)', () => {
  assert.ok(FONT_ALLOWLIST.length > 0);
  assert.ok((FONT_ALLOWLIST as readonly string[]).includes('Poppins'));
});

test('fontSubpath: strips spaces to the google-fonts PascalCase subpath', () => {
  assert.equal(fontSubpath('Poppins'), 'Poppins');
  assert.equal(fontSubpath('Playfair Display'), 'PlayfairDisplay');
  assert.equal(fontSubpath('Bebas Neue'), 'BebasNeue');
});

test('isBrandFont: accepts allowlisted, rejects others', () => {
  assert.equal(isBrandFont('Poppins'), true);
  assert.equal(isBrandFont('Comic Sans'), false);
  assert.equal(isBrandFont(42), false);
});

test('drift guard: every allowlisted font has a loadFont import in remotion/brand-fonts.ts', () => {
  const src = readFileSync(new URL('../../../remotion/brand-fonts.ts', import.meta.url), 'utf8');
  // Sanity: prove we read the REAL file — a misresolved-but-readable path (or an
  // empty file) must not let this pass vacuously before the loop runs.
  assert.ok(src.length > 0, 'brand-fonts.ts is empty or unreadable — check the path');
  assert.ok(src.includes('loadFont'), 'brand-fonts.ts has no loadFont imports — wrong file?');
  for (const family of FONT_ALLOWLIST) {
    const subpath = `@remotion/google-fonts/${fontSubpath(family)}`;
    assert.ok(
      src.includes(subpath),
      `missing loadFont import for ${family} (${subpath}) in remotion/brand-fonts.ts`,
    );
  }
});
