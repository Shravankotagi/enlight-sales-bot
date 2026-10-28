const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { setMockPermissions, builtinFor, invalidateBotPermissions } = require('../../src/utils/permissions');
const { createTools } = require('../../src/core/tools');

const TEST_PHONE = '9876543210';

test('catalogFlow blocks menu preemption when permission is revoked', async (t) => {
  const h = loadCatalogFlow();
  t.after(() => {
    h.restore();
    invalidateBotPermissions();
  });

  // 1. Revoke inquiries.manage
  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'inquiries.manage': false }));

  const filteredCatalog = await h.catalogFlow.catalogForPhone(TEST_PHONE);
  const menuTitles = filteredCatalog.sections
    .flatMap((section) => section.rows.map((row) => row.title))
    .join('\n');
  assert.doesNotMatch(menuTitles, /Log New Inquiry/i);
  assert.equal(
    filteredCatalog.items.some((item) => item.action === 'LOG_INQUIRY'),
    false,
  );

  const resInq = await h.catalogFlow.handleCatalogFlow('menu_1', TEST_PHONE);
  assert.equal(resInq.handled, true);
  assert.match(resInq.reply, /do not have permission to log inquiries/i);
  assert.equal(h.getSession(TEST_PHONE), null);

  const resInqText = await h.catalogFlow.handleCatalogFlow('Log Inquiry', TEST_PHONE);
  assert.equal(resInqText.handled, true);
  assert.match(resInqText.reply, /do not have permission to log inquiries/i);
  assert.equal(h.getSession(TEST_PHONE), null);

  // 2. Revoke orders.create
  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'orders.create': false }));

  const resOrder = await h.catalogFlow.handleCatalogFlow('menu_3', TEST_PHONE);
  assert.equal(resOrder.handled, true);
  assert.match(resOrder.reply, /do not have permission to log orders/i);
  assert.equal(h.getSession(TEST_PHONE), null);

  // 3. Revoke visits.log
  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'visits.log': false }));

  const resVisit = await h.catalogFlow.handleCatalogFlow('menu_5', TEST_PHONE);
  assert.equal(resVisit.handled, true);
  assert.match(resVisit.reply, /do not have permission to log visits/i);
  assert.equal(h.getSession(TEST_PHONE), null);

  // 4. Normal permitted user initiates flow smoothly
  setMockPermissions(TEST_PHONE, builtinFor('salesperson'));

  const resPermitted = await h.catalogFlow.handleCatalogFlow('menu_1', TEST_PHONE);
  assert.equal(resPermitted.handled, true);
  assert.match(resPermitted.reply, /Log New Inquiry/i);
  assert.match(h.getSession(TEST_PHONE).last_intent, /^catalog_flow\|LOG_INQUIRY/);
});

test('OCR document intake blocks when permissions are revoked', async (t) => {
  const h = loadCatalogFlow();
  t.after(() => {
    h.restore();
    invalidateBotPermissions();
  });

  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'inquiries.manage': false, 'orders.create': false }));

  const dummyBuffer = Buffer.from('dummy');
  const ocrInq = await h.catalogFlow.handleInquiryDocumentOcr(dummyBuffer, 'image/jpeg', TEST_PHONE);
  assert.equal(ocrInq.handled, true);
  assert.match(ocrInq.reply, /do not have permission to log inquiries/i);

  const ocrOrder = await h.catalogFlow.handleOrderDocumentOcr(dummyBuffer, 'image/jpeg', TEST_PHONE);
  assert.equal(ocrOrder.handled, true);
  assert.match(ocrOrder.reply, /do not have permission to log orders/i);

  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'orders.create': true, 'orders.attach_po': false }));
  const ocrOrderNoAttach = await h.catalogFlow.handleOrderDocumentOcr(dummyBuffer, 'image/jpeg', TEST_PHONE);
  assert.equal(ocrOrderNoAttach.handled, true);
  assert.match(ocrOrderNoAttach.reply, /do not have permission to attach PO documents/i);
});

test('Option 5 Add Price blocks when pricing permissions are absent', async (t) => {
  const h = loadCatalogFlow();
  t.after(() => {
    h.restore();
    invalidateBotPermissions();
  });

  // When inquiry management and pricing permissions are revoked
  setMockPermissions(TEST_PHONE, builtinFor('salesperson', {
    'inquiries.manage': false,
    'inquiries.edit': false,
    'inquiries.send_quote': false,
    'inquiries.fill_base_prices': false,
    'inquiries.price_override': false,
  }));

  const resPrice = await h.catalogFlow.handleCatalogFlow('menu_price', TEST_PHONE);
  assert.equal(resPrice.handled, true);
  assert.match(resPrice.reply, /do not have permission to add inquiry prices/i);
});

test('executeAction refuses database write when permission is revoked', async (t) => {
  const h = loadCatalogFlow();
  t.after(() => {
    h.restore();
    invalidateBotPermissions();
  });

  setMockPermissions(TEST_PHONE, builtinFor('salesperson', { 'inquiries.manage': false }));

  const res = await h.catalogFlow.executeAction('LOG_INQUIRY', { company_name: 'Test Steel' }, TEST_PHONE);
  assert.match(res, /do not have permission to log inquiries/i);
});

test('LangGraph conversational AI tools enforce permission gating', async () => {
  const phone = '9998887777';

  // 1. Revoke send_quote and customers.edit
  setMockPermissions(phone, builtinFor('salesperson', {
    'inquiries.send_quote': false,
    'customers.edit': false,
    'inquiries.view': false,
  }));

  const tools = createTools(phone);
  const sendQuote = tools.find((t) => t.name === 'send_quotation');
  const updateCust = tools.find((t) => t.name === 'update_customer_profile');
  const getInq = tools.find((t) => t.name === 'get_inquiries');

  const quoteRes = await sendQuote.invoke({ text: 'send quote to client@example.com' });
  assert.match(quoteRes, /Permission Denied.*send quotations/i);

  const custRes = await updateCust.invoke({ customer_name: 'Apex Steel', order_frequency_days: 45 });
  assert.match(custRes, /Permission Denied.*edit customer profiles/i);

  const inqRes = await getInq.invoke({});
  assert.match(inqRes, /Permission Denied.*view inquiries/i);

  invalidateBotPermissions(phone);
});
