import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNdjsonAccumulator,
  parseSceneLine,
  sceneToRpcArgs,
  buildSystemPrompt,
  buildUserPrompt,
  DEFAULT_VIDEO_CONFIG,
} from './script-generation.ts';

test('accumulator: buffers a partial line across chunks', () => {
  const acc = createNdjsonAccumulator();
  assert.deepEqual(acc.push('{"a":'), []);
  assert.deepEqual(acc.push('1}\n'), ['{"a":1}']);
});

test('accumulator: splits multiple lines in one chunk and skips blanks', () => {
  const acc = createNdjsonAccumulator();
  assert.deepEqual(acc.push('a\n\n  \nb\n'), ['a', 'b']);
});

test('accumulator: flush returns trailing unterminated line', () => {
  const acc = createNdjsonAccumulator();
  assert.deepEqual(acc.push('x\ny'), ['x']);
  assert.deepEqual(acc.flush(), ['y']);
  assert.deepEqual(acc.flush(), []);
});

test('parseSceneLine: valid scene parses with shot defaults', () => {
  const scene = parseSceneLine(
    '{"position":1,"narration":"Hi","durationSeconds":4,"shots":[{"position":1,"description":"a cup","stockQuery":"coffee"}]}',
  );
  assert.ok(scene);
  assert.equal(scene.position, 1);
  assert.equal(scene.shots[0].source, 'stock'); // default applied
});

test('parseSceneLine: malformed JSON returns null', () => {
  assert.equal(parseSceneLine('not json'), null);
  assert.equal(parseSceneLine('```'), null);
});

test('parseSceneLine: schema violation returns null', () => {
  // missing narration
  assert.equal(parseSceneLine('{"position":1,"shots":[]}'), null);
  // empty narration
  assert.equal(parseSceneLine('{"position":1,"narration":"","shots":[]}'), null);
});

test('sceneToRpcArgs: maps to snake_case with nulls for missing fields', () => {
  const scene = parseSceneLine(
    '{"position":2,"narration":"Two","shots":[{"position":1,"description":"d","source":"procedural"}]}',
  );
  assert.ok(scene);
  const args = sceneToRpcArgs(scene, 'acct-1', 'vid-1');
  assert.deepEqual(args, {
    p_account_id: 'acct-1',
    p_video_id: 'vid-1',
    p_position: 2,
    p_narration: 'Two',
    p_duration_seconds: null,
    p_shots: [
      { position: 1, description: 'd', source: 'procedural', stock_query: null, duration_seconds: null },
    ],
  });
});

test('prompts: system demands NDJSON; user includes prompt, channel, and target length', () => {
  const sys = buildSystemPrompt();
  assert.match(sys, /NDJSON/);
  assert.match(sys, /one JSON object per line/i);

  const user = buildUserPrompt('Why coffee cools fast', { channelName: 'Studio', tone: 'curious' }, DEFAULT_VIDEO_CONFIG);
  assert.match(user, /Why coffee cools fast/);
  assert.match(user, /Studio/);
  assert.match(user, /curious/);
  assert.match(user, /30s/);
});
