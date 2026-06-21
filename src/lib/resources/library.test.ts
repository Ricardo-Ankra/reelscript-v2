import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateResourceUpload,
  sanitizeResourceFields,
  MAX_TAGS,
  MAX_TAG_LEN,
  MAX_DESCRIPTION_LEN,
} from './library.ts';

test('validateResourceUpload: accepts the four allowed types with kind + ext', () => {
  assert.deepEqual(validateResourceUpload({ contentType: 'image/jpeg' }), { ok: true, kind: 'image', ext: 'jpg' });
  assert.deepEqual(validateResourceUpload({ contentType: 'image/png' }), { ok: true, kind: 'image', ext: 'png' });
  assert.deepEqual(validateResourceUpload({ contentType: 'image/webp' }), { ok: true, kind: 'image', ext: 'webp' });
  assert.deepEqual(validateResourceUpload({ contentType: 'video/mp4' }), { ok: true, kind: 'video', ext: 'mp4' });
});

test('validateResourceUpload: rejects unsupported types', () => {
  assert.equal(validateResourceUpload({ contentType: 'image/gif' }).ok, false);
  assert.equal(validateResourceUpload({ contentType: 'application/pdf' }).ok, false);
  assert.equal(validateResourceUpload({ contentType: '' }).ok, false);
});

test('sanitizeResourceFields: trims + caps description; absent → empty string', () => {
  assert.equal(sanitizeResourceFields({ description: '  hi  ' }).description, 'hi');
  assert.equal(sanitizeResourceFields({}).description, '');
  assert.equal(sanitizeResourceFields({ description: 123 }).description, '');
  const long = 'x'.repeat(MAX_DESCRIPTION_LEN + 50);
  assert.equal(sanitizeResourceFields({ description: long }).description.length, MAX_DESCRIPTION_LEN);
});

test('sanitizeResourceFields: tags trimmed, empties dropped, deduped, capped', () => {
  assert.deepEqual(sanitizeResourceFields({ tags: [' a ', 'b', '', 'a', '  '] }).tags, ['a', 'b']);
  assert.deepEqual(sanitizeResourceFields({ tags: 'notarray' }).tags, []);
  assert.deepEqual(sanitizeResourceFields({}).tags, []);
  const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `t${i}`);
  assert.equal(sanitizeResourceFields({ tags: many }).tags.length, MAX_TAGS);
  const longTag = 'y'.repeat(MAX_TAG_LEN + 20);
  assert.equal(sanitizeResourceFields({ tags: [longTag] }).tags[0].length, MAX_TAG_LEN);
});
