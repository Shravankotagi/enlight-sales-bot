const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('./helpers/catalogFlowHarness');

test('customer match score calculation and threshold handling', () => {
  const { calculateCustomerMatchPercentage, buildCustomerMatchValidationMessage } = loadCatalogFlow().catalogFlow;

  // 1. Exact match returns 100%
  assert.equal(calculateCustomerMatchPercentage('PQR Steel Industries', 'PQR Steel Industries'), 100);

  // 2. Minor typo returns > 70% (no validation needed)
  const typoScore = calculateCustomerMatchPercentage('PQR Steel Industriess', 'PQR Steel Industries');
  assert.ok(typoScore >= 70, `Expected typo score >= 70, got ${typoScore}`);

  // 3. Match ignoring corporate suffixes (Pvt Ltd) returns 100%
  assert.equal(calculateCustomerMatchPercentage('PQR Steel Industries', 'PQR Steel Industries Pvt Ltd'), 100);

  // 4. Shorthand entry like "PQR" against "PQR Steel Industries" is < 70%
  const shortScore = calculateCustomerMatchPercentage('PQR', 'PQR Steel Industries');
  assert.ok(shortScore < 70, `Expected short score < 70, got ${shortScore}`);

  // 5. Short prefix "PQR" against "PQR Super Alloys Private Limited" is < 70%
  const shortAlloyScore = calculateCustomerMatchPercentage('PQR', 'PQR Super Alloys Private Limited');
  assert.ok(shortAlloyScore < 70, `Expected short alloy score < 70, got ${shortAlloyScore}`);

  // 6. Validation message builder formats up to 3 candidates cleanly
  const msg3 = buildCustomerMatchValidationMessage('PQR', 'PQR Steel Industries', [
    'PQR Steel Industries',
    'PQR Alloys Ltd',
    'PQR Tubes Pvt Ltd',
  ]);
  assert.ok(msg3.includes('Do you want to continue with the fetched customer name: *PQR Steel Industries*?'));
  assert.ok(msg3.includes('1. *PQR Steel Industries*'));
  assert.ok(msg3.includes('2. *PQR Alloys Ltd*'));
  assert.ok(msg3.includes('3. *PQR Tubes Pvt Ltd*'));
  assert.ok(msg3.includes('reply with *1*, *2*, or *3*'));

  // 7. Validation message builder with only 1 candidate does not show extra numbers
  const msg1 = buildCustomerMatchValidationMessage('PQR', 'PQR Steel Industries', [
    'PQR Steel Industries',
  ]);
  assert.ok(msg1.includes('1. *PQR Steel Industries*'));
  assert.ok(!msg1.includes('2. *'));
  assert.ok(msg1.includes('reply with *1*'));
});

test('replying 1, 2, 3, or yes to customer validation continues original flow without catalog preemption', async (t) => {
  const PHONE = '919822000001';
  const candidates = ['rajesh company', 'Rajeshwari industries', 'Rajeshwari Shah Industries'];
  const fetchedName = 'rajesh company';
  const draft = { company_name: fetchedName };
  const lastPrompt = `Do you want to continue with the fetched customer name: *${fetchedName}*?\n\nMatching accounts from your assigned list:\n  1. *${candidates[0]}*\n  2. *${candidates[1]}*\n  3. *${candidates[2]}*\n\n👉 Tap *Yes* to continue with *${fetchedName}*, or reply with *1*, *2*, or *3* to choose a customer.`;

  // Provide envelope simulating the assistant just sent the customer validation prompt
  const h = loadCatalogFlow({
    envelope: {
      current_session: {
        messages: [
          { role: 'user', content: 'Log a visit for rajesh company Industry' },
          { role: 'assistant', content: lastPrompt, action_type: 'LOG_VISIT', sub_action: 'CUST_MATCH_CONFIRM' },
        ],
      },
    },
  });
  t.after(h.restore);

  // 1. Reply "1": Must pick candidates[0] ("rajesh company") and NOT start LOG_INQUIRY
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_VISIT|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );
  const res1 = await h.catalogFlow.handleCatalogFlow('1', PHONE);
  assert.equal(res1.handled, true);
  // Must NOT have started Log New Inquiry
  assert.doesNotMatch(res1.reply, /Log New Inquiry/i);
  assert.doesNotMatch(res1.reply, /Please send the inquiry details/i);
  // Must prompt for visit details
  assert.match(res1.reply, /visit report/i);
  const savedState1 = h.getSession(PHONE).last_intent;
  assert.ok(savedState1.startsWith('catalog_flow|LOG_VISIT|'), `Expected catalog_flow|LOG_VISIT|, got ${savedState1}`);
  assert.ok(savedState1.includes('"company_name":"rajesh company"'));
  assert.ok(savedState1.includes('"_customer_verified":true'));

  // 2. Reply "2": Must pick candidates[1] ("Rajeshwari industries")
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_VISIT|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );
  const res2 = await h.catalogFlow.handleCatalogFlow('2', PHONE);
  assert.equal(res2.handled, true);
  assert.doesNotMatch(res2.reply, /Log New Inquiry/i);
  assert.match(res2.reply, /visit report/i);
  const savedState2 = h.getSession(PHONE).last_intent;
  assert.ok(savedState2.includes('"company_name":"Rajeshwari industries"'));
  assert.ok(savedState2.includes('"_customer_verified":true'));

  // 3. Reply "3": Must pick candidates[2] ("Rajeshwari Shah Industries")
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_VISIT|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );
  const res3 = await h.catalogFlow.handleCatalogFlow('3', PHONE);
  assert.equal(res3.handled, true);
  assert.doesNotMatch(res3.reply, /Log New Inquiry/i);
  assert.match(res3.reply, /visit report/i);
  const savedState3 = h.getSession(PHONE).last_intent;
  assert.ok(savedState3.includes('"company_name":"Rajeshwari Shah Industries"'));
  assert.ok(savedState3.includes('"_customer_verified":true'));

  // 4. Reply "Yes": Must pick fetchedName ("rajesh company")
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_VISIT|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );
  const resYes = await h.catalogFlow.handleCatalogFlow('yes', PHONE);
  assert.equal(resYes.handled, true);
  assert.doesNotMatch(resYes.reply, /Log New Inquiry/i);
  assert.match(resYes.reply, /visit report/i);
  const savedStateYes = h.getSession(PHONE).last_intent;
  assert.ok(savedStateYes.includes('"company_name":"rajesh company"'));
  assert.ok(savedStateYes.includes('"_customer_verified":true'));

  // 5. Reply candidate name directly: e.g. "Rajeshwari industries"
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_VISIT|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );
  const resName = await h.catalogFlow.handleCatalogFlow('Rajeshwari industries', PHONE);
  assert.equal(resName.handled, true);
  assert.doesNotMatch(resName.reply, /Log New Inquiry/i);
  assert.match(resName.reply, /visit report/i);
  const savedStateName = h.getSession(PHONE).last_intent;
  assert.ok(savedStateName.includes('"company_name":"Rajeshwari industries"'));
  assert.ok(savedStateName.includes('"_customer_verified":true'));
});

test('inquiry with 90 days payment terms retains 90 Days and does not ask again after customer confirmation', async (t) => {
  const PHONE = '919822000001';
  const candidates = ['rajesh company', 'Rajeshwari industries', 'Rajeshwari Shah Industries'];
  const fetchedName = 'rajesh company';
  const draft = {
    company_name: fetchedName,
    email: 'xyz@gmail.com',
    product_description: 'HR plate 3*250*2500',
    line_items: [{ sku_text: 'HR Plate', spec: '3*250*2500', quantity: 1, unit: 'MT' }],
    payment_terms: '90 Days',
    delivery_location: 'Satara',
  };

  const h = loadCatalogFlow();
  t.after(h.restore);

  // When customer validation triggers with 90 Days payment terms already in draft
  h.setSession(
    PHONE,
    `catalog_cust_match_confirm|LOG_INQUIRY|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`
  );

  // User replies "1" to pick customer #1
  const res = await h.catalogFlow.handleCatalogFlow('1', PHONE);
  assert.equal(res.handled, true);
  // Must NOT ask for Payment Terms again!
  assert.doesNotMatch(res.reply, /Please provide the remaining mandatory details.*Payment Terms/is);
  // Must go directly to confirmation summary with 90 Days captured
  assert.match(res.reply, /Payment Terms:\* 90 Days/i);
  assert.match(res.reply, /Customer \/ Company:\* rajesh company/i);
  assert.match(res.reply, /Delivery Location:\* Satara/i);
  const savedState = h.getSession(PHONE).last_intent;
  assert.ok(savedState.startsWith('catalog_confirm|LOG_INQUIRY|'));
  assert.ok(savedState.includes('"payment_terms":"90 Days"'));
});

test('filling missing payment terms with "90 days" or "90 dyas" captures 90 Days and never 30 Days', async (t) => {
  const PHONE = '919822000001';
  const draft = {
    company_name: 'rajesh company',
    email: 'xyz@gmail.com',
    product_description: 'HR plate 3*250*2500',
    line_items: [{ sku_text: 'HR Plate', spec: '3*250*2500', quantity: 1, unit: 'MT' }],
    delivery_location: 'Satara',
    _customer_verified: true,
  };

  const h = loadCatalogFlow();
  t.after(h.restore);

  h.setSession(PHONE, `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`);
  const res = await h.catalogFlow.handleCatalogFlow('90 days', PHONE);
  assert.equal(res.handled, true);
  assert.doesNotMatch(res.reply, /Payment Terms:\* 30 Days/i);
  assert.match(res.reply, /Payment Terms:\* 90 Days/i);

  // Also test typo "90 dyas"
  h.setSession(PHONE, `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`);
  const resTypo = await h.catalogFlow.handleCatalogFlow('90 dyas', PHONE);
  assert.equal(resTypo.handled, true);
  assert.doesNotMatch(resTypo.reply, /Payment Terms:\* 30 Days/i);
  assert.match(resTypo.reply, /Payment Terms:\* 90 Days/i);
});
