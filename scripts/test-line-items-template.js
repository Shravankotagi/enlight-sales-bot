require('dotenv').config();
const assert = require('assert');
const { formatDetailedInquiryItemsList } = require('../src/core/catalogFlow');

async function runComprehensiveTests() {
  console.log('=== Comprehensive Line Items Template Audit Test Suite ===\n');

  // Test 1: Standard Item with Rate & Line Total (with 18% GST added)
  console.log('--- Test 1: Standard Item with Rate & Line Total (with 18% GST) ---');
  const items1 = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 }
  ];
  const out1 = formatDetailedInquiryItemsList(items1);
  console.log('Output 1:', out1);
  assert.strictEqual(out1, 'HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹4,672.80');
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

  // Test 3: Multiple Items Numbered (with 18% GST added to Line Total)
  console.log('--- Test 3: Multiple Items Numbered ---');
  const items3 = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 },
    { sku_text: 'CR Sheet', dimensions: '2mm', quantity: 20, unit: 'MT', rate: 92, amount: 1840 }
  ];
  const out3 = formatDetailedInquiryItemsList(items3);
  console.log('Output 3:\n' + out3);
  assert.strictEqual(out3, '1. HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹4,672.80\n2. CR Sheet (2mm) | 20 MT | ₹92 /MT | Line Total: ₹2,171.20');
  console.log('✅ Test 3 Passed\n');

  // Test 4: Property Aliases (product_requirement, quantity_mt, rate_per_mt, thickness) with 18% GST
  console.log('--- Test 4: Property Aliases Compatibility ---');
  const items4 = [
    { product_requirement: 'GP Sheet', thickness: '0.5mm', quantity_mt: 30, rate_per_mt: 75000 }
  ];
  const out4 = formatDetailedInquiryItemsList(items4);
  console.log('Output 4:', out4);
  // 30 MT * 75000 = 22,50,000 + 18% GST (4,05,000) = 26,55,000
  assert.strictEqual(out4, 'GP Sheet (0.5mm) | 30 MT | ₹75,000 /MT | Line Total: ₹26,55,000');
  console.log('✅ Test 4 Passed\n');

  // Test 5: Auto-calculation of Line Total when amount is not explicitly provided (with 18% GST)
  console.log('--- Test 5: Auto-calculation of Line Total ---');
  const items5 = [
    { sku_text: 'MS Plate', dimensions: '12mm', quantity: 10, unit: 'MT', rate: 60000 }
  ];
  const out5 = formatDetailedInquiryItemsList(items5);
  console.log('Output 5:', out5);
  // 10 MT * 60000 = 6,00,000 + 18% GST (1,08,000) = 7,08,000
  assert.strictEqual(out5, 'MS Plate (12mm) | 10 MT | ₹60,000 /MT | Line Total: ₹7,08,000');
  console.log('✅ Test 5 Passed\n');

  // Test 6: Dimension already in product name
  console.log('--- Test 6: Dimension already in product name should not duplicate ---');
  const items6 = [
    { sku_text: 'HR Coil 8mm', dimensions: '8mm', quantity: 15, unit: 'MT', rate: 52000 }
  ];
  const out6 = formatDetailedInquiryItemsList(items6);
  console.log('Output 6:', out6);
  // 15 MT * 52000 = 7,80,000 + 18% GST (1,40,400) = 9,20,400
  assert.strictEqual(out6, 'HR Coil 8mm | 15 MT | ₹52,000 /MT | Line Total: ₹9,20,400');
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

  // Test 8: KG to MT conversion with Rate per MT and 18% GST Line Total (Exact PO Match)
  console.log('--- Test 8: KG to MT conversion (Exact Adoriva Infratech PO match) ---');
  const items8 = [
    { sku_text: 'HR PLATE', dimensions: '12000MM', quantity: 22000, unit: 'KG', rate: 68.5, amount: 1507000 }
  ];
  const out8 = formatDetailedInquiryItemsList(items8);
  console.log('Output 8:', out8);
  // 22000 KG -> 22 MT | Rate: 68.5 * 1000 = ₹68,500 /MT | Line Total: 15,07,000 + 18% GST = ₹17,78,260
  assert.strictEqual(out8, 'HR PLATE (12000MM) | 22 MT | ₹68,500 /MT | Line Total: ₹17,78,260');
  console.log('✅ Test 8 Passed\n');

  // Test 9: Nos to MT conversion with 18% GST Line Total
  console.log('--- Test 9: Nos to MT conversion (TMT Bar pieces to MT) ---');
  const items9 = [
    { sku_text: 'TMT Bar 12mm', dimensions: '12mm x 12m', quantity: 100, unit: 'Nos', rate: 60000 }
  ];
  const out9 = formatDetailedInquiryItemsList(items9);
  console.log('Output 9:', out9);
  // (12^2 / 162) * 12 * 100 / 1000 = 1.067 MT | Rate: ₹60,000 /MT | Base: 64,020 + 18% GST: 11,523.60 = Line Total: ₹75,543.60
  assert.strictEqual(out9, 'TMT Bar 12mm (12mm x 12m) | 1.067 MT | ₹60,000 /MT | Line Total: ₹75,543.60');
  console.log('✅ Test 9 Passed\n');

  console.log('🎉 ALL COMPREHENSIVE AUDIT TESTS PASSED SUCCESSFULLY! 🎉');
}

runComprehensiveTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
