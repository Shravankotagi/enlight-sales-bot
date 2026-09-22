require('dotenv').config();
const assert = require('assert');
const { handleCatalogFlow, CATALOG_MENU } = require('../src/core/catalogFlow');

// Test the streamline helper function
function streamlineMenuReplyForWeb(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return rawReply;

  const hasCatalogMenu =
    rawReply.includes('SalesOS Assistant') ||
    rawReply.includes('Log New Inquiry') ||
    rawReply.includes('Here is the menu to start a new activity') ||
    /\b1\.\s+\*?\*?Log New Inquiry/i.test(rawReply);

  if (hasCatalogMenu) {
    let prefix = '';
    if (rawReply.includes('Activity cancelled')) {
      prefix = 'Activity cancelled.\n\n';
    } else if (rawReply.includes('currently in the')) {
      const parts = rawReply.split(/\n\nHere is the menu/i);
      if (parts.length > 1) {
        prefix = parts[0].trim() + '\n\n';
      } else {
        const firstPara = rawReply.split(/\n\n/)[0];
        if (firstPara) prefix = firstPara.trim() + '\n\n';
      }
    } else if (rawReply.includes('To start an activity, please select')) {
      prefix = 'To start an activity, please select the relevant option from the menu below:\n\n';
    }

    return `${prefix}Welcome to **SalesOS Assistant**!\n\nWhat would you like to do today? Reply with a number (1–10) or type what you'd like to do.`;
  }

  return rawReply;
}

async function runTests() {
  console.log('--- TEST 1: Greeting "Hi" Catalog Menu Streamlining ---');
  const catalogRes = await handleCatalogFlow('Hi', '9619226169');
  assert(catalogRes.handled === true, 'Must be handled by catalog flow');
  assert(catalogRes.interactiveType === 'list', 'Must be interactive list');
  assert(catalogRes.interactiveList.sections.length === 3, 'Must have 3 sections');

  const streamlined = streamlineMenuReplyForWeb(catalogRes.reply);
  console.log('Streamlined Reply:\n' + streamlined);

  assert(!streamlined.includes('1. **Log New Inquiry**'), 'Must NOT include 1. **Log New Inquiry** text');
  assert(!streamlined.includes('8. **Log Customer Complaint**'), 'Must NOT include 8. **Log Customer Complaint** text');
  assert(streamlined.includes('Welcome to **SalesOS Assistant**!'), 'Must include Welcome header');
  assert(streamlined.includes('What would you like to do today? Reply with a number (1–10) or type what you\'d like to do.'), 'Must include prompt');
  console.log('✅ TEST 1 PASSED!\n');

  console.log('--- TEST 2: Activity Cancel Streamlining ---');
  const cancelRaw = `Activity cancelled.\n\n` + CATALOG_MENU;
  const streamlinedCancel = streamlineMenuReplyForWeb(cancelRaw);
  console.log('Streamlined Cancel Reply:\n' + streamlinedCancel);
  assert(streamlinedCancel.startsWith('Activity cancelled.'), 'Must start with Activity cancelled');
  assert(!streamlinedCancel.includes('1. **Log New Inquiry**'), 'Must NOT include 1. **Log New Inquiry** text');
  assert(streamlinedCancel.includes('Welcome to **SalesOS Assistant**!'), 'Must include Welcome header');
  console.log('✅ TEST 2 PASSED!\n');

  console.log('--- TEST 3: Mid-flow Interruption Streamlining ---');
  const interrupRaw = `You are currently in the *Complaint* flow. To log an inquiry, please complete or cancel the current activity first and select the relevant option from the menu.\n\nHere is the menu to start a new activity:\n\n` + CATALOG_MENU;
  const streamlinedInterrup = streamlineMenuReplyForWeb(interrupRaw);
  console.log('Streamlined Interruption Reply:\n' + streamlinedInterrup);
  assert(streamlinedInterrup.includes('You are currently in the *Complaint* flow.'), 'Must retain interruption warning');
  assert(!streamlinedInterrup.includes('1. **Log New Inquiry**'), 'Must NOT include 1. **Log New Inquiry** text');
  console.log('✅ TEST 3 PASSED!\n');

  console.log('ALL MENU STREAMLINING TESTS PASSED! 🎉');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
