const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '../../src');

/**
 * Loads a module from `src/` with selected dependencies replaced.
 *
 *   const { mod, restore } = loadWithMocks('core/catalogFlow', {
 *     supabase: { ...fakeExports },
 *     'core/sessionManager': { ...fakeExports },
 *   });
 *
 * Keys are paths relative to `src/`. The target and every module that
 * depends on a mock are re-evaluated so they bind to the fakes. Call
 * `restore()` in `finally`/`after` to put the original cache back.
 */
function loadWithMocks(target, mocks = {}) {
  const resolve = (rel) => require.resolve(path.join(SRC_ROOT, rel));
  const saved = new Map();
  const remember = (file) => {
    if (!saved.has(file)) saved.set(file, require.cache[file]);
  };

  for (const [rel, exportsObj] of Object.entries(mocks)) {
    const file = resolve(rel);
    remember(file);
    require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
  }

  // Drop every other cached src module so it re-binds to the mocks.
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(SRC_ROOT) && !Object.keys(mocks).some((rel) => resolve(rel) === file)) {
      remember(file);
      delete require.cache[file];
    }
  }

  const mod = require(resolve(target));

  return {
    mod,
    restore() {
      for (const file of Object.keys(require.cache)) {
        if (file.startsWith(SRC_ROOT) && !saved.has(file)) delete require.cache[file];
      }
      for (const [file, entry] of saved) {
        if (entry) require.cache[file] = entry;
        else delete require.cache[file];
      }
    },
  };
}

module.exports = { loadWithMocks, SRC_ROOT };
