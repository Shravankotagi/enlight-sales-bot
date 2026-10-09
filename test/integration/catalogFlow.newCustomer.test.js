const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');

const PHONE = '919811111111';

function extractionLlm(fields) {
  return (messages) => {
    const system = String(messages[0]?.content || '');
    if (system.includes('Structured Data Extraction')) return JSON.stringify(fields);
    return JSON.stringify({ classification: 'SAME_ACTIVITY' });
  };
}

test('menu selection starts a new-customer draft', async (t) => {
  const h = loadCatalogFlow();
  t.after(h.restore);

  const res = await h.catalogFlow.handleCatalogFlow('menu_7', PHONE);

  assert.equal(res.handled, true);
  assert.match(h.getSession(PHONE).last_intent, /^catalog_flow\|LOG_NEW_CUSTOMER\|/);
});

test('a complete, unregistered customer reaches the confirmation step', async (t) => {
  const h = loadCatalogFlow({
    llm: extractionLlm({ company_name: 'Fresh Fabricators', contact_person: 'Ravi', mobile_number: '9876543210', delivery_location: 'Pune' }),
  });
  t.after(h.restore);
  h.setSession(PHONE, 'catalog_flow|LOG_NEW_CUSTOMER|{}');

  const res = await h.catalogFlow.handleCatalogFlow('Fresh Fabricators, Ravi, 9876543210, Pune', PHONE);

  assert.equal(res.handled, true);
  assert.match(h.getSession(PHONE).last_intent, /^catalog_confirm\|LOG_NEW_CUSTOMER\|/);
  assert.match(res.reply, /Fresh Fabricators/);
});
