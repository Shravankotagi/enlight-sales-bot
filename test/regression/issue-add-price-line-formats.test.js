/**
 * Regression: Add Price to Inquiry treated a copied material line as the base
 * price, so "Heavy Structural Beam (ISMB) 35 MT: 10000, 100, 100, 0, 100"
 * replied "Base must be a price in rupees per MT." The word Base inside
 * Heavy Base Plate was read the same way.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { handleFullSalesPrice } = require('../../src/core/salesPriceFlow');

const PHONE = '9844444444';

const MATERIALS = [
  { line_key: 'beam-35', sku_text: 'Heavy Structural Beam (ISMB)', quantity: 35, unit: 'MT' },
  { line_key: 'beam-25', sku_text: 'Heavy Structural Beam (ISMB)', quantity: 25, unit: 'MT' },
  { line_key: 'channel', sku_text: 'MS Channel (ISMC)', quantity: 18.5, unit: 'MT' },
  { line_key: 'angle', sku_text: 'MS Equal Angle (ISA)', quantity: 14, unit: 'MT' },
  { line_key: 'plate', sku_text: 'Heavy Base Plate', quantity: 20, unit: 'MT' },
];

function deps(db, intents) {
  return {
    supabase: db.client,
    saveActiveSession: async (_phone, _name, next) => { intents.push(next); },
    getAccessibleSalespersonPhonesForBot: async () => ({ phones: [PHONE], isAdmin: true }),
    expandPhoneVariants: (phones) => phones,
  };
}

function openInquiry(lineItems, number = 'PR-10251') {
  const db = createSupabaseMock({
    tables: {
      inquiries: [{
        id: 'inq-10251',
        procurement_number: number,
        status: 'new_inquiry',
        pricing_status: 'awaiting_price',
        salesperson_phone: PHONE,
        delivery_location: 'Pune',
        customer_name: 'Rathi Infrastructure Projects Ltd.',
        ai_extraction_json: {
          customer_name: 'Rathi Infrastructure Projects Ltd.',
          line_items: lineItems,
        },
      }],
    },
  });
  const intents = ['general'];
  return { db, intents, flow: deps(db, intents) };
}

const PASTED = [
  'Heavy Structural Beam (ISMB) 25 MT: 11000, 100, 100, 0, 100',
  'Heavy Structural Beam (ISMB) 35 MT: 10000, 100, 100, 0, 100',
  'MS Channel (ISMC) 18.5 MT: 10000, 100, 100, 0, 100',
  'MS Equal Angle (ISA) 14 MT: 10000, 100, 100, 0, 100',
  'Heavy Base Plate 20 MT: 10000, 100, 100, 0, 100',
].join('\n');

test('a pasted material list prices each line, including the two beams and Heavy Base Plate', async () => {
  const { db, intents, flow } = openInquiry(MATERIALS);
  await handleFullSalesPrice('btn_price_current|PR-10251', PHONE, intents.at(-1), flow);
  const confirmed = await handleFullSalesPrice(PASTED, PHONE, intents.at(-1), flow);
  assert.doesNotMatch(confirmed.reply, /Base must be a price/);
  assert.match(confirmed.reply, /Save this price\?/);
  assert.match(confirmed.reply, /1\. Heavy Structural Beam \(ISMB\) 35 MT —[\s\S]*Rate ₹10,300\/MT/);
  assert.match(confirmed.reply, /2\. Heavy Structural Beam \(ISMB\) 25 MT —[\s\S]*Rate ₹11,300\/MT/);
  assert.match(confirmed.reply, /Heavy Base Plate 20 MT —[\s\S]*Rate ₹10,300\/MT/);
  assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
});

test('a line number fills only that material', async () => {
  const { db, intents, flow } = openInquiry(MATERIALS);
  await handleFullSalesPrice('btn_price_current|PR-10251', PHONE, intents.at(-1), flow);
  const next = await handleFullSalesPrice('1. 10000, 100, 100, 0, 100', PHONE, intents.at(-1), flow);
  assert.doesNotMatch(next.reply, /Save this price\?/);
  assert.doesNotMatch(next.reply, /Base must be a price/);
  assert.match(next.reply, /Line 2/);
  const saved = JSON.parse(String(intents.at(-1)).slice('sales_full|'.length));
  assert.equal(saved.rows[0].base, 10000);
  assert.equal(saved.rows[1] ?? null, null);
  assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
});

test('semicolon, pipe, and space separators reach confirmation', async () => {
  for (const message of ['10000; 100; 100; 0; 100', '10000 | 100 | 100 | 0 | 100', '10000 100 100 0 100']) {
    const { db, intents, flow } = openInquiry(
      [{ line_key: 'hr', sku_text: 'HR Coil', quantity: 10, unit: 'MT' }],
      'PR-20010',
    );
    await handleFullSalesPrice('btn_price_current|PR-20010', PHONE, intents.at(-1), flow);
    const confirmed = await handleFullSalesPrice(message, PHONE, intents.at(-1), flow);
    assert.match(confirmed.reply, /Save this price\?/);
    assert.match(confirmed.reply, /₹10,300\/MT/);
    assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
  }
});

test('an unknown material is named and not saved', async () => {
  const { db, intents, flow } = openInquiry(MATERIALS);
  await handleFullSalesPrice('btn_price_current|PR-10251', PHONE, intents.at(-1), flow);
  const reply = await handleFullSalesPrice('Wire Rod 8 MT: 10000, 100, 100, 0, 100', PHONE, intents.at(-1), flow);
  assert.match(reply.reply, /Wire Rod 8 MT/);
  assert.doesNotMatch(reply.reply, /Save this price\?/);
  assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
});
