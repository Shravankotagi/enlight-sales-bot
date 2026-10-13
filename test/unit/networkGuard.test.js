const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');

test('tests cannot reach the network through fetch', async () => {
  await assert.rejects(fetch('https://example.com'), { name: 'NetworkAccessError' });
});

test('tests cannot reach the network through https.request', () => {
  assert.throws(() => https.request('https://example.com'), { name: 'NetworkAccessError' });
});
