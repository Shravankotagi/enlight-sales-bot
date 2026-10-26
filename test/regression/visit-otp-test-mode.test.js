// Issue: <add GitHub issue link>
// A temporary flag returns the visit code without WhatsApp.
const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { requestVisitCode, verifyVisitCode } = require('../../src/core/visitRequirements');

const previous = {
  mode: process.env.VISIT_OTP_TEST_MODE,
  token: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  template: process.env.WHATSAPP_VISIT_OTP_TEMPLATE,
};

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv('VISIT_OTP_TEST_MODE', previous.mode);
  restoreEnv('WHATSAPP_TOKEN', previous.token);
  restoreEnv('WHATSAPP_PHONE_NUMBER_ID', previous.phoneNumberId);
  restoreEnv('WHATSAPP_VISIT_OTP_TEMPLATE', previous.template);
});

test('a test flag returns the code without calling WhatsApp', async () => {
  process.env.VISIT_OTP_TEST_MODE = 'true';
  const db = createSupabaseMock({ tables: { visit_phone_verifications: [] } });
  const sent = await requestVisitCode(db.client, '9822012345', async () => {
    throw new Error('WhatsApp should not be called');
  });

  assert.equal(sent.ok, true);
  const otp = String(sent.message).match(/(\d{6})/)?.[1];
  assert.match(otp, /^\d{6}$/);
  const verified = await verifyVisitCode(db.client, '9822012345', otp);
  assert.equal(verified.ok, true);
});

test('a missing template still fails when the test flag is off', async () => {
  delete process.env.VISIT_OTP_TEST_MODE;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_VISIT_OTP_TEMPLATE;
  const db = createSupabaseMock({ tables: { visit_phone_verifications: [] } });
  const sent = await requestVisitCode(db.client, '9822012345');

  assert.equal(sent.ok, false);
  assert.match(sent.message, /WhatsApp is not configured for visit codes/);
});
