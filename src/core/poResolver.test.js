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

test('releases an unclaimed draft reservation with its ownership context', async () => {
  let releaseArgs;
  const rpc = async (name, args) => {
    if (name === 'release_po_reservation') {
      releaseArgs = args;
      return {
        data: { released: true, po_number: 'EM/PO/44' },
        error: null,
      };
    }
    return { data: { available: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    await assert.deepEqual(
      await resolver.releasePoReservation(
        'catalog-direct:123',
        'EM/PO/44',
        '11111111-1111-4111-8111-111111111111',
      ),
      { released: true, po_number: 'EM/PO/44' },
    );
    assert.deepEqual(releaseArgs, {
      p_reservation_token: 'catalog-direct:123',
      p_po_number: 'EM/PO/44',
      p_deal_id: '11111111-1111-4111-8111-111111111111',
    });
  } finally {
    restore();
  }
});

test('treats a missing draft token as an idempotent no-op', async () => {
  let rpcCalled = false;
  const rpc = async () => {
    rpcCalled = true;
    return { data: { released: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    assert.deepEqual(await resolver.releasePoReservation(), {
      released: false,
      reason: 'Reservation token is required',
    });
    assert.equal(rpcCalled, false);
  } finally {
    restore();
  }
});

test('reuses a released PO while preserving abandoned and claimed allocations', async () => {
  const allocations = new Map();
  const rpc = async (name, args) => {
    if (name === 'allocate_system_po') {
      let number = 1;
      while ([...allocations.values()].some(item => item.number === number)) {
        number += 1;
      }
      const po = `EM/PO/${number}`;
      allocations.set(args.p_reservation_token, {
        number,
        po,
        claimed: false,
      });
      return { data: po, error: null };
    }

    if (name === 'claim_po_number') {
      const allocation = [...allocations.values()].find(
        item => item.po === args.p_po_number,
      );
      if (allocation && allocation.claimed === false) {
        allocation.claimed = true;
        return { data: { claimed: true, po_number: allocation.po }, error: null };
      }
      return {
        data: { claimed: false, reason: 'PO number is already allocated' },
        error: null,
      };
    }

    if (name === 'release_po_reservation') {
      const allocation = allocations.get(args.p_reservation_token);
      if (
        !allocation ||
        allocation.claimed ||
        (args.p_po_number && args.p_po_number !== allocation.po)
      ) {
        return {
          data: {
            released: false,
            reason: 'No matching unclaimed PO reservation found',
          },
          error: null,
        };
      }
      allocations.delete(args.p_reservation_token);
      return {
        data: { released: true, po_number: allocation.po },
        error: null,
      };
    }

    return { data: { available: true }, error: null };
  };
  const { resolver, restore } = loadResolver(rpc);

  try {
    const abandoned = await resolver.allocateSystemPo('abandoned');
    const claimed = await resolver.allocateSystemPo('claimed');
    await resolver.claimPoNumber(
      claimed.po_number,
      claimed.po_reservation_token,
    );
    const cancelled = await resolver.allocateSystemPo('cancelled');

    assert.equal(abandoned.po_number, 'EM/PO/1');
    assert.equal(claimed.po_number, 'EM/PO/2');
    assert.equal(cancelled.po_number, 'EM/PO/3');

    await assert.deepEqual(
      await resolver.releasePoReservation(
        cancelled.po_reservation_token,
        cancelled.po_number,
      ),
      { released: true, po_number: 'EM/PO/3' },
    );
    assert.deepEqual(
      await resolver.releasePoReservation(
        cancelled.po_reservation_token,
        cancelled.po_number,
      ),
      {
        released: false,
        reason: 'No matching unclaimed PO reservation found',
      },
    );

    const reused = await resolver.allocateSystemPo('reused');
    assert.equal(reused.po_number, 'EM/PO/3');

    const claimedRelease = await resolver.releasePoReservation(
      claimed.po_reservation_token,
      claimed.po_number,
    );
    assert.equal(claimedRelease.released, false);
    assert.equal((await resolver.allocateSystemPo('next')).po_number, 'EM/PO/4');
  } finally {
    restore();
  }
});
