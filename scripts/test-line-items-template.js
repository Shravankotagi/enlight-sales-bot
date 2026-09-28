require('dotenv').config();
const assert = require('assert');
const { formatDetailedInquiryItemsList } = require('../src/core/catalogFlow');

async function runComprehensiveTests() {
  console.log('=== Comprehensive Line Items Template Audit Test Suite ===\n');

  // Test 1: Standard Item with Rate & Line Total
  console.log('--- Test 1: Standard Item with Rate & Line Total ---');
  const items1 = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 }
  ];
  const out1 = formatDetailedInquiryItemsList(items1);
  console.log('Output 1:', out1);
  assert.strictEqual(out1, 'HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960');
  console.log('✅ Test 1 Passed\n');

  // Test 2: Standard Item Without Rate
  console.log('--- Test 2: Standard Item Without Rate ---');
  const items2 = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT' }
  ];
  const out2 = formatDetailedInquiryItemsList(items2);
  console.log('Output 2:', out2);
  assert.strictEqual(out2, 'HR Coil (7mm) | 45 MT');
  console.log('✅ Test 2 Passed\n');

  // Test 3: Multiple Items Numbered
  console.log('--- Test 3: Multiple Items Numbered ---');
  const items3 = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 },
    { sku_text: 'CR Sheet', dimensions: '2mm', quantity: 20, unit: 'MT', rate: 92, amount: 1840 }
  ];
  const out3 = formatDetailedInquiryItemsList(items3);
  console.log('Output 3:\n' + out3);
  assert.strictEqual(out3, '1. HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960\n2. CR Sheet (2mm) | 20 MT | ₹92 /MT | Line Total: ₹1,840');
  console.log('✅ Test 3 Passed\n');

  // Test 4: Property Aliases (product_requirement, quantity_mt, rate_per_mt, thickness)
  console.log('--- Test 4: Property Aliases Compatibility ---');
  const items4 = [
    { product_requirement: 'GP Sheet', thickness: '0.5mm', quantity_mt: 30, rate_per_mt: 75000 }
  ];
  const out4 = formatDetailedInquiryItemsList(items4);
  console.log('Output 4:', out4);
  assert.strictEqual(out4, 'GP Sheet (0.5mm) | 30 MT | ₹75,000 /MT | Line Total: ₹22,50,000');
  console.log('✅ Test 4 Passed\n');

  // Test 5: Auto-calculation of Line Total when amount is not explicitly provided
  console.log('--- Test 5: Auto-calculation of Line Total ---');
  const items5 = [
    { sku_text: 'MS Plate', dimensions: '12mm', quantity: 10, unit: 'MT', rate: 60000 }
  ];
  const out5 = formatDetailedInquiryItemsList(items5);
  console.log('Output 5:', out5);
  assert.strictEqual(out5, 'MS Plate (12mm) | 10 MT | ₹60,000 /MT | Line Total: ₹6,00,000');
  console.log('✅ Test 5 Passed\n');

  // Test 6: Dimension already in product name
  console.log('--- Test 6: Dimension already in product name should not duplicate ---');
  const items6 = [
    { sku_text: 'HR Coil 8mm', dimensions: '8mm', quantity: 15, unit: 'MT', rate: 52000 }
  ];
  const out6 = formatDetailedInquiryItemsList(items6);
  console.log('Output 6:', out6);
  assert.strictEqual(out6, 'HR Coil 8mm | 15 MT | ₹52,000 /MT | Line Total: ₹7,80,000');
  console.log('✅ Test 6 Passed\n');

  // Test 7: Empty or missing fields edge case
  console.log('--- Test 7: Empty or missing fields ---');
  const items7 = [
    { sku_text: 'TMT Rebars' }
  ];
  const out7 = formatDetailedInquiryItemsList(items7);
  console.log('Output 7:', out7);
  assert.strictEqual(out7, 'TMT Rebars');
  console.log('✅ Test 7 Passed\n');

  console.log('🎉 ALL COMPREHENSIVE AUDIT TESTS PASSED SUCCESSFULLY! 🎉');
}

runComprehensiveTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
