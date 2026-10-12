const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDuplicateCustomerResponse,
  validateDraftProducts,
  handleCatalogFlow,
  UNKNOWN_PRODUCT_BUTTONS,
  ADD_PRODUCT_CONFIRM_BUTTONS,
  CONFIRMATION_BUTTONS,
} = require('./catalogFlow');
const { saveActiveSession } = require('../supabase');

test('duplicate customer response only offers discard draft', () => {
  const response = buildDuplicateCustomerResponse(
    '*Customer Already Registered!*\n\nAssigned Representative: Vedant Goel',
  );

  assert.equal(response.handled, true);
  assert.match(response.reply, /Customer Already Registered/);
  assert.doesNotMatch(response.reply, /What would you like to do/i);
  assert.doesNotMatch(response.reply, /different customer name/i);
  assert.doesNotMatch(response.reply, /reply .*cancel/i);
  assert.deepEqual(response.interactiveButtons, [
    { id: 'btn_confirm_cancel', title: 'Discard Draft' },
  ]);
});

test('validateDraftProducts rejects unknown product and returns Add Product button', () => {
  const draft = {
    company_name: 'Tata Motors',
    line_items: [
      { sku_text: 'PLATE', dimensions: '10mm', quantity: 20, unit: 'MT' },
    ],
  };

  const result = validateDraftProducts('LOG_INQUIRY', draft);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.invalidProducts, ['PLATE']);
  assert.match(result.clarificationMessage, /Add Product/i);
  assert.deepEqual(result.interactiveButtons, UNKNOWN_PRODUCT_BUTTONS);
});

test('Add Product enforces all 3 mandatory fields (*), accepts partial inputs, and treats added product as valid afterwards', async () => {
  const senderPhone = '9999900011';
  const draft = {
    company_name: 'Tata Motors',
    delivery_location: 'Pune',
    payment_terms: 'Advance',
    _customer_verified: true,
    line_items: [
      { sku_text: 'Custom Titanium Alloy', dimensions: '', quantity: 15, unit: 'MT', rate: 55000 },
    ],
  };

  await saveActiveSession(
    senderPhone,
    'Tata Motors',
    `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`,
  );

  // 1. User taps "Add Product" button -> shows mandatory stars (*) and empty Specs/HSN
  const addStep = await handleCatalogFlow('btn_add_product', senderPhone);
  assert.equal(addStep.handled, true);
  assert.match(addStep.reply, /Add New Product/);
  assert.match(addStep.reply, /\*\*Product Name \*:\*\* Custom Titanium Alloy/);
  assert.match(addStep.reply, /\*\*Specs \/ Dimensions \*:\*\* _Empty_/);
  assert.match(addStep.reply, /\*\*HSN\/SAC Code \*:\*\* _Empty_/);
  assert.deepEqual(addStep.interactiveButtons, ADD_PRODUCT_CONFIRM_BUTTONS);

  // 2. Trying to save before filling all 3 fields is blocked
  const blockedSave1 = await handleCatalogFlow('btn_prod_save', senderPhone);
  assert.equal(blockedSave1.handled, true);
  assert.match(blockedSave1.reply, /Cannot save product yet/i);
  assert.match(blockedSave1.reply, /Specs \/ Dimensions \*/);
  assert.match(blockedSave1.reply, /HSN\/SAC Code \*/);

  // 3. Partial input: user sends only Specs/Dimensions -> keeps Product Name, still blocks save without HSN
  const partialSpecStep = await handleCatalogFlow('12mm x 1500mm', senderPhone);
  assert.equal(partialSpecStep.handled, true);
  assert.match(partialSpecStep.reply, /\*\*Product Name \*:\*\* Custom Titanium Alloy/);
  assert.match(partialSpecStep.reply, /\*\*Specs \/ Dimensions \*:\*\* 12mm x 1500mm/);
  assert.match(partialSpecStep.reply, /\*\*HSN\/SAC Code \*:\*\* _Empty_/);

  const blockedSave2 = await handleCatalogFlow('btn_prod_save', senderPhone);
  assert.equal(blockedSave2.handled, true);
  assert.match(blockedSave2.reply, /Cannot save product yet/i);
  assert.match(blockedSave2.reply, /HSN\/SAC Code \*/);

  // 4. Partial input: user sends only HSN/SAC code -> keeps Name and Specs
  const partialHsnStep = await handleCatalogFlow('81089010', senderPhone);
  assert.equal(partialHsnStep.handled, true);
  assert.match(partialHsnStep.reply, /\*\*Product Name \*:\*\* Custom Titanium Alloy/);
  assert.match(partialHsnStep.reply, /\*\*Specs \/ Dimensions \*:\*\* 12mm x 1500mm/);
  assert.match(partialHsnStep.reply, /\*\*HSN\/SAC Code \*:\*\* 81089010/);

  // 5. Now all 3 fields are filled -> Save Product succeeds and moves to confirmation
  const saveStep = await handleCatalogFlow('btn_prod_save', senderPhone);
  assert.equal(saveStep.handled, true);
  assert.match(saveStep.reply, /Product "Custom Titanium Alloy" Added/i);
  assert.deepEqual(saveStep.interactiveButtons, CONFIRMATION_BUTTONS);

  // 6. Treated as valid afterwards: used in a later inquiry -> validateDraftProducts passes!
  const laterCheck = validateDraftProducts('LOG_INQUIRY', {
    company_name: 'Mahindra',
    line_items: [{ sku_text: 'Custom Titanium Alloy', dimensions: '12mm x 1500mm', quantity: 5, unit: 'MT' }],
  });
  assert.equal(laterCheck.isValid, true);
});

test('Multiple unlisted products: inquiry cannot be saved until every unlisted product is resolved', async () => {
  const senderPhone = '9999900022';
  const draft = {
    company_name: 'Tata Motors',
    delivery_location: 'Pune',
    payment_terms: 'Advance',
    _customer_verified: true,
    line_items: [
      { sku_text: 'Unlisted Alpha Coil', dimensions: '5mm', quantity: 10, unit: 'MT', rate: 50000 },
      { sku_text: 'Unlisted Beta Pipe', dimensions: '50mm', quantity: 8, unit: 'MT', rate: 52000 },
    ],
  };

  const initialCheck = validateDraftProducts('LOG_INQUIRY', draft);
  assert.equal(initialCheck.isValid, false);
  assert.deepEqual(initialCheck.invalidProducts, ['Unlisted Alpha Coil', 'Unlisted Beta Pipe']);

  await saveActiveSession(
    senderPhone,
    'Tata Motors',
    `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`,
  );

  // Resolve 1st product by selecting a catalog product ("HR Coil")
  const resolveFirst = await handleCatalogFlow('HR Coil', senderPhone);
  assert.equal(resolveFirst.handled, true);
  // Must still block and ask for the remaining unlisted product ("Unlisted Beta Pipe")
  assert.match(resolveFirst.reply, /These products are not in our product list: Unlisted Beta Pipe/i);
  assert.doesNotMatch(resolveFirst.reply, /Unlisted Alpha Coil/i);
  assert.deepEqual(resolveFirst.interactiveButtons, UNKNOWN_PRODUCT_BUTTONS);

  // Resolve 2nd product via Add Product with all 3 mandatory fields
  const addSecond = await handleCatalogFlow('btn_add_product', senderPhone);
  assert.match(addSecond.reply, /Unlisted Beta Pipe/);
  await handleCatalogFlow('73063090', senderPhone);
  const saveSecond = await handleCatalogFlow('btn_prod_save', senderPhone);
  assert.match(saveSecond.reply, /Product "Unlisted Beta Pipe" Added/i);
  assert.deepEqual(saveSecond.interactiveButtons, CONFIRMATION_BUTTONS);
});


