/**
 * Preloaded for every test file (`node --require ./test/setup.js --test`).
 * Tests must be deterministic and offline: no Supabase, WhatsApp, Gemini,
 * AssemblyAI or any other real network call.
 */
const http = require('node:http');
const https = require('node:https');

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-google-key';

class NetworkAccessError extends Error {
  constructor(target) {
    super(`Network access is blocked in tests (attempted: ${target}). Mock the dependency instead.`);
    this.name = 'NetworkAccessError';
  }
}

const describeTarget = (input) => {
  if (!input) return 'unknown';
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input.url) return input.url;
  return `${input.protocol || ''}//${input.hostname || input.host || ''}${input.path || ''}`;
};

globalThis.fetch = async (input) => {
  throw new NetworkAccessError(describeTarget(input));
};

for (const mod of [http, https]) {
  mod.request = (input) => { throw new NetworkAccessError(describeTarget(input)); };
  mod.get = (input) => { throw new NetworkAccessError(describeTarget(input)); };
}

module.exports = { NetworkAccessError };
