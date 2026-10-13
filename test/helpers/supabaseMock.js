/**
 * Minimal chainable Supabase client fake for unit tests.
 *
 * Usage:
 *   const db = createSupabaseMock({ tables: { recurring_customers: [...] } });
 *   await db.client.from('recurring_customers').select('*').eq('id', 1);
 *   db.calls // every terminal query, for assertions
 *
 * Only `eq`, `neq`, `in`, `is` and `ilike` filter rows; every other modifier is
 * recorded and ignored so production query shapes never throw.
 */

const FILTER_PASSTHROUGH = [
  'select', 'order', 'limit', 'range', 'or', 'gte', 'lte', 'gt', 'lt',
  'not', 'contains', 'containedBy', 'filter', 'match', 'textSearch', 'returns',
];

function likeToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
}

function createSupabaseMock({ tables = {}, rpc = {}, errors = {} } = {}) {
  const store = {};
  for (const [name, rows] of Object.entries(tables)) store[name] = rows.map((r) => ({ ...r }));
  const calls = [];

  function builder(table) {
    const state = { table, op: 'select', filters: [], modifiers: [], payload: null, single: false, maybe: false };

    const run = () => {
      calls.push({ ...state });
      if (errors[table]) return { data: null, error: errors[table] };
      const rows = store[table] || (store[table] = []);
      const matches = rows.filter((row) => state.filters.every((f) => f(row)));

      if (state.op === 'insert' || state.op === 'upsert') {
        const inserted = [].concat(state.payload).map((r) => ({ ...r }));
        rows.push(...inserted);
        return finalize(inserted);
      }
      if (state.op === 'update') {
        matches.forEach((row) => Object.assign(row, state.payload));
        return finalize(matches);
      }
      if (state.op === 'delete') {
        store[table] = rows.filter((row) => !matches.includes(row));
        return finalize(matches);
      }
      return finalize(matches);
    };

    const finalize = (data) => {
      if (state.single || state.maybe) {
        if (data.length === 0) {
          return state.maybe
            ? { data: null, error: null }
            : { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
        }
        return { data: data[0], error: null };
      }
      return { data, error: null, count: data.length };
    };

    const api = {
      insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
      upsert(payload) { state.op = 'upsert'; state.payload = payload; return api; },
      update(payload) { state.op = 'update'; state.payload = payload; return api; },
      delete() { state.op = 'delete'; return api; },
      eq(col, val) { state.filters.push((r) => r[col] === val); return api; },
      neq(col, val) { state.filters.push((r) => r[col] !== val); return api; },
      in(col, vals) { state.filters.push((r) => vals.includes(r[col])); return api; },
      is(col, val) { state.filters.push((r) => (r[col] ?? null) === val); return api; },
      ilike(col, pattern) {
        const re = likeToRegExp(pattern);
        state.filters.push((r) => re.test(String(r[col] ?? '')));
        return api;
      },
      single() { state.single = true; return api; },
      maybeSingle() { state.maybe = true; return api; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    for (const name of FILTER_PASSTHROUGH) {
      api[name] = (...args) => { state.modifiers.push([name, args]); return api; };
    }
    return api;
  }

  const client = {
    from: (table) => builder(table),
    rpc: async (name, params) => {
      calls.push({ rpc: name, params });
      const handler = rpc[name];
      if (!handler) return { data: null, error: null };
      return typeof handler === 'function' ? handler(params) : handler;
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: 'mock/path' }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://example.invalid/mock' } }),
      }),
    },
  };

  return { client, store, calls };
}

module.exports = { createSupabaseMock };
