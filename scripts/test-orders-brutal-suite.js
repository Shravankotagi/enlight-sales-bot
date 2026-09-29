require('dotenv').config();
const assert = require('assert');
const {
  handleCatalogFlow,
  formatDetailedInquiryItemsList,
  getAllowedFieldsListForAction,
  getEditPromptForAction
} = require('../src/core/catalogFlow');
const { calculateQuotationBreakdown } = require('../src/utils/pricingEngine');
const { executeGetMyOpenDeals, executeGetInquiries, executeGetDealIds, executeQueryMyData, resolveCallerContext } = require('../src/core/retrievalTools');

const REAL_SP_PHONE = '8262937458';

async function runOrdersBrutalTestSuite() {
  console.log('================================================================');
  console.log('🚀 BRUTAL TEST SUITE FOR WHATSAPP BOT ORDERS MODULE');
  console.log('================================================================\n');

  const testResults = [];
  function recordTest(title, passed, details = '') {
    testResults.push({ title, passed, details });
    if (passed) {
      console.log(`✅ [PASS] ${title}`);
    } else {
      console.log(`❌ [FAIL] ${title}: ${details}`);
    }
  }

  // Clear previous session for clean test
  await handleCatalogFlow('cancel', REAL_SP_PHONE);

  // ───────────────────────────────────────────────────────────────────────────
  // CATEGORY 1: Menu Navigation & Action Routing (WhatsApp Standard Flow)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- Category 1: Menu Navigation & Action Routing ---');

  // Test 1.1: Menu -> Option 3 (Log Order)
  await handleCatalogFlow('menu', REAL_SP_PHONE);
  const resOpt3 = await handleCatalogFlow('3', REAL_SP_PHONE);
  recordTest(
    'Menu -> "3" starts LOG_ORDER (Log New Order)',
    resOpt3.handled === true && (resOpt3.reply.includes('Record New Order') || resOpt3.reply.includes('Inquiry ID') || resOpt3.reply.includes('PO')),
    `Reply:\n${resOpt3.reply?.slice(0, 150)}...`
  );
  await handleCatalogFlow('cancel', REAL_SP_PHONE);

  // Test 1.2: Menu -> Option 4 (Update Order)
  await handleCatalogFlow('menu', REAL_SP_PHONE);
  const resOpt4 = await handleCatalogFlow('4', REAL_SP_PHONE);
  recordTest(
    'Menu -> "4" starts UPDATE_ORDER (renders recent orders list)',
    resOpt4.handled === true && (resOpt4.reply.includes('Update Order') || resOpt4.reply.includes('recent orders') || resOpt4.reply.includes('PO:')),
    `Reply:\n${resOpt4.reply?.slice(0, 150)}...`
  );

  // Test 1.3: Direct natural language "update order"
  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  const resNLUpdate = await handleCatalogFlow('update order', REAL_SP_PHONE);
  recordTest(
    'Direct natural language "update order" opens UPDATE_ORDER',
    resNLUpdate.handled === true && (resNLUpdate.reply.includes('Update Order') || resNLUpdate.reply.includes('recent orders') || resNLUpdate.reply.includes('PO:')),
    `Reply:\n${resNLUpdate.reply?.slice(0, 150)}...`
  );

  // Test 1.4: Direct natural language "log order"
  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  const resNLLog = await handleCatalogFlow('log order', REAL_SP_PHONE);
  recordTest(
    'Direct natural language "log order" opens LOG_ORDER',
    resNLLog.handled === true && (resNLLog.reply.includes('Record New Order') || resNLLog.reply.includes('Inquiry ID') || resNLLog.reply.includes('PO')),
    `Reply:\n${resNLLog.reply?.slice(0, 150)}...`
  );
  await handleCatalogFlow('cancel', REAL_SP_PHONE);

  // ───────────────────────────────────────────────────────────────────────────
  // CATEGORY 2: Allowed Fields vs Non-Editable Guards
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Category 2: Allowed Fields vs Non-Editable Guards ---');

  // Test 2.1: Allowed fields for UPDATE_ORDER
  const allowedFields = getAllowedFieldsListForAction('UPDATE_ORDER');
  recordTest(
    'Allowed fields for UPDATE_ORDER advertises PO Number, PO Date, Delivery Location, Payment Terms, Line Items',
    allowedFields.includes('PO Number') && allowedFields.includes('Delivery Location') && allowedFields.includes('Payment Terms') && allowedFields.includes('Line Item'),
    `Allowed fields:\n${allowedFields}`
  );

  // Test 2.2: Edit prompt for UPDATE_ORDER
  const editPrompt = getEditPromptForAction('UPDATE_ORDER');
  recordTest(
    'Edit prompt for UPDATE_ORDER lists representative examples',
    editPrompt.includes('PO Number') || editPrompt.includes('Rate') || editPrompt.includes('Delivery location'),
    `Edit prompt: "${editPrompt}"`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // CATEGORY 3: Financial Calculations & Piped Formatting
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Category 3: Financial Calculations & Piped Formatting ---');

  // Test 3.1: Financial calculation with 18% GST
  const calcBreakdown = calculateQuotationBreakdown(500000);
  recordTest(
    'Basic value ₹5,00,000 calculates GST ₹90,000 and Grand Total ₹5,90,000',
    calcBreakdown.subtotal === 500000 && calcBreakdown.GST === 90000 && calcBreakdown.grandTotal === 590000,
    `Breakdown: ${JSON.stringify(calcBreakdown)}`
  );

  // Test 3.2: Single line item formatted strictly with pipe template
  const singleItem = [{ sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 }];
  const singlePiped = formatDetailedInquiryItemsList(singleItem);
  recordTest(
    'Single line item formatted as: HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960',
    singlePiped === 'HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960',
    `Formatted: "${singlePiped}"`
  );

  // Test 3.3: Multi-line items formatted with numbers and pipe template
  const multiItems = [
    { sku_text: 'HR Coil', dimensions: '6mm', quantity: 50, unit: 'MT', rate: 52000, amount: 2600000 },
    { sku_text: 'CR Sheet', dimensions: '2mm', quantity: 20, unit: 'MT', rate: 58000, amount: 1160000 }
  ];
  const multiPiped = formatDetailedInquiryItemsList(multiItems);
  recordTest(
    'Multi-line items formatted with numbers and single-line pipe format',
    multiPiped.includes('1. HR Coil (6mm) | 50 MT | ₹52,000 /MT | Line Total: ₹26,00,000') &&
    multiPiped.includes('2. CR Sheet (2mm) | 20 MT | ₹58,000 /MT | Line Total: ₹11,60,000'),
    `Formatted:\n${multiPiped}`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // CATEGORY 4: Candidate Selection & Active UPDATE_ORDER Session
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Category 4: Candidate Selection & Non-Editable Guards in Active Session ---');

  // Start UPDATE_ORDER session
  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  await handleCatalogFlow('update order', REAL_SP_PHONE);
  
  // Select Option 1 (First order from candidate list)
  const selectRes = await handleCatalogFlow('1', REAL_SP_PHONE);
  recordTest(
    'Select Option 1 displays Selected Order card with Current Line Items in piped template',
    selectRes.handled === true && selectRes.reply.includes('Selected Order') && selectRes.reply.includes('Current Line Items'),
    `Selected Reply:\n${selectRes.reply}`
  );

  // Test 4.1: Non-editable guard - attempt to edit total value
  const totalValRes = await handleCatalogFlow('change total value to 5000000', REAL_SP_PHONE);
  recordTest(
    'Direct total value change attempt in UPDATE_ORDER produces clear permission / refusal notice',
    totalValRes.handled === true && (totalValRes.reply.includes('Total Order Value is system-calculated') || totalValRes.reply.includes('calculated automatically') || totalValRes.reply.includes('permission')),
    `Total val Reply:\n${totalValRes.reply}`
  );

  // Test 4.2: Non-editable guard - attempt to change company name
  const compNameRes = await handleCatalogFlow('change company to Reliance Industries', REAL_SP_PHONE);
  recordTest(
    'Customer name change attempt in UPDATE_ORDER produces locked company refusal notice',
    compNameRes.handled === true && (compNameRes.reply.includes('Customer Name cannot be edited') || compNameRes.reply.includes('permanently linked') || compNameRes.reply.includes('locked')),
    `Company change Reply:\n${compNameRes.reply}`
  );

  // Test 4.3: Valid update - change delivery location
  const delLocRes = await handleCatalogFlow('update delivery location to Bhosari MIDC Pune', REAL_SP_PHONE);
  recordTest(
    'Valid delivery location update generates confirmation summary card with piped items and financials',
    delLocRes.handled === true &&
    (delLocRes.reply.includes('captured') || delLocRes.reply.includes('Captured') || delLocRes.reply.includes("Here's what I've captured")) &&
    delLocRes.reply.includes('Bhosari MIDC Pune') &&
    delLocRes.reply.includes('New Total Order Value'),
    `Update Reply:\n${delLocRes.reply}`
  );

  await handleCatalogFlow('cancel', REAL_SP_PHONE);

  // ───────────────────────────────────────────────────────────────────────────
  // CATEGORY 5: Database Retrieval Tools for Orders
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Category 5: Database Retrieval Tools for Orders ---');

  let wonDeals = [];
  try {
    const callerCtx = await resolveCallerContext(REAL_SP_PHONE);
    const dealsRes = await executeGetMyOpenDeals({ status: 'won', limit: 5 }, callerCtx);
    wonDeals = dealsRes?.data?.deals || [];
    recordTest(
      'executeGetMyOpenDeals returns won deals with formatted line items in piped template',
      dealsRes && Array.isArray(wonDeals) && wonDeals.length > 0 && Boolean(wonDeals[0]?.formatted_line_items),
      `Returned ${wonDeals.length} won deals. First deal: ${wonDeals[0]?.deal_code} (${wonDeals[0]?.customer_name}) | Items: ${wonDeals[0]?.formatted_line_items?.replace(/\n/g, ' ')}`
    );
  } catch (err) {
    recordTest('executeGetMyOpenDeals handles query gracefully', false, err.message);
  }

  try {
    const callerCtx = await resolveCallerContext(REAL_SP_PHONE);
    const inqRes = await executeGetInquiries({ limit: 5 }, callerCtx);
    const inqList = inqRes?.data?.inquiries || [];
    recordTest(
      'executeGetInquiries returns order / inquiry records for salesperson with line items data',
      inqRes && Array.isArray(inqList) && inqList.length > 0 && Array.isArray(inqList[0]?.line_items),
      `Returned ${inqList.length} records. First record: ${inqList[0]?.inquiry_id} (${inqList[0]?.customer_name}) | Line items count: ${inqList[0]?.line_items?.length}`
    );
  } catch (err) {
    recordTest('executeGetInquiries handles query gracefully', false, err.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('📊 ORDERS BRUTAL TEST SUITE SUMMARY');
  console.log('================================================================');
  const passCount = testResults.filter(t => t.passed).length;
  const failCount = testResults.filter(t => !t.passed).length;
  console.log(`Total Tests Run: ${testResults.length} | Passed: ${passCount} | Failed: ${failCount}\n`);

  return { passCount, failCount, testResults };
}

runOrdersBrutalTestSuite().catch(err => {
  console.error('Test run error:', err);
  process.exit(1);
});
