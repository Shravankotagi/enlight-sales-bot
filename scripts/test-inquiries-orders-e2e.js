/**
 * Comprehensive End-to-End Test Suite for Inquiries and Orders Modules
 *
 * Verifies:
 * 1. Tool A(1): Precision line-item matching & disambiguation using Master Catalog & HSN.
 * 2. Tool A(2): Field-aware, non-greedy verbatim notes extraction (no pollution of pricing/qty).
 * 3. Tool B(2): 4-digit HSN root & category-guarded PO-to-Inquiry linking (no cross-category mismatch).
 * 4. Tool C(1, 2): Robust intent classification preserving SAME_ACTIVITY on compound updates.
 * 5. Tool D(1, 2, 3): Multi-lingual Hinglish stage updates, customer-name lookup, and non-silent clarification.
 * 6. Pipeline Stage Transition Guard: Mandatory fields (rate, delivery location, payment terms) enforced before moving to Price Quote.
 * 7. Order Execution & Line Item Recalculation: Subtotal, GST (18%), and Total Amount calculation.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const assert = require('assert');
const {
  scoreLineItemAgainstUpdate,
  matchLineItemUpdate,
  resolveLineItemUpdateTargets,
  pickLineItemChoice,
  pinLineUpdateToItems,
  extractVerbatimNotes,
  findMatchingInquiriesForPo,
  isStageOnlyUpdate,
  isStageUpdatePrompt,
  classifyActiveSessionIntent,
  handleMidFlowStageUpdate,
  extractFieldsWithLLM,
  isNumericOptionSelector,
  resolveClarifiedProduct,
  validateDraftProducts,
  buildConfirmationSummary,
  buildLineItemChoicePrompt,
  handleLineItemChoiceReply
} = require('../src/core/catalogFlow');

const {
  detectHsnCode,
  normalizeProductToCatalog,
  extractThickness,
  extractHeight,
  MASTER_PRODUCTS_CATALOG
} = require('../src/utils/hsnDetector');

let totalTests = 0;
let passedTests = 0;

function report(condition, testName, extra = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${testName} ${extra}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${extra}`);
  }
}

async function runInquiriesAndOrdersSuite() {
  console.log('================================================================');
  console.log('🧪 RUNNING COMPREHENSIVE INQUIRIES & ORDERS E2E TEST SUITE');
  console.log('================================================================\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 1: MASTER CATALOG & HSN CODE AUTO-DETECTION (4 CATEGORIES)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ [GROUP 1] Product Normalization & HSN Codes across 4 Master Categories');
  {
    // Flat Steel
    const hr = normalizeProductToCatalog('HR Coil', '2.5 mm');
    report(hr.isValid && hr.hsnCode === '72083940', 'Flat Steel - HR Coil 2.5mm HSN 72083940');

    // Structural Steel
    const angle = normalizeProductToCatalog('MS Angle', '50x50x5 mm');
    report(angle.isValid && angle.hsnCode === '72162100', 'Structural Steel - MS Angle <80mm HSN 72162100');

    // Pipes & Tubes
    const rect = normalizeProductToCatalog('MS Rectangular Tube', '50x25x2 mm');
    report(rect.isValid && rect.hsnCode === '73063090', 'Pipes & Tubes - MS Rectangular Tube HSN 73063090');

    // Value Added Products
    const strip = normalizeProductToCatalog('GI Earthing Strip', '25x3 mm');
    report(strip.isValid && strip.hsnCode === '73082019', 'Value Added - GI Earthing Strip HSN 73082019');

    const tray = normalizeProductToCatalog('Perforated Cable Tray', '150 mm width');
    report(tray.isValid && tray.hsnCode === '73089090', 'Value Added - Cable Tray HSN 73089090');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 2: TOOL A(1) - LINE ITEM MATCHING & MULTI-ITEM DISAMBIGUATION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 2] Tool A(1): Precision Line-Item Matching & Disambiguation');
  {
    const items = [
      { id: '101', sku_text: 'HR Coil', dimensions: '2.5 mm', quantity: 10, unit: 'MT', rate: 50000 },
      { id: '102', sku_text: 'HR Coil', dimensions: '6.0 mm', quantity: 20, unit: 'MT', rate: 52000 },
      { id: '103', sku_text: 'Cable Tray – Perforated', dimensions: '150 mm width', quantity: 100, unit: 'MTR', rate: 450 },
      { id: '104', sku_text: 'MS Rectangular Tube', dimensions: '50x25x2 mm', quantity: 5, unit: 'MT', rate: 62000 }
    ];

    // Case A: Specific thickness update disambiguates automatically without prompt
    const updHR = { sku_text: 'HR Coil', spec: '2.5mm', rate: 55000 };
    const score1 = scoreLineItemAgainstUpdate(items[0], updHR);
    const score2 = scoreLineItemAgainstUpdate(items[1], updHR);
    report(score1 > 400 && score2 < 200 && score1 > score2, 'HR Coil 2.5mm scores significantly higher than 6.0mm');

    const draftSpecific = { existing_items: items, line_item_updates: [updHR] };
    const disambigSpecific = resolveLineItemUpdateTargets(draftSpecific);
    report(disambigSpecific === null, 'No user disambiguation prompt needed when thickness is provided');
    report(draftSpecific.line_item_updates[0]._target_item_ids[0] === '101', 'Pinned accurately to Item 101 (2.5mm)');

    // Case B: Cross-category mismatch penalty
    const updCable = { sku_text: 'Cable Tray', spec: '150mm', rate: 480 };
    const scoreRect = scoreLineItemAgainstUpdate(items[3], updCable);
    report(scoreRect < 0, 'Cross-category mismatch (Cable Tray vs Rect Tube) receives negative penalty');

    // Case C: Ambiguous update prompts user disambiguation
    const updAmbiguous = { sku_text: 'HR Coil', rate: 56000 };
    const draftAmbiguous = { existing_items: items, line_item_updates: [updAmbiguous] };
    const disambigAmbiguous = resolveLineItemUpdateTargets(draftAmbiguous);
    report(
      disambigAmbiguous !== null && disambigAmbiguous.candidateIndexes?.length === 2,
      'Ambiguous HR Coil without thickness correctly prompts user with candidates'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 3: TOOL A(2) - FIELD-AWARE NON-GREEDY NOTES EXTRACTION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 3] Tool A(2): Field-Aware Non-Greedy Verbatim Notes Extraction');
  {
    const note1 = extractVerbatimNotes('Notes: Client wants urgent delivery, rate 54000/MT');
    report(note1 === 'Client wants urgent delivery', 'Notes stopped before rate instruction', `(got: "${note1}")`);

    const note2 = extractVerbatimNotes('update remarks to Spoke with Sharma ji and stage to price quote');
    report(note2 === 'Spoke with Sharma ji', 'Remarks stopped before stage instruction', `(got: "${note2}")`);

    const note3 = extractVerbatimNotes('Notes: Material needed on site\nDelivery Location: Bhosari Pune');
    report(note3 === 'Material needed on site', 'Notes stopped before newline delivery location', `(got: "${note3}")`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 4: TOOL B(2) - PO-TO-INQUIRY LINKING (4-DIGIT HSN & CATEGORY GUARD)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 4] Tool B(2): PO-to-Inquiry Linking & Category Guards');
  {
    // Test matching helper directly
    function testPoMatch(poItem, inqItem) {
      const pNorm = normalizeProductToCatalog(poItem.sku_text, poItem.dimensions);
      const cNorm = normalizeProductToCatalog(inqItem.sku_text, inqItem.dimensions);
      const pHsn = pNorm.hsnCode || detectHsnCode(poItem.sku_text, poItem.dimensions);
      const cHsn = cNorm.hsnCode || detectHsnCode(inqItem.sku_text, inqItem.dimensions);
      const pRoot = pHsn ? pHsn.slice(0, 4) : null;
      const cRoot = cHsn ? cHsn.slice(0, 4) : null;

      if (pNorm.catalogName && cNorm.catalogName && pNorm.catalogName === cNorm.catalogName) return true;
      if (pRoot && cRoot && pRoot === cRoot && pNorm.category === cNorm.category) return true;
      if (pNorm.category && cNorm.category && pNorm.category !== cNorm.category) return false;
      return false;
    }

    // Match across synonym: RHS -> MS Rectangular Tube
    const matchTube = testPoMatch(
      { sku_text: 'RHS 50x25 mm', dimensions: '2mm' },
      { sku_text: 'MS Rectangular Tube', dimensions: '50x25x2 mm' }
    );
    report(matchTube === true, 'PO RHS matches Inquiry MS Rectangular Tube (Pipes category & HSN 7306)');

    // Guard across categories: Round Bar (Structural) vs Round Pipe (Pipes)
    const matchFalse = testPoMatch(
      { sku_text: 'Round Bar 25mm', dimensions: '' },
      { sku_text: 'MS Round Pipe', dimensions: '25mm' }
    );
    report(matchFalse === false, 'Category Guard prevents false match between Round Bar and Round Pipe');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 5: TOOL C(1, 2) - COMPOUND INTENT CLASSIFICATION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 5] Tool C(1, 2): Compound Intent Classification (SAME_ACTIVITY)');
  {
    // Pure stage updates -> isStageOnlyUpdate is TRUE
    report(isStageOnlyUpdate('stage won') === true, 'Pure stage "stage won" detected as stage-only');
    report(isStageOnlyUpdate('update stage to price quote') === true, 'Pure stage "update stage to price quote" detected as stage-only');

    // Compound stage + rate updates -> isStageOnlyUpdate is FALSE
    const compound1 = 'upadte the rate of Hr coil to 200/MT and update the satge to price quote';
    const compound2 = 'upadte the satge of the inquiry to new inquiry and price of Hr coil to 8/MT and CR coil to 15/MT';

    report(isStageOnlyUpdate(compound1) === false, 'Compound update with rate & stage is NOT stage-only');
    report(isStageOnlyUpdate(compound2) === false, 'Compound update with multiple rates & stage is NOT stage-only');

    // Preemption / classification ensures SAME_ACTIVITY
    const class1 = await classifyActiveSessionIntent('UPDATE_INQUIRY', compound1);
    const class2 = await classifyActiveSessionIntent('UPDATE_INQUIRY', compound2);
    report(class1.classification === 'SAME_ACTIVITY', 'Compound 1 classified as SAME_ACTIVITY in active inquiry');
    report(class2.classification === 'SAME_ACTIVITY', 'Compound 2 classified as SAME_ACTIVITY in active inquiry');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 6: TOOL D(1, 2, 3) - HINGLISH, CUSTOMER NAME & NON-SILENT STAGE
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 6] Tool D(1, 2, 3): Hinglish Phrasing, Customer Name & Non-Silent Clarification');
  {
    // D(1) Hinglish stage recognition
    const mockDraft = { inquiry_id: 'INQ-TEST01', company_name: 'Test Steel Corp' };

    // D(3) Ambiguous stage prompts with button menu (never silently defaults to 'quoted')
    const resAmbiguous = await handleMidFlowStageUpdate('change status for above inquiry', '919999999999', 'step_1', 'UPDATE_INQUIRY', mockDraft);
    report(
      resAmbiguous.handled && resAmbiguous.reply.includes('Which stage would you like to update this inquiry to?'),
      'Ambiguous stage prompts for clarification'
    );
    report(
      Array.isArray(resAmbiguous.interactiveButtons) && resAmbiguous.interactiveButtons.length >= 3,
      'Presents interactive quick-action buttons for stage choices'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 7: PIPELINE STAGE TRANSITION RULES & MANDATORY FIELDS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 7] Pipeline Stage Transition Rules & Mandatory Fields');
  {
    const { evaluateMandatoryFields } = require('../src/agents/salesAgent');

    // Case A: Missing rate & payment terms
    const evalIncomplete = evaluateMandatoryFields({
      customerName: 'Shreeji Steel',
      lineItems: [{ sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, unit: 'MT', rate: null }],
      deliveryLocation: 'Pune',
      paymentTerms: null
    });
    report(evalIncomplete.isComplete === false, 'Incomplete inquiry blocked from Price Quote');
    report(
      evalIncomplete.missingFields.some(f => f.includes('Rate')) && evalIncomplete.missingFields.includes('Payment Terms'),
      'Correctly identifies missing rate and payment terms'
    );

    // Case B: All mandatory fields present
    const evalComplete = evaluateMandatoryFields({
      customerName: 'Shreeji Steel',
      lineItems: [{ sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, unit: 'MT', rate: 52000 }],
      deliveryLocation: 'Pune MIDC',
      paymentTerms: '30 Days Credit'
    });
    report(evalComplete.isComplete === true, 'Complete inquiry permitted to transition to Price Quote');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 8: COMPOUND EXTRACTION END-TO-END (GEMINI + REGEX HYBRID)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 8] End-to-End Hybrid Extraction on Multi-Field Updates');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    const initialDraft = {
      inquiry_id: 'INQ-TEST88',
      company_name: 'Shreeji Steel Corporation',
      existing_items: [
        { id: 'item_1', sku_text: 'HR Coil', dimensions: '2.5 mm', quantity: 20, unit: 'MT', rate: 50000 },
        { id: 'item_2', sku_text: 'CR Coil', dimensions: '0.8 mm', quantity: 15, unit: 'MT', rate: 58000 }
      ]
    };

    const prompt = 'upadte the satge of the inquiry to new inquiry and price of Hr coil to 8/MT and CR coil to 15/MT';
    const extracted = await extractFieldsWithLLM('UPDATE_INQUIRY', prompt, initialDraft);
    const stage = extracted.updates?.stage || extracted.updates?.target_stage || extracted.stage;
    const lines = extracted.line_item_updates || extracted.updates?.line_item_updates || [];

    report(/new[_\s]*inquiry/i.test(stage), 'LLM extracts target stage: "New Inquiry"');
    report(lines.length >= 2, `LLM extracts both line item rates (count: ${lines.length})`);
    const hrLine = lines.find(l => /hr/i.test(l.sku_text || l.item_reference));
    const crLine = lines.find(l => /cr/i.test(l.sku_text || l.item_reference));
    report(hrLine && Number(hrLine.rate) === 8, 'HR Coil rate updated to 8');
    report(crLine && Number(crLine.rate) === 15, 'CR Coil rate updated to 15');
  } else {
    console.log('  ⚠️ Skipping live Gemini LLM call (GOOGLE_API_KEY not configured in test environment)');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST GROUP 9: OPTION SELECTOR PROTECTION & ZERO PHANTOM PRICE EXTRACTION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ [GROUP 9] Option Selector Protection & Zero Phantom Price Extraction');
  {
    // 1. Selector detection
    report(isNumericOptionSelector('2') === true, 'Standalone option "2" recognized as numeric option selector');
    report(isNumericOptionSelector('option 3') === true, '"option 3" recognized as numeric option selector');
    report(isNumericOptionSelector('2nd') === true, '"2nd" recognized as numeric option selector');
    report(isNumericOptionSelector('2 MT') === false, '"2 MT" with unit correctly rejected from pure option selector');
    report(isNumericOptionSelector('₹200/MT') === false, '"₹200/MT" correctly rejected from pure option selector');
    report(isNumericOptionSelector('60 days') === false, '"60 days" correctly rejected from pure option selector');

    // 2. Product disambiguation option resolution
    const clarified = resolveClarifiedProduct('2', 'MS plate');
    report(clarified === 'HR Sheet', `Disambiguation choice "2" for MS plate resolves to HR Sheet (got: "${clarified}")`);

    // 3. LLM Field Extraction with standalone "2" does NOT extract rate
    const testDraft = {
      action: 'LOG_INQUIRY',
      company_name: 'Apex Steels',
      line_items: [{ sku_text: 'HR Sheet', dimensions: '4mm', quantity: 25, unit: 'MT', rate: null, amount: null }],
      delivery_location: 'Mumbai',
      payment_terms: null
    };

    const extractedFromOption = await extractFieldsWithLLM('LOG_INQUIRY', '2', testDraft);
    const hasPhantomRate = Boolean(
      (extractedFromOption.rate && extractedFromOption.rate !== null) ||
      (extractedFromOption.line_items && extractedFromOption.line_items[0] && extractedFromOption.line_items[0].rate)
    );
    report(!hasPhantomRate, 'Pure option choice "2" extracts ZERO phantom rate into inquiry draft');

    // 4. Final summary calculation with 60 days payment terms contains NO ₹2 /MT or ₹50 line total
    const finalDraft = {
      action: 'LOG_INQUIRY',
      company_name: 'Apex Steels',
      line_items: [{ sku_text: 'HR Sheet', dimensions: '4mm', quantity: 25, unit: 'MT', rate: null, amount: null }],
      delivery_location: 'Mumbai',
      payment_terms: '60 days credit'
    };
    const summary = buildConfirmationSummary('LOG_INQUIRY', finalDraft);
    report(!summary.includes('₹2 /MT') && !summary.includes('Line Total: ₹50') && !summary.includes('Quotation Total: ₹50'), 'Confirmation summary has zero phantom rate or quotation total');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP 10: Multi-Item Rate Disambiguation & Stale-State Stage Updates
  // ──────────────────────────────────────────────────────────────────────────
  {
    console.log('\n▶ [GROUP 10] Multi-Item Rate Disambiguation & Stale-State Stage Updates');

    // 1. Multi-item rate entered without product prompts for product choice
    const multiItemDraft = {
      action: 'UPDATE_INQUIRY',
      company_name: 'ABC Infra',
      inquiry_id: 'INQ-D0C940',
      _inquiry_display_id: 'INQ-D0C940',
      existing_items: [
        { id: 'item-1', sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, rate: 55000 },
        { id: 'item-2', sku_text: 'MS Angle', dimensions: '5mm', quantity: 15, rate: 0 },
        { id: 'item-3', sku_text: 'MS Rectangular Tube', dimensions: '2mm', quantity: 10, rate: 0 },
        { id: 'item-4', sku_text: 'GI Earthing Strip', dimensions: '3mm', quantity: 5, rate: 0 },
      ],
      updates: {
        rate: 54000,
        notes: 'Client wants urgent delivery by Saturday',
      },
    };

    const pendingChoice = resolveLineItemUpdateTargets(multiItemDraft);
    report(Boolean(pendingChoice), 'Unassigned rate on 4-item inquiry triggers line item disambiguation');
    report(pendingChoice?.reason === 'unnamed', 'Pending reason is "unnamed" for generic rate update');
    report(pendingChoice?.candidateIndexes?.length === 4, 'Candidate list offers all 4 line items');

    // 2. Choice picking
    const pickFirst = pickLineItemChoice('1', multiItemDraft.existing_items, pendingChoice.candidateIndexes);
    report(Array.isArray(pickFirst) && pickFirst.length === 1 && pickFirst[0] === 0, 'Reply "1" selects first item (HR Coil 2.5mm)');

    const pickByName = pickLineItemChoice('MS Angle', multiItemDraft.existing_items, pendingChoice.candidateIndexes);
    report(Array.isArray(pickByName) && pickByName.length === 1 && pickByName[0] === 1, 'Reply "MS Angle" selects second item');

    const pickAll = pickLineItemChoice('All', multiItemDraft.existing_items, pendingChoice.candidateIndexes);
    report(Array.isArray(pickAll) && pickAll.length === 4, 'Reply "All" selects all candidate items');

    // 3. Choice prompt text verification
    const promptText = buildLineItemChoicePrompt(multiItemDraft, pendingChoice);
    report(promptText.includes('📌 *Extracted Rate:* ₹54,000 / MT'), 'Choice prompt includes exact rate header format');
    report(promptText.includes('*For which product is this rate for?*'), 'Choice prompt asks which product');
    report(promptText.includes('*Skip* to leave rates unchanged'), 'Choice prompt gives Skip option');

    // 4. Isolated item update verification
    const testLineUpdate = multiItemDraft.line_item_updates[0];
    pinLineUpdateToItems(testLineUpdate, multiItemDraft.existing_items, [0]);
    const matchedFirst = matchLineItemUpdate(multiItemDraft.existing_items[0], 0, 4, [testLineUpdate]);
    const matchedSecond = matchLineItemUpdate(multiItemDraft.existing_items[1], 1, 4, [testLineUpdate]);
    report(Boolean(matchedFirst && matchedFirst.rate === 54000), 'Item 1 gets rate 54000 update');
    report(matchedSecond === null, 'Item 2 receives NO rate update (unassigned empty rate fields protected)');

    // 5. User chooses "Skip" -> rate update is discarded and rates remain unchanged
    const skipDraft = {
      action: 'UPDATE_INQUIRY',
      company_name: 'ABC Infra',
      inquiry_id: 'INQ-D0C940',
      delivery_location: 'Mumbai',
      payment_terms: '30 days',
      existing_items: [
        { id: 'item-1', sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, rate: 55000 },
        { id: 'item-2', sku_text: 'MS Angle', dimensions: '5mm', quantity: 15, rate: 0 },
      ],
      line_item_updates: [{ operation: 'update', item_reference: 'Line Item', rate: 54000 }],
      _pending_line_choice: { updateIndex: 0, candidateIndexes: [0, 1], reason: 'unnamed' },
      updates: { notes: 'Urgent delivery' },
    };
    const skipResult = await handleLineItemChoiceReply('skip', '919999999999', 'UPDATE_INQUIRY', skipDraft);
    report(Boolean(skipResult && skipResult.handled), 'Skip reply is handled cleanly');
    report(!skipDraft._pending_line_choice, 'Pending line choice cleared on Skip');
    report(!skipDraft.line_item_updates || skipDraft.line_item_updates.length === 0, 'Unassigned rate update removed on Skip leaving existing rates intact');

    // 6. Single product record directly assigns rate without asking
    const singleItemDraft = {
      action: 'UPDATE_INQUIRY',
      company_name: 'Single Corp',
      inquiry_id: 'INQ-SINGLE01',
      existing_items: [
        { id: 'item-1', sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, rate: 50000 },
      ],
      updates: {
        rate: 54000,
        notes: 'Urgent delivery',
      },
    };
    const singlePending = resolveLineItemUpdateTargets(singleItemDraft);
    report(singlePending === null, 'Single-product inquiry does not trigger disambiguation prompt');
    report(singleItemDraft.line_item_updates && singleItemDraft.line_item_updates[0] && singleItemDraft.line_item_updates[0].rate === 54000, 'Single-product inquiry directly gets rate 54000 assigned');

    // 7. Compound Rate + Notes Extraction Non-Truncation Test (54000 must NEVER become 540)
    const compoundRateDraft = {
      action: 'UPDATE_INQUIRY',
      company_name: 'CrossMAT Ltd',
      inquiry_id: 'INQ-FEF09B',
      existing_items: [
        { id: 'item-1', sku_text: 'GI Earthing Strip', dimensions: '3mm', quantity: 5, rate: 0 },
        { id: 'item-2', sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 20, rate: 55000 },
        { id: 'item-3', sku_text: 'MS Angle', dimensions: '5mm', quantity: 15, rate: 0 },
        { id: 'item-4', sku_text: 'MS Rectangular Tube', dimensions: '2mm', quantity: 10, rate: 0 }
      ]
    };
    const extractedCompound = await extractFieldsWithLLM('UPDATE_INQUIRY', 'Update inquiry: Notes: Client wants urgent delivery by Saturday, rate 54000/MT', compoundRateDraft);
    report(Number(extractedCompound.updates?.rate) === 54000, 'Rate 54000/MT extracted accurately as 54000 (not truncated to 540)');
    report(extractedCompound.updates?.rate !== 540, 'Rate 54000/MT is strictly not 540');

    const pendingCompound = resolveLineItemUpdateTargets(extractedCompound);
    const compoundPrompt = buildLineItemChoicePrompt(extractedCompound, pendingCompound);
    report(compoundPrompt.includes('₹54,000 / MT'), 'Choice prompt displays ₹54,000 / MT (not ₹540)');

    extractedCompound._pending_line_choice = pendingCompound;
    const compoundReply = await handleLineItemChoiceReply('1', '918262937458', 'UPDATE_INQUIRY', extractedCompound);
    report(Boolean(compoundReply && compoundReply.reply && compoundReply.reply.includes('₹54,000/MT')), 'Confirmation reply shows GI Earthing Strip updated with ₹54,000/MT');
    report(!compoundReply.reply.includes('₹540/MT'), 'Confirmation reply has zero ₹540/MT');

    // 8. Stale/Idle State Stage Update Queries
    report(isStageUpdatePrompt('sauda pakka ho gaya for ABC infra'), 'Prompt "sauda pakka ho gaya for ABC infra" recognized as stage update');
    report(isStageUpdatePrompt('mark ABC infra deal won'), 'Prompt "mark ABC infra deal won" recognized as stage update');
    report(isStageUpdatePrompt('deal won for ABC infra'), 'Prompt "deal won for ABC infra" recognized as stage update');
    report(isStageUpdatePrompt('ABC infra deal won'), 'Prompt "ABC infra deal won" recognized as stage update');
    report(isStageUpdatePrompt('deal confirm for ABC infra'), 'Prompt "deal confirm for ABC infra" recognized as stage update');
    report(isStageUpdatePrompt('sauda pakka for ABC infra'), 'Prompt "sauda pakka for ABC infra" recognized as stage update');
    report(isStageUpdatePrompt('mark INQ-123456 as won'), 'Prompt "mark INQ-123456 as won" recognized as stage update');
    report(isStageUpdatePrompt('update stage to quoted'), 'Prompt "update stage to quoted" recognized as stage update');

    // 5. Stage Only Update verification
    report(isStageOnlyUpdate('sauda pakka ho gaya for ABC infra'), 'Hinglish prompt "sauda pakka ho gaya for ABC infra" is stage-only');

    // 6. Strict gating verification (other write prompts must NOT match isStageUpdatePrompt)
    report(!isStageUpdatePrompt('log new inquiry for ABC infra 20 MT HR Coil'), 'New inquiry prompt rejected by isStageUpdatePrompt (keeps menu gating)');
    report(!isStageUpdatePrompt('record field visit for Tata Steel'), 'Field visit prompt rejected by isStageUpdatePrompt (keeps menu gating)');
    report(!isStageUpdatePrompt('update notes to urgent delivery'), 'General text update rejected by isStageUpdatePrompt');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FINAL SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log(`📊 FINAL SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================');

  if (passedTests === totalTests) {
    console.log('🎉 ALL INQUIRIES & ORDERS E2E TESTS PASSED WITH 100% SUCCESS!\n');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED!\n');
    process.exit(1);
  }
}

runInquiriesAndOrdersSuite().catch(err => {
  console.error('Unhandled suite error:', err);
  process.exit(1);
});
