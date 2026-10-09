const test = require('node:test');
const assert = require('node:assert/strict');

const { safeParseJSON } = require('../../src/utils/jsonUtils');

test('safeParseJSON extracts JSON from fenced markdown', () => {
  assert.deepEqual(safeParseJSON('```json\n{"a":1}\n```', null), { a: 1 });
});

test('safeParseJSON extracts JSON from function-call wrappers', () => {
  assert.deepEqual(safeParseJSON('<function(update_deal_stage)>{"b":2}</function>', null), { b: 2 });
});

test('safeParseJSON extracts JSON surrounded by prose', () => {
  assert.deepEqual(safeParseJSON('Here you go:\n{"stage":"won"}\nHope this helps!', null), { stage: 'won' });
});

test('safeParseJSON repairs single-quoted keys and values', () => {
  assert.deepEqual(safeParseJSON("{\"d\": 'x', 'e': 'y'}", null), { d: 'x', e: 'y' });
});

test('safeParseJSON returns the fallback for unparseable input', () => {
  const fallback = { fallback: true };
  assert.deepEqual(safeParseJSON('raw garbage', fallback), fallback);
  assert.deepEqual(safeParseJSON(null, fallback), fallback);
});
