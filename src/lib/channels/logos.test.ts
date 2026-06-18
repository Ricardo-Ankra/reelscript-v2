import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLogoUpload, sanitizeLogos, LOGO_SLOTS, MAX_LOGO_BYTES } from './logos.ts';

test('validateLogoUpload: accepts png/jpeg/webp/svg → correct ext', () => {
  assert.deepEqual(validateLogoUpload({ slot: 'primary', contentType: 'image/png' }), { ok: true, ext: 'png' });
  assert.deepEqual(validateLogoUpload({ slot: 'icon', contentType: 'image/jpeg' }), { ok: true, ext: 'jpg' });
  assert.deepEqual(validateLogoUpload({ slot: 'monoLight', contentType: 'image/webp' }), { ok: true, ext: 'webp' });
  assert.deepEqual(validateLogoUpload({ slot: 'monoDark', contentType: 'image/svg+xml' }), { ok: true, ext: 'svg' });
});

test('validateLogoUpload: rejects unknown content type', () => {
  assert.equal(validateLogoUpload({ slot: 'primary', contentType: 'image/gif' }).ok, false);
  assert.equal(validateLogoUpload({ slot: 'primary', contentType: 'application/pdf' }).ok, false);
});

test('validateLogoUpload: rejects unknown slot', () => {
  assert.equal(validateLogoUpload({ slot: 'banner', contentType: 'image/png' }).ok, false);
  assert.equal(validateLogoUpload({ contentType: 'image/png' }).ok, false);
});

test('sanitizeLogos: keeps known string slots, drops unknown/non-string/empty', () => {
  assert.deepEqual(
    sanitizeLogos({
      primary: 'logos/a.png',
      icon: '',
      monoLight: 42,
      banner: 'x.png',
      monoDark: 'logos/d.svg',
    }),
    { primary: 'logos/a.png', monoDark: 'logos/d.svg' },
  );
});

test('sanitizeLogos: empty / garbage input → {}', () => {
  assert.deepEqual(sanitizeLogos(null), {});
  assert.deepEqual(sanitizeLogos('nope'), {});
  assert.deepEqual(sanitizeLogos({}), {});
});

test('LOGO_SLOTS + MAX_LOGO_BYTES: the four slots and the 2 MB guard', () => {
  assert.deepEqual([...LOGO_SLOTS], ['primary', 'monoLight', 'monoDark', 'icon']);
  assert.equal(MAX_LOGO_BYTES, 2 * 1024 * 1024);
});
