/**
 * Regression: duplicate-customer warning offered a "reply with a different
 * customer name" continuation instead of a single Discard Draft action.
 * Issue: <add GitHub issue link>
 *
 * Expected: the ownership warning is kept, the only action is Discard Draft,
 * arbitrary text cannot resume the blocked draft, and discarding finalizes it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');

const PHONE = '919811111111';
const DISCARD_ONLY = [{ id: 'btn_confirm_cancel', title: 'Discard Draft' }];

function setup() {
  return loadCatalogFlow({
    tables: {
      recurring_customers: [{
        customer_name: 'DYNAMIC INDUSTRIES',
        assigned_salesperson_phone: '9822000001',
        contact_person: 'Shubham Farakate',
        customer_phone: '9370816366',
      }],
    },
    employees: { '9822000001': { name: 'Vedant Goel' } },
    llm: (messages) => {
      const system = String(messages[0]?.content || '');
      if (system.includes('Structured Data Extraction')) {
        return JSON.stringify({ company_name: 'Dynamic Industries', contact_person: 'Ravi', mobile_number: '9876543210', delivery_location: 'Pune' });
      }
      return JSON.stringify({ classification: 'SAME_ACTIVITY' });
    },
  });
}

test('duplicate customer warning keeps details and only offers Discard Draft', async (t) => {
  const h = setup();
  t.after(h.restore);
  h.setSession(PHONE, 'catalog_flow|LOG_NEW_CUSTOMER|{}');

  const res = await h.catalogFlow.handleCatalogFlow('Dynamic Industries, Ravi, 9876543210, Pune', PHONE);

  assert.match(res.reply, /Customer Already Registered/);
  assert.match(res.reply, /Assigned Representative:\* Vedant Goel \(9822000001\)/);
  assert.doesNotMatch(res.reply, /What would you like to do/i);
  assert.doesNotMatch(res.reply, /different customer name/i);
  assert.doesNotMatch(res.reply, /reply \*?cancel/i);
  assert.equal(res.interactiveType, 'buttons');
  assert.deepEqual(res.interactiveButtons, DISCARD_ONLY);
  assert.match(h.getSession(PHONE).last_intent, /^catalog_duplicate_blocked\|LOG_NEW_CUSTOMER\|/);
});

test('arbitrary text cannot resume or overwrite a blocked duplicate draft', async (t) => {
  const h = setup();
  t.after(h.restore);
  h.setSession(PHONE, 'catalog_duplicate_blocked|LOG_INQUIRY|{"company_name":null,"payment_terms":"30 days"}');
  const before = h.getSession(PHONE).last_intent;

  const res = await h.catalogFlow.handleCatalogFlow('Static Works Pvt Ltd', PHONE);

  assert.deepEqual(res.interactiveButtons, DISCARD_ONLY);
  assert.doesNotMatch(res.reply, /different customer name/i);
  assert.equal(h.getSession(PHONE).last_intent, before);
});

for (const reply of ['btn_confirm_cancel', 'cancel', 'discard draft']) {
  test(`"${reply}" discards the blocked draft and finalizes the session`, async (t) => {
    const h = setup();
    t.after(h.restore);
    h.setSession(PHONE, 'catalog_duplicate_blocked|LOG_INQUIRY|{"company_name":null}');

    const res = await h.catalogFlow.handleCatalogFlow(reply, PHONE);

    assert.match(res.reply, /Activity cancelled/);
    assert.equal(h.getSession(PHONE).last_intent, 'general');
    assert.ok(h.events.some((e) => e.type === 'finalizeCurrentSession'));
    assert.equal((await h.catalogFlow.getLastInactiveDraft(PHONE))?.status, 'discarded');
  });
}

test('buildDuplicateCustomerResponse returns only the warning and Discard Draft', () => {
  const h = setup();
  try {
    const res = h.catalogFlow.buildDuplicateCustomerResponse('*Customer Already Registered!*');
    assert.deepEqual(res, {
      handled: true,
      reply: '*Customer Already Registered!*',
      interactiveType: 'buttons',
      interactiveButtons: DISCARD_ONLY,
    });
  } finally {
    h.restore();
  }
});
