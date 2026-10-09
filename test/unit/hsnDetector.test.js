const test = require('node:test');
const assert = require('node:assert/strict');

const hsn = require('../../src/utils/hsnDetector');

test('HR Coil HSN code follows the thickness bands', () => {
  assert.equal(hsn.detectHsnCode('HR Coil 2mm'), '72083940');
  assert.equal(hsn.detectHsnCode('HR Coil 3.5mm'), '72083840');
  assert.equal(hsn.detectHsnCode('HR Coil 6mm'), '72083740');
  assert.equal(hsn.detectHsnCode('HR Coil 12mm'), '72083740');
});

test('GI Sheet is normalized to the GP Sheet catalog entry', () => {
  const r = hsn.normalizeProductToCatalog('GI Sheet');
  assert.equal(r.isValid, true);
  assert.equal(r.catalogName, 'GP Sheet');
  assert.equal(r.hsnCode, '72104900');
});

test('unknown products are not valid catalog products', () => {
  assert.equal(hsn.isValidCatalogProduct('random widget'), false);
  assert.equal(hsn.normalizeProductToCatalog('random widget').isValid, false);
});

test('extractThickness reads millimetre values', () => {
  assert.equal(hsn.extractThickness('MS plate 12mm'), 12);
});

test('every catalog entry has an 8-digit HSN code and a consistent thickness range', () => {
  for (const item of hsn.MASTER_PRODUCTS_CATALOG) {
    assert.match(String(item.hsn_code), /^\d{8}$/, `${item.product_name} HSN`);
    if (item.min_thickness_mm != null && item.max_thickness_mm != null) {
      assert.ok(item.min_thickness_mm <= item.max_thickness_mm, `${item.product_name} thickness range`);
    }
  }
});
