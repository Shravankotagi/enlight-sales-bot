// Issue: <add GitHub issue link>
// Tomorrow and after a month become calendar days instead of staying in the prompt list.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyExplicitFollowUpDate, nextVisitPrompts } = require('../../src/core/visitRequirements');

function istToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year').value;
  const month = parts.find((part) => part.type === 'month').value;
  const day = parts.find((part) => part.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function formatUtcDay(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shiftDay(isoDay, days) {
  const [year, month, day] = isoDay.split('-').map(Number);
  return formatUtcDay(new Date(Date.UTC(year, month - 1, day + days)));
}

function addMonth(isoDay) {
  const [year, month, day] = isoDay.split('-').map(Number);
  return formatUtcDay(new Date(Date.UTC(year, month - 1 + 1, day)));
}

function asksFor(prompts, label) {
  return prompts.some((item) => item.includes(label));
}

test('after a month and tomorrow leave the prompt list as calendar days', () => {
  const today = istToday();
  const draft = {
    next_purchase_expected: 'after a month',
    follow_up_date: 'tomorrow',
  };
  const prompts = nextVisitPrompts(draft);

  assert.equal(asksFor(prompts, 'Next Purchase Expected'), false);
  assert.equal(asksFor(prompts, 'Follow-up Date'), false);
  assert.equal(draft.next_purchase_expected, addMonth(today));
  assert.equal(draft.follow_up_date, shiftDay(today, 1));
  assert.ok(draft.next_purchase_expected >= today);
  assert.ok(draft.follow_up_date >= today);
});

test('one month later and a follow-up action of tomorrow are stored the same way', () => {
  const today = istToday();
  const draft = {
    next_purchase_expected: 'one month later',
    followup_action: 'send quotation tomorrow',
  };
  const prompts = nextVisitPrompts(draft);

  assert.equal(asksFor(prompts, 'Next Purchase Expected'), false);
  assert.equal(asksFor(prompts, 'Follow-up Date'), false);
  assert.equal(draft.next_purchase_expected, addMonth(today));
  assert.equal(draft.follow_up_date, shiftDay(today, 1));
});

test('a labeled follow-up date of tomorrow is stored separately from the action', () => {
  const today = istToday();
  const draft = { followup_action: 'send quotation' };
  applyExplicitFollowUpDate(
    draft,
    'Follow up action - send quotation\nfollow up Date - tomorrow',
  );
  const prompts = nextVisitPrompts(draft);

  assert.equal(asksFor(prompts, 'Follow-up Date'), false);
  assert.equal(draft.follow_up_date, shiftDay(today, 1));
  assert.equal(draft.followup_action, 'send quotation');
});

test('a next purchase phrase does not fill the follow-up date', () => {
  const draft = { next_purchase_expected: 'one month later' };
  applyExplicitFollowUpDate(draft, 'next purchase is one month later, visited today');

  assert.equal(draft.follow_up_date, undefined);
  const prompts = nextVisitPrompts(draft);
  assert.equal(asksFor(prompts, 'Follow-up Date'), true);
  assert.equal(asksFor(prompts, 'Next Purchase Expected'), false);
});

test('a past explicit date stays in the prompt list', () => {
  const draft = {
    next_purchase_expected: '2020-01-01',
    follow_up_date: '2020-01-02',
  };
  const prompts = nextVisitPrompts(draft);

  assert.equal(asksFor(prompts, 'Next Purchase Expected'), true);
  assert.equal(asksFor(prompts, 'Follow-up Date'), true);
  assert.equal(draft.next_purchase_expected, '2020-01-01');
  assert.equal(draft.follow_up_date, '2020-01-02');
});
