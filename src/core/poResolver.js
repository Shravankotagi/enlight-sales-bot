/**
 * Shared system PO allocation for every bot-owned order path.
 *
 * The Supabase RPCs are the authority for sequence allocation and conflicts.
 * The require is intentionally lazy because supabase.js also exposes the
 * helper functions used by the conversational flows.
 */

function getSupabase() {
  return require('../supabase').supabase;
}

function cleanPo(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function cleanDealId(value) {
  const cleaned = cleanPo(value);
  return cleaned && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleaned)
    ? cleaned
    : null;
}

function createReservationToken(prefix = 'bot') {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

async function allocateSystemPo(reservationToken, dealId = null) {
  const token = cleanPo(reservationToken) || createReservationToken();
  const { data, error } = await getSupabase().rpc('allocate_system_po', {
    p_reservation_token: token,
    p_deal_id: cleanDealId(dealId),
  });

  if (error || !data || !/^EM\/PO\/\d+$/.test(String(data))) {
    const failure = new Error(
      error?.message || 'System PO generation is unavailable',
    );
    failure.code = 'PO_ALLOCATOR_UNAVAILABLE';
    throw failure;
  }

  return {
    po_number: String(data),
    generated_po_number: String(data),
    po_reservation_token: token,
  };
}

async function checkPoAvailability(poNumber, reservationToken = null, dealId = null) {
  const value = cleanPo(poNumber);
  if (!value) return { available: false, reason: 'PO number cannot be blank' };

  const { data, error } = await getSupabase().rpc('check_po_availability', {
    p_po_number: value,
    p_reservation_token: cleanPo(reservationToken),
    p_deal_id: cleanDealId(dealId),
  });

  if (error || !data || typeof data !== 'object') {
    const failure = new Error(
      error?.message || 'PO availability could not be checked',
    );
    failure.code = 'PO_ALLOCATOR_UNAVAILABLE';
    throw failure;
  }

  return data;
}

async function claimPoNumber(poNumber, reservationToken = null, dealId = null) {
  const value = cleanPo(poNumber);
  if (!value) {
    const failure = new Error('PO number cannot be blank');
    failure.code = 'PO_CONFLICT';
    throw failure;
  }

  const { data, error } = await getSupabase().rpc('claim_po_number', {
    p_po_number: value,
    p_reservation_token: cleanPo(reservationToken),
    p_deal_id: cleanDealId(dealId),
  });

  if (error) {
    const failure = new Error(error.message || 'PO number could not be reserved');
    failure.code = 'PO_ALLOCATOR_UNAVAILABLE';
    throw failure;
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.claimed) {
    const failure = new Error(
      result?.reason || `PO number "${value}" is already allocated`,
    );
    failure.code = 'PO_CONFLICT';
    throw failure;
  }

  return result;
}

/**
 * Adds a stable system PO to a conversational draft without writing an order
 * row. The current po_number remains editable; generated_po_number records the
 * first allocation for audit/reference.
 */
async function ensureDraftSystemPo(draft, reservationToken = null, dealId = null) {
  const target = draft || {};
  const existingGenerated = cleanPo(target.generated_po_number);
  const existingToken = cleanPo(
    target.po_reservation_token || reservationToken,
  );

  if (existingGenerated && cleanPo(target.po_number)) {
    target.po_reservation_token = existingToken || createReservationToken();
    return target;
  }

  const allocation = await allocateSystemPo(existingToken, dealId);
  target.generated_po_number = existingGenerated || allocation.generated_po_number;
  target.po_reservation_token =
    existingToken || allocation.po_reservation_token;
  if (!cleanPo(target.po_number)) target.po_number = allocation.po_number;
  target.po_source =
    String(target.po_number).toLowerCase() ===
    String(target.generated_po_number).toLowerCase()
      ? 'generated'
      : 'user_edit';
  target.po_status = 'draft';
  target.po_generated_at = target.po_generated_at || new Date().toISOString();
  return target;
}

async function resolveFinalPo({
  poNumber,
  generatedPoNumber,
  referencePoNumber,
  reservationToken,
  dealId = null,
  existingDeal = null,
} = {}) {
  const token = cleanPo(reservationToken) || createReservationToken();
  let generated =
    cleanPo(existingDeal?.generated_po_number) ||
    (
      /^EM\/PO\/\d+$/i.test(cleanPo(existingDeal?.po_number) || '')
        ? cleanPo(existingDeal?.po_number)
        : null
    ) ||
    cleanPo(generatedPoNumber);
  if (generated && !/^EM\/PO\/\d+$/i.test(generated)) {
    generated = null;
  }

  if (!generated) {
    const allocation = await allocateSystemPo(token, dealId);
    generated = allocation.generated_po_number;
  }

  const legacyPo =
    !existingDeal?.generated_po_number &&
    cleanPo(existingDeal?.po_number) &&
    !/^EM\/PO\/\d+$/i.test(cleanPo(existingDeal?.po_number))
      ? cleanPo(existingDeal?.po_number)
      : null;
  const requested = cleanPo(poNumber);
  const current =
    requested && (!legacyPo || requested.toLowerCase() !== legacyPo.toLowerCase())
      ? requested
      : generated;
  const customerReference = cleanPo(referencePoNumber) || legacyPo;
  await claimPoNumber(generated, token, dealId);
  const availability = await checkPoAvailability(current, token, dealId);
  if (!availability.available) {
    const failure = new Error(
      availability.reason || `PO number "${current}" is already allocated`,
    );
    failure.code = 'PO_CONFLICT';
    throw failure;
  }
  await claimPoNumber(current, token, dealId);

  return {
    po_number: current,
    generated_po_number: generated,
    reference_po_number: customerReference || null,
    po_source:
      current.toLowerCase() === generated.toLowerCase()
        ? 'generated'
        : 'user_edit',
    po_status: 'confirmed',
    po_reservation_token: token,
    po_generated_at:
      cleanPo(existingDeal?.po_generated_at) || new Date().toISOString(),
    po_confirmed_at: new Date().toISOString(),
  };
}

module.exports = {
  cleanPo,
  createReservationToken,
  allocateSystemPo,
  checkPoAvailability,
  claimPoNumber,
  ensureDraftSystemPo,
  resolveFinalPo,
};
