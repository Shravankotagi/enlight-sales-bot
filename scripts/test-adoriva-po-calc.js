const assert = require('assert');
const { calculateLineItems, calculatePricingSummary, calculateQuotationBreakdown } = require('../src/utils/pricingEngine');
const { formatDetailedInquiryItemsList } = require('../src/core/catalogFlow');

console.log('=== Test: Adoriva Infratech PO 13-Line Items Calculation & Display Audit ===\n');

// 13 Line items from the uploaded Adoriva Infratech PO document
const adorivaPoItems = [
  { sku_text: 'RMX5X1250X12000 REST ALL SIZES AS PER BOQ', quantity: 22000, unit: 'KGS', rate: 68.5, amount: 1507000 },
  { sku_text: 'RMX5X1500X12000 REST ALL SIZES AS PER BOQ', quantity: 38000, unit: 'KGS', rate: 68.5, amount: 2603000 },
  { sku_text: 'RMX6X1250X12000 REST ALL SIZES AS PER BOQ', quantity: 25000, unit: 'KGS', rate: 68.5, amount: 1712500 },
  { sku_text: 'RMX6X2000X11490 REST ALL SIZES AS PER BOQ', quantity: 18000, unit: 'KGS', rate: 68.5, amount: 1233000 },
  { sku_text: 'RMX8X1250X9950 REST ALL SIZES AS PER BOQ', quantity: 13000, unit: 'KGS', rate: 68.5, amount: 890500 },
  { sku_text: 'RMX8X1500X11660 REST ALL SIZES AS PER BOQ', quantity: 10000, unit: 'KGS', rate: 68.5, amount: 685000 },
  { sku_text: 'RMX10X1500X10500 REST ALL SIZES AS PER BOQ', quantity: 19000, unit: 'KGS', rate: 68.5, amount: 1301500 },
  { sku_text: 'RMX10X2000X7950 REST ALL SIZES AS PER BOQ', quantity: 60000, unit: 'KGS', rate: 68.5, amount: 4110000 },
  { sku_text: 'RMX12X2000X12000 REST ALL SIZES AS PER BOQ', quantity: 11000, unit: 'KGS', rate: 69, amount: 759000 },
  { sku_text: 'RMX12X1500X8000 REST ALL SIZES AS PER BOQ', quantity: 3000, unit: 'KGS', rate: 68.5, amount: 205500 },
  { sku_text: 'RMX12X1250X10250 REST ALL SIZES AS PER BOQ', quantity: 26000, unit: 'KGS', rate: 68.5, amount: 1781000 },
  { sku_text: 'RMX16X1500X9700 REST ALL SIZES AS PER BOQ', quantity: 15000, unit: 'KGS', rate: 69, amount: 1035000 },
  { sku_text: 'RMX20X2500X6000', quantity: 20000, unit: 'KGS', rate: 69, amount: 1380000 },
];

// Expected amounts from the PO document
const expectedTotalsWithGst = [
  1778260, 3071540, 2020750, 1454940, 1050790, 808300,
  1535770, 4849800, 895620, 242490, 2101580, 1221300, 1628400
];

const processed = calculateLineItems(adorivaPoItems);

console.log('1. Verifying line item calculations:');
let sumFinalAmounts = 0;
processed.forEach((item, idx) => {
  assert.strictEqual(item.unit, 'MT', `Item ${idx + 1} unit must be MT`);
  assert.strictEqual(item.final_amount, expectedTotalsWithGst[idx], `Item ${idx + 1} final amount must match PO`);
  sumFinalAmounts += item.final_amount;
  console.log(`  Line ${idx + 1}: ${item.quantity} MT @ ₹${item.rate.toLocaleString('en-IN')}/MT | Base: ₹${item.amount.toLocaleString('en-IN')} | Final (Base+GST): ₹${item.final_amount.toLocaleString('en-IN')}`);
});

console.log('\n2. Verifying PO totals:');
const summary = calculatePricingSummary(adorivaPoItems);
console.log(`  Base Subtotal: ₹${summary.subtotal.toLocaleString('en-IN')} (Expected: 1,92,03,000)`);
console.log(`  18% GST:       ₹${summary.gstAmount.toLocaleString('en-IN')} (Expected: 34,56,540)`);
console.log(`  Grand Total:   ₹${summary.grandTotal.toLocaleString('en-IN')} (Expected: 2,26,59,540)`);
console.log(`  Sum of Line Totals: ₹${sumFinalAmounts.toLocaleString('en-IN')}`);

assert.strictEqual(summary.subtotal, 19203000, 'Subtotal base must equal 1,92,03,000');
assert.strictEqual(summary.gstAmount, 3456540, 'GST must equal 34,56,540');
assert.strictEqual(summary.grandTotal, 22659540, 'Grand Total must equal 2,26,59,540');
assert.strictEqual(sumFinalAmounts, 22659540, 'Sum of all line totals must equal Grand Total 2,26,59,540');

console.log('\n3. Verifying WhatsApp formatted string:');
const formattedText = formatDetailedInquiryItemsList(adorivaPoItems);
console.log(formattedText);

assert(formattedText.includes('1. RMX5X1250X12000 REST ALL SIZES AS PER BOQ | 22 MT | ₹68,500 /MT | Line Total: ₹17,78,260'));
assert(formattedText.includes('13. RMX20X2500X6000 | 20 MT | ₹69,000 /MT | Line Total: ₹16,28,400'));

console.log('\n🎉 ALL ADORIVA PO 13-LINE ITEMS CALCULATIONS & DISPLAYS PASSED PERFECTLY! 🎉\n');
