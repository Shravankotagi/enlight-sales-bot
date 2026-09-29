require('dotenv').config();
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { getFullActiveSession } = require('../src/supabase');

async function test() {
  const phone = '8262937458';
  console.log('--- Step 1: cancel ---');
  await handleCatalogFlow('cancel', phone);

  console.log('--- Step 2: send "hi" ---');
  const resHi = await handleCatalogFlow('hi', phone);
  console.log('resHi handled:', resHi.handled);

  let session = await getFullActiveSession(phone);
  console.log('Session after hi:', session?.last_intent);

  console.log('\n--- Step 3: send "2. Update Inquiry" ---');
  const res2 = await handleCatalogFlow('2. Update Inquiry', phone);
  console.log('res2 handled:', res2.handled);
  console.log('res2 reply:\n' + res2.reply);

  session = await getFullActiveSession(phone);
  console.log('\nSession after 2. Update Inquiry:', session?.last_intent);

  console.log('\n--- Step 4: send "2. Update Inquiry" AGAIN while in catalog_update_select ---');
  const res2Again = await handleCatalogFlow('2. Update Inquiry', phone);
  console.log('res2Again handled:', res2Again.handled);
  console.log('res2Again reply:\n' + res2Again.reply);
}

test().catch(console.error);
