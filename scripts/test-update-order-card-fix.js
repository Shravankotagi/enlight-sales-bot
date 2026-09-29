require('dotenv').config();
const assert = require('assert');
const {
  formatDetailedInquiryItemsList,
  formatSelectedOrderPrompt,
  handleCatalogFlow,
} = require('../src/core/catalogFlow');

async function testUpdateOrderCard() {
  console.log('--- Testing formatSelectedOrderPrompt Unit Test ---');

  const mockRecord = {
    id: 'DEAL-7E426C-999',
    inquiry_id: 'INQ-7E426C',
    po_number: 'P0989',
    po_date: '2026-09-28',
    customer_name: 'shree trades',
    stage: 'won',
    delivery_location: 'Mumbai',
    payment_terms: '68 Days Credit',
    deal_items: [
      {
        sku_text: 'HR Coil',
        dimensions: '3mm',
        quantity: 12,
        unit: 'MT',
        rate: 33,
        amount: 396,
        hsn_code: '72083740',
      },
    ],
  };

  const itemsListText = formatDetailedInquiryItemsList(mockRecord.deal_items, { includeHsn: true });
  console.log('Formatted items:\n' + itemsListText);
  assert(itemsListText.includes('HR Coil (3mm) [HSN: 72083740] | 12 MT | ₹33 /MT | Line Total: ₹396'));

  const prompt = formatSelectedOrderPrompt(mockRecord, itemsListText);
  console.log('\n--- Rendered Selected Order Card ---');
  console.log(prompt);
  console.log('------------------------------------\n');

  assert(prompt.includes('Selected Order P0989 (shree trades):'), 'Header must contain Selected Order displayId and customer');
  assert(prompt.includes('Linked Inquiry: INQ-7E426C') || prompt.includes('Linked Inquiry:* INQ-7E426C'), 'Must show Linked Inquiry');
  assert(prompt.includes('PO Number: P0989') || prompt.includes('PO Number:* P0989'), 'Must show PO Number');
  assert(prompt.includes('PO Date: 28-09-2026') || prompt.includes('PO Date:* 28-09-2026'), 'Must show PO Date');
  assert(prompt.includes('Stage: Won') || prompt.includes('Stage:* Won'), 'Must show Stage');
  assert(prompt.includes('Delivery Location: Mumbai') || prompt.includes('Delivery Location:* Mumbai'), 'Must show Delivery Location');
  assert(prompt.includes('Payment Terms: 68 Days Credit') || prompt.includes('Payment Terms:* 68 Days Credit'), 'Must show Payment Terms');
  assert(prompt.includes('HR Coil (3mm) [HSN: 72083740] | 12 MT | ₹33 /MT | Line Total: ₹396'), 'Must show Line item with HSN');
  assert(prompt.includes('Total Tonnage: 12 MT') || prompt.includes('Total Tonnage:* 12 MT'), 'Must show Total Tonnage');
  assert(prompt.includes('Sub Total: ₹396') || prompt.includes('Sub Total:* ₹396'), 'Must show Sub Total');
  assert(prompt.includes('GST (18%): ₹71.28') || prompt.includes('GST (18%):* ₹71.28'), 'Must show GST 18%');
  assert(prompt.includes('Total Order Value: ₹467.28') || prompt.includes('Total Order Value:* ₹467.28'), 'Must show Total Order Value');
  assert(prompt.includes('Which field would you like to update? (Rate, Quantity, PO Number, PO Date, Delivery Location, Payment Terms, Stage, Attach PO)'), 'Must show full allowed update prompt');

  console.log('✅ Unit test passed 100%!');

  // Test live handleCatalogFlow Update Order selection
  console.log('\n--- Testing live Update Order selection flow ---');
  const REAL_SP_PHONE = '8262937458';
  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  const listRes = await handleCatalogFlow('update order', REAL_SP_PHONE);
  console.log('List response:\n' + listRes.reply?.slice(0, 200) + '...\n');

  const selectRes = await handleCatalogFlow('1', REAL_SP_PHONE);
  console.log('Selection card response:\n' + selectRes.reply);
  assert(selectRes.handled === true);
  assert(selectRes.reply.includes('Selected Order'));
  assert(selectRes.reply.includes('Linked Inquiry'));
  assert(selectRes.reply.includes('Delivery Location'));
  assert(selectRes.reply.includes('Payment Terms'));
  assert(selectRes.reply.includes('Sub Total'));
  assert(selectRes.reply.includes('GST (18%)'));
  assert(selectRes.reply.includes('Total Order Value'));
  assert(selectRes.reply.includes('Which field would you like to update?'));

  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

testUpdateOrderCard().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
