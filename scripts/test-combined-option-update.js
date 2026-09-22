require('dotenv').config();
const assert = require('assert');

// Test the extractCandidateIndex and isPureOptionSelectorOnly functions
function extractCandidateIndex(text, candidateCount = 5) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  // Pattern 1: Explicit "option 1", "opt 1", "choice 2", "no. 1", "#1", "in option 1", "for option 2" anywhere in text
  const optMatch = clean.match(/\b(?:in\s+|for\s+|from\s+|of\s+)?(?:option|opt|choice|no\.?|number|#|item|row)\s*([1-9]\d*)\b/i);
  if (optMatch) {
    const idx = parseInt(optMatch[1], 10);
    if (idx >= 1 && idx <= candidateCount) return idx;
  }

  // Pattern 2: "1st option", "2nd one", "3rd inquiry", "1st", "2nd", "3rd"
  const ordMatch = clean.match(/\b([1-9]\d*)\s*(?:st|nd|rd|th)\b/i);
  if (ordMatch) {
    const idx = parseInt(ordMatch[1], 10);
    if (idx >= 1 && idx <= candidateCount) return idx;
  }

  // Pattern 3: English ordinals ("first", "second", "third", "fourth", "fifth", "last")
  const wordOrdinals = {
    first: 1,
    '1st': 1,
    second: 2,
    '2nd': 2,
    third: 3,
    '3rd': 3,
    fourth: 4,
    '4th': 4,
    fifth: 5,
    '5th': 5,
    last: candidateCount,
  };
  for (const [word, val] of Object.entries(wordOrdinals)) {
    const wordRegex = new RegExp(`\\b(?:in\\s+|for\\s+|from\\s+|of\\s+)?(?:the\\s+)?${word}\\s*(?:option|choice|inquiry|order|visit|complaint|deal|one|item|row)?\\b`, 'i');
    if (wordRegex.test(clean) && val <= candidateCount) {
      return val;
    }
  }

  // Pattern 4: Standalone / start-of-line number ("1", "1.", "1)", "1 -", "#1", "1️⃣")
  const cleanKeycap = clean.replace(/([1-9]|10)️⃣/g, '$1');
  const startNumMatch = cleanKeycap.match(/^\s*(?:option\s*|no\.?\s*|#\s*)?([1-9]\d*)\s*(?:[.)\-:\s]|$)/i);
  if (startNumMatch) {
    const idx = parseInt(startNumMatch[1], 10);
    if (idx >= 1 && idx <= candidateCount) return idx;
  }

  return null;
}

function isPureOptionSelectorOnly(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim();
  if (/^\s*(?:option|choice|no\.?|#)?\s*[1-9]\d*\.?\s*$/i.test(clean)) return true;
  if (/^\s*(?:the\s+)?(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s*(?:option|choice|inquiry|order|visit|one)?\.?\s*$/i.test(clean)) return true;
  if (/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*[0-9A-Za-z-]+$/i.test(clean)) return true;
  return false;
}

async function runTests() {
  console.log('--- TEST 1: extractCandidateIndex variations ---');
  assert.strictEqual(extractCandidateIndex('update the location in option 1 to Bhiwandi', 2), 1, 'Failed on "update the location in option 1 to Bhiwandi"');
  assert.strictEqual(extractCandidateIndex('in option 2 rate to 54000', 2), 2, 'Failed on "in option 2 rate to 54000"');
  assert.strictEqual(extractCandidateIndex('for option 1 change delivery location to Bhiwandi', 2), 1, 'Failed on "for option 1..."');
  assert.strictEqual(extractCandidateIndex('1st option delivery location Bhiwandi', 2), 1, 'Failed on "1st option..."');
  assert.strictEqual(extractCandidateIndex('second option update rate to 55000', 2), 2, 'Failed on "second option..."');
  assert.strictEqual(extractCandidateIndex('first one rate 50000', 2), 1, 'Failed on "first one..."');
  assert.strictEqual(extractCandidateIndex('1', 2), 1, 'Failed on "1"');
  assert.strictEqual(extractCandidateIndex('option 1', 2), 1, 'Failed on "option 1"');
  assert.strictEqual(extractCandidateIndex('#2', 2), 2, 'Failed on "#2"');
  assert.strictEqual(extractCandidateIndex('2️⃣', 2), 2, 'Failed on "2️⃣"');
  assert.strictEqual(extractCandidateIndex('no match text', 2), null, 'Failed on no match text');
  console.log('✅ TEST 1: All candidate index extractions passed!\n');

  console.log('--- TEST 2: isPureOptionSelectorOnly classifications ---');
  assert.strictEqual(isPureOptionSelectorOnly('1'), true, '"1" must be pure option selector');
  assert.strictEqual(isPureOptionSelectorOnly('option 1'), true, '"option 1" must be pure option selector');
  assert.strictEqual(isPureOptionSelectorOnly('first one'), true, '"first one" must be pure option selector');
  assert.strictEqual(isPureOptionSelectorOnly('1st option'), true, '"1st option" must be pure option selector');
  assert.strictEqual(isPureOptionSelectorOnly('INQ-02D2BD'), true, '"INQ-02D2BD" must be pure option selector');
  assert.strictEqual(isPureOptionSelectorOnly('update the location in option 1 to Bhiwandi'), false, 'Combined update must NOT be pure selector');
  assert.strictEqual(isPureOptionSelectorOnly('in option 2 rate to 54000'), false, 'Combined rate update must NOT be pure selector');
  console.log('✅ TEST 2: All pure option classifications passed!\n');

  console.log('ALL COMBINED OPTION UPDATE TESTS PASSED! 🎉');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
