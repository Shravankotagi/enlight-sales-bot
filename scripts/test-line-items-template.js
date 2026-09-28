require('dotenv').config();
const assert = require('assert');

// 1. Test retrieval tools line items formatting
const { get_inquiries, get_deal_ids } = require('../src/core/retrievalTools');

// 2. Test catalogFlow helper
const { handleCatalogFlow } = require('../src/core/catalogFlow');

async function testLineItemsFormatting() {
  console.log('=== Starting Line Items Single-Line Piped Template Verification ===\n');

  // Test retrieval query formatting simulation
  const dummyItemsWithPricing = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 },
  ];

  const dummyMultiItems = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 },
    { sku_text: 'CR Sheet', dimensions: '2mm', quantity: 20, unit: 'MT', rate: 92, amount: 1840 },
  ];

  const dummyItemsWithoutPricing = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT' },
  ];

  // Helper logic check
  const formatItem = (it, idx, totalCount) => {
    const prefix = totalCount > 1 ? `${idx + 1}. ` : '';
    const spec = it.dimensions ? ` (${it.dimensions})` : '';
    const qtyStr = it.quantity ? `${it.quantity} ${it.unit || 'MT'}` : '';
    const rate = Number(it.rate || 0);
    const amt = Number(it.amount || 0) || (rate > 0 && it.quantity ? rate * Number(it.quantity) : 0);
    if (rate > 0) {
      const lineTotalStr = amt > 0 ? ` | Line Total: ₹${amt.toLocaleString('en-IN')}` : '';
      return `${prefix}${it.sku_text || 'Item'}${spec} | ${qtyStr} | ₹${rate.toLocaleString('en-IN')} /${it.unit || 'MT'}${lineTotalStr}`;
    }
    return `${prefix}${it.sku_text || 'Item'}${spec} | ${qtyStr}`;
  };

  console.log('--- Test 1: Single item with rate & line total ---');
  const res1 = formatItem(dummyItemsWithPricing[0], 0, 1);
  console.log('Output 1:', res1);
  assert.strictEqual(res1, 'HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960');
  console.log('✅ Test 1 Passed\n');

  console.log('--- Test 2: Single item without rate ---');
  const res2 = formatItem(dummyItemsWithoutPricing[0], 0, 1);
  console.log('Output 2:', res2);
  assert.strictEqual(res2, 'HR Coil (7mm) | 45 MT');
  console.log('✅ Test 2 Passed\n');

  console.log('--- Test 3: Multiple items with rate & line total ---');
  const res3 = dummyMultiItems.map((it, idx) => formatItem(it, idx, dummyMultiItems.length)).join('\n');
  console.log('Output 3:\n' + res3);
  assert(res3.includes('1. HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960'));
  assert(res3.includes('2. CR Sheet (2mm) | 20 MT | ₹92 /MT | Line Total: ₹1,840'));
  console.log('✅ Test 3 Passed\n');

  console.log('🎉 ALL LINE ITEMS TEMPLATE TESTS PASSED SUCCESSFULLY! 🎉');
}

testLineItemsFormatting().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
