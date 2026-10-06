const test = require('node:test');
const assert = require('node:assert/strict');

function loadResolver(rpc) {
  const supabasePath = require.resolve('../supabase');
  const resolverPath = require.resolve('./poResolver');
  const originalSupabase = require.cache[supabasePath];
  const originalResolver = require.cache[resolverPath];

  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: { supabase: { rpc } },
  };
  delete require.cache[resolverPath];

  const resolver = require('./poResolver');

  return {
    resolver,
    restore() {
      if (originalSupabase) require.cache[supabasePath] = originalSupabase;
      else delete require.cache[supabasePath];
      if (originalResolver) require.cache[resolverPath] = originalResolver;
      else delete require.cache[resolverPath];
    },
  };
}

test('allocates an editable draft system PO without writing a business row', async () => {
  const rpc = async (name) => {
    if (name === 'allocate_system_po') return { data: 'EM/PO/7', error: null };
    if (name === 'check_po_availability') {
      return { data: { available: true }, error: null };
    }
    return { data: { claimed: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    const draft = {};
    await resolver.ensureDraftSystemPo(draft, 'draft-test');
    assert.equal(draft.po_number, 'EM/PO/7');
    assert.equal(draft.generated_po_number, 'EM/PO/7');
    assert.equal(draft.po_status, 'draft');
  } finally {
    restore();
  }
});

test('rejects a duplicate edited system PO authoritatively', async () => {
  const rpc = async (name) => {
    if (name === 'allocate_system_po') return { data: 'EM/PO/8', error: null };
    if (name === 'check_po_availability') {
      return {
        data: { available: false, reason: 'PO number is already allocated' },
        error: null,
      };
    }
    return { data: { claimed: false }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    await assert.rejects(
      resolver.resolveFinalPo({
        poNumber: 'EM/PO/9',
        generatedPoNumber: 'EM/PO/8',
        reservationToken: 'duplicate-test',
      }),
      (error) => error.code === 'PO_CONFLICT',
    );
  } finally {
    restore();
  }
});

test('keeps the generated PO immutable while allowing a separate editable canonical value', async () => {
  const rpc = async (name) => {
    if (name === 'check_po_availability') {
      return { data: { available: true }, error: null };
    }
    return { data: { claimed: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    const resolved = await resolver.resolveFinalPo({
      poNumber: 'PO-INTERNAL-42',
      generatedPoNumber: 'EM/PO/41',
      referencePoNumber: 'PO-CUSTOMER-42',
      reservationToken: 'editable-test',
    });

    assert.equal(resolved.po_number, 'PO-INTERNAL-42');
    assert.equal(resolved.generated_po_number, 'EM/PO/41');
    assert.equal(resolved.reference_po_number, 'PO-CUSTOMER-42');
    assert.equal(resolved.po_source, 'user_edit');
  } finally {
    restore();
  }
});

test('moves a legacy canonical PO into Reference PO when resolving a Won order', async () => {
  const rpc = async (name) => {
    if (name === 'allocate_system_po') return { data: 'EM/PO/43', error: null };
    if (name === 'check_po_availability') {
      return { data: { available: true }, error: null };
    }
    return { data: { claimed: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    const resolved = await resolver.resolveFinalPo({
      existingDeal: {
        po_number: 'PO-LEGACY-42',
        generated_po_number: null,
      },
      reservationToken: 'legacy-test',
    });

    assert.equal(resolved.po_number, 'EM/PO/43');
    assert.equal(resolved.generated_po_number, 'EM/PO/43');
    assert.equal(resolved.reference_po_number, 'PO-LEGACY-42');
  } finally {
    restore();
  }
});
