const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { cleanPhone } = require('../src/supabase');

const TEST_PHONE = '919876543210';

async function testInquiryCustomerOnboarding() {
  console.log('================================================================');
  console.log('🧪 TESTING INQUIRY WITH ONBOARDING & CONTACT PERSON EXTRACTION');
  console.log('================================================================');

  // Cancel any existing session first
  await handleCatalogFlow('cancel', TEST_PHONE);

  console.log('\n--- Step 1: Initiate Log New Inquiry (Menu Selection 1) ---');
  const res0 = await handleCatalogFlow('1', TEST_PHONE);
  console.log('Bot Response Step 1 (Menu Selection):\n', res0.reply);

  const initialMessage = "I want to inquiry about HR coil 7mm 87MT, need to understand about its pricing, my company name is sheetal trades, and my name is sheetal kumari. once i get response on this inquiry will surely plan to visit u";
  console.log('\n--- Step 2: Sending Inquiry Details ---');
  console.log('User:', initialMessage);

  const res1 = await handleCatalogFlow(initialMessage, TEST_PHONE);
  console.log('Bot Response Step 2:\n', res1.reply);

  const isAskNewCustomer = res1 && res1.reply && (
    res1.reply.includes('is not in your customer list') ||
    res1.reply.includes('Is this a new customer?')
  );
  console.log('Step 2 Verification (Asked for New Customer confirmation):', isAskNewCustomer ? '✅ PASS' : '❌ FAIL');

  console.log('\n--- Step 3: Tapping "Yes, Add Customer" ---');
  const res2 = await handleCatalogFlow('Yes, Add Customer', TEST_PHONE);
  console.log('Bot Response Step 3:\n', res2.reply);

  const hasContactPersonAcknowledged = res2 && res2.reply && res2.reply.includes('Contact Person:') && /sheetal kumari/i.test(res2.reply);
  const hasRemainingFieldsOnly = res2 && res2.reply && res2.reply.includes('Mobile Number') && res2.reply.includes('Delivery Location') && !res2.reply.includes('• *Contact Person*');
  const doesNotMentionVisitReport = res2 && res2.reply && !res2.reply.includes('visit report');

  console.log('Step 3 Verification (Acknowledged Sheetal Kumari from message):', hasContactPersonAcknowledged ? '✅ PASS' : '❌ FAIL');
  console.log('Step 3 Verification (Prompted only for remaining fields Mobile & Delivery):', hasRemainingFieldsOnly ? '✅ PASS' : '❌ FAIL');
  console.log('Step 3 Verification (Does NOT say "visit report"):', doesNotMentionVisitReport ? '✅ PASS' : '❌ FAIL');

  // Cancel session to clean up
  await handleCatalogFlow('cancel', TEST_PHONE);

  if (isAskNewCustomer && hasContactPersonAcknowledged && hasRemainingFieldsOnly && doesNotMentionVisitReport) {
    console.log('\n🎉 ALL CHECKS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error('\n⚠️ SOME CHECKS FAILED');
    process.exit(1);
  }
}

testInquiryCustomerOnboarding().catch(err => {
  console.error('Error during test:', err);
  process.exit(1);
});

