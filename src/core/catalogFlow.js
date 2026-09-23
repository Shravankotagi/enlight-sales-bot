/**
 * catalogFlow.js - Guided Catalog & Interactive Conversational Forms for WhatsApp Bot
 *
 * Implements:
 * 1. Greeting Detection & 9-Option Menu
 * 2. 1-9 & Keyword Action Routing
 * 3. Structured Data Collection for Inquiries, Orders, Field Visits, Complaints
 * 4. AI-Powered Free-Form Field Extraction, Multi-Product Parsing & Date Normalization
 * 5. Multi-Turn Clarification & Missing Field Prompts
 * 6. Interactive Confirmation Summary (Yes / Edit / Cancel) State Machine
 * 7. Clean Database Execution into Supabase (Inquiries, Deals, Customer Visits, Complaints)
 *    - Strict Schema Compatibility with Enlight Sales OS Frontend (Company Name, Rate, & Line Items)
 */

const { invokeWithFallback } = require('./modelRouter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  supabase,
  saveActiveSession,
  getFullActiveSession,
  ensureCustomerRecord,
  verifyAndGetCustomerName,
  getAssignedCustomersList,
  normalizeCoreCompanyName,
  getAccessibleSalespersonPhonesForBot,
  expandPhoneVariants,
  isPhoneInScope,
} = require('../supabase');
const {
  detectHsnCode,
  normalizeProductToCatalog,
  isValidCatalogProduct,
  getUnknownProductClarificationMessage,
  MASTER_PRODUCTS_CATALOG,
} = require('../utils/hsnDetector');
const { safeParseJSON } = require('../utils/jsonUtils');
const { calculateQuotationBreakdown } = require('../utils/pricingEngine');
const {
  startNewCatalogSession,
  recordSessionMessage,
  finalizeCurrentSession,
} = require('./sessionManager');
const { logBotActivity } = require('../utils/activityLogger');

function cleanPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function getPhoneVariants(phone) {
  if (!phone) return [];
  const clean = String(phone).replace(/\D/g, '');
  const variants = new Set();
  if (clean.length === 10) {
    variants.add(clean);
    variants.add(`91${clean}`);
    variants.add(`+91${clean}`);
  } else if (clean.length === 12 && clean.startsWith('91')) {
    variants.add(clean);
    variants.add(clean.slice(2));
    variants.add(`+${clean}`);
  } else {
    variants.add(clean);
  }
  return Array.from(variants);
}

const CATALOG_MENU = `👋 Welcome to **SalesOS Assistant**!

What would you like to do today?

1. **Log New Inquiry**
2. **Update Inquiry**
3. **Log New Order**
4. **Update Order**
5. **Log Customer Field Visit**
6. **Update Field Visit**
7. **New Customer Acquisition**
8. **Log Customer Complaint**
9. **Update Customer Complaint**
10. **Other / General Query**

Reply with a number (1–10) or type what you'd like to do.`;

const CONFIRMATION_BUTTONS = [
  { id: 'btn_confirm_yes', title: 'Save / Yes' },
  { id: 'btn_confirm_edit', title: 'Edit Details' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const DISCARD_DRAFT_BUTTONS = [
  { id: 'btn_confirm_cancel', title: '🗑️ Discard Draft' },
];

const NEW_CUSTOMER_BUTTONS = [
  { id: 'btn_cust_yes', title: 'Yes, Add Customer' },
  { id: 'btn_cust_no', title: 'No / Cancel' },
];

const RESUME_QUERY_BUTTONS = [
  { id: 'btn_resume_yes', title: 'Yes, Continue' },
  { id: 'btn_resume_no', title: 'No, Go to Menu' },
];

function getPostActivityButtons(action) {
  switch (action) {
    case 'LOG_COMPLAINT':
      return [
        { id: 'btn_repeat_log_complaint', title: 'Log Another Complaint' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_COMPLAINT':
      return [
        { id: 'btn_repeat_update_complaint', title: 'Update Complaint' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_VISIT':
      return [
        { id: 'btn_repeat_log_visit', title: 'Log Another Visit' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_VISIT':
      return [
        { id: 'btn_repeat_update_visit', title: 'Update Another Visit' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_INQUIRY':
      return [
        { id: 'btn_repeat_log_inquiry', title: 'Log Another Inquiry' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_INQUIRY':
      return [
        { id: 'btn_repeat_update_inquiry', title: 'Update Another Inq' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_ORDER':
      return [
        { id: 'btn_repeat_log_order', title: 'Record Another Order' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_ORDER':
      return [
        { id: 'btn_repeat_update_order', title: 'Update Another Order' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_NEW_CUSTOMER':
      return [
        { id: 'btn_repeat_log_new_customer', title: 'Onboard Another' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    default:
      return [
        { id: 'btn_post_menu', title: 'Menu' },
      ];
  }
}

function isDiscardOrCancelIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

  // 1. Exact button IDs & single-phrase control commands
  const exactCancelWords = new Set([
    'btn_confirm_cancel',
    'btn_cust_no',
    'btn_flow_discard',
    'cancel',
    'discard',
    'stop',
    'exit',
    'quit',
    'abort',
    'drop',
    'skip',
    'nahi',
    'galat',
    'no',
    'no cancel',
    'discard draft',
    'cancel draft',
    'discard activity',
    'cancel activity',
    'discard complaint',
    'cancel complaint',
    'discard order',
    'cancel order',
    'discard inquiry',
    'cancel inquiry',
    'discard visit',
    'cancel visit',
    'cancel logging',
    'discard logging',
    'skip remaining',
    'discard remaining',
    'cancel remaining',
    'cancel this',
    'discard this',
    'cancel it',
    'discard it',
    'cancel now',
    'discard now',
    'mat karo',
    'nahi chahiye',
    'nahi karna',
    'cancel kar do',
    'discard kar do',
    'cancel karo',
    'discard karo',
  ]);

  if (exactCancelWords.has(clean)) {
    return true;
  }

  // 2. Strict start-to-end command patterns (where the entire intent of the message is cancellation)
  const fullCommandPatterns = [
    /^(?:please\s+)?(?:cancel|discard|abort|drop|stop|quit|clear)\s+(?:this\s+)?(?:draft|inquiry|order|visit|complaint|flow|activity|form|session|process|entry|logging|creation|action)\s*$/i,
    /^(?:please\s+)?(?:cancel|discard|abort|drop|stop|quit)\s+(?:it|this|that|all|now|please)\s*$/i,
    /^(?:i\s+)?(?:don\s*t|dont|do\s+not)\s+want\s+to\s+(?:log|create|save|record|continue|proceed|enter)(?:\s+(?:this|it|anymore))?\s*$/i,
    /^(?:never\s+mind|leave\s+it|forget\s+it|drop\s+it)\s*$/i,
    /^(?:cancel|discard)\s+kar\s*(?:do|de|diya|dena)?\s*$/i,
    /^(?:mat\s+karo|nahi\s+karna\s+hai|nahi\s+chahiye|band\s+karo)\s*$/i,
  ];

  for (const pattern of fullCommandPatterns) {
    if (pattern.test(clean)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a candidate option index (1-based integer) from anywhere within natural language text.
 * Supports:
 * - "option 1", "opt 1", "choice 2", "no. 1", "#1", "in option 1", "for option 2"
 * - "1st option", "2nd one", "3rd inquiry", "1st", "2nd", "3rd"
 * - "first", "second", "third", "fourth", "fifth", "last"
 * - Standalone "1", "1.", "1)", "1️⃣"
 */
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

/**
 * Checks if the user message is purely an option/identifier selector without any field update instructions.
 */
function isPureOptionSelectorOnly(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim();
  if (/^\s*(?:option|choice|no\.?|#)?\s*[1-9]\d*\.?\s*$/i.test(clean)) return true;
  if (/^\s*(?:the\s+)?(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s*(?:option|choice|inquiry|order|visit|one)?\.?\s*$/i.test(clean)) return true;
  if (/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*[0-9A-Za-z-]+$/i.test(clean)) return true;
  return false;
}

const CATALOG_MENU_SECTIONS = [
  {
    title: 'Inquiries & Orders',
    rows: [
      { id: 'menu_1', title: '1. Log New Inquiry', description: 'Capture customer requirements' },
      { id: 'menu_2', title: '2. Update Inquiry', description: 'Update rates, specs or stage' },
      { id: 'menu_3', title: '3. Log New Order', description: 'Record new confirmed PO' },
      { id: 'menu_4', title: '4. Update Order', description: 'Attach PO, update items' },
    ],
  },
  {
    title: 'Visits & Customers',
    rows: [
      { id: 'menu_5', title: '5. Log Field Visit', description: 'Record client meeting' },
      { id: 'menu_6', title: '6. Update Field Visit', description: 'Update meeting outcome' },
      { id: 'menu_7', title: '7. New Acquisition', description: 'Add new customer profile' },
    ],
  },
  {
    title: 'Complaints & Queries',
    rows: [
      { id: 'menu_8', title: '8. Log Complaint', description: 'Report quality or delay' },
      { id: 'menu_9', title: '9. Update Complaint', description: 'Update resolution status' },
      { id: 'menu_10', title: '10. General Query', description: 'Ask any data retrieval query' },
    ],
  },
];

// ── MODULE COLLECTION PROMPTS ────────────────────────────────────────────────

const MODULE_PROMPTS = {
  LOG_INQUIRY: `📋 **Log New Inquiry**

Please provide the following details:

- **Customer / Company:** *
- **Product Description / Quantity:** *
- **Rate:** (optional)
- **Preferred Make:** (optional)
- **Payment Terms:** *
- **Delivery Location:** *
- **Additional Notes:** (optional)

You can reply in any format — just include the field names or values in order.`,

  UPDATE_INQUIRY: `✏️ **Update Inquiry**

- **Inquiry ID:** * (e.g. INQ-2026-0042)

Which fields do you want to update? Mention the field name and new value.

**Updatable Fields:**
- Product Description / Quantity
- Rate
- Preferred Make
- Payment Terms
- Delivery Location
- Additional Notes
- Status (Open / Quoted / Won / Lost / On Hold)

Example:
"INQ-2026-0042, update rate to 54000, payment terms to 45 days credit, status to Quoted"`,

  LOG_ORDER: `🛒 **Record New Order**

Please provide the **Inquiry ID** (e.g. INQ-F4D982) linked to this order:

- **Inquiry ID:** * (e.g. INQ-F4D982)
- **PO Number:** (e.g. PO-2026-0042, or auto-generated if not provided)
- **PO Date:** (e.g. 10-09-2026, or today's date if not provided)
- **Delivery Location:** (optional, defaults to Quoted Inquiry details)
- **Payment Terms:** (optional, defaults to Quoted Inquiry details)

- **Line Items:** (if not already specified in the Quoted Inquiry)
  - Product Name / Description
  - Spec / Dimensions
  - Quantity & Unit
  - Rate (₹ per unit)

💡 _Tip: If the Inquiry is already Quoted, in Negotiation, or On Hold, you can simply reply with the Inquiry ID to auto-load all products, rates, and customer details!_`,

  UPDATE_ORDER: `✏️ **Update Order**

To identify the order, please provide ONE of the following:
- **Inquiry ID:** * (e.g. INQ-936C7B or INQ-3C86DE)
- **PO Number:** * (e.g. PO-2026-0042)

What would you like to update?
- **Attach / Update PO Number:** (e.g. "attach PO-2026-8899")
- **Header Fields:** PO Date, Delivery Location, Payment Terms, Status
- **Line Item Updates:** Quantity, Rate, Add/Remove Items

**Examples:**
- "For Inquiry INQ-936C7B, attach PO number PO-2026-8899"
- "PO-2026-0042, update delivery location to Pune MIDC, change item 1 rate to 58000"`,

  LOG_VISIT: `📍 **Log Customer Field Visit**

Please provide the following details:

- **Customer / Company:** *
- **Person Met:** *
- **Contact Phone:** *
- **City / Location:** *
- **Visit Date:** *
- **Visit Outcome:** * (Positive / Negative / Neutral / Follow-up Required)
- **Follow-up Action:** (optional)
- **Meeting Remarks:** *`,

  UPDATE_VISIT: `✏️ **Update Field Visit**

- **Customer / Company:** * (e.g. Vanguard Industrial Automation Systems)
- **Visit Date:** (optional e.g. 10-09-2026)

Which fields do you want to update? Mention the field name and new value.

**Updatable Fields:**
- Person Met
- Contact Phone
- City / Location
- Visit Date
- Visit Outcome (Positive / Negative / Neutral / Follow-up Required)
- Follow-up Action
- Meeting Remarks
- Status (Completed / Follow-up Pending / Cancelled)

Example:
"Vanguard Industrial Automation Systems, update Person Met to Amit Sharma, Visit Outcome to Positive"`,

  LOG_NEW_CUSTOMER: `👤 **New Customer Acquisition**

Please provide the following details:

- **Company Name:** *
- **Contact Person:** *
- **Mobile Number:** *
- **Delivery Location:** *
- **Email:** (optional)
- **GST Number:** (optional)

You can reply in any format — just include the field names or values in order.

Example:
"Apex Steel Structures, Contact: Rajesh Sharma, Phone: 9820123456, Location: Chakan Pune, Email: rajesh@apexsteel.com, GST: 27AABCU9603R1ZM"`,

  LOG_COMPLAINT: `⚠️ **Log Customer Complaint**

Please provide the following details:

- **Customer / Company:** *
- **Linked Order / Ref:** (optional, auto-linked if customer has active orders)
- **Product / Material:** (e.g. 12 MT MS angle)
- **Complaint Type:** (optional: Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
- **Description:** * (e.g. 12 MT MS angle with bending damage and edge cuts)
- **Corrective Action:** (optional)

Example:
"Shree Balaji Pre-Engineered Buildings received 12 MT MS angle with bending damage and edge cuts during truck unloading"`,

  UPDATE_COMPLAINT: `✏️ **Update Complaint**

To identify the complaint, provide ONE of the following:
- **Linked Order / Ref:** * (e.g. PO-2026-TI-101 or INQ-8971B1)
- **Customer / Company:** (e.g. Tech Industries)

What would you like to update?

**Updatable Fields:**
- Complaint Type (Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
- Description
- Corrective Action Taken
- Resolution Notes
- Status (Pending / In Progress / Resolved / Closed)

Example:
"Update complaint for Tech Industries to Specification Mismatch"`
};

// ── ACTION NAME FORMATTER FOR PROMPTS ─────────────────────────────────────────

function getActionFriendlyName(action) {
  switch (action) {
    case 'LOG_INQUIRY': return 'new inquiry';
    case 'UPDATE_INQUIRY': return 'inquiry update';
    case 'LOG_ORDER': return 'order';
    case 'UPDATE_ORDER': return 'order update';
    case 'LOG_VISIT': return 'visit report';
    case 'UPDATE_VISIT': return 'visit update';
    case 'LOG_NEW_CUSTOMER': return 'customer acquisition';
    case 'LOG_COMPLAINT': return 'complaint';
    case 'UPDATE_COMPLAINT': return 'complaint update';
    default: return 'action';
  }
}

function getModuleFamily(action) {
  if (!action) return 'OTHER';
  const act = String(action).toUpperCase().trim();
  if (act === 'LOG_INQUIRY' || act === 'UPDATE_INQUIRY') return 'INQUIRY';
  if (act === 'LOG_ORDER' || act === 'UPDATE_ORDER') return 'ORDER';
  if (act === 'LOG_VISIT' || act === 'UPDATE_VISIT') return 'VISIT';
  if (act === 'LOG_COMPLAINT' || act === 'UPDATE_COMPLAINT') return 'COMPLAINT';
  if (act === 'LOG_NEW_CUSTOMER') return 'CUSTOMER';
  return 'OTHER';
}

function getModuleDisplayName(action) {
  const family = getModuleFamily(action);
  switch (family) {
    case 'INQUIRY': return 'Inquiry';
    case 'ORDER': return 'Order';
    case 'VISIT': return 'Field Visit';
    case 'COMPLAINT': return 'Complaint';
    case 'CUSTOMER': return 'Customer Acquisition';
    default: return getActionFriendlyName(action);
  }
}

function getTargetActionVerb(action) {
  switch (action) {
    case 'LOG_INQUIRY': return 'log an inquiry';
    case 'UPDATE_INQUIRY': return 'update an inquiry';
    case 'LOG_ORDER': return 'log an order';
    case 'UPDATE_ORDER': return 'update an order';
    case 'LOG_VISIT': return 'log a field visit';
    case 'UPDATE_VISIT': return 'update a field visit';
    case 'LOG_NEW_CUSTOMER': return 'onboard a customer';
    case 'LOG_COMPLAINT': return 'log a complaint';
    case 'UPDATE_COMPLAINT': return 'update a complaint';
    default: return `start ${getActionFriendlyName(action)}`;
  }
}

function getEditPromptForAction(action) {
  switch (action) {
    case 'LOG_INQUIRY':
      return `Which field would you like to change? (e.g. "Rate: 55000", "Delivery location: Pune", or "Quantity: 25 MT")`;
    case 'UPDATE_INQUIRY':
      return `Which field would you like to change? (e.g. "Rate: 55000" or "Payment terms: 30 days")`;
    case 'LOG_ORDER':
      return `Which field would you like to change? (e.g. "Rate: 54000", "Delivery location: Pune", or "PO Number: PO-2026-001")`;
    case 'UPDATE_ORDER':
      return `Which field would you like to change? (e.g. "PO Number: PO-2026-001", "PO Date: 12-09-2026", or "Delivery location: Pune")`;
    case 'LOG_VISIT':
      return `Which field would you like to change? (e.g. "Person met: Jenny Shah", "Contact phone: 9820123456", "Visit date: 20-09-2026", or "Remarks: Discussed HR coil")`;
    case 'UPDATE_VISIT':
      return `Which field would you like to change? (e.g. "Person met: Jenny Shah", "Outcome: Positive", or "Remarks: Updated remarks")`;
    case 'LOG_COMPLAINT':
      return `Which field would you like to change? (e.g. "Description: Delivered product had severe rust", "Product: HR Sheet 3mm", or "Type: Quality Defect")`;
    case 'UPDATE_COMPLAINT':
      return `Which field would you like to change? (e.g. "Status: In Progress", "Type: Physical Damage", or "Description: Updated notes")`;
    case 'LOG_NEW_CUSTOMER':
      return `Which field would you like to change? (e.g. "Contact person: Rajesh Sharma", "Mobile: 9820123456", or "Delivery location: Satara")`;
    default:
      return `Which field would you like to change? (e.g. "Rate: 55000" or "Delivery location: Pune")`;
  }
}

function buildOutOfScopeActivityResponse(currentAction, detectedAction) {
  const currentModuleName = getModuleDisplayName(currentAction);
  const targetVerb = getTargetActionVerb(detectedAction);

  const replyText = `You are currently in the *${currentModuleName}* flow. To ${targetVerb}, please complete the current ongoing activity or select the relevant option from the menu.\n\nHere is the menu to start a new activity:\n\n${CATALOG_MENU}`;

  return {
    handled: true,
    reply: replyText,
    interactiveType: 'list',
    interactiveList: {
      bodyText: `You are currently in the *${currentModuleName}* flow. To ${targetVerb}, please complete the current ongoing activity or select the relevant option from the menu.\n\nHere is the menu to start a new activity:`,
      buttonText: 'Choose Action',
      sections: CATALOG_MENU_SECTIONS,
    },
  };
}

// ── GREETING & ROUTING MATCHERS ──────────────────────────────────────────────

function isGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().replace(/[!.,?]/g, '');
  const greetings = [
    'hi', 'hello', 'hey', 'start', 'menu', 'main menu', 'options',
    'namaste', 'good morning', 'good afternoon', 'good evening',
    'hii', 'hiii', 'heyy', 'catalog', 'help', 'btn_post_menu'
  ];
  if (greetings.includes(clean)) return true;
  return /^(?:hi|hello|hey|start|menu|namaste)\b/i.test(clean) && clean.length <= 15;
}

function matchActionFromInput(text) {
  if (!text || typeof text !== 'string') return null;

  // Extract first line in case of multi-line interactive list replies (e.g. "3. Log New Order\nRecord new confirmed PO")
  const firstLine = text.split(/[\r\n]+/)[0].trim();
  const clean = firstLine.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();
  const fullClean = text.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();

  // If text is a full sentence with arguments/details, let natural action detection & LLM extraction handle it
  if (clean.length > 35 || /\b(?:for|to|on|of|with|at|rate|qty|status|inq-|po-|midc|midc\s+pune|midc\s+bhosari|mt|tons|plate|sheet|coil)\b/i.test(clean)) {
    if (!/^(?:1|2|3|4|5|6|7|8|9|10)\.?$/i.test(clean) && !/^(?:\d+[\.\)\s\-]+|menu_\d+|start_log_|start_update_)?(?:log|update|record|start_log_|start_update_)?\s*(?:new\s*)?(?:inquiry|order|visit|complaint|customer|customer acquisition|field visit|customer visit|customer complaint|general query|other query)$/i.test(clean)) {
      return null;
    }
  }

  const stripped = clean.replace(/^(?:menu_|\d+[\.\)\s\-]+|\*+[0-9🔟]+[️⃣\s\.\)]+)/i, '').trim();

  if (
    clean === '1' || clean === '1.' || clean === 'menu_1' ||
    stripped === 'log inquiry' || stripped === 'log new inquiry' || stripped === 'new inquiry' || stripped === 'start_log_inquiry' ||
    clean === '1. log new inquiry' || clean === '1. log inquiry' || clean === '1 log new inquiry' ||
    fullClean.includes('capture customer requirements')
  ) {
    return 'LOG_INQUIRY';
  }
  if (
    clean === '2' || clean === '2.' || clean === 'menu_2' ||
    stripped === 'update inquiry' || stripped === 'start_update_inquiry' ||
    clean === '2. update inquiry' || clean === '2 update inquiry' ||
    fullClean.includes('update rates, specs or stage')
  ) {
    return 'UPDATE_INQUIRY';
  }
  if (
    clean === '3' || clean === '3.' || clean === 'menu_3' ||
    stripped === 'log order' || stripped === 'log new order' || stripped === 'record order' || stripped === 'record new order' || stripped === 'new order' || stripped === 'start_log_order' ||
    clean === '3. log new order' || clean === '3. log order' || clean === '3 log new order' ||
    fullClean.includes('record new confirmed po')
  ) {
    return 'LOG_ORDER';
  }
  if (
    clean === '4' || clean === '4.' || clean === 'menu_4' ||
    stripped === 'update order' || stripped === 'start_update_order' ||
    clean === '4. update order' || clean === '4 update order' ||
    fullClean.includes('update po date, items or stage')
  ) {
    return 'UPDATE_ORDER';
  }
  if (
    clean === '5' || clean === '5.' || clean === 'menu_5' ||
    stripped === 'log visit' || stripped === 'log customer field visit' || stripped === 'log customer visit' || stripped === 'log field visit' || stripped === 'field visit' || stripped === 'new visit' || stripped === 'start_log_visit' ||
    clean === '5. log customer field visit' || clean === '5. log field visit' || clean === '5 log customer field visit' ||
    fullClean.includes('log rep on-site client visit')
  ) {
    return 'LOG_VISIT';
  }
  if (
    clean === '6' || clean === '6.' || clean === 'menu_6' ||
    stripped === 'update visit' || stripped === 'update field visit' || stripped === 'update customer visit' || stripped === 'start_update_visit' ||
    clean === '6. update field visit' || clean === '6. update visit' || clean === '6 update field visit' ||
    fullClean.includes('update outcome or remarks')
  ) {
    return 'UPDATE_VISIT';
  }
  if (
    clean === '7' || clean === '7.' || clean === 'menu_7' ||
    stripped === 'new acquisition' || stripped === 'new customer' || stripped === 'new customer acquisition' || stripped === 'customer acquisition' || stripped === 'add customer' || stripped === 'onboard customer' || stripped === 'log customer' || stripped === 'start_log_customer' ||
    clean === '7. new customer acquisition' || clean === '7. new acquisition' || clean === '7 new customer acquisition' ||
    fullClean.includes('onboard new client profile')
  ) {
    return 'LOG_NEW_CUSTOMER';
  }
  if (
    clean === '8' || clean === '8.' || clean === 'menu_8' ||
    stripped === 'log complaint' || stripped === 'log customer complaint' || stripped === 'new complaint' || stripped === 'start_log_complaint' ||
    clean === '8. log customer complaint' || clean === '8. log complaint' || clean === '8 log customer complaint' ||
    fullClean.includes('log quality/service issue')
  ) {
    return 'LOG_COMPLAINT';
  }
  if (
    clean === '9' || clean === '9.' || clean === 'menu_9' ||
    stripped === 'update complaint' || stripped === 'update customer complaint' || stripped === 'start_update_complaint' ||
    clean === '9. update customer complaint' || clean === '9. update complaint' || clean === '9 update customer complaint' ||
    fullClean.includes('update resolution or status')
  ) {
    return 'UPDATE_COMPLAINT';
  }
  if (
    clean === '10' || clean === '10.' || clean === 'menu_10' ||
    stripped === 'other' || stripped === 'general query' || stripped === 'other query' || stripped === 'general_query' || stripped === 'other / general query' || text.includes('🔟') || text.includes('1️⃣0️⃣') ||
    clean === '10. other / general query' || clean === '10. other' || clean === '10. general query' ||
    fullClean.includes('general search or intelligence')
  ) {
    return 'GENERAL_QUERY';
  }

  return null;
}

function isExplicitMenuSelection(text, hasActiveSession = false) {
  if (!text || typeof text !== 'string') return null;
  const firstLine = text.split(/[\r\n]+/)[0].trim();
  const clean = firstLine.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();
  const fullClean = text.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();

  // 1. WhatsApp List Item ID (e.g. menu_1 .. menu_10)
  if (/^menu_(?:[1-9]|10)$/i.test(clean)) {
    return matchActionFromInput(text);
  }

  // 2. Exact catalog list titles / descriptions
  if (
    /^(?:1|2|3|4|5|6|7|8|9|10)[\.\)\s\-]+(?:log|update|record|new|onboard)?\s*(?:new\s*)?(?:inquiry|order|visit|field visit|customer visit|complaint|customer complaint|customer|acquisition|customer acquisition|general query|other query|other)\b/i.test(clean) ||
    fullClean.includes('capture customer requirements') ||
    fullClean.includes('update rates, specs or stage') ||
    fullClean.includes('record new confirmed po') ||
    fullClean.includes('attach po, update items') ||
    fullClean.includes('record client meeting') ||
    fullClean.includes('update meeting outcome') ||
    fullClean.includes('add new customer profile') ||
    fullClean.includes('report quality or delay') ||
    fullClean.includes('update resolution status') ||
    fullClean.includes('ask any data retrieval query') ||
    fullClean.includes('general search or intelligence')
  ) {
    return matchActionFromInput(text);
  }

  // 3. Action command / start prefix (e.g. "start_log_order", "start_update_inquiry")
  if (/^start_(?:log|update)_(?:inquiry|order|visit|customer|complaint)$/i.test(clean)) {
    return matchActionFromInput(text);
  }

  // 3b. Repeat action button / command (e.g. "btn_repeat_log_complaint", "log another complaint")
  if (/^btn_repeat_/i.test(clean) || /\b(?:log|record|update|onboard|add)\s+another\b/i.test(clean)) {
    if (clean.includes('complaint')) return clean.includes('update') ? 'UPDATE_COMPLAINT' : 'LOG_COMPLAINT';
    if (clean.includes('visit')) return clean.includes('update') ? 'UPDATE_VISIT' : 'LOG_VISIT';
    if (clean.includes('order')) return clean.includes('update') ? 'UPDATE_ORDER' : 'LOG_ORDER';
    if (clean.includes('inquiry') || clean.includes('inq')) return clean.includes('update') ? 'UPDATE_INQUIRY' : 'LOG_INQUIRY';
    if (clean.includes('customer') || clean.includes('cust') || clean.includes('onboard')) return 'LOG_NEW_CUSTOMER';
  }

  // 4. Standalone action verbs when NOT providing complex data/arguments (e.g. "log order", "new inquiry", "log visit")
  if (
    /^(?:log|update|record|new|onboard)?\s*(?:new\s*)?(?:inquiry|order|visit|field visit|customer visit|complaint|customer complaint|customer acquisition|customer onboarding|general query|other query)$/i.test(clean) &&
    clean.length <= 30
  ) {
    return matchActionFromInput(text);
  }

  // 5. If NOT in an active session (idle/general), single digits 1-10 are catalog selections
  if (!hasActiveSession && /^(?:[1-9]|10)\.?$/i.test(clean)) {
    return matchActionFromInput(text);
  }

  return null;
}

// ── DATE NORMALIZATION ───────────────────────────────────────────────────────

function normalizeDateToDDMMYYYY(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const clean = dateStr.trim();

  // Handle relative words
  const now = new Date();
  if (/^(?:today|now|nonw|just now|aaj|current)$/i.test(clean)) {
    return formatDateDDMMYYYY(now);
  }
  if (/^yesterday$/i.test(clean)) {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    return formatDateDDMMYYYY(y);
  }
  if (/^(?:day before yesterday|parso)$/i.test(clean)) {
    const dby = new Date(now.getTime() - 48 * 3600 * 1000);
    return formatDateDDMMYYYY(dby);
  }

  // Handle DD-MM-YYYY or DD/MM/YYYY embedded in text
  const dmyMatch = clean.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${day}-${month}-${year}`;
  }

  // Handle YYYY-MM-DD embedded in text
  const ymdMatch = clean.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = String(ymdMatch[2]).padStart(2, '0');
    const day = String(ymdMatch[3]).padStart(2, '0');
    return `${day}-${month}-${year}`;
  }

  // Handle textual e.g. "10 Sep 2026", "10th September 2026"
  const parsed = new Date(clean);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    return formatDateDDMMYYYY(parsed);
  }

  return clean;
}

function formatDateDDMMYYYY(d) {
  if (!d) return '';
  const dObj = d instanceof Date ? d : new Date(d);
  if (isNaN(dObj.getTime())) return typeof d === 'string' ? d : '';
  const day = String(dObj.getDate()).padStart(2, '0');
  const month = String(dObj.getMonth() + 1).padStart(2, '0');
  const year = dObj.getFullYear();
  return `${day}-${month}-${year}`;
}

function parseDDMMYYYYtoISO(dStr) {
  const now = new Date();
  if (!dStr) return now.toISOString();

  const todayStr = formatDateDDMMYYYY(now);
  if (typeof dStr === 'string' && dStr.trim() === todayStr) {
    return now.toISOString();
  }

  const m = String(dStr).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const targetDate = new Date(Date.UTC(year, month, day, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
    return targetDate.toISOString();
  }

  const parsed = new Date(dStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return now.toISOString();
}

function extractFollowUpDate(followupText, baseDate = new Date()) {
  if (!followupText || typeof followupText !== 'string') return null;
  const lower = followupText.toLowerCase();

  // 1. Explicit DD-MM-YYYY or YYYY-MM-DD
  const dmyMatch = lower.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  const ymdMatch = lower.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = String(ymdMatch[2]).padStart(2, '0');
    const day = String(ymdMatch[3]).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const base = new Date(baseDate.getTime());

  // 2. Relative "in X days" / "after X days" / "X days"
  const daysMatch = lower.match(/(?:in|after|within)?\s*(\d+)\s*(?:days?|din)/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const target = new Date(base.getTime() + days * 24 * 3600 * 1000);
    return target.toISOString().split('T')[0];
  }

  // 3. "tomorrow" / "kal"
  if (/\b(?:tomorrow|kal)\b/i.test(lower)) {
    const target = new Date(base.getTime() + 1 * 24 * 3600 * 1000);
    return target.toISOString().split('T')[0];
  }

  // 4. "next week" / "agle hafte"
  if (/\b(?:next\s+week|agle\s+hafte)\b/i.test(lower)) {
    const target = new Date(base.getTime() + 7 * 24 * 3600 * 1000);
    return target.toISOString().split('T')[0];
  }

  // 5. Day of week (e.g. "on monday", "next tuesday")
  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < daysOfWeek.length; i++) {
    const dayName = daysOfWeek[i];
    if (new RegExp(`\\b(?:on\\s+|next\\s+)?${dayName}\\b`, 'i').test(lower)) {
      const currentDay = base.getDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7;
      const target = new Date(base.getTime() + diff * 24 * 3600 * 1000);
      return target.toISOString().split('T')[0];
    }
  }

  return null;
}

// ── LLM FIELD EXTRACTION ENGINE ──────────────────────────────────────────────

async function extractFieldsWithLLM(action, userInput, existingDraft = {}) {
  const now = new Date();
  const todayStr = formatDateDDMMYYYY(now);
  const yesterdayDate = new Date(now.getTime() - 24 * 3600 * 1000);
  const yesterdayStr = formatDateDDMMYYYY(yesterdayDate);
  const dayBeforeYesterdayDate = new Date(now.getTime() - 48 * 3600 * 1000);
  const dayBeforeYesterdayStr = formatDateDDMMYYYY(dayBeforeYesterdayDate);

  const cleanDraftForLLM = Object.fromEntries(Object.entries(existingDraft || {}).filter(([k]) => !k.startsWith('_')));

  const systemPrompt = `You are the Structured Data Extraction Agent for Enlight Metals CRM WhatsApp Bot.
The user is providing details for the action: "${action}".

REAL-TIME REFERENCE DATES (CRITICAL - ALWAYS USE THESE):
- Today: ${todayStr} (DD-MM-YYYY)
- Yesterday: ${yesterdayStr} (DD-MM-YYYY)
- Day Before Yesterday / Parso: ${dayBeforeYesterdayStr} (DD-MM-YYYY)
- Current Year: ${now.getFullYear()}
- All relative dates like "today", "yesterday", "day before yesterday", "kal", "parso", "now" MUST be calculated relative to Today (${todayStr}) and Yesterday (${yesterdayStr}).
- NEVER output past years like 2024 or 2025 unless the user explicitly typed that specific year.

Extract the fields according to the following strict schema rules.
Return ONLY a valid JSON object (no markdown, no backticks, no explanation).

Schema by Action:

LOG_INQUIRY:
{
  "action": "LOG_INQUIRY",
  "company_name": "<Customer / Company Name, else null>",
  "product_description": "<Summary of all products/quantities, else null>",
  "rate": <numeric target rate/price per unit if mentioned, else null>,
  "preferred_make": "<JSW, SAIL, Tata, any, etc. if mentioned, else null>",
  "payment_terms": "<e.g. 30 Days Credit, 100% Advance, else null>",
  "delivery_location": "<e.g. Chakan Pune, Taloja, Aurangabad, else null>",
  "additional_notes": "<any extra notes if mentioned, else null>",
  "line_items": [
    {
      "sku_text": "<Literal product name mentioned by user e.g. 'Sheet', 'CR Sheet', 'HR Coil', 'MS Angle', 'Pipe', 'TMT Bar'>",
      "description": "<Full product text e.g. 'MS Sheet 5MM THK (1250 x 2500)'>",
      "dimensions": "<Dimensions / specifications e.g. '1250 x 2500', '1000 x 2000 mm'>",
      "spec": "<Dimensions / specifications>",
      "hsn_sac": "<HSN code if known, else null>",
      "quantity": <numeric quantity e.g. 15>,
      "unit": "<MT | KG | PCS | Sheets | Nos, default MT>",
      "rate": <numeric rate per unit in INR without symbol e.g. 54000 or 20, else null>,
      "amount": <auto-calculated quantity * rate if rate mentioned, else null>
    }
  ],
  "entries": [
    {
      "company_name": "<Company Name>",
      "product_description": "<Product description>",
      "rate": <rate or null>,
      "preferred_make": "<make or null>",
      "payment_terms": "<payment terms or null>",
      "delivery_location": "<location or null>",
      "line_items": []
    }
  ]
}

UPDATE_INQUIRY:
{
  "action": "UPDATE_INQUIRY",
  "inquiry_id": "<Inquiry ID e.g. INQ-2026-0042, INQ-1BB6F1, INQ-B76516, INQ-0042, else null>",
  "company_name": "<Customer / Company Name e.g. 'SS Industries', else null>",
  "updates": {
    "product_description": "<if user requested general product text update, else null>",
    "rate": <numeric rate ONLY if a single overall rate was specified without mentioning product names, else null>,
    "preferred_make": "<if user requested update, else null>",
    "payment_terms": "<if user requested update, else null>",
    "delivery_location": "<if user requested update, else null>",
    "additional_notes": "<if user requested update, else null>",
    "status": "<Open | Quoted | Won | Lost | On Hold if mentioned, else null>"
  },
  "line_item_updates": [
    {
      "sku_text": "<Product SKU or Name e.g. 'MS Sheet 5MM', 'MS Sheet 6MM'>",
      "description": "<Product description>",
      "rate": <numeric rate if specified for this product e.g. 20, 30, 54000, else null>,
      "quantity": <numeric quantity if specified for this product e.g. 15, 20, else null>,
      "unit": "<MT | KG | PCS | Sheets, default MT>"
    }
  ]
}

IMPORTANT RULES FOR INQUIRIES:
- If a user provides multiple products with individual rates (e.g. 'rate \n MS Sheet 5MM - 20 \n MS Sheet 6MM - 30'), put each product with its specific rate into 'line_item_updates' array! Do NOT put 20 as updates.rate, and do NOT put 'MS Sheet 5MM, MS Sheet 6MM' into updates.product_description.
- If a user provides multiple products with quantities (e.g. 'MS Sheet 5MM - 15 MT, MS Sheet 6MM - 20 MT'), parse each into line_items/line_item_updates with its respective quantity and unit.
- If a single rate is provided along with multiple products, apply that rate to all line items.

LOG_ORDER:
{
  "action": "LOG_ORDER",
  "inquiry_id": "<Inquiry ID e.g. INQ-F4D982, INQ-2026-0042, else null>",
  "company_name": "<Company Name, else null>",
  "po_number": "<PO Number e.g. PO-2026-0042, else null>",
  "po_date": "<PO Date in DD-MM-YYYY format, else null>",
  "delivery_location": "<Delivery Location, else null>",
  "payment_terms": "<Payment Terms, else null>",
  "rate": <numeric rate per unit in INR without symbol e.g. 50000 or 58000 if mentioned at top level or single rate, else null>,
  "line_items": [
    {
      "sku_text": "<Core metal product name e.g. 'MS Plate 10mm', 'HR Coil'>",
      "description": "<Product name e.g. 'MS Plate 10mm', 'HR Coil'>",
      "spec": "<Dimensions / Spec e.g. '8X6000X1500', else null>",
      "dimensions": "<Dimensions / Spec, else null>",
      "hsn_sac": "<HSN code if mentioned, else null>",
      "quantity": <numeric quantity e.g. 10>,
      "unit": "<MT | KG | PCS | Sheets | Nos, default MT>",
      "rate": <numeric rate per unit in INR without symbol e.g. 58000>,
      "amount": <auto-calculated quantity * rate>
    }
  ],
  "entries": [
    {
      "inquiry_id": "<Inquiry ID>",
      "company_name": "<Company Name>",
      "po_number": "<PO Number>",
      "po_date": "<PO Date>",
      "delivery_location": "<Location>",
      "payment_terms": "<Payment Terms>",
      "rate": <rate or null>,
      "line_items": []
    }
  ]
}

UPDATE_ORDER:
{
  "action": "UPDATE_ORDER",
  "inquiry_id": "<Inquiry ID if mentioned e.g. INQ-936C7B, INQ-3C86DE, INQ-2026-0042, else null>",
  "po_number": "<PO Number to lookup or attach e.g. PO-2026-0042, else null>",
  "company_name": "<Customer / Company Name if mentioned, else null>",
  "updates": {
    "po_number": "<new or attached PO number if updating/attaching to inquiry e.g. PO-2026-8899, else null>",
    "po_date": "<new PO date if updated, else null>",
    "delivery_date": "<new delivery date if updated e.g. 25-09-2026, else null>",
    "delivery_location": "<new delivery location if updated, else null>",
    "payment_terms": "<new payment terms if updated, else null>",
    "status": "<Pending | Processing | Dispatched | Delivered | Cancelled | Won if updated, else null>"
  },
  "line_item_updates": [
    {
      "operation": "<update | add | remove>",
      "item_reference": "<item number or product name>",
      "description": "<product name>",
      "spec": "<spec>",
      "hsn_sac": "<hsn>",
      "quantity": <numeric quantity or null>,
      "unit": "<unit or null>",
      "rate": <numeric rate or null>,
      "amount": <numeric amount or null>
    }
  ]
}

LOG_VISIT:
{
  "action": "LOG_VISIT",
  "company_name": "<Customer / Company Name visited, else null>",
  "person_met": "<Person met and/or designation, else null>",
  "contact_phone": "<10-digit phone number if provided, else null>",
  "city_location": "<City or location of visit, else null>",
  "visit_date": "<Visit date in DD-MM-YYYY format e.g. 10-09-2026, else null>",
  "visit_outcome": "<Positive | Negative | Neutral | Follow-up Required, else null>",
  "followup_action": "<specific follow up action if mentioned, else null>",
  "meeting_remarks": "<meeting remarks & requirements discussed, else null>",
  "entries": [
    {
      "company_name": "<Company Name visited>",
      "person_met": "<Person met, else null>",
      "contact_phone": "<Phone, else null>",
      "city_location": "<City / Location, else null>",
      "visit_date": "<Visit date in DD-MM-YYYY format, else null>",
      "visit_outcome": "<Positive | Negative | Neutral | Follow-up Required, else null>",
      "followup_action": "<Follow-up action, else null>",
      "meeting_remarks": "<Meeting remarks, else null>"
    }
  ]
}

UPDATE_VISIT:
{
  "action": "UPDATE_VISIT",
  
  "company_name": "<Customer / Company Name if mentioned (strip leading possessives like 'my' or 'our'), else null>",
  "visit_date": "<Visit Date if mentioned, else null>",
  "updates": {
    "person_met": "<Person met if updated, else null>",
    "contact_phone": "<Contact phone if updated, else null>",
    "city_location": "<City / Location if updated, else null>",
    "visit_outcome": "<Positive | Negative | Neutral | Follow-up Required if updated, else null>",
    "followup_action": "<Follow-up action if updated, else null>",
    "meeting_remarks": "<Meeting remarks if updated, else null>",
    "status": "<Completed | Follow-up Pending | Cancelled if updated, else null>"
  }
}

LOG_NEW_CUSTOMER:
{
  "action": "LOG_NEW_CUSTOMER",
  "company_name": "<Customer / Company Name, else null>",
  "contact_person": "<Owner / Contact Person Name, else null>",
  "mobile_number": "<10-digit mobile number, digits only, else null>",
  "delivery_location": "<City / Delivery Address / Location, else null>",
  "email": "<Email address if mentioned, else null>",
  "gst_number": "<GST number if mentioned, else null>",
  "entries": [
    {
      "company_name": "<Company Name>",
      "contact_person": "<Contact Person>",
      "mobile_number": "<Mobile Number>",
      "delivery_location": "<Location>",
      "email": "<Email>",
      "gst_number": "<GST>"
    }
  ]
}

LOG_COMPLAINT:
{
  "action": "LOG_COMPLAINT",
  "company_name": "<Company / Customer Name, else null>",
  "affected_product": "<Product name from the official 22 catalog products list (e.g. 'HR Coil', 'HR Sheet', 'CR Sheet', 'MS Angle', etc.) if explicitly named, or null if only generic words like '2 coils', 'material', 'defective goods' are mentioned>",
  "linked_inquiry_or_po": "<Linked Inquiry ID e.g. INQ-8971B1 or PO Number e.g. PO-Apex-4567, 6712 if mentioned, else null>",
  "complaint_type": "<Quality Defect | Physical Damage | Quantity Shortage | Delivery Delay | Billing Mismatch | Specification Mismatch | Other, if mentioned or inferred from issue, else null>",
  "complaint_description": "<Detailed complaint description including issue details and any quantities mentioned, else null>",
  "corrective_action": "<Corrective action taken if mentioned, else null>",
  "entries": [
    {
      "company_name": "<Company Name>",
      "affected_product": "<Product from official catalog, else null>",
      "linked_inquiry_or_po": "<Linked ID, else null>",
      "complaint_type": "<Type>",
      "complaint_description": "<Description>",
      "corrective_action": "<Action>",
      "initial_status": "<Status>"
    }
  ]
}

UPDATE_COMPLAINT:
{
  "action": "UPDATE_COMPLAINT",
  "company_name": "<Customer / Company Name if mentioned, else null>",
  "linked_inquiry_or_po": "<Linked PO Number or Inquiry ID e.g. INQ-8971B1, PO-2026-TI-101 if mentioned, else null>",
  "updates": {
    "complaint_type": "<Quality Defect | Physical Damage | Quantity Shortage | Delivery Delay | Billing Mismatch | Specification Mismatch | Other if updated, else null>",
    "complaint_description": "<if updated, else null>",
    "corrective_action": "<if updated, else null>",
    "status": "<Pending | In Progress | Resolved | Closed if updated, else null>",
    "resolution_notes": "<if updated, else null>"
  }
}

CRITICAL RULES:
1. Extract from natural language, free-form text, or lists.
2. For numeric amounts/rates, strip ₹ and currency symbols.
3. Normalize all dates to DD-MM-YYYY format (e.g. "today" -> current date, "yesterday" -> yesterday date, "10/9/26" -> "10-09-2026").
4. If a field was NOT mentioned by the user, leave it as null or empty string. NEVER fabricate or guess.
5. In LOG_INQUIRY and LOG_ORDER: if multiple products are listed, extract EACH individual item into the line_items array with its own product name, dimensions/spec, quantity, and unit.
6. If an existing draft is provided, you are completing or updating fields for THAT ACTIVE DRAFT (${cleanDraftForLLM.company_name || 'the current draft'}). PRESERVE existing draft fields unless explicitly changed by the user message.
7. MULTIPLE ENTITIES / COMPANIES (CRITICAL): If and only if the user message itself introduces multiple distinct companies/records (e.g. 'Visited two customers today: ABC Steel in Mumbai (positive) and Sharma Construction in Pune (neutral)' or 'Inquiry from ABC for 10 MT and XYZ for 20 MT'):
Output an 'entries' array containing a separate object for EACH individual customer/visit/inquiry/complaint!
If only a single company is mentioned or if filling missing fields for an existing draft, return the top-level fields (e.g. company_name, person_met, contact_phone, etc.) and do NOT output an entries array.
8. In LOG_ORDER: If the user provides an Inquiry ID (e.g. INQ-F4D982 or 'regarding inquiry INQ-F4D982'), extract the inquiry ID into 'inquiry_id'.
9. In UPDATE_ORDER: If the user provides an Inquiry ID (e.g. INQ-936C7B, INQ-3C86DE) and asks to attach/set/update a PO number (e.g. 'attach PO-2026-8899 to INQ-936C7B' or 'INQ-936C7B PO is PO-2026-8899'), extract the inquiry ID into 'inquiry_id' and the PO number into 'po_number' and 'updates.po_number'.
10. PRODUCT EXTRACTION & CATALOG INTEGRITY RULES (CRITICAL):
- Extract the EXACT, LITERAL product term mentioned by the user (e.g. 'Sheet', 'Coil', 'Plate', 'Pipe', 'Tube', 'MS Sheet', 'HR Sheet', 'CR Coil', 'MS Angle', 'TMT Bar').
- ZERO FABRICATION / ZERO AUTO-CONVERSION: NEVER guess, assume, or auto-convert generic or ambiguous words (e.g. 'sheet', 'coil', 'plate', 'pipe', 'tube', 'bar', 'rod') to a specific catalog variant.
  - If the user says "sheet", extract sku_text as "Sheet" (NEVER auto-convert "sheet" to "HR Sheet" or "CR Sheet").
  - If the user says "coil", extract sku_text as "Coil" (NEVER auto-convert "coil" to "HR Coil").
  - If the user says "plate", extract sku_text as "Plate" (NEVER auto-convert "plate" to "HR Plate").
  - If the user says "pipe", extract sku_text as "Pipe" (NEVER auto-convert "pipe" to "MS Round Pipe").
  The backend validation engine will automatically detect generic/ambiguous terms and ask the user to clarify the exact catalog variant.
- In LOG_COMPLAINT: if no official catalog product name is mentioned, leave 'affected_product' as null so the system automatically resolves it from the linked Order / PO!
- "dimensions" / "spec": Extract thickness, gauge, width, and size (e.g. '8mm', '1250 x 2500', '50x50x6').
11. TOTAL ORDER VALUE / DIRECT MONEY MODIFICATION (CRITICAL):
- In UPDATE_ORDER: Total order value (or total money / total amount / grand total) is a computed calculation derived strictly from line item rates, quantities, and taxes.
- Users CANNOT directly modify or override the total order value at the header level.
- If the user asks to change the total value or money directly (e.g. 'Change the total Value from 2,36,000 to 2,50,000' or 'update total amount to 2,50,000'), do NOT put 'total_amount' or 'total_value' into updates, and do NOT create a line item update with only amount.
- You MUST still extract any other valid updates mentioned in the message (e.g. payment_terms, delivery_location, po_date, delivery_date, status, po_number, or specific line item rate/qty changes).
`;

  const userPrompt = `Existing Active Draft:
${JSON.stringify(cleanDraftForLLM, null, 2)}

User Message:
"${userInput}"`;

  try {
    const response = await invokeWithFallback([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    let raw = typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
    if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
    else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

    const parsed = safeParseJSON(raw, null);
    if (parsed) {
      return mergeDraft(action, existingDraft, parsed, userInput);
    }
  } catch (err) {
    console.error('[CatalogFlow] LLM extraction error:', err.message);
  }

  return existingDraft;
}

const TOTAL_VALUE_PERMISSION_NOTICE = '⚠️ *Permission Notice:* You do not have permission to directly change the Total Order Value. Total value is calculated automatically from individual line item quantities and rates. To adjust the total value, please update individual line item rates or quantities.';

function detectTotalValueUpdateAttempt(text, extractedData) {
  if (text && typeof text === 'string') {
    const clean = text.trim();
    if (
      /\b(?:change|update|set|modify|make|edit|increase|decrease|reduce|fix)\b.*?\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|money)\b/i.test(clean) ||
      /\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|money)\b.*?\b(?:change|update|set|modify|from|to|is|=|karo|badlo)\b/i.test(clean) ||
      /\btotal\s+(?:value|amount)\s+(?:from\s+[\d,.]+\s+)?to\s+[\d,.]+/i.test(clean) ||
      /\b(?:change|update|set|modify)\s+(?:the\s+)?total\s+(?:value|amount)\b/i.test(clean)
    ) {
      return true;
    }
  }

  if (extractedData?.updates && (extractedData.updates.total_amount || extractedData.updates.total_value || extractedData.updates.grand_total)) {
    return true;
  }

  if (Array.isArray(extractedData?.line_item_updates)) {
    const spuriousAmountUpdate = extractedData.line_item_updates.some(item => 
      item && item.amount && !item.rate && !item.quantity && !item.item_reference && !item.description && !item.sku_text
    );
    if (spuriousAmountUpdate) return true;
  }

  return false;
}

// ── MERGE DRAFT HELPER ───────────────────────────────────────────────────────

function mergeSingleDraft(action, baseDraft, newExtracted, userInput = '') {
  const merged = { ...baseDraft, action };
  if (baseDraft._queue) merged._queue = baseDraft._queue;
  if (baseDraft._totalCount) merged._totalCount = baseDraft._totalCount;
  if (baseDraft._currentIndex) merged._currentIndex = baseDraft._currentIndex;

  for (const [key, val] of Object.entries(newExtracted)) {
    if (key === 'action' || key === 'entries' || key.startsWith('_')) continue;

    if (val !== null && val !== undefined && val !== '') {
      if (key === 'updates' && typeof val === 'object' && !Array.isArray(val)) {
        merged.updates = merged.updates || {};
        for (const [uKey, uVal] of Object.entries(val)) {
          if (uVal !== null && uVal !== undefined && uVal !== '') {
            if (action === 'UPDATE_ORDER' && (uKey === 'total_amount' || uKey === 'total_value' || uKey === 'grand_total' || uKey === 'amount')) {
              continue;
            }
            merged.updates[uKey] = uVal;
          }
        }
      } else if (key === 'line_items' && Array.isArray(val)) {
        if (val.length > 0) {
          const existingList = Array.isArray(baseDraft.line_items) ? baseDraft.line_items : [];
          merged.line_items = val.map((item, idx) => {
            const prevItem = existingList[idx] || (existingList.length === 1 ? existingList[0] : null);
            const qty = Number(item.quantity) || (prevItem ? Number(prevItem.quantity) || 0 : 0);
            const rawUnit = item.unit || prevItem?.unit || 'MT';
            const rate = Number(item.rate) || (prevItem ? Number(prevItem.rate) || 0 : 0);
            const amt = item.amount ? Number(item.amount) : (qty && rate ? qty * rate : (prevItem?.amount ? Number(prevItem.amount) : 0));
            const rawSku = item.sku_text || item.description || prevItem?.sku_text || prevItem?.description || '';
            const itemDim = item.dimensions || item.spec || prevItem?.dimensions || prevItem?.spec || '';
            const norm = normalizeProductToCatalog(rawSku, itemDim);
            const canonicalSku = norm.isValid ? norm.catalogName : rawSku;
            const hsn = item.hsn_code || item.hsn_sac || (norm.isValid ? norm.hsnCode : (detectHsnCode(rawSku, itemDim) || detectHsnCode(item.description || '') || prevItem?.hsn_code || null));
            return {
              sku_text: canonicalSku,
              description: item.description || prevItem?.description || canonicalSku,
              dimensions: itemDim,
              spec: itemDim,
              hsn_sac: hsn,
              hsn_code: hsn,
              is_valid_catalog: norm.isValid,
              quantity: qty || '',
              unit: rawUnit,
              rate: rate || '',
              amount: amt || '',
            };
          });

          if (!merged.product_description || merged.product_description.length < 5) {
            merged.product_description = merged.line_items.map(it => `${it.sku_text || it.description}${it.quantity ? ` - ${it.quantity} ${it.unit || 'MT'}` : ''}`).join(', ');
          }
        }
      } else if (key === 'line_item_updates' && Array.isArray(val)) {
        let validUpdates = val;
        if (action === 'UPDATE_ORDER') {
          validUpdates = val.filter(item => {
            if (!item) return false;
            // Reject items where only amount is given without any item reference, product, rate, or quantity
            if (item.amount && !item.rate && !item.quantity && !item.item_reference && !item.description && !item.sku_text) {
              return false;
            }
            return Boolean(item.item_reference || item.description || item.sku_text || item.rate || item.quantity || item.spec || item.dimensions);
          });
        }
        if (validUpdates.length > 0) {
          merged.line_item_updates = validUpdates;
          if (merged.updates) {
            delete merged.updates.rate;
            delete merged.updates.product_description;
          }
        }
      } else if (key === 'product_description' && typeof val === 'string' && val.trim()) {
        const norm = normalizeProductToCatalog(val.trim());
        if (norm.isValid && Array.isArray(merged.line_items) && merged.line_items.length > 0) {
          merged.line_items = merged.line_items.map(it => {
            const dim = it.dimensions || '';
            const itemNorm = normalizeProductToCatalog(it.sku_text, dim);
            if (!itemNorm.isValid) {
              return {
                ...it,
                sku_text: norm.catalogName,
                description: norm.catalogName,
                hsn_code: norm.hsnCode,
                hsn_sac: norm.hsnCode,
                is_valid_catalog: true,
              };
            }
            return it;
          });
        }
        merged.product_description = val;
      } else {
        if (key === 'company_name' && typeof val === 'string') {
          merged.company_name = val.replace(/^my\s*/i, '').replace(/^our\s+/i, '').replace(/^for\s+/i, '').trim();
        } else if (key.includes('date') && typeof val === 'string') {
          if (/\b(?:day before yesterday|parso)\b/i.test(userInput)) {
            const dby = new Date(Date.now() - 48 * 3600 * 1000);
            merged[key] = formatDateDDMMYYYY(dby);
          } else if (/\b(?:yesterday|kal)\b/i.test(userInput)) {
            const y = new Date(Date.now() - 24 * 3600 * 1000);
            merged[key] = formatDateDDMMYYYY(y);
          } else if (/\b(?:today|now|just now|aaj)\b/i.test(userInput)) {
            merged[key] = formatDateDDMMYYYY(new Date());
          } else {
            merged[key] = normalizeDateToDDMMYYYY(val);
          }
        } else {
          merged[key] = val;
        }
      }
    }
  }

  // Fallback date injection if date field is empty and user mentioned relative date
  if (!merged.visit_date && !merged.po_date) {
    const targetDateKey = action.includes('ORDER') ? 'po_date' : 'visit_date';
    if (/\b(?:day before yesterday|parso)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date(Date.now() - 48 * 3600 * 1000));
    } else if (/\b(?:yesterday|kal)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date(Date.now() - 24 * 3600 * 1000));
    } else if (/\b(?:today|now|just now|aaj)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date());
    }
  }

  // Fallback inquiry_id injection if missing and user mentioned INQ- or DEAL- ID
  if (!merged.inquiry_id && ['LOG_ORDER', 'UPDATE_ORDER', 'UPDATE_INQUIRY'].includes(action)) {
    const inqMatch = userInput.match(/\b(?:INQ|DEAL)-[A-Z0-9]+\b|#INQ-[A-Z0-9]+/i);
    if (inqMatch) {
      merged.inquiry_id = inqMatch[0].replace(/^#/, '').trim().toUpperCase();
    }
  }

  // Fallback rate extraction for LOG_ORDER / LOG_INQUIRY / UPDATE_INQUIRY
  if (!merged.rate && ['LOG_ORDER', 'LOG_INQUIRY', 'UPDATE_INQUIRY'].includes(action)) {
    const rateMatch = userInput.match(/(?:rate|price|@|bhav)[\s:=-]*₹?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i) ||
      userInput.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:\/|\s*per\s*)(?:mt|ton|tonne|kg|pcs|sheet)/i);
    if (rateMatch) {
      merged.rate = Number(rateMatch[1].replace(/,/g, ''));
    }
  }

  // Fallback PO number extraction for LOG_ORDER / UPDATE_ORDER
  if (!merged.po_number && ['LOG_ORDER', 'UPDATE_ORDER'].includes(action)) {
    const poMatch = userInput.match(/\b(?:PO[-_:#\s]*([A-Za-z0-9_-]+)|(?:po\s*number|po\s*no\.?|po#)[\s:=-]*([A-Za-z0-9_-]+))\b/i);
    if (poMatch) {
      const candidate = (poMatch[1] || poMatch[2] || '').trim();
      if (candidate && !/^(?:date|for|to|is|with|number|no|details?)$/i.test(candidate)) {
        merged.po_number = candidate.toUpperCase().startsWith('PO') ? candidate.toUpperCase() : `PO-${candidate.toUpperCase()}`;
      }
    }
  }

  // Fallback payment_terms extraction for LOG_INQUIRY / LOG_ORDER / UPDATE_INQUIRY / UPDATE_ORDER
  if (!merged.payment_terms && ['LOG_INQUIRY', 'LOG_ORDER', 'UPDATE_INQUIRY', 'UPDATE_ORDER'].includes(action)) {
    const payMatch = userInput.match(/\b(\d+\s*days?(?:\s*(?:credit|terms?|net|advance))?|100%\s*advance|advance|immediate|pdc|lc|cad|credit|online|rtgs|neft|against\s+delivery|cash\s+on\s+delivery|cod)\b/i);
    if (payMatch) {
      merged.payment_terms = payMatch[0].trim();
    }
  }

  // Fallback contact_person and mobile_number for LOG_NEW_CUSTOMER / LOG_VISIT / UPDATE_VISIT
  if (['LOG_NEW_CUSTOMER', 'LOG_VISIT', 'UPDATE_VISIT'].includes(action)) {
    if (!merged.mobile_number && !merged.contact_phone) {
      const phoneMatch = userInput.match(/\b([6-9]\d{9})\b/);
      if (phoneMatch) {
        merged.mobile_number = phoneMatch[1];
        if (action.includes('VISIT')) merged.contact_phone = phoneMatch[1];
      }
    }
    if (!merged.contact_person && !merged.person_met) {
      const namePhoneMatch = userInput.match(/^([a-zA-Z\s]{2,40})[,\s]+([6-9]\d{9})/);
      if (namePhoneMatch) {
        merged.contact_person = namePhoneMatch[1].trim();
        if (action.includes('VISIT')) merged.person_met = namePhoneMatch[1].trim();
      }
    }
  }

  // Update normalization for edit workflows
  if (action === 'UPDATE_ORDER') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.delivery_date && !merged.updates.delivery_date) merged.updates.delivery_date = normalizeDateToDDMMYYYY(newExtracted.delivery_date);
    if (newExtracted.delivery_location && !merged.updates.delivery_location) merged.updates.delivery_location = newExtracted.delivery_location;
    if (newExtracted.po_date && !merged.updates.po_date) merged.updates.po_date = normalizeDateToDDMMYYYY(newExtracted.po_date);
    if (newExtracted.payment_terms && !merged.updates.payment_terms) merged.updates.payment_terms = newExtracted.payment_terms;
    if (newExtracted.status && !merged.updates.status) merged.updates.status = newExtracted.status;
    if (newExtracted.po_number && !merged.updates.po_number && merged.inquiry_id) merged.updates.po_number = newExtracted.po_number;
  } else if (action === 'UPDATE_INQUIRY') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.rate && !merged.updates.rate) merged.updates.rate = newExtracted.rate;
    if (newExtracted.delivery_location && !merged.updates.delivery_location) merged.updates.delivery_location = newExtracted.delivery_location;
    if (newExtracted.payment_terms && !merged.updates.payment_terms) merged.updates.payment_terms = newExtracted.payment_terms;
    if (newExtracted.stage && !merged.updates.stage) merged.updates.stage = newExtracted.stage;
    if (newExtracted.status && !merged.updates.stage) merged.updates.stage = newExtracted.status;
  } else if (action === 'UPDATE_VISIT') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.person_met && !merged.updates.person_met) merged.updates.person_met = newExtracted.person_met;
    if (newExtracted.contact_phone && !merged.updates.contact_phone) merged.updates.contact_phone = newExtracted.contact_phone;
    if (newExtracted.city_location && !merged.updates.city_location) merged.updates.city_location = newExtracted.city_location;
    if (newExtracted.visit_outcome && !merged.updates.visit_outcome) merged.updates.visit_outcome = newExtracted.visit_outcome;
    if (newExtracted.visit_date && !merged.updates.visit_date) merged.updates.visit_date = normalizeDateToDDMMYYYY(newExtracted.visit_date);
    if (newExtracted.meeting_remarks && !merged.updates.meeting_remarks) merged.updates.meeting_remarks = newExtracted.meeting_remarks;
    if (newExtracted.followup_action && !merged.updates.followup_action) merged.updates.followup_action = newExtracted.followup_action;
    if (newExtracted.follow_up_action && !merged.updates.followup_action) merged.updates.followup_action = newExtracted.follow_up_action;
    if (newExtracted.status && !merged.updates.status) merged.updates.status = newExtracted.status;
  } else if (action === 'UPDATE_COMPLAINT') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.status && !merged.updates.status) merged.updates.status = newExtracted.status;
    if (newExtracted.resolution_notes && !merged.updates.resolution_notes) merged.updates.resolution_notes = newExtracted.resolution_notes;
  }

  return merged;
}

function mergeDraft(action, baseDraft, newExtracted, userInput = '') {
  // If LLM returned multiple entries (e.g. 2 visits / 2 companies in one message)
  if (Array.isArray(newExtracted?.entries) && newExtracted.entries.length > 0) {
    const firstEntry = newExtracted.entries[0];
    const remainingEntries = newExtracted.entries.slice(1).map(entry => {
      return mergeSingleDraft(action, {}, entry, userInput);
    });

    const merged = mergeSingleDraft(action, baseDraft, firstEntry, userInput);
    if (remainingEntries.length > 0) {
      merged._queue = (baseDraft._queue || []).concat(remainingEntries);
      merged._totalCount = baseDraft._totalCount || (merged._queue.length + 1);
      merged._currentIndex = baseDraft._currentIndex || 1;
    }
    if (action === 'UPDATE_ORDER' && detectTotalValueUpdateAttempt(userInput, newExtracted)) {
      merged._permissionNotice = TOTAL_VALUE_PERMISSION_NOTICE;
    }
    return merged;
  }

  const merged = mergeSingleDraft(action, baseDraft, newExtracted, userInput);
  if (action === 'UPDATE_ORDER' && detectTotalValueUpdateAttempt(userInput, newExtracted)) {
    merged._permissionNotice = TOTAL_VALUE_PERMISSION_NOTICE;
  }
  return merged;
}

// ── FORWARD CUSTOMER DETAILS TO PARENT DRAFT ──────────────────────────────

function forwardCustomerDetailsToParentDraft(originalAction, originalDraft, custDraft) {
  if (!originalDraft || typeof originalDraft !== 'object') return originalDraft;
  if (!custDraft || typeof custDraft !== 'object') return originalDraft;

  // 1. Company Name
  if (custDraft.company_name) {
    originalDraft.company_name = custDraft.company_name;
  }

  // 2. Phone / Mobile Number
  const phoneVal = custDraft.mobile_number || custDraft.phone || custDraft.contact_phone;
  if (phoneVal) {
    if (!originalDraft.contact_phone) originalDraft.contact_phone = phoneVal;
    if (!originalDraft.mobile_number) originalDraft.mobile_number = phoneVal;
    if (!originalDraft.phone) originalDraft.phone = phoneVal;
  }

  // 3. Location / City / Delivery Address
  const locVal = custDraft.delivery_location || custDraft.city_location || custDraft.location || custDraft.address;
  if (locVal) {
    if (!originalDraft.city_location) originalDraft.city_location = locVal;
    if (!originalDraft.delivery_location) originalDraft.delivery_location = locVal;
    if (!originalDraft.location) originalDraft.location = locVal;
    if (!originalDraft.address) originalDraft.address = locVal;
  }

  // 4. Contact Person / Person Met
  const personVal = custDraft.contact_person || custDraft.person_met;
  if (personVal) {
    if (!originalDraft.person_met) originalDraft.person_met = personVal;
    if (!originalDraft.contact_person) originalDraft.contact_person = personVal;
  }

  // Mark customer as verified and created
  originalDraft._customer_verified = true;
  originalDraft._new_customer_created = true;

  return originalDraft;
}

// ── VALIDATE MANDATORY FIELDS ────────────────────────────────────────────────

function validateMandatoryFields(action, draft) {
  const missing = [];

  switch (action) {
    case 'LOG_INQUIRY':
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.product_description && (!Array.isArray(draft.line_items) || draft.line_items.length === 0)) {
        missing.push('Product Description / Quantity');
      } else {
        const prodCheck = validateDraftProducts('LOG_INQUIRY', draft);
        if (!prodCheck.isValid) {
          missing.push(`Valid Product Name (Unrecognized: "${prodCheck.invalidProducts.join(', ')}")`);
        }
      }
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!draft.delivery_location) missing.push('Delivery Location');
      break;

    case 'UPDATE_INQUIRY':
      if (!draft.inquiry_id && !draft.company_name) missing.push('Inquiry ID (e.g. INQ-2026-0042) or Company Name');
      const inqUpdates = draft.updates || {};
      const hasInqUpdate = Object.values(inqUpdates).some(v => v !== null && v !== undefined && v !== '');
      const hasInqLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      if (!hasInqUpdate && !hasInqLineUpdates) missing.push('At least one field to update (e.g. Rate, Quantity, Delivery Location, Payment Terms, or Stage)');
      const inqProdCheck = validateDraftProducts('UPDATE_INQUIRY', draft);
      if (!inqProdCheck.isValid) {
        missing.push(`Valid Product Name (Unrecognized: "${inqProdCheck.invalidProducts.join(', ')}")`);
      }
      break;

    case 'LOG_ORDER':
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.inquiry_id) missing.push('Inquiry ID (e.g. INQ-F4D982)');
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.po_number) missing.push('PO Number (e.g. PO-2026-0042)');
      if (!draft.po_date) missing.push('PO Date (e.g. 10-09-2026)');
      if (!draft.delivery_location) missing.push('Delivery Location');
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!Array.isArray(draft.line_items) || draft.line_items.length === 0) {
        missing.push('Line Items (Product Name, Quantity, Rate)');
      } else {
        const first = draft.line_items[0];
        if (!first.description && !first.sku_text) missing.push('Product Name for line item');
        if (!first.quantity) missing.push('Quantity for line item');
        if (!first.rate) missing.push('Rate (₹ per unit) for line item');
        const ordProdCheck = validateDraftProducts('LOG_ORDER', draft);
        if (!ordProdCheck.isValid) {
          missing.push(`Valid Product Name (Unrecognized: "${ordProdCheck.invalidProducts.join(', ')}")`);
        }
      }
      break;

    case 'UPDATE_ORDER': {
      const hasOrderIdentifier = Boolean(draft.po_number || draft.inquiry_id || draft.company_name);
      if (!hasOrderIdentifier) {
        missing.push('Inquiry ID OR PO Number (e.g. INQ-936C7B or PO-2026-0042)');
      }
      const ordUpdates = draft.updates || {};
      const hasOrdHeader = Object.values(ordUpdates).some(v => v !== null && v !== undefined && v !== '') ||
                           Boolean(draft.po_date || draft.delivery_date || draft.delivery_location || draft.payment_terms || draft.status);
      const hasLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      const hasPoToAttach = Boolean(draft.inquiry_id && (draft.po_number || ordUpdates.po_number));
      if (!hasOrdHeader && !hasLineUpdates && !hasPoToAttach) {
        missing.push('At least one field to update (e.g. PO Number to attach, PO Date, Delivery Date, Delivery Location, Payment Terms, or Line Items)');
      }
      break;
    }

    case 'LOG_VISIT':
      if (!draft.meeting_remarks && (draft.followup_action || draft.notes || draft.additional_notes)) {
        draft.meeting_remarks = draft.followup_action || draft.notes || draft.additional_notes;
      }
      if (!draft.contact_phone && (draft.mobile_number || draft.phone)) {
        draft.contact_phone = draft.mobile_number || draft.phone;
      }
      if (!draft.city_location && (draft.delivery_location || draft.location || draft.address)) {
        draft.city_location = draft.delivery_location || draft.location || draft.address;
      }
      if (!draft.person_met && draft.contact_person) {
        draft.person_met = draft.contact_person;
      }
      if (!draft.company_name) missing.push('Customer / Company Name');
      if (!draft.person_met) missing.push('Person Met');
      if (!draft.contact_phone) missing.push('Contact Phone');
      if (!draft.city_location) missing.push('City / Location');
      if (!draft.visit_date) missing.push('Visit Date (e.g. 10-09-2026)');
      if (!draft.visit_outcome) missing.push('Visit Outcome (Positive / Negative / Neutral / Follow-up Required)');
      if (!draft.meeting_remarks) missing.push('Meeting Remarks & Requirements');
      break;

    case 'UPDATE_VISIT': {
      const hasVisitIdentifier = Boolean(draft.visit_id || draft.company_name);
      if (!hasVisitIdentifier) {
        missing.push('Customer / Company Name');
      }
      const visUpdates = draft.updates || {};
      const hasVisUpdate = Object.values(visUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasVisUpdate) missing.push('At least one field to update (e.g. Person Met, Contact Phone, City/Location, Outcome, Follow-up, Remarks)');
      break;
    }

    case 'LOG_NEW_CUSTOMER':
      if (!draft.contact_person && draft.person_met) {
        draft.contact_person = draft.person_met;
      }
      if (!draft.mobile_number && (draft.contact_phone || draft.phone)) {
        draft.mobile_number = draft.contact_phone || draft.phone;
      }
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.contact_person) missing.push('Contact Person');
      if (!draft.mobile_number && !draft.phone && !draft.contact_phone) missing.push('Mobile Number');
      if (!draft.delivery_location && !draft.city_location && !draft.address) missing.push('Delivery Location');
      break;

    case 'LOG_COMPLAINT':
      if (!draft.company_name) missing.push('Company / Customer Name');
      if (!draft.complaint_description && !draft.affected_product) {
        missing.push('Complaint Description & Affected Material');
      }
      break;

    case 'UPDATE_COMPLAINT': {
      const hasCmpRef = Boolean(draft.linked_inquiry_or_po || draft.company_name || draft.complaint_id);
      if (!hasCmpRef) {
        missing.push('Customer Name OR Linked PO Number / Inquiry ID');
      }
      const cmpUpdates = draft.updates || {};
      const hasCmpUpdate = Object.values(cmpUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasCmpUpdate) missing.push('At least one field to update (e.g. Complaint Type, Status, Description, Resolution Notes)');
      break;
    }
  }

  return missing;
}

// ── VERIFY DRAFT CUSTOMER (ROLE & ACCOUNT SCOPED) ───────────────────────────

async function verifyDraftCustomer(action, draft, senderPhone) {
  if (!draft || !draft.company_name) return { isValid: true };
  if (draft._customer_verified === true || draft._new_customer_created === true) {
    return { isValid: true, officialName: draft.company_name };
  }
  if (
    action === 'LOG_NEW_CUSTOMER' ||
    action === 'UPDATE_INQUIRY' ||
    action === 'UPDATE_ORDER' ||
    action === 'UPDATE_COMPLAINT' ||
    action === 'LOG_COMPLAINT' ||
    (action === 'LOG_ORDER' && (draft.deal_id || draft.inquiry_id || draft._inquiry_display_id))
  ) return { isValid: true };

  const rawName = String(draft.company_name).trim();
  if (!rawName || rawName.toLowerCase() === 'null' || rawName.toLowerCase() === 'unknown') {
    draft.company_name = null;
    return { isValid: true };
  }

  // Attempt verification against assigned accounts / scope
  const officialName = await verifyAndGetCustomerName(rawName, senderPhone);
  if (officialName) {
    draft.company_name = officialName;
    draft._customer_verified = true;
    return { isValid: true, officialName };
  }

  // Unrecognized customer -> Prompt for implicit new customer confirmation
  const askNewCustomerPrompt = `⚠️ *"${rawName}"* is not in your customer list.\n\n` +
    `Is this a new customer?\n` +
    `👉 Reply *Yes* to onboard as a new customer, or *No* to re-enter the correct company name.`;

  return {
    isValid: false,
    isUnrecognizedCustomer: true,
    unverifiedName: rawName,
    prompt: askNewCustomerPrompt,
  };
}

async function validateDraftComplaintReference(draft, senderPhone) {
  if (!draft || !draft.company_name) return { isValid: true };
  const companyName = String(draft.company_name).trim();
  const rawRef = (draft.linked_inquiry_or_po || draft.po_number || '').trim();
  if (!rawRef) return { isValid: true };

  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  const isExplicitInquiry = /^#?(?:INQ|DEAL)-/i.test(rawRef);
  if (isExplicitInquiry) {
    const cleanInqCode = rawRef.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/^#+/, '').trim().toUpperCase();
    let dQuery = supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, po_number, stage, salesperson_phone')
      .ilike('customer_name', `%${companyName}%`);

    let iQuery = supabase
      .from('inquiries')
      .select('id, sender_name, salesperson_phone, status')
      .ilike('sender_name', `%${companyName}%`);

    if (scope.phones !== null) {
      const targetPhones = expandPhoneVariants(scope.phones);
      if (targetPhones.length > 0) {
        dQuery = dQuery.in('salesperson_phone', targetPhones);
        iQuery = iQuery.in('salesperson_phone', targetPhones);
      } else {
        dQuery = null;
        iQuery = null;
      }
    }

    const { data: customerDeals } = dQuery ? await dQuery : { data: [] };

    const matchedDeal = (customerDeals || []).find(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || (d.id || '').toUpperCase().startsWith(cleanInqCode);
    });

    if (!matchedDeal) {
      const { data: customerInqs } = iQuery ? await iQuery : { data: [] };

      const matchedInq = (customerInqs || []).find(i => {
        const iId = (i.id || '').replace(/-/g, '').toUpperCase();
        return iId.startsWith(cleanInqCode) || (i.id || '').toUpperCase().startsWith(cleanInqCode);
      });

      if (!matchedInq) {
        const displayInq = cleanInqCode.startsWith('INQ-') ? cleanInqCode : `INQ-${cleanInqCode}`;
        return {
          isValid: false,
          rejectionMessage: `Inquiry ${displayInq} was not found for ${companyName}. A complaint can only be raised against an existing PO or inquiry in your portfolio. Please verify the inquiry ID and try again.`,
        };
      }
    }
  } else {
    // PO Number validation
    const cleanPo = rawRef.replace(/^(?:PO|Purchase\s*Order)[\s#:-]*/i, '').replace(/^#+/, '').trim();
    let dQuery = supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, po_number, stage, salesperson_phone')
      .ilike('customer_name', `%${companyName}%`);

    if (scope.phones !== null) {
      const targetPhones = expandPhoneVariants(scope.phones);
      if (targetPhones.length > 0) {
        dQuery = dQuery.in('salesperson_phone', targetPhones);
      } else {
        dQuery = null;
      }
    }

    const { data: customerDeals } = dQuery ? await dQuery : { data: [] };

    const matchedDeal = (customerDeals || []).find(d => {
      if (!d.po_number) return false;
      const dPo = String(d.po_number).trim().toUpperCase();
      const cPo = cleanPo.toUpperCase();
      const dPoClean = dPo.replace(/^(?:PO|Purchase\s*Order)[\s#:-]*/i, '').replace(/^#+/, '');
      return dPo === cPo || dPoClean === cPo || dPo.includes(cPo) || cPo.includes(dPoClean);
    });

    if (!matchedDeal) {
      const displayPo = cleanPo.startsWith('PO') || cleanPo.startsWith('#') ? cleanPo : `#${cleanPo}`;
      return {
        isValid: false,
        rejectionMessage: `PO ${displayPo} was not found in the Orders records for ${companyName}. A complaint can only be raised against an existing PO or inquiry in your portfolio. Please verify the PO number and try again.`,
      };
    }
  }

  return { isValid: true };
}

// ── VALIDATE ORDER INQUIRY STAGE GATE ───────────────────────────────────────

/**
 * Validates that an Order is linked to an existing Inquiry that is in Quoted stage.
 * Per Rule B:
 * - Salesperson provides an Inquiry ID → bot queries Inquiries/deals table → checks current stage
 * - If stage is Quoted / Price Quote → proceed with order creation flow ✅
 * - If stage is New Inquiry, Negotiation, On Hold, or any pre-quote stage → block:
 *   "Order cannot be created. Inquiry INQ-XXXXX is currently in [stage] stage. A quotation must be sent and the inquiry must be in Quoted stage before an order can be recorded."
 * - If Inquiry ID does not exist → block:
 *   "Inquiry ID not found. Please verify and try again."
 */
async function validateOrderInquiryStage(draft, senderPhone) {
  if (!draft) return { isValid: false, reply: 'Inquiry ID not found. Please verify and try again.' };

  const rawInq = (draft.inquiry_id || '').trim();
  if (!rawInq) {
    return {
      isValid: false,
      isMissingId: true,
      reply: `🛒 *Record New Order*\n\nPlease provide the *Inquiry ID* (e.g. INQ-F4D982) linked to this order:`,
    };
  }

  const cleanInqCode = rawInq.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();

  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  // 1. Fetch candidate deals matching cleanInqCode
  let dQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    dQuery = dQuery.in('salesperson_phone', targetPhones);
  }

  const { data: deals, error: dErr } = await dQuery.limit(500);
  if (dErr) console.warn('[CatalogFlow] validateOrderInquiryStage deals fetch warning:', dErr.message);

  let matchedDeal = (deals || []).find(d => {
    const dId = (d.id || '').replace(/-/g, '').toUpperCase();
    const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
    return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || (d.id || '').toUpperCase().startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
  });

  let matchedInq = null;
  if (!matchedDeal) {
    let iQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, status, salesperson_phone, created_at, ai_extraction_json')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      iQuery = iQuery.in('salesperson_phone', targetPhones);
    }

    const { data: inqs, error: iErr } = await iQuery.limit(500);
    if (iErr) console.warn('[CatalogFlow] validateOrderInquiryStage inqs fetch warning:', iErr.message);

    matchedInq = (inqs || []).find(i => {
      const iId = (i.id || '').replace(/-/g, '').toUpperCase();
      return iId.startsWith(cleanInqCode) || (i.id || '').toUpperCase().startsWith(cleanInqCode) || iId.includes(cleanInqCode);
    });
  }

  // 1b. Unscoped fallback by explicit cleanInqCode
  if (!matchedDeal && !matchedInq && cleanInqCode) {
    const { data: allDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false })
      .limit(500);

    matchedDeal = (allDeals || []).find(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || (d.id || '').toUpperCase().startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
    });

    if (!matchedDeal) {
      const { data: allInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, salesperson_phone, created_at, ai_extraction_json')
        .order('created_at', { ascending: false })
        .limit(500);

      matchedInq = (allInqs || []).find(i => {
        const iId = (i.id || '').replace(/-/g, '').toUpperCase();
        return iId.startsWith(cleanInqCode) || (i.id || '').toUpperCase().startsWith(cleanInqCode) || iId.includes(cleanInqCode);
      });
    }
  }

  if (!matchedDeal && !matchedInq) {
    return {
      isValid: false,
      reply: `Inquiry ID not found. Please verify and try again.`,
    };
  }

  // Determine stage & display formatting
  const canonicalInqId = matchedInq ? matchedInq.id : (matchedDeal?.inquiry_id || matchedDeal?.id);
  const formattedCode = canonicalInqId ? `INQ-${canonicalInqId.replace(/-/g, '').slice(0, 6).toUpperCase()}` : 'Inquiry';

  const rawStage = (matchedInq ? (matchedInq.stage || matchedInq.status) : matchedDeal?.stage) || 'new_inquiry';
  const stageLower = String(rawStage).toLowerCase().trim();

  const isNewInquiryStage = [
    'new_inquiry',
    'new',
    'auto_created',
    'inquiry'
  ].includes(stageLower);

  if (isNewInquiryStage) {
    return {
      isValid: false,
      reply: `Order cannot be created. Inquiry ${formattedCode} is currently in New Inquiry stage. A quotation must be sent before an order can be recorded.`,
    };
  }

  if (stageLower === 'lost' || stageLower === 'closed lost' || stageLower === 'closed_lost') {
    return {
      isValid: false,
      reply: `Order cannot be created. Inquiry ${formattedCode} is marked as Lost. Please reopen or update the inquiry before recording an order.`,
    };
  }

  // If Quoted stage -> Auto populate customer name, delivery location, payment terms, line items, PO details
  draft.inquiry_id = formattedCode;
  draft._inquiry_display_id = formattedCode;

  const sessionRate = draft.rate ? Number(String(draft.rate).replace(/[^\d.]/g, '')) : (Array.isArray(draft.line_items) && draft.line_items[0]?.rate ? Number(draft.line_items[0].rate) : null);

  // 1. Customer Name
  if (!draft.company_name) {
    draft.company_name = matchedDeal?.customer_name || matchedInq?.sender_name || matchedInq?.ai_extraction_json?.customer_name || matchedInq?.ai_extraction_json?.companyName || 'Customer';
  }
  draft._customer_verified = true;

  // 2. Delivery Location
  if (!draft.delivery_location) {
    draft.delivery_location = matchedDeal?.delivery_location || matchedInq?.ai_extraction_json?.delivery_location || matchedInq?.ai_extraction_json?.deliveryLocation || matchedInq?.ai_extraction_json?.delivery_address || 'Standard / Ex-Works';
  }

  // 3. Payment Terms
  if (!draft.payment_terms) {
    draft.payment_terms = matchedDeal?.payment_terms || matchedInq?.ai_extraction_json?.payment_terms || matchedInq?.ai_extraction_json?.paymentTerms || 'Standard Terms';
  }

  // 4. PO Date
  if (!draft.po_date) {
    draft.po_date = formatDateDDMMYYYY(new Date());
  }

  // 5. PO Number
  if (!draft.po_number) {
    if (matchedDeal?.po_number) {
      draft.po_number = matchedDeal.po_number;
    } else {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      draft.po_number = `PO-${todayStr}-${randomNum}`;
    }
  }

  // 6. Fetch DB line items
  let dbItems = [];
  if (matchedDeal && Array.isArray(matchedDeal.deal_items) && matchedDeal.deal_items.length > 0) {
    dbItems = matchedDeal.deal_items;
  } else if (matchedDeal?.id) {
    const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', matchedDeal.id);
    if (dItems && dItems.length > 0) dbItems = dItems;
  }

  if (dbItems.length === 0 && canonicalInqId) {
    const { data: inqItems } = await supabase.from('inquiry_items').select('*').eq('inquiry_id', canonicalInqId);
    if (inqItems && inqItems.length > 0) dbItems = inqItems;
  }

  if (dbItems.length === 0 && matchedInq?.ai_extraction_json?.line_items) {
    dbItems = matchedInq.ai_extraction_json.line_items;
  }

  if (dbItems.length > 0) {
    if (!Array.isArray(draft.line_items) || draft.line_items.length === 0) {
      draft.line_items = dbItems.map(it => {
        const qty = Number(it.quantity) || 0;
        const rate = (sessionRate && sessionRate > 0) ? sessionRate : (Number(it.rate) || (matchedInq?.ai_extraction_json?.rate ? Number(matchedInq.ai_extraction_json.rate) : 0));
        const amount = qty > 0 && rate > 0 ? qty * rate : (Number(it.amount) || 0);
        const sku = it.sku_text || it.description || 'Metal Product';
        const dim = it.dimensions || it.spec || null;
        const norm = normalizeProductToCatalog(sku, dim);
        const canonicalSku = norm.isValid ? norm.catalogName : sku;
        const hsn = it.hsn_code || it.hsn_sac || (norm.isValid ? norm.hsnCode : detectHsnCode(sku, dim));
        return {
          sku_text: canonicalSku,
          description: it.description || canonicalSku,
          dimensions: dim,
          spec: dim,
          quantity: qty,
          unit: it.unit || 'MT',
          rate: rate,
          amount: amount,
          hsn_sac: hsn,
          hsn_code: hsn,
          is_valid_catalog: norm.isValid,
        };
      });
    } else {
      draft.line_items = draft.line_items.map((it, idx) => {
        const fallbackDb = dbItems[idx] || dbItems[0] || {};
        const qty = Number(it.quantity) || Number(fallbackDb.quantity) || 0;
        const rate = (sessionRate && sessionRate > 0) ? sessionRate : (Number(it.rate) || Number(fallbackDb.rate) || 0);
        const amount = qty > 0 && rate > 0 ? qty * rate : (Number(it.amount) || 0);
        const sku = it.sku_text || it.description || fallbackDb.sku_text || fallbackDb.description || 'Metal Product';
        const dim = it.dimensions || it.spec || fallbackDb.dimensions || fallbackDb.spec || null;
        const norm = normalizeProductToCatalog(sku, dim);
        const canonicalSku = norm.isValid ? norm.catalogName : sku;
        const hsn = it.hsn_code || it.hsn_sac || fallbackDb.hsn_code || (norm.isValid ? norm.hsnCode : detectHsnCode(sku, dim));
        return {
          ...fallbackDb,
          ...it,
          sku_text: canonicalSku,
          description: it.description || fallbackDb.description || canonicalSku,
          dimensions: dim,
          spec: dim,
          quantity: qty,
          unit: it.unit || fallbackDb.unit || 'MT',
          rate: rate,
          amount: amount,
          hsn_sac: hsn,
          hsn_code: hsn,
          is_valid_catalog: norm.isValid,
        };
      });
    }
  }

  return {
    isValid: true,
    deal: matchedDeal,
    inquiry: matchedInq,
  };
}

// ── STRICT PRODUCT CATALOG VERIFICATION ──────────────────────────────────────

function resolveClarifiedProduct(userInput, invalidProduct) {
  const clean = (userInput || '').trim();
  const numMatch = clean.match(/^(?:option\s*|#\s*)?([1-6])\b/i);
  const pLower = String(invalidProduct || '').toLowerCase();

  const sheetOptions = ['HR Sheet', 'CR Sheet', 'HRPO Sheet', 'GP Sheet', 'Galvalume Sheet', 'Chequered Sheet'];
  const coilOptions = ['HR Coil', 'CR Coil', 'HRPO Coil', 'GP Coil', 'Galvalume Coil', 'Chequered Coil'];
  const plateOptions = ['HR Plate', 'HR Sheet', 'Chequered Sheet'];
  const pipeOptions = ['MS Round Pipe', 'MS Square Pipe', 'MS Rectangular Tube'];
  const barOptions = ['MS Round Bar', 'MS Flat Bar', 'MS Square Bar', 'TMT Bar'];

  let targetList = [];
  if (pLower.includes('sheet')) targetList = sheetOptions;
  else if (pLower.includes('coil')) targetList = coilOptions;
  else if (pLower.includes('plate')) targetList = plateOptions;
  else if (pLower.includes('pipe') || pLower.includes('tube')) targetList = pipeOptions;
  else if (pLower.includes('bar') || pLower.includes('rod') || pLower.includes('sariya')) targetList = barOptions;

  if (numMatch && targetList.length > 0) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (targetList[idx]) return targetList[idx];
  }

  const norm = normalizeProductToCatalog(clean);
  if (norm.isValid) return norm.catalogName;

  return null;
}

function validateDraftProducts(action, draft) {
  if (!draft || !['LOG_INQUIRY', 'UPDATE_INQUIRY', 'LOG_ORDER', 'UPDATE_ORDER'].includes(action)) {
    return { isValid: true };
  }

  const invalidProducts = [];

  // 1. Validate line items
  if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
    for (const item of draft.line_items) {
      const pName = item.sku_text || item.description || '';
      const dim = item.dimensions || item.spec || '';
      if (pName && pName.trim()) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid) {
          invalidProducts.push(pName.trim());
        }
      }
    }
  }

  // 2. Validate line item updates for UPDATE flows
  if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
    for (const item of draft.line_item_updates) {
      const pName = item.sku_text || item.description || item.item_reference || '';
      const dim = item.dimensions || item.spec || '';
      if (pName && pName.trim() && !/^(?:item\s*\d+|\d+)$/i.test(pName.trim())) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid) {
          invalidProducts.push(pName.trim());
        }
      }
    }
  }

  // 3. Validate product_description if line_items is empty
  if ((!draft.line_items || draft.line_items.length === 0) && draft.product_description && typeof draft.product_description === 'string') {
    const rawDesc = draft.product_description.trim();
    if (rawDesc.length > 0) {
      const norm = normalizeProductToCatalog(rawDesc);
      if (!norm.isValid) {
        invalidProducts.push(rawDesc);
      }
    }
  }

  if (invalidProducts.length > 0) {
    const uniqueInvalid = Array.from(new Set(invalidProducts));
    const clarificationMessage = getUnknownProductClarificationMessage(uniqueInvalid[0]);
    return {
      isValid: false,
      invalidProducts: uniqueInvalid,
      clarificationMessage,
    };
  }

  return { isValid: true };
}

// ── MULTI-VISIT DATE DISAMBIGUATION CHECK ────────────────────────────────────

async function checkMultipleVisitsForUpdate(action, draft, senderPhone) {
  if (action !== 'UPDATE_VISIT') return { needsDisambiguation: false };
  if (draft.visit_id || draft.visit_date || draft.updates?.visit_date) return { needsDisambiguation: false };
  if (!draft.company_name) return { needsDisambiguation: false };

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  let query = supabase
    .from('customer_visits')
    .select('id, customer_name, customer_address, person_met, contact_no, remarks, visited_at, salesperson_phone')
    .ilike('customer_name', `%${draft.company_name.trim()}%`)
    .order('visited_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      query = query.in('salesperson_phone', targetPhones);
    } else {
      return { needsDisambiguation: false };
    }
  }

  const { data: allVisits } = await query.limit(20);

  if (!allVisits || allVisits.length <= 1) return { needsDisambiguation: false };

  // 1. Accessibility filtering by salesperson phone
  let candidateVisits = allVisits.filter(v => {
    if (scope.isAdmin || scope.phones === null) return true;
    if (!v.salesperson_phone) return false;
    return isPhoneInScope(v.salesperson_phone, scope.phones);
  });

  // 2. Filter out synthetic Bigin sync logs
  const realVisits = candidateVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
  const pool = realVisits.length > 0 ? realVisits : candidateVisits;

  if (pool.length <= 1) return { needsDisambiguation: false };

  const candidateSummaries = pool.slice(0, 5).map((v, idx) => {
    const vDate = v.visited_at ? new Date(v.visited_at) : new Date();
    const dateFormatted = formatDateDDMMYYYY(vDate);
    const outTagMatch = (v.remarks || '').match(/\[Outcome:\s*([^\]]+)\]/i);
    const outcome = outTagMatch ? outTagMatch[1] : 'Positive';
    const cleanRemarks = (v.remarks || '')
      .replace(/\[Outcome:\s*[^\]]+\]/gi, '')
      .replace(/\[Follow-up:\s*[^\]]+\]/gi, '')
      .trim();
    return {
      index: idx + 1,
      id: v.id,
      company_name: v.customer_name || draft.company_name,
      date: dateFormatted,
      visited_at: v.visited_at,
      person_met: v.person_met || 'Not recorded',
      location: v.customer_address || 'Not recorded',
      outcome: outcome,
      remarks: cleanRemarks ? (cleanRemarks.length > 80 ? cleanRemarks.slice(0, 77) + '...' : cleanRemarks) : null,
    };
  });

  const choicesText = candidateSummaries
    .map(c => {
      const lines = [
        `${c.index}. *Visit on ${c.date}*`,
        `   • *Person Met:* ${c.person_met}`,
        `   • *Location:* ${c.location}`,
        `   • *Outcome:* ${c.outcome}`,
      ];
      if (c.remarks) {
        lines.push(`   • *Remarks:* ${c.remarks}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const prompt = `📅 *Multiple Visits Found for ${draft.company_name}:*\n\n` +
    `Please choose which visit you want to update:\n\n` +
    `${choicesText}\n\n` +
    `👉 Reply with the *Option Number* (1–${candidateSummaries.length}), *Visit Date* (e.g. "${candidateSummaries[0].date}"), or what you want to update (e.g. "update remarks in option 1 to Positive").`;

  draft._visit_candidates = candidateSummaries;

  return {
    needsDisambiguation: true,
    prompt,
    draft,
  };
}

// ── COMPLAINT ORDER VALIDATION & MULTI-ORDER DISAMBIGUATION CHECK ───────────

async function checkOrdersForComplaint(action, draft, senderPhone, originalText = '') {
  if (action !== 'LOG_COMPLAINT') return { handled: false, needsDisambiguation: false };
  if (!draft || !draft.company_name) return { handled: false, needsDisambiguation: false };

  const companyName = String(draft.company_name).trim();
  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  // Query confirmed won orders from Orders module (deals table with stage = 'won') strictly scoped by role
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, po_number, stage, total_amount, delivery_location, payment_terms, created_at, salesperson_phone')
    .ilike('customer_name', `%${companyName}%`)
    .eq('stage', 'won')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
    } else {
      dealsQuery = null;
    }
  }

  const { data: deals } = dealsQuery ? await dealsQuery : { data: [] };
  const wonDeals = deals || [];

  if (wonDeals.length === 0) {
    const reply = `⚠️ *No Confirmed Orders Found for ${companyName}*\n\n` +
      `A complaint can only be raised against an existing delivered order in the Orders module. Please verify the customer name or ensure an order has been marked as won.`;
    return {
      handled: true,
      status: 'NO_ORDERS',
      reply,
      draft,
    };
  }

  // Fetch line items for these won deals
  const dealIds = wonDeals.map(d => d.id);
  const { data: items } = await supabase
    .from('deal_items')
    .select('deal_id, sku_text, dimensions, quantity, unit')
    .in('deal_id', dealIds);

  const itemMap = new Map();
  (items || []).forEach(it => {
    const list = itemMap.get(it.deal_id) || [];
    list.push(it);
    itemMap.set(it.deal_id, list);
  });

  const enrichedDeals = wonDeals.map(d => {
    const rawInq = d.id;
    const cleanCode = rawInq.replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
    const dealCode = `INQ-${cleanCode}`;
    const itms = itemMap.get(d.id) || [];
    const prodSummary = itms.length > 0
      ? itms.map(it => `${it.sku_text || 'Steel'} ${it.dimensions || ''} ${it.quantity ? `(${it.quantity} ${it.unit || 'MT'})` : ''}`.trim()).join(', ')
      : 'Steel Material';
    const dateFormatted = d.created_at ? new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '';
    const loc = d.delivery_location ? `${d.delivery_location}` : 'Not specified';
    const payment = d.payment_terms ? `${d.payment_terms}` : 'Not specified';

    return {
      ...d,
      deal_code: dealCode,
      clean_code: cleanCode,
      effective_deal_id: d.id,
      items: itms,
      product_summary: prodSummary,
      date_formatted: dateFormatted,
      location: loc,
      payment_terms: payment,
      total_amount: Number(d.total_amount) || 0,
    };
  });

  const formatOrderCandidate = (d, idx) => {
    const poRef = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;
    const lines = [
      `${idx + 1}. ${poRef} — _${d.stage ? (d.stage.charAt(0).toUpperCase() + d.stage.slice(1)) : 'Won'}_`,
      `   • *Product:* ${d.product_summary}`,
      `   • *Delivery Location:* ${d.location}`,
      `   • *Payment Terms:* ${d.payment_terms}`,
    ];
    if (d.total_amount > 0) {
      lines.push(`   • *Total Value:* ₹${d.total_amount.toLocaleString('en-IN')}`);
    }
    if (d.date_formatted) {
      lines.push(`   • *Date:* ${d.date_formatted}`);
    }
    return lines.join('\n');
  };

  // Check if candidate PO or Inquiry ID was specified in user text or draft
  const rawRef = (draft.linked_inquiry_or_po || draft.po_number || draft.deal_id || '').trim();

  if (rawRef) {
    const cleanInput = rawRef.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*/i, '').replace(/^#+/, '').trim().toUpperCase();

    const matched = enrichedDeals.find(d => {
      const dPo = (d.po_number || '').trim().toUpperCase();
      const dPoClean = dPo.replace(/^(?:PO|Purchase\s*Order)[\s#:-]*/i, '').replace(/^#+/, '');
      const dIdClean = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqIdClean = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();

      return (
        (dPo && (dPo === cleanInput || dPoClean === cleanInput || dPo.includes(cleanInput) || cleanInput.includes(dPoClean))) ||
        d.clean_code === cleanInput ||
        d.deal_code.toUpperCase() === cleanInput ||
        dIdClean.startsWith(cleanInput) ||
        inqIdClean.startsWith(cleanInput)
      );
    });

    if (matched) {
      draft.deal_id = matched.id;
      draft.po_number = matched.po_number || null;
      draft.linked_inquiry_or_po = matched.po_number ? `PO: ${matched.po_number} (${matched.deal_code})` : matched.deal_code;
      const dealProd = matched.product_summary || (matched.items && matched.items.length > 0 ? matched.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
      const isCatalogProd = draft.affected_product && isValidCatalogProduct(draft.affected_product);
      if ((!draft.affected_product || !isCatalogProd) && dealProd) {
        draft.affected_product = dealProd;
      } else if (isCatalogProd) {
        const norm = normalizeProductToCatalog(draft.affected_product);
        if (norm.catalogName) draft.affected_product = norm.catalogName;
      }
      return { handled: false, needsDisambiguation: false, draft };
    } else {
      // Specified PO or Inquiry not found among won orders
      const availableList = enrichedDeals.map(formatOrderCandidate).join('\n\n');

      const reply = `❌ *Order / PO Not Found in Orders Module*\n\n` +
        `Customer: *${companyName}*\n` +
        `Order / PO *"${rawRef}"* was not found among confirmed orders for ${companyName}.\n\n` +
        `*Available Confirmed Orders for ${companyName}:*\n\n` +
        `${availableList}\n\n` +
        `👉 Please reply with a valid *PO Number* or *Inquiry ID* from the list above.`;

      draft._order_candidates = enrichedDeals;
      return {
        handled: true,
        status: 'ORDER_NOT_FOUND',
        reply,
        draft,
      };
    }
  }

  // If no reference was specified by user:
  if (enrichedDeals.length === 1) {
    const singleDeal = enrichedDeals[0];
    draft.deal_id = singleDeal.effective_deal_id || singleDeal.inquiry_id || singleDeal.id;
    draft.po_number = singleDeal.po_number || null;
    draft.linked_inquiry_or_po = singleDeal.po_number ? `PO: ${singleDeal.po_number} (${singleDeal.deal_code})` : singleDeal.deal_code;
    const singleProd = singleDeal.product_summary || (singleDeal.items && singleDeal.items.length > 0 ? singleDeal.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
    const isCatalogProd = draft.affected_product && isValidCatalogProduct(draft.affected_product);
    if ((!draft.affected_product || !isCatalogProd) && singleProd) {
      draft.affected_product = singleProd;
    } else if (isCatalogProd) {
      const norm = normalizeProductToCatalog(draft.affected_product);
      if (norm.catalogName) draft.affected_product = norm.catalogName;
    }
    return { handled: false, needsDisambiguation: false, draft };
  }

  // Multiple won orders exist and no specific PO/INQ was provided -> Multi-Order Disambiguation
  const orderList = enrichedDeals.map(formatOrderCandidate).join('\n\n');

  const prompt = `⚠️ *Multiple Confirmed Orders Found for ${companyName}:*\n\n` +
    `Please specify which order or PO this complaint is about:\n\n` +
    `${orderList}\n\n` +
    `👉 Reply with the *Number* (1–${enrichedDeals.length}) or the *Inquiry ID* / *PO Number*.`;

  draft._order_candidates = enrichedDeals;

  return {
    handled: true,
    needsDisambiguation: true,
    status: 'MULTIPLE_ORDERS',
    reply: prompt,
    prompt,
    draft,
  };
}

// ── CUSTOMER MATCHING HELPERS ────────────────────────────────────────────────

function cleanLegalSuffixes(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCustomerMatch(custName, custPhone, targetName, targetPhone) {
  const cClean = cleanLegalSuffixes(custName);
  const tClean = cleanLegalSuffixes(targetName);
  if (!cClean || !tClean) return false;
  if (cClean === tClean) return true;
  if ((cClean.startsWith(tClean) || tClean.startsWith(cClean)) && Math.min(cClean.length, tClean.length) >= 2) return true;
  const genericWords = new Set(['steel', 'metals', 'traders', 'industries', 'engineering', 'enterprises', 'enterprise', 'infra', 'works', 'projects', 'systems']);
  const cWords = cClean.split(' ').filter(w => w.length >= 2 && !genericWords.has(w));
  const tWords = tClean.split(' ').filter(w => w.length >= 2 && !genericWords.has(w));
  if (cWords.length > 0 && tWords.length > 0) {
    if (cWords.every(w => tWords.includes(w)) || tWords.every(w => cWords.includes(w))) return true;
  }
  return false;
}

// ── INQUIRY LOOKUP & EDITABILITY DISAMBIGUATION CHECK ─────────────────────────

async function checkInquiriesForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_INQUIRY') return { handled: false };

  const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  const rawInqId = (draft.inquiry_id || '').trim();
  const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
  const companyName = (draft.company_name || '').trim();

  // If neither ID nor company name is provided, let mandatory field check handle it
  if (!cleanInqId && !companyName) {
    return { handled: false };
  }

  const accessibleSet = new Set();
  if (Array.isArray(scope.phones)) scope.phones.forEach(p => getPhoneVariants(p).forEach(pv => accessibleSet.add(pv)));
  if (senderPhone) getPhoneVariants(senderPhone).forEach(pv => accessibleSet.add(pv));
  const accessibleList = Array.from(accessibleSet);

  // Fetch deals and inquiries to find matches
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  let inqsQuery = supabase
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, inquiry_type, created_at, salesperson_phone')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin) {
    if (accessibleList.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', accessibleList);
      inqsQuery = inqsQuery.in('salesperson_phone', accessibleList);
    } else {
      dealsQuery = null;
      inqsQuery = null;
    }
  }

  if (companyName) {
    const cleanWord = cleanLegalSuffixes(companyName).split(' ').filter(w => w.length >= 2)[0] || companyName;
    if (dealsQuery) dealsQuery = dealsQuery.ilike('customer_name', `%${cleanWord}%`);
  }

  if (dealsQuery) dealsQuery = dealsQuery.limit(500);
  if (inqsQuery) inqsQuery = inqsQuery.limit(500);

  const [{ data: allDeals }, { data: allInqs }] = await Promise.all([
    dealsQuery ? dealsQuery : Promise.resolve({ data: [] }),
    inqsQuery ? inqsQuery : Promise.resolve({ data: [] }),
  ]);

  // Apply RBAC phone filtering
  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      if (!item.salesperson_phone) return false;
      return isPhoneInScope(item.salesperson_phone, scope.phones);
    });
  };

  const scopedDeals = filterByScope(allDeals);
  const scopedInqs = filterByScope(allInqs);

  const dealMapByInqId = new Map();
  scopedDeals.forEach(d => {
    if (d.inquiry_id) dealMapByInqId.set(d.inquiry_id, d);
  });

  const matchedCandidates = [];
  const seenKeys = new Set();

  // 1. Direct ID match if inquiry_id was provided
  if (cleanInqId) {
    scopedDeals.forEach(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      if (dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && (dId.includes(cleanInqId) || inqId.includes(cleanInqId)))) {
        const stage = (d.stage || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(d.id || d.inquiry_id).slice(0, 6).toUpperCase()}`;
        matchedCandidates.push({
          id: d.id || d.inquiry_id,
          deal_id: d.id,
          inquiry_id: d.inquiry_id,
          displayId,
          company_name: d.customer_name || 'Customer',
          stage,
          payment_terms: d.payment_terms || 'Not specified',
          delivery_location: d.delivery_location || 'Not specified',
          total_amount: Number(d.total_amount) || 0,
          deal_items: d.deal_items || [],
          created_at: d.created_at,
          dateFormatted: formatDateDDMMYYYY(d.created_at),
          raw_text: '',
        });
        seenKeys.add(d.id);
        if (d.inquiry_id) seenKeys.add(d.inquiry_id);
      }
    });

    scopedInqs.forEach(inq => {
      if (seenKeys.has(inq.id)) return;
      const inqId = (inq.id || '').replace(/-/g, '').toUpperCase();
      if (inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && inqId.includes(cleanInqId))) {
        const ai = inq.ai_extraction_json || {};
        const stage = (inq.status || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${inq.id.slice(0, 6).toUpperCase()}`;
        matchedCandidates.push({
          id: inq.id,
          deal_id: null,
          inquiry_id: inq.id,
          displayId,
          company_name: inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
          stage,
          payment_terms: ai.paymentTerms || ai.payment_terms || 'Not specified',
          delivery_location: ai.deliveryLocation || ai.delivery_location || 'Not specified',
          total_amount: Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
          deal_items: ai.lineItems || ai.line_items || [],
          created_at: inq.created_at,
          dateFormatted: formatDateDDMMYYYY(inq.created_at),
          raw_text: inq.raw_text,
        });
        seenKeys.add(inq.id);
      }
    });

    // 1b. Unscoped fallback by explicit cleanInqId if not found in scoped list
    if (matchedCandidates.length === 0) {
      const { data: fallbackDeals } = await supabase
        .from('deals')
        .select('id, inquiry_id, customer_name, customer_phone, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
        .order('created_at', { ascending: false })
        .limit(500);

      (fallbackDeals || []).forEach(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        if (dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && (dId.includes(cleanInqId) || inqId.includes(cleanInqId)))) {
          const stage = (d.stage || 'new_inquiry').toLowerCase();
          const displayId = `INQ-${(d.id || d.inquiry_id).slice(0, 6).toUpperCase()}`;
          matchedCandidates.push({
            id: d.id || d.inquiry_id,
            deal_id: d.id,
            inquiry_id: d.inquiry_id,
            displayId,
            company_name: d.customer_name || 'Customer',
            stage,
            payment_terms: d.payment_terms || 'Not specified',
            delivery_location: d.delivery_location || 'Not specified',
            total_amount: Number(d.total_amount) || 0,
            deal_items: d.deal_items || [],
            created_at: d.created_at,
            dateFormatted: formatDateDDMMYYYY(d.created_at),
            raw_text: '',
          });
          seenKeys.add(d.id);
          if (d.inquiry_id) seenKeys.add(d.inquiry_id);
        }
      });

      if (matchedCandidates.length === 0) {
        const { data: fallbackInqs } = await supabase
          .from('inquiries')
          .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, inquiry_type, created_at, salesperson_phone')
          .order('created_at', { ascending: false })
          .limit(500);

        (fallbackInqs || []).forEach(inq => {
          if (seenKeys.has(inq.id)) return;
          const inqId = (inq.id || '').replace(/-/g, '').toUpperCase();
          if (inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && inqId.includes(cleanInqId))) {
            const ai = inq.ai_extraction_json || {};
            const stage = (inq.status || 'new_inquiry').toLowerCase();
            const displayId = `INQ-${inq.id.slice(0, 6).toUpperCase()}`;
            matchedCandidates.push({
              id: inq.id,
              deal_id: null,
              inquiry_id: inq.id,
              displayId,
              company_name: inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
              stage,
              payment_terms: ai.paymentTerms || ai.payment_terms || 'Not specified',
              delivery_location: ai.deliveryLocation || ai.delivery_location || 'Not specified',
              total_amount: Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
              deal_items: ai.lineItems || ai.line_items || [],
              created_at: inq.created_at,
              dateFormatted: formatDateDDMMYYYY(inq.created_at),
              raw_text: inq.raw_text,
            });
            seenKeys.add(inq.id);
          }
        });
      }
    }
  }

  // 2. Company Name Match if no direct ID match or if company_name provided
  if (matchedCandidates.length === 0 && companyName) {
    scopedInqs.forEach(inq => {
      const ai = inq.ai_extraction_json || {};
      const candidateName = inq.sender_name || ai.companyName || ai.customer_name || ai.customer?.name || '';
      if (isCustomerMatch(companyName, null, candidateName, inq.sender_phone)) {
        const linkedDeal = dealMapByInqId.get(inq.id);
        const stage = (linkedDeal?.stage || inq.status || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(linkedDeal?.id || inq.id).slice(0, 6).toUpperCase()}`;
        matchedCandidates.push({
          id: inq.id,
          deal_id: linkedDeal?.id || null,
          inquiry_id: inq.id,
          displayId,
          company_name: linkedDeal?.customer_name || candidateName || companyName,
          stage,
          payment_terms: linkedDeal?.payment_terms || ai.paymentTerms || ai.payment_terms || 'Not specified',
          delivery_location: linkedDeal?.delivery_location || ai.deliveryLocation || ai.delivery_location || 'Not specified',
          total_amount: Number(linkedDeal?.total_amount) || Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
          deal_items: linkedDeal?.deal_items || ai.lineItems || ai.line_items || [],
          created_at: inq.created_at,
          dateFormatted: formatDateDDMMYYYY(inq.created_at),
          raw_text: inq.raw_text,
        });
        seenKeys.add(inq.id);
        if (linkedDeal?.id) seenKeys.add(linkedDeal.id);
      }
    });

    scopedDeals.forEach(d => {
      if (seenKeys.has(d.id) || (d.inquiry_id && seenKeys.has(d.inquiry_id))) return;
      if (isCustomerMatch(companyName, null, d.customer_name, d.customer_phone)) {
        const stage = (d.stage || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(d.id || d.inquiry_id).slice(0, 6).toUpperCase()}`;
        matchedCandidates.push({
          id: d.id || d.inquiry_id,
          deal_id: d.id,
          inquiry_id: d.inquiry_id,
          displayId,
          company_name: d.customer_name || companyName,
          stage,
          payment_terms: d.payment_terms || 'Not specified',
          delivery_location: d.delivery_location || 'Not specified',
          total_amount: Number(d.total_amount) || 0,
          deal_items: d.deal_items || [],
          created_at: d.created_at,
          dateFormatted: formatDateDDMMYYYY(d.created_at),
          raw_text: '',
        });
        seenKeys.add(d.id);
      }
    });
  }

  const formatStageLabel = (st) => {
    const s = String(st || '').toLowerCase();
    if (s.includes('won') || s.includes('order')) return 'Won';
    if (s.includes('lost')) return 'Lost';
    if (s.includes('quote') || s.includes('price')) return 'Price Quote';
    if (s.includes('negot')) return 'Negotiation';
    if (s.includes('hold')) return 'On Hold';
    return 'New Inquiry';
  };

  const formatProductSummary = (item) => {
    if (Array.isArray(item.deal_items) && item.deal_items.length > 0) {
      if (item.deal_items.length === 1) {
        const it = item.deal_items[0];
        const name = it.sku_text || it.description || 'Metal Item';
        const qtyStr = it.quantity ? ` (${it.quantity} ${it.unit || 'MT'})` : '';
        const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
        return `${name}${qtyStr}${rateStr}`;
      }
      const totalQty = item.deal_items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
      const names = item.deal_items.slice(0, 2).map(it => it.sku_text || it.description || 'Item').join(', ');
      return `${item.deal_items.length} Items${totalQty > 0 ? ` (${totalQty} MT Total)` : ''} — ${names}`;
    }
    if (item.raw_text) {
      const firstLine = item.raw_text.split('\n')[0].trim();
      return firstLine.slice(0, 60);
    }
    return 'Products on record';
  };

  const isTerminal = (st) => ['won', 'lost', 'closed', 'completed', 'cancelled'].includes(String(st || '').toLowerCase());
  const editable = matchedCandidates.filter(m => !isTerminal(m.stage));
  const nonEditable = matchedCandidates.filter(m => isTerminal(m.stage));

  const targetName = companyName || draft.company_name || 'Customer';

  // ── Case A: 0 Editable Inquiries Found ──
  if (editable.length === 0) {
    if (nonEditable.length > 0) {
      const latestNonEditable = nonEditable[0];
      const stageLabel = formatStageLabel(latestNonEditable.stage);
      const reply = `ℹ️ *No Editable Inquiries Found for ${latestNonEditable.company_name}*\n\n` +
        `The inquiry found for *${latestNonEditable.company_name}* (*${latestNonEditable.displayId}*) is already marked as *${stageLabel}*. Completed / won inquiries cannot be edited.\n\n` +
        `If you would like to log a new inquiry for *${latestNonEditable.company_name}*, please send the inquiry details (Product, Quantity, Payment Terms, Delivery Location).`;
      return {
        handled: true,
        reply,
        status: 'ONLY_TERMINAL',
      };
    }

    if (rawInqId) {
      delete draft.inquiry_id;
      const reply = `❌ *Inquiry Not Found*\n\n` +
        `Could not find Inquiry ID *${rawInqId}* in your active records.\n\n` +
        `Please check the Inquiry ID or reply with the Customer / Company Name.`;
      return {
        handled: true,
        reply,
        status: 'ID_NOT_FOUND',
        draft,
      };
    }

    const reply = `ℹ️ *No Inquiries Found for ${targetName}*\n\n` +
      `There are no existing inquiries recorded for *${targetName}*.\n\n` +
      `If you would like to log a new inquiry, please share the inquiry details (Product, Quantity, Payment Terms, Delivery Location).`;
    return {
      handled: true,
      reply,
      status: 'NO_INQUIRIES',
      draft,
    };
  }

  // ── Case B: Exactly 1 Editable Inquiry Found ──
  if (editable.length === 1) {
    const single = editable[0];
    draft.inquiry_id = single.inquiry_id || single.id;
    draft.company_name = single.company_name;
    draft._inquiry_display_id = single.displayId;

    const hasUpdates = (draft.updates && Object.values(draft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
      (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0);

    // If user has not specified what to update yet, show current inquiry details & ask
    if (!hasUpdates) {
      const prodSummary = formatProductSummary(single);
      const stageLabel = formatStageLabel(single.stage);
      const prompt = `✏️ *Editable Inquiry Found for ${single.company_name}:*\n\n` +
        `• *Inquiry ID:* ${single.displayId}\n` +
        `• *Date:* ${single.dateFormatted}\n` +
        `• *Stage:* ${stageLabel}\n` +
        `• *Product / Requirement:* ${prodSummary}\n` +
        `• *Payment Terms:* ${single.payment_terms}\n` +
        `• *Delivery Location:* ${single.delivery_location}\n\n` +
        `What details would you like to update?\n` +
        `_(e.g., Rate, Quantity, Delivery Location, Payment Terms, or Stage)_`;

      return {
        handled: true,
        reply: prompt,
        status: 'SINGLE_EDITABLE_ASK_DETAILS',
        draft,
      };
    }

    // User already provided update values -> continue to confirmation
    return {
      handled: false,
      status: 'SINGLE_EDITABLE_READY',
      draft,
    };
  }

  // ── Case C: Multiple Editable Inquiries Found ──
  const candidateSummaries = editable.slice(0, 5).map((inq, idx) => {
    let rateStr = null;
    let makeStr = null;
    if (Array.isArray(inq.deal_items) && inq.deal_items.length > 0) {
      const firstItem = inq.deal_items[0];
      if (firstItem.rate) {
        rateStr = `₹${Number(firstItem.rate).toLocaleString('en-IN')}${firstItem.unit ? `/${firstItem.unit}` : '/MT'}`;
      }
      if (firstItem.preferred_make || firstItem.make) {
        makeStr = firstItem.preferred_make || firstItem.make;
      }
    }
    return {
      index: idx + 1,
      id: inq.inquiry_id || inq.id,
      displayId: inq.displayId,
      company_name: inq.company_name,
      date: inq.dateFormatted,
      stage: formatStageLabel(inq.stage),
      productSummary: formatProductSummary(inq),
      payment_terms: inq.payment_terms || 'Not specified',
      delivery_location: inq.delivery_location || 'Not specified',
      rate: rateStr,
      make: makeStr,
    };
  });

  const choicesText = candidateSummaries
    .map(c => {
      const lines = [
        `${c.index}. *${c.displayId}* (${c.date}) — _${c.stage}_`,
        `   • *Product:* ${c.productSummary}`,
        `   • *Delivery Location:* ${c.delivery_location}`,
        `   • *Payment Terms:* ${c.payment_terms}`,
      ];
      if (c.rate && !c.productSummary.includes('@ ₹')) {
        lines.push(`   • *Rate:* ${c.rate}`);
      }
      if (c.make) {
        lines.push(`   • *Make:* ${c.make}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const prompt = `📋 *Multiple Editable Inquiries Found for ${targetName}:*\n\n` +
    `Please choose which inquiry you want to edit:\n\n` +
    `${choicesText}\n\n` +
    `👉 Reply with the *Option Number* (1–${candidateSummaries.length}), *Inquiry ID* (e.g. "${candidateSummaries[0].displayId}"), or what you want to update (e.g. "update location in option 1 to Bhiwandi").`;

  draft._inquiry_candidates = candidateSummaries;

  return {
    handled: true,
    reply: prompt,
    status: 'MULTIPLE_EDITABLE',
    draft,
  };
}

// ── ORDER LOOKUP & VALIDATION HELPER ─────────────────────────────────────────

async function checkOrdersForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_ORDER') return { handled: false };

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  const rawInqId = (draft.inquiry_id || '').trim();
  const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
  const rawPo = (draft.updates?.po_number || draft.po_number || '').trim();
  const cleanPo = rawPo.replace(/^(?:PO[-_:#\s]*)/i, '').trim();
  const rawCompany = (draft.company_name || '').trim();

  if (!cleanInqId && !rawPo && !rawCompany) {
    return { handled: false };
  }

  // 1. Fetch recent deals strictly scoped by role
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
    } else {
      dealsQuery = null;
    }
  }

  const { data: deals } = dealsQuery ? await dealsQuery.limit(500) : { data: [] };

  let deal = null;
  if (deals && deals.length > 0) {
    if (cleanInqId) {
      deal = deals.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
      }) || null;
    }
    if (!deal && rawPo) {
      deal = deals.find(d => {
        if (!d.po_number) return false;
        const dPo = String(d.po_number).trim();
        return dPo.toLowerCase() === rawPo.toLowerCase() || (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
      }) || null;
    }
    if (!deal && rawCompany) {
      deal = deals.find(d => isCustomerMatch(rawCompany, null, d.customer_name, null)) || null;
    }
  }

  // 2. Check inquiries table if cleanInqId was given and not yet found in deals
  if (!deal && cleanInqId) {
    let inqsQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
      .order('created_at', { ascending: false });

    if (scope.phones !== null) {
      const targetPhones = expandPhoneVariants(scope.phones);
      if (targetPhones.length > 0) {
        inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
      } else {
        inqsQuery = null;
      }
    }

    const { data: inqRows } = inqsQuery ? await inqsQuery.limit(500) : { data: [] };
    if (inqRows) {
      for (const inq of inqRows) {
        const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
        if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
          if (inq.deals && inq.deals.length > 0) {
            deal = inq.deals[0];
          } else {
            const inqJson = inq.ai_extraction_json || {};
            deal = {
              id: inq.id,
              inquiry_id: inq.id,
              customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
              total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
              delivery_location: inqJson.delivery_location || inqJson.location || null,
              payment_terms: inqJson.payment_terms || null,
              po_number: rawPo || null,
              stage: inq.status || 'new_inquiry',
            };
          }
          break;
        }
      }
    }
  }

  // 2b. Unscoped fallback by explicit cleanInqId or rawPo if not found yet
  if (!deal && (cleanInqId || rawPo)) {
    const { data: allDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
      .order('created_at', { ascending: false })
      .limit(500);

    if (allDeals && allDeals.length > 0) {
      if (cleanInqId) {
        deal = allDeals.find(d => {
          const dId = (d.id || '').replace(/-/g, '').toUpperCase();
          const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
          return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
        }) || null;
      }
      if (!deal && rawPo) {
        deal = allDeals.find(d => {
          if (!d.po_number) return false;
          const dPo = String(d.po_number).trim();
          return dPo.toLowerCase() === rawPo.toLowerCase() || (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
        }) || null;
      }
    }

    if (!deal && cleanInqId) {
      const { data: allInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(500);

      if (allInqs) {
        for (const inq of allInqs) {
          const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
          if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
            if (inq.deals && inq.deals.length > 0) {
              deal = inq.deals[0];
            } else {
              const inqJson = inq.ai_extraction_json || {};
              deal = {
                id: inq.id,
                inquiry_id: inq.id,
                customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                delivery_location: inqJson.delivery_location || inqJson.location || null,
                payment_terms: inqJson.payment_terms || null,
                po_number: rawPo || null,
                stage: inq.status || 'new_inquiry',
              };
            }
            break;
          }
        }
      }
    }
  }

  if (!deal) {
    if (rawInqId || rawPo) {
      delete draft.inquiry_id;
      delete draft.po_number;
      const ref = rawInqId ? `Inquiry ID "${rawInqId}"` : `PO Number "${rawPo}"`;
      const reply = `❌ *Order / Inquiry Not Found*\n\n` +
        `Could not find an order or inquiry matching ${ref} in your records.\n\n` +
        `Please verify the Inquiry ID or PO Number and try again.`;
      return {
        handled: true,
        reply,
        status: 'ID_NOT_FOUND',
        draft,
      };
    }
    const reply = `ℹ️ *No Orders or Inquiries Found for ${rawCompany || 'Customer'}*\n\n` +
      `Could not find any active orders or inquiries for *${rawCompany || 'Customer'}*.\n\n` +
      `Please check the customer name or provide the Inquiry ID / PO Number.`;
    return {
      handled: true,
      reply,
      status: 'NOT_FOUND',
      draft,
    };
  }

  // Bind matched deal
  draft.inquiry_id = deal.inquiry_id || deal.id;
  draft.company_name = deal.customer_name || draft.company_name;
  if (deal.po_number && !draft.po_number && !draft.updates?.po_number) {
    draft.po_number = deal.po_number;
  }

  const ordUpdates = draft.updates || {};
  const hasUpdates = Object.values(ordUpdates).some(v => v !== null && v !== undefined && v !== '') ||
                     Boolean(draft.po_date || draft.delivery_date || draft.delivery_location || draft.payment_terms || draft.status) ||
                     (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0);

  if (!hasUpdates) {
    const displayInq = deal.inquiry_id ? `INQ-${deal.inquiry_id.replace(/-/g, '').slice(0, 6).toUpperCase()}` : `INQ-${deal.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    let prompt = '';
    if (draft._permissionNotice) {
      prompt += `${draft._permissionNotice}\n\n`;
    }
    prompt += `✏️ *Order / Inquiry Found for ${deal.customer_name}:*\n\n` +
      `• *Inquiry ID:* ${displayInq}\n` +
      `• *PO Number:* ${deal.po_number || 'Not Attached Yet'}\n` +
      `• *Stage:* ${deal.stage || 'Won'}\n` +
      `• *Total Value:* ₹${Number(deal.total_amount || 0).toLocaleString('en-IN')}\n` +
      `• *Payment Terms:* ${deal.payment_terms || 'Not specified'}\n` +
      `• *Delivery Location:* ${deal.delivery_location || 'Not specified'}\n\n` +
      `What would you like to update?\n` +
      `_(e.g. "Attach PO-2026-8899", "Update delivery location to Bhosari", or "Change payment terms to 45 days credit")_`;

    return {
      handled: true,
      reply: prompt,
      status: 'ASK_DETAILS',
      draft,
    };
  }

  return {
    handled: false,
    status: 'READY',
    draft,
  };
}

// ── COMPLAINT LOOKUP & VALIDATION HELPER ──────────────────────────────────────

async function checkComplaintsForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_COMPLAINT') return { handled: false };

  const targetRef = (draft.linked_inquiry_or_po || draft.target_ref || draft.complaint_id || '').trim();
  const companyName = (draft.company_name || '').trim();

  if (!targetRef && !companyName) {
    return { handled: false };
  }

  const matchedCmp = await findAndMatchComplaint(draft, senderPhone);

  if (!matchedCmp) {
    const refDisplay = targetRef ? `"${targetRef}"` : (companyName ? `"${companyName}"` : 'the specified reference');
    delete draft.linked_inquiry_or_po;
    delete draft.complaint_id;
    const reply = `⚠️ *No Active Complaint Found for ${refDisplay}*\n\n` +
      `Could not find an active complaint matching ${refDisplay} in your records.\n\n` +
      `Please check the Customer Name, PO Number, or Inquiry ID and try again.`;
    return {
      handled: true,
      reply,
      status: 'NOT_FOUND',
      draft,
    };
  }

  draft.company_name = matchedCmp.customer_name;
  draft.complaint_id = matchedCmp.id;
  if (matchedCmp.po_number && !draft.linked_inquiry_or_po) {
    draft.linked_inquiry_or_po = matchedCmp.po_number;
  }

  const cmpUpdates = draft.updates || {};
  const hasUpdates = Object.values(cmpUpdates).some(v => v !== null && v !== undefined && v !== '');

  if (!hasUpdates) {
    const prompt = `✏️ *Active Complaint Found for ${matchedCmp.customer_name}:*\n\n` +
      (matchedCmp.po_number ? `• *Linked Order / Ref:* PO: ${matchedCmp.po_number}\n` : '') +
      `• *Complaint Type:* ${matchedCmp.complaint_type || 'Quality Defect'}\n` +
      `• *Status:* ${matchedCmp.status || 'Open'}\n` +
      `• *Description:* ${matchedCmp.description || 'N/A'}\n\n` +
      `What details would you like to update?\n` +
      `_(e.g. "Mark as Resolved", "Update type to Specification Mismatch", "Add resolution notes: Replaced 2 MT coils")_`;

    return {
      handled: true,
      reply: prompt,
      status: 'ASK_DETAILS',
      draft,
    };
  }

  return {
    handled: false,
    status: 'READY',
    draft,
  };
}

// ── BUILD CONFIRMATION SUMMARY ───────────────────────────────────────────────

function buildConfirmationSummary(action, draft) {
  const indexTag = draft._totalCount && draft._totalCount > 1 ? ` (${draft._currentIndex || 1} of ${draft._totalCount}: ${draft.company_name || 'Item'})` : '';
  let summary = '';
  if (draft._permissionNotice) {
    summary += `${draft._permissionNotice}\n\n`;
  }
  summary += `✅ *Here's what I've captured${indexTag}:*\n\n`;

  switch (action) {
    case 'LOG_INQUIRY': {
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
        if (draft.line_items.length === 1) {
          const it = draft.line_items[0];
          const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
          const qtyStr = it.quantity ? ` — ${it.quantity} ${it.unit || 'MT'}` : '';
          const rateVal = it.rate || (draft.rate ? Number(String(draft.rate).replace(/[^\d.]/g, '')) : null);
          const rateStr = rateVal ? ` @ ₹${Number(rateVal).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
          const amtStr = it.amount ? ` (₹${Number(it.amount).toLocaleString('en-IN')})` : '';
          summary += `• *Product:* ${it.sku_text || it.description}${specStr}${qtyStr}${rateStr}${amtStr}\n`;
        } else {
          summary += `• *Products:*\n`;
          draft.line_items.forEach((it) => {
            const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
            const qtyStr = it.quantity ? ` — ${it.quantity} ${it.unit || 'MT'}` : '';
            const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
            const amtStr = it.amount ? ` (₹${Number(it.amount).toLocaleString('en-IN')})` : '';
            summary += `  • ${it.sku_text || it.description}${specStr}${qtyStr}${rateStr}${amtStr}\n`;
          });
        }
      } else {
        const rateStr = draft.rate ? ` @ ₹${Number(String(draft.rate).replace(/[^\d.]/g, '')).toLocaleString('en-IN')}/MT` : '';
        summary += `• *Product:* ${draft.product_description || '-'}${rateStr}\n`;
      }
      summary += `• *Preferred Make:* ${draft.preferred_make || '-'}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms || '-'}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location || '-'}\n`;
      summary += `• *Additional Notes:* ${draft.additional_notes || '-'}\n`;
      if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
        const totalAmt = draft.line_items.reduce((sum, it) => sum + (Number(it.amount) || ((Number(it.quantity) || 0) * (Number(it.rate) || 0)) || 0), 0);
        if (totalAmt > 0) {
          const gstAmt = Math.round(totalAmt * 0.18);
          const grandTot = totalAmt + gstAmt;
          summary += `• *Quotation Total:* ₹${Number(totalAmt).toLocaleString('en-IN')} + 18% GST (₹${Number(gstAmt).toLocaleString('en-IN')}) = *₹${Number(grandTot).toLocaleString('en-IN')}*\n`;
        }
      }
      break;
    }

    case 'UPDATE_INQUIRY': {
      const displayId = draft._inquiry_display_id || (draft.inquiry_id ? (draft.inquiry_id.startsWith('INQ-') ? draft.inquiry_id : `INQ-${draft.inquiry_id.slice(0, 6).toUpperCase()}`) : 'Inquiry');
      summary += `• *Inquiry ID:* ${displayId}\n`;
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      const hasHeaderUpdates = draft.updates && Object.values(draft.updates).some(v => v !== null && v !== undefined && v !== '');
      if (hasHeaderUpdates) {
        summary += `• *Updating Fields:*\n`;
        for (const [k, v] of Object.entries(draft.updates || {})) {
          if (v) {
            const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const valStr = k.toLowerCase().includes('rate') ? `₹${Number(String(v).replace(/[^\d.]/g, '')).toLocaleString('en-IN')} / MT` : v;
            summary += `  • *${label}* → ${valStr}\n`;
          }
        }
      }
      if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
        summary += `• *Updating Products / Rates:*\n`;
        draft.line_item_updates.forEach((it, i) => {
          const name = it.sku_text || it.description || `Item ${i + 1}`;
          const parts = [];
          if (it.quantity) parts.push(`Qty: ${it.quantity} ${it.unit || 'MT'}`);
          if (it.rate) parts.push(`Rate: ₹${Number(String(it.rate).replace(/[^\d.]/g, '')).toLocaleString('en-IN')}/${it.unit || 'MT'}`);
          summary += `  • *${name}* → ${parts.join(' | ')}\n`;
        });
      }
      break;
    }

    case 'LOG_ORDER': {
      if (draft.inquiry_id) {
        const cleanDisplayInq = draft.inquiry_id.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        summary += `• *Inquiry ID:* INQ-${cleanDisplayInq}\n`;
      }
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *PO Number:* ${draft.po_number || '-'}\n`;
      summary += `• *PO Date:* ${draft.po_date || '-'}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location || '-'}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms || '-'}\n`;
      let subtotal = 0;
      let totalTonnage = 0;
      let primaryUnit = 'MT';
      if (Array.isArray(draft.line_items) && draft.line_items.length === 1) {
        const it = draft.line_items[0];
        const qty = Number(it.quantity) || 0;
        const rate = Number(it.rate) || 0;
        const amount = Number(it.amount) || qty * rate;
        subtotal += amount;
        totalTonnage += qty;
        primaryUnit = it.unit || 'MT';
        const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
        const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
        summary += `• *Product:* ${it.sku_text || it.description}${specStr}${hsnStr} — ${qty} ${it.unit || 'MT'} @ ₹${rate.toLocaleString('en-IN')}/${it.unit || 'MT'}\n`;
      } else if (Array.isArray(draft.line_items) && draft.line_items.length > 1) {
        summary += `• *Line Items:*\n`;
        (draft.line_items || []).forEach((it) => {
          const qty = Number(it.quantity) || 0;
          const rate = Number(it.rate) || 0;
          const amount = Number(it.amount) || qty * rate;
          subtotal += amount;
          totalTonnage += qty;
          primaryUnit = it.unit || 'MT';
          const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
          const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
          summary += `  • ${it.sku_text || it.description}${specStr}${hsnStr} — ${qty} ${it.unit || 'MT'} @ ₹${rate.toLocaleString('en-IN')}/${it.unit || 'MT'} (₹${amount.toLocaleString('en-IN')})\n`;
        });
      }
      if (totalTonnage > 0) {
        summary += `• *Total Tonnage:* ${totalTonnage.toLocaleString('en-IN')} ${primaryUnit}\n`;
      }
      const breakdown = calculateQuotationBreakdown(subtotal);
      summary += `• *Sub Total:* ₹${breakdown.formattedSubtotal}\n`;
      summary += `• *GST (18%):* ₹${breakdown.formattedGST}\n`;
      summary += `• *Total Order Value:* ${breakdown.formattedGrandTotal}\n`;
      break;
    }

    case 'UPDATE_ORDER': {
      if (draft.inquiry_id) {
        const cleanDisplayInq = draft.inquiry_id.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        summary += `• *Inquiry ID:* INQ-${cleanDisplayInq}\n`;
      }
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      const poToDisplay = draft.updates?.po_number || draft.po_number;
      if (poToDisplay) {
        summary += `• *PO Number:* ${poToDisplay}\n`;
      }
      if (draft.updates && Object.keys(draft.updates).length > 0) {
        const headerEntries = Object.entries(draft.updates).filter(([k, v]) => v && k !== 'po_number');
        if (headerEntries.length > 0) {
          summary += `• *Header Updates:*\n`;
          for (const [k, v] of headerEntries) {
            const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            summary += `  • *${label}* → ${v}\n`;
          }
        }
      }
      if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
        summary += `• *Line Item Updates:*\n`;
        draft.line_item_updates.forEach((liu) => {
          summary += `  • [${(liu.operation || 'update').toUpperCase()}] ${liu.item_reference || liu.description || 'Line Item'}: Qty ${liu.quantity || '-'}, Rate ₹${liu.rate || '-'}\n`;
        });
      }
      break;
    }

    case 'LOG_VISIT': {
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *Person Met:* ${draft.person_met || '-'}\n`;
      summary += `• *Contact Phone:* ${draft.contact_phone || '-'}\n`;
      summary += `• *City / Location:* ${draft.city_location || '-'}\n`;
      summary += `• *Visit Date:* ${draft.visit_date || '-'}\n`;
      summary += `• *Visit Outcome:* ${draft.visit_outcome || '-'}\n`;
      summary += `• *Follow-up Action:* ${draft.followup_action || '-'}\n`;
      summary += `• *Meeting Remarks:* ${draft.meeting_remarks || '-'}\n`;
      break;
    }

    case 'UPDATE_VISIT': {
      const targetVis = draft.visit_id ? `${draft.company_name ? `${draft.company_name} ` : ''}(#${draft.visit_id.slice(0, 8)})` : `${draft.company_name}${draft.visit_date ? ` (Visit Date: ${draft.visit_date})` : ''}`;
      summary += `• *Customer / Company:* ${targetVis}\n`;
      summary += `• *Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `  • *${label}* → ${v}\n`;
        }
      }
      break;
    }

    case 'LOG_NEW_CUSTOMER': {
      summary += `• *Company Name:* ${draft.company_name || '-'}\n`;
      summary += `• *Contact Person:* ${draft.contact_person || '-'}\n`;
      const phoneVal = draft.mobile_number || draft.phone || draft.contact_phone || '-';
      summary += `• *Mobile Number:* ${phoneVal}\n`;
      const locVal = draft.delivery_location || draft.city_location || draft.address || '-';
      summary += `• *Delivery Location:* ${locVal}\n`;
      summary += `• *Email:* ${draft.email || '-'}\n`;
      const gstVal = draft.gst_number || draft.gst || '-';
      summary += `• *GST Number:* ${gstVal}\n`;
      break;
    }

    case 'LOG_COMPLAINT': {
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *Linked Order / Ref:* ${draft.linked_inquiry_or_po || '-'}\n`;
      summary += `• *Product / Material:* ${draft.affected_product || draft.product_name || '-'}\n`;
      summary += `• *Complaint Type:* ${draft.complaint_type || 'Quality Defect'}\n`;
      summary += `• *Description:* ${draft.complaint_description || draft.affected_product || '-'}\n`;
      summary += `• *Corrective Action:* ${draft.corrective_action || '-'}\n`;
      summary += `• *Status:* Open (48-Hour SLA Clock Started)\n`;
      break;
    }

    case 'UPDATE_COMPLAINT': {
      const targetCmp = draft.linked_inquiry_or_po || draft.complaint_id || 'Active Complaint';
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      if (draft.linked_inquiry_or_po) {
        summary += `• *Linked Order / Ref:* ${targetCmp}\n`;
      }
      summary += `• *Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `  • *${label}* → ${v}\n`;
        }
      }
      break;
    }
  }

  return summary;
}

// ── COMPLAINT RESOLUTION HELPERS ─────────────────────────────────────────────

function normalizeComplaintType(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return 'Quality Defect';
  const t = typeStr.trim().toLowerCase();
  if (t.includes('spec') || t.includes('mismatch')) return 'Specification Mismatch';
  if (t.includes('damage') || t.includes('physical') || t.includes('broken') || t.includes('crack') || t.includes('bend')) return 'Physical Damage';
  if (t.includes('short') || t.includes('qty') || t.includes('quantity') || t.includes('kam')) return 'Quantity Shortage';
  if (t.includes('delay') || t.includes('late') || t.includes('delivery')) return 'Delivery Delay';
  if (t.includes('bill') || t.includes('invoice') || t.includes('price') || t.includes('rate') || t.includes('amount')) return 'Billing Mismatch';
  if (t.includes('quality') || t.includes('rust') || t.includes('defect') || t.includes('reject')) return 'Quality Defect';
  if (t.includes('other')) return 'Other';
  return typeStr.trim().replace(/\b\w/g, l => l.toUpperCase());
}

function extractProductFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const str = text.trim();

  // Pattern 1: e.g. "12 MT MS angle", "15 MT CR Sheet 1.20mm", "10 MT HR Coil", "60 MT MS plates"
  const m1 = str.match(/(?:(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?|bundle|bundles))\s+)?\b(MS\s+Plates?|MS\s+Sheets?|HR\s+Coils?|HR\s+Sheets?|CR\s+Coils?|CR\s+Sheets?|TMT\s+Bars?|GI\s+Sheets?|GI\s+Coils?|GP\s+Sheets?|GP\s+Coils?|Chequered\s+Plates?|MS\s+Pipes?|Seamless\s+Pipes?|ERW\s+Pipes?|MS\s+Angles?|MS\s+Channels?|MS\s+Beams?|MS\s+Flats?|MS\s+Rounds?|Square\s+Bars?|Beams?|Channels?|Angles?|Flats?|Rounds?|Alloy\s+Steel|Stainless\s+Steel|IS\s+2062(?:\s+E250)?)\b(?:\s+([0-9.]+\s*mm(?:(?:\s*x\s*[0-9.]+\s*mm)+)?))?(?:\s+(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?)))?/i);
  if (m1) {
    const qty = (m1[1] || m1[4] || '').trim();
    const prod = m1[2].trim();
    const dims = (m1[3] || '').trim();
    let res = prod;
    if (dims) res += ` ${dims}`;
    if (qty) res += ` (${qty})`;
    return res;
  }

  // Pattern 2: e.g. "MS Plate", "HR Coil", "CR Sheet", "MS Angle", "Chequered Plate"
  const m2 = str.match(/\b(MS\s+Plate|MS\s+Plates|MS\s+Sheet|MS\s+Sheets|HR\s+Coil|HR\s+Coils|HR\s+Sheet|HR\s+Sheets|CR\s+Coil|CR\s+Coils|CR\s+Sheet|CR\s+Sheets|TMT\s+Bar|TMT\s+Bars|GI\s+Sheet|GI\s+Sheets|GI\s+Coil|GI\s+Coils|Chequered\s+Plate|Chequered\s+Plates|MS\s+Pipe|MS\s+Pipes|MS\s+Angle|MS\s+Angles|MS\s+Channel|MS\s+Channels|MS\s+Beam|MS\s+Beams)\b/i);
  if (m2) {
    return m2[1];
  }

  return null;
}

async function findAndMatchComplaint(draft, senderPhone) {
  const targetRef = (draft.linked_inquiry_or_po || draft.target_ref || draft.complaint_id || '').trim();
  const companyName = (draft.company_name || '').trim();

  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let complaintsQuery = supabase
    .from('complaints')
    .select('*')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    complaintsQuery = complaintsQuery.in('reported_by', targetPhones);
  }

  const { data: allComplaints } = await complaintsQuery.limit(100);

  if (!allComplaints || allComplaints.length === 0) return null;

  // 1. Direct match by targetRef (PO Number, Inquiry ID / Deal ID, or Complaint UUID)
  if (targetRef) {
    const cleanRef = targetRef.replace(/^#?(?:INQ|DEAL|PO)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    // Direct check on complaints table
    const directMatch = allComplaints.find(c => {
      const cId = (c.id || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const po = (c.po_number || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const dealId = (c.deal_id || '').replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const cust = (c.customer_name || '').toLowerCase();

      return (
        (cleanRef.length >= 4 && cId.startsWith(cleanRef)) ||
        (cleanRef.length >= 2 && po.includes(cleanRef)) ||
        (cleanRef.length >= 2 && dealId.includes(cleanRef)) ||
        (cleanRef.length >= 3 && cust.includes(cleanRef))
      );
    });

    if (directMatch) return directMatch;

    // Lookup deals table if cleanRef matches a deal ID or PO
    try {
      let dealsQuery = supabase
        .from('deals')
        .select('id, po_number, customer_name, salesperson_phone');

      if (!scope.isAdmin && targetPhones.length > 0) {
        dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
      }

      const { data: deals } = await dealsQuery.limit(100);

      const matchedDeal = deals?.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toLowerCase();
        const dPo = (d.po_number || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        return (cleanRef.length >= 3 && dId.startsWith(cleanRef)) || (cleanRef.length >= 3 && dPo.includes(cleanRef));
      });

      if (matchedDeal) {
        const dealMatch = allComplaints.find(c =>
          (c.deal_id && (c.deal_id === matchedDeal.id || c.deal_id.toLowerCase().includes(matchedDeal.id.toLowerCase()))) ||
          (c.po_number && matchedDeal.po_number && c.po_number.toLowerCase().includes(matchedDeal.po_number.toLowerCase())) ||
          (c.customer_name && matchedDeal.customer_name && c.customer_name.toLowerCase().includes(matchedDeal.customer_name.toLowerCase()))
        );
        if (dealMatch) return dealMatch;
      }
    } catch (e) {
      console.warn('[CatalogFlow] Error in deal lookup for complaint:', e.message);
    }
  }

  // 2. Match by companyName
  if (companyName) {
    const cleanCust = companyName.toLowerCase();
    const custMatches = allComplaints.filter(c =>
      (c.customer_name || '').toLowerCase().includes(cleanCust) ||
      cleanCust.includes((c.customer_name || '').toLowerCase())
    );

    if (custMatches.length > 0) {
      const openMatch = custMatches.find(c =>
        ['open', 'pending', 'reported', 'in progress', 'reopened'].includes((c.status || '').toLowerCase())
      );
      return openMatch || custMatches[0];
    }
  }

  return null;
}

// ── EXECUTE ACTION HANDLERS ──────────────────────────────────────────────────

async function executeAction(action, draft, senderPhone) {
  try {
    switch (action) {
      case 'LOG_INQUIRY': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          city: draft.delivery_location || null,
        });

        let totalAmount = 0;
        const globalRate = Number(String(draft.rate || 0).replace(/[^\d.]/g, '')) || 0;

        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const hCode = it.hsn_code || it.hsn_sac || detectHsnCode(sText, sDim) || detectHsnCode(it.description || '') || '72083840';
              const itRate = Number(it.rate) || globalRate || 0;
              const itQty = Number(it.quantity) || 0;
              const itAmt = it.amount ? Number(it.amount) : (itQty && itRate ? itQty * itRate : 0);
              totalAmount += itAmt;
              return {
                sku_text: sText,
                description: it.description || sText,
                dimensions: sDim,
                spec: sDim,
                hsn_code: hCode,
                hsn_sac: hCode,
                quantity: itQty,
                unit: it.unit || 'MT',
                rate: itRate || null,
                amount: itAmt || null,
              };
            })
          : [
              {
                sku_text: draft.product_description || 'Hot Rolled',
                description: draft.product_description || 'Hot Rolled',
                dimensions: '',
                spec: '',
                hsn_code: detectHsnCode(draft.product_description || '') || '72083840',
                hsn_sac: detectHsnCode(draft.product_description || '') || '72083840',
                quantity: 0,
                unit: 'MT',
                rate: globalRate || null,
                amount: null,
              }
            ];

        const structuredAiJson = {
          customer: {
            name: companyName,
            phone: null,
            address: draft.delivery_location || null,
            match_status: 'matched',
          },
          customer_name: companyName,
          companyName: companyName,
          delivery_location: draft.delivery_location || null,
          delivery_address: draft.delivery_location || null,
          payment_terms: draft.payment_terms || null,
          preferred_make: draft.preferred_make || null,
          additional_notes: draft.additional_notes || null,
          rate: globalRate || (structuredLineItems[0]?.rate ?? null),
          unitPrice: globalRate || (structuredLineItems[0]?.rate ?? null),
          total_amount: totalAmount || null,
          totalAmount: totalAmount || null,
          product_requirement: draft.product_description || (structuredLineItems[0] ? structuredLineItems[0].sku_text : null),
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          inquiry_type: 'inquiry',
          overall_confidence: 0.95,
        };

        let humanRawText = `Customer: ${companyName}\n`;
        if (structuredLineItems.length > 0 && structuredLineItems[0].quantity > 0) {
          humanRawText += `Products:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} - ${it.quantity} ${it.unit}${it.rate ? ` @ ₹${it.rate}/${it.unit}` : ''}`).join('\n') + `\n`;
        } else if (draft.product_description) {
          humanRawText += `Product: ${draft.product_description}\n`;
          if (globalRate) humanRawText += `Rate: ₹${globalRate}/MT\n`;
        }
        if (draft.preferred_make) humanRawText += `Preferred Make: ${draft.preferred_make}\n`;
        if (draft.payment_terms) humanRawText += `Payment Terms: ${draft.payment_terms}\n`;
        if (draft.delivery_location) humanRawText += `Delivery Location: ${draft.delivery_location}\n`;
        if (draft.additional_notes) humanRawText += `Notes: ${draft.additional_notes}\n`;

        // 1. Insert into inquiries (primary canonical table with pipeline fields)
        const { data: inqRow, error: inqErr } = await supabase
          .from('inquiries')
          .insert({
            source_channel: 'WhatsApp',
            sender_name: companyName,
            customer_name: companyName,
            raw_text: humanRawText.trim(),
            sender_phone: senderPhone,
            salesperson_phone: senderPhone,
            status: 'new_inquiry',
            stage: 'new_inquiry',
            delivery_location: draft.delivery_location || null,
            payment_terms: draft.payment_terms || null,
            total_amount: totalAmount || null,
            ai_extraction_json: structuredAiJson,
            overall_confidence: 0.95,
            inquiry_type: 'inquiry',
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (inqErr) console.error('[CatalogFlow] Inquiry insert error:', inqErr);

        const targetRecordId = inqRow?.id;
        const hexCode = targetRecordId ? targetRecordId.replace(/-/g, '').slice(0, 6).toUpperCase() : Math.random().toString(16).substring(2, 8).toUpperCase();
        const inquiryCode = `INQ-${hexCode}`;

        if (inqRow) {
          structuredAiJson.inquiry_code = inquiryCode;
          structuredAiJson.display_id = inquiryCode;
          await supabase.from('inquiries').update({ ai_extraction_json: structuredAiJson }).eq('id', inqRow.id);
        }

        // 2. Insert line items into inquiry_items (canonical items table)
        if (inqRow && structuredLineItems.length > 0) {
          const inqItemsPayload = structuredLineItems.map(it => ({
            inquiry_id: inqRow.id,
            sku_text: it.sku_text || it.description,
            dimensions: it.dimensions || it.spec || null,
            grade: it.grade || null,
            quantity: Number(it.quantity) || null,
            unit: it.unit || 'MT',
            rate: Number(it.rate) || null,
            amount: Number(it.amount) || null,
            confidence: 0.95,
            created_at: new Date().toISOString(),
          }));
          await supabase.from('inquiry_items').insert(inqItemsPayload);
        }

        // 3. Mirror into deals & deal_items (with id = inqRow.id, inquiry_id = inqRow.id for 100% backward-compatibility)
        if (inqRow) {
          const { data: dealRow, error: dealErr } = await supabase
            .from('deals')
            .insert({
              id: inqRow.id,
              inquiry_id: inqRow.id,
              stage: 'new_inquiry',
              customer_name: companyName,
              customer_address: draft.delivery_location || null,
              delivery_location: draft.delivery_location || null,
              payment_terms: draft.payment_terms || null,
              total_amount: totalAmount || null,
              inquiry_type: 'inquiry',
              status: 'auto_created',
              salesperson_phone: senderPhone,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (dealErr) console.error('[CatalogFlow] Deal mirror insert error:', dealErr);

          if (structuredLineItems.length > 0) {
            const itemsPayload = structuredLineItems.map(it => ({
              deal_id: inqRow.id,
              sku_text: it.sku_text || it.description,
              dimensions: it.dimensions || it.spec || null,
              grade: it.grade || null,
              quantity: Number(it.quantity) || null,
              unit: it.unit || 'MT',
              rate: Number(it.rate) || null,
              amount: Number(it.amount) || null,
              confidence: 0.95,
              created_at: new Date().toISOString(),
            }));
            await supabase.from('deal_items').insert(itemsPayload);
          }
        }

        // 4. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'new_inquiry',
          customer_name: companyName,
          description: `Logged New Inquiry ${inquiryCode} for ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 5. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New inquiry ${inquiryCode} logged for ${companyName}${totalAmount ? ` (₹${Number(totalAmount).toLocaleString('en-IN')})` : ''}`,
            module: 'Inquiries',
            customer_name: companyName,
            entity_id: inqRow?.id || targetRecordId,
            entity_type: 'inquiry',
            action_type: 'inquiry_created',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_INQUIRY:', actErr?.message);
        }

        let productSummaryLines = '';
        if (structuredLineItems.length > 0) {
          if (structuredLineItems.length === 1) {
            const it = structuredLineItems[0];
            const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
            const qtyStr = it.quantity ? ` — ${it.quantity} ${it.unit || 'MT'}` : '';
            const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
            const amtStr = it.amount ? ` (₹${Number(it.amount).toLocaleString('en-IN')})` : '';
            productSummaryLines = `• *Product:* ${it.sku_text || it.description}${specStr}${qtyStr}${rateStr}${amtStr}\n`;
          } else {
            productSummaryLines = `• *Products:*\n`;
            structuredLineItems.forEach((it) => {
              const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
              const qtyStr = it.quantity ? ` — ${it.quantity} ${it.unit || 'MT'}` : '';
              const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
              const amtStr = it.amount ? ` (₹${Number(it.amount).toLocaleString('en-IN')})` : '';
              productSummaryLines += `  • ${it.sku_text || it.description}${specStr}${qtyStr}${rateStr}${amtStr}\n`;
            });
          }
        } else {
          const rateStr = globalRate ? ` @ ₹${Number(globalRate).toLocaleString('en-IN')}/MT` : '';
          productSummaryLines = `• *Product:* ${draft.product_description || 'Steel Material'}${rateStr}\n`;
        }

        let quoteTotalLines = '';
        if (totalAmount > 0) {
          const gstAmt = Math.round(totalAmount * 0.18);
          const grandTot = totalAmount + gstAmt;
          quoteTotalLines = `• *Quotation Total:* ₹${Number(totalAmount).toLocaleString('en-IN')} + 18% GST (₹${Number(gstAmt).toLocaleString('en-IN')}) = *₹${Number(grandTot).toLocaleString('en-IN')}*\n`;
        }

        return `🎉 *Inquiry Successfully Created!*\n\n` +
          `• *Inquiry ID:* ${inquiryCode}\n` +
          `• *Customer / Company:* ${companyName}\n` +
          productSummaryLines +
          (draft.preferred_make ? `• *Preferred Make:* ${draft.preferred_make}\n` : '') +
          (draft.payment_terms ? `• *Payment Terms:* ${draft.payment_terms}\n` : '') +
          (draft.delivery_location ? `• *Delivery Location:* ${draft.delivery_location}\n` : '') +
          (draft.additional_notes ? `• *Additional Notes:* ${draft.additional_notes}\n` : '') +
          quoteTotalLines +
          `\nLogged to Sales Pipeline & Inquiries! ✅`;
      }

      case 'UPDATE_INQUIRY': {
        const rawId = (draft.inquiry_id || '').trim();
        const cleanId = rawId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').trim().toUpperCase();
        const companyName = (draft.company_name || '').trim();

        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        let deal = null;
        if (rawId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
          let dByIdQuery = supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .or(`id.eq.${rawId},inquiry_id.eq.${rawId}`);
          if (!scope.isAdmin && targetPhones.length > 0) {
            dByIdQuery = dByIdQuery.in('salesperson_phone', targetPhones);
          }
          const { data: dById } = await dByIdQuery.limit(1);
          if (dById && dById.length > 0) {
            deal = dById[0];
          }
        }

        if (!deal) {
          let dealsQuery = supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
          }
          if (companyName) {
            const cleanWord = cleanLegalSuffixes(companyName).split(' ').filter(w => w.length >= 2)[0] || companyName;
            dealsQuery = dealsQuery.ilike('customer_name', `%${cleanWord}%`);
          }
          const { data: deals } = await dealsQuery.limit(500);

          if (deals && deals.length > 0) {
            if (cleanId) {
              deal = deals.find(d => {
                const dId = (d.id || '').replace(/-/g, '').toUpperCase();
                const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
                return dId.startsWith(cleanId) || inqId.startsWith(cleanId) || (cleanId.length >= 4 && (dId.includes(cleanId) || inqId.includes(cleanId)));
              }) || null;
            }
            if (!deal && companyName) {
              deal = deals.find(d => isCustomerMatch(companyName, null, d.customer_name, null) && !['won', 'lost', 'closed', 'completed', 'cancelled'].includes((d.stage || '').toLowerCase())) ||
                     deals.find(d => isCustomerMatch(companyName, null, d.customer_name, null)) || null;
            }
          }
        }

        // Check inquiries table if not found in deals yet
        if (!deal && cleanId) {
          let inqQuery = supabase
            .from('inquiries')
            .select('id, sender_name, salesperson_phone, status, raw_text, ai_extraction_json, deals(*)')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            inqQuery = inqQuery.in('salesperson_phone', targetPhones);
          }
          const { data: inqRows } = await inqQuery.limit(500);
          if (inqRows) {
            for (const inq of inqRows) {
              const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
              if (inqCode.startsWith(cleanId) || inqCode.includes(cleanId)) {
                if (inq.deals && inq.deals.length > 0) {
                  deal = inq.deals[0];
                } else {
                  const inqJson = inq.ai_extraction_json || {};
                  const { data: newDealRows } = await supabase
                    .from('deals')
                    .insert({
                      inquiry_id: inq.id,
                      customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || companyName || 'Customer',
                      salesperson_phone: inq.salesperson_phone || senderPhone,
                      stage: 'new_inquiry',
                      total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0) || null,
                      delivery_location: inqJson.delivery_location || inqJson.location || null,
                      customer_address: inqJson.delivery_location || inqJson.location || null,
                      payment_terms: inqJson.payment_terms || null,
                      status: 'active',
                    })
                    .select();
                  if (newDealRows && newDealRows.length > 0) {
                    deal = newDealRows[0];
                  }
                }
                break;
              }
            }
          }
        }

        // Unscoped fallback by cleanId if still not found
        if (!deal && cleanId) {
          const { data: allDeals } = await supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .order('created_at', { ascending: false })
            .limit(500);

          if (allDeals && allDeals.length > 0) {
            deal = allDeals.find(d => {
              const dId = (d.id || '').replace(/-/g, '').toUpperCase();
              const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
              return dId.startsWith(cleanId) || inqId.startsWith(cleanId) || (cleanId.length >= 4 && (dId.includes(cleanId) || inqId.includes(cleanId)));
            }) || null;
          }

          if (!deal) {
            const { data: allInqRows } = await supabase
              .from('inquiries')
              .select('id, sender_name, salesperson_phone, status, raw_text, ai_extraction_json, deals(*)')
              .order('created_at', { ascending: false })
              .limit(500);

            if (allInqRows) {
              for (const inq of allInqRows) {
                const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
                if (inqCode.startsWith(cleanId) || inqCode.includes(cleanId)) {
                  if (inq.deals && inq.deals.length > 0) {
                    deal = inq.deals[0];
                  } else {
                    const inqJson = inq.ai_extraction_json || {};
                    const { data: newDealRows } = await supabase
                      .from('deals')
                      .insert({
                        inquiry_id: inq.id,
                        customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || companyName || 'Customer',
                        salesperson_phone: inq.salesperson_phone || senderPhone,
                        stage: 'new_inquiry',
                        total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0) || null,
                        delivery_location: inqJson.delivery_location || inqJson.location || null,
                        customer_address: inqJson.delivery_location || inqJson.location || null,
                        payment_terms: inqJson.payment_terms || null,
                        status: 'active',
                      })
                      .select();
                    if (newDealRows && newDealRows.length > 0) {
                      deal = newDealRows[0];
                    }
                  }
                  break;
                }
              }
            }
          }
        }

        if (!deal) {
          const missingIdentifier = draft.inquiry_id ? `Inquiry ID "${draft.inquiry_id}"` : (companyName ? `Customer "${companyName}"` : 'the specified inquiry');
          return `❌ Could not find an existing inquiry matching ${missingIdentifier} in your records.\n\nPlease verify the Inquiry ID or Customer Name and try again.`;
        }

        const updates = draft.updates || {};
        const dealUpdates = {};

        if (updates.payment_terms) {
          dealUpdates.payment_terms = updates.payment_terms;
        }
        if (updates.delivery_location) {
          dealUpdates.delivery_location = updates.delivery_location;
          dealUpdates.customer_address = updates.delivery_location;
        }
        if (updates.status || updates.stage) {
          const s = String(updates.status || updates.stage).toLowerCase();
          if (s.includes('won') || s.includes('order')) dealUpdates.stage = 'won';
          else if (s.includes('lost')) dealUpdates.stage = 'lost';
          else if (s.includes('negot')) dealUpdates.stage = 'negotiation';
          else if (s.includes('hold')) dealUpdates.stage = 'on_hold';
          else if (s.includes('quote') || s.includes('price')) dealUpdates.stage = 'quoted';
          else dealUpdates.stage = updates.status || updates.stage;
        }

        let itemsUpdated = false;
        let totalAmount = 0;
        const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);

        // 1. Specific line item updates
        if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0 && dItems && dItems.length > 0) {
          for (let i = 0; i < dItems.length; i++) {
            const currentItem = dItems[i];
            const curSku = (currentItem.sku_text || currentItem.description || '').toLowerCase();

            const matchedUpd = draft.line_item_updates.find((upd, uIdx) => {
              const updSku = (upd.sku_text || upd.description || '').toLowerCase();
              if (!updSku) return uIdx === i;
              const cleanCur = curSku.replace(/[^a-z0-9]/g, '');
              const cleanUpd = updSku.replace(/[^a-z0-9]/g, '');
              return cleanCur.includes(cleanUpd) || cleanUpd.includes(cleanCur) || uIdx === i;
            });

            let itRate = Number(currentItem.rate) || 0;
            let itQty = Number(currentItem.quantity) || 0;

            if (matchedUpd) {
              if (matchedUpd.rate !== null && matchedUpd.rate !== undefined && matchedUpd.rate !== '') {
                itRate = Number(String(matchedUpd.rate).replace(/[^\d.]/g, '')) || itRate;
              }
              if (matchedUpd.quantity !== null && matchedUpd.quantity !== undefined && matchedUpd.quantity !== '') {
                itQty = Number(String(matchedUpd.quantity).replace(/[^\d.]/g, '')) || itQty;
              }
            } else if (updates.rate) {
              const globalRate = Number(String(updates.rate).replace(/[^\d.]/g, '')) || 0;
              if (globalRate > 0) itRate = globalRate;
            }

            const itAmt = itQty > 0 && itRate > 0 ? itQty * itRate : 0;
            totalAmount += itAmt;

            await supabase.from('deal_items').update({
              rate: itRate,
              quantity: itQty,
              amount: itAmt,
            }).eq('id', currentItem.id);
            itemsUpdated = true;
          }
        } else if (updates.rate && dItems && dItems.length > 0) {
          // 2. Global rate update across all items
          const newRate = Number(String(updates.rate).replace(/[^\d.]/g, '')) || 0;
          if (newRate > 0) {
            for (const it of dItems) {
              const itQty = Number(it.quantity) || 0;
              const itAmt = itQty > 0 ? itQty * newRate : 0;
              totalAmount += itAmt;
              await supabase.from('deal_items').update({ rate: newRate, amount: itAmt }).eq('id', it.id);
            }
            itemsUpdated = true;
          }
        }

        if (itemsUpdated && totalAmount > 0) {
          dealUpdates.total_amount = totalAmount;
        }

        if (Object.keys(dealUpdates).length > 0) {
          await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
        }

        // Synchronize inquiries table (ai_extraction_json AND raw_text)
        const targetInqId = deal.inquiry_id || deal.id;
        if (targetInqId) {
          const { data: inqRow } = await supabase.from('inquiries').select('id, raw_text, ai_extraction_json, status').eq('id', targetInqId).single();
          if (inqRow) {
            const aiJson = inqRow.ai_extraction_json || {};
            if (updates.payment_terms) {
              aiJson.payment_terms = updates.payment_terms;
              aiJson.paymentTerms = updates.payment_terms;
            }
            if (updates.delivery_location) {
              aiJson.delivery_location = updates.delivery_location;
              aiJson.deliveryLocation = updates.delivery_location;
              aiJson.delivery_address = updates.delivery_location;
              if (aiJson.customer) aiJson.customer.address = updates.delivery_location;
            }
            if (updates.preferred_make) aiJson.preferred_make = updates.preferred_make;
            if (updates.additional_notes) aiJson.additional_notes = updates.additional_notes;

            if (itemsUpdated) {
              const { data: refreshedItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
              if (refreshedItems && refreshedItems.length > 0) {
                aiJson.line_items = refreshedItems.map(it => ({
                  sku_text: it.sku_text,
                  description: it.sku_text,
                  dimensions: it.dimensions,
                  spec: it.dimensions,
                  hsn_code: it.hsn_code || detectHsnCode(it.sku_text, it.dimensions) || '72083840',
                  hsn_sac: it.hsn_code || detectHsnCode(it.sku_text, it.dimensions) || '72083840',
                  quantity: Number(it.quantity) || 0,
                  unit: it.unit || 'MT',
                  rate: Number(it.rate) || 0,
                  amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
                }));
                aiJson.lineItems = aiJson.line_items;
                aiJson.rate = refreshedItems[0]?.rate ?? aiJson.rate;
                aiJson.unitPrice = refreshedItems[0]?.rate ?? aiJson.unitPrice;
                aiJson.total_amount = totalAmount;
                aiJson.totalAmount = totalAmount;
              }
            }

            // Sync raw_text so frontend line-by-line fallback regex matches the updated values
            let updatedRawText = inqRow.raw_text || '';
            if (updates.delivery_location) {
              if (/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i, `Delivery Location: ${updates.delivery_location}`);
              } else {
                updatedRawText += `\nDelivery Location: ${updates.delivery_location}`;
              }
            }
            if (updates.payment_terms) {
              if (/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i, `Payment Terms: ${updates.payment_terms}`);
              } else {
                updatedRawText += `\nPayment Terms: ${updates.payment_terms}`;
              }
            }
            if (updates.rate) {
              if (/Rate\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/Rate\s*[:=-]\s*([^\n|]+)/i, `Rate: ₹${updates.rate}/MT`);
              }
            }

            const inqUpdatePayload = {
              ai_extraction_json: aiJson,
              raw_text: updatedRawText.trim(),
            };
            if (dealUpdates.stage) {
              inqUpdatePayload.stage = dealUpdates.stage;
              inqUpdatePayload.status = dealUpdates.stage === 'won' ? 'confirmed' : dealUpdates.stage;
            }
            if (dealUpdates.total_amount) inqUpdatePayload.total_amount = dealUpdates.total_amount;
            if (dealUpdates.delivery_location) inqUpdatePayload.delivery_location = dealUpdates.delivery_location;
            if (dealUpdates.payment_terms) inqUpdatePayload.payment_terms = dealUpdates.payment_terms;
            if (dealUpdates.po_number) inqUpdatePayload.po_number = dealUpdates.po_number;
            if (dealUpdates.po_date) inqUpdatePayload.po_date = dealUpdates.po_date;
            if (dealUpdates.won_at) inqUpdatePayload.won_at = dealUpdates.won_at;
            if (dealUpdates.lost_reason) inqUpdatePayload.lost_reason = dealUpdates.lost_reason;
            await supabase.from('inquiries').update(inqUpdatePayload).eq('id', targetInqId);

            if (itemsUpdated) {
              const { data: refreshedItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
              if (refreshedItems && refreshedItems.length > 0) {
                await supabase.from('inquiry_items').delete().eq('inquiry_id', targetInqId);
                const inqItems = refreshedItems.map(it => ({
                  inquiry_id: targetInqId,
                  sku_text: it.sku_text,
                  dimensions: it.dimensions,
                  grade: it.grade,
                  quantity: it.quantity,
                  unit: it.unit,
                  rate: it.rate,
                  amount: it.amount,
                  confidence: 0.95,
                  created_at: new Date().toISOString(),
                }));
                await supabase.from('inquiry_items').insert(inqItems);
              }
            }
          }
        }

        const canonicalTargetId = targetInqId || (deal ? (deal.inquiry_id || deal.id) : null);
        const displayInqId = draft._inquiry_display_id || (canonicalTargetId ? `INQ-${canonicalTargetId.replace(/-/g, '').slice(0, 6).toUpperCase()}` : (deal ? (deal.deal_number || `INQ-${deal.id.slice(0, 6).toUpperCase()}`) : (draft.inquiry_id || 'Inquiry')));
        const displayCustName = deal?.customer_name || draft.company_name || 'Customer';

        let fieldsSummary = '';
        if (updates.delivery_location) fieldsSummary += `• *Delivery Location:* ${updates.delivery_location}\n`;
        if (updates.payment_terms) fieldsSummary += `• *Payment Terms:* ${updates.payment_terms}\n`;
        if (updates.stage || updates.status) fieldsSummary += `• *Stage / Status:* ${dealUpdates.stage}\n`;
        if (itemsUpdated && totalAmount > 0) fieldsSummary += `• *Quotation Total:* ₹${totalAmount.toLocaleString('en-IN')}\n`;
        if (updates.preferred_make) fieldsSummary += `• *Preferred Make:* ${updates.preferred_make}\n`;
        if (updates.additional_notes) fieldsSummary += `• *Additional Notes:* ${updates.additional_notes}\n`;

        // Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Inquiry ${displayInqId} updated for ${displayCustName}${updates.stage ? ` (Stage: ${updates.stage})` : ''}`,
            module: 'Inquiries',
            customer_name: displayCustName,
            entity_id: canonicalTargetId,
            entity_type: 'inquiry',
            action_type: 'inquiry_updated',
            change_detail: dealUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_INQUIRY:', actErr?.message);
        }

        return `✅ *Inquiry Updated Successfully!*\n\n` +
          `• *Inquiry ID:* ${displayInqId}\n` +
          `• *Customer / Company:* ${displayCustName}\n` +
          (fieldsSummary ? `${fieldsSummary}` : '') +
          `\nUpdated details saved to Sales Pipeline & Inquiries! 📈`;
      }

      case 'LOG_ORDER': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          city: draft.delivery_location || null,
        });

        let subtotal = 0;
        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const qty = Number(it.quantity) || 0;
              const rate = Number(it.rate) || 0;
              const amt = Number(it.amount) || qty * rate;
              subtotal += amt;
              const hCode = it.hsn_code || it.hsn_sac || detectHsnCode(sText, sDim) || detectHsnCode(it.description || '') || '72083840';
              return {
                sku_text: sText,
                description: it.description || sText,
                dimensions: sDim,
                spec: sDim,
                hsn_code: hCode,
                hsn_sac: hCode,
                quantity: qty,
                unit: it.unit || 'MT',
                rate: rate,
                amount: amt,
              };
            })
          : [];

        const breakdown = calculateQuotationBreakdown(subtotal);
        const totalAmount = breakdown.grandTotal;

        const structuredAiJson = {
          customer: {
            name: companyName,
            phone: null,
            address: draft.delivery_location || null,
            match_status: 'matched',
          },
          customer_name: companyName,
          companyName: companyName,
          inquiry_id: draft.inquiry_id || null,
          po_number: draft.po_number,
          po_date: draft.po_date,
          delivery_location: draft.delivery_location || null,
          delivery_address: draft.delivery_location || null,
          payment_terms: draft.payment_terms || null,
          product_requirement: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          subtotal: breakdown.subtotal,
          cgst_amount: breakdown.CGST,
          sgst_amount: breakdown.SGST,
          total_amount: totalAmount,
          grand_total: totalAmount,
          inquiry_type: 'purchase_order',
          overall_confidence: 0.98,
        };

        let humanRawText = `Customer: ${companyName}\nPO Number: ${draft.po_number}\nPO Date: ${draft.po_date}\n`;
        if (draft.inquiry_id) humanRawText += `Linked Inquiry: ${draft.inquiry_id}\n`;
        if (structuredLineItems.length > 0) {
          humanRawText += `Line Items:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} ${it.dimensions ? `(${it.dimensions})` : ''} - ${it.quantity} ${it.unit} @ ₹${it.rate}/${it.unit}`).join('\n') + `\n`;
        }
        if (draft.payment_terms) humanRawText += `Payment Terms: ${draft.payment_terms}\n`;
        if (draft.delivery_location) humanRawText += `Delivery Location: ${draft.delivery_location}\n`;

        // 1. Resolve linked inquiry / deal ID if provided
        let targetInquiryId = null;
        let targetDealId = draft.deal_id || null;

        const rawRef = draft.inquiry_id || draft.deal_id || draft._inquiry_display_id || null;
        if (rawRef) {
          const cleanCode = String(rawRef).replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase();
          const { data: matchedInqRows } = await supabase.from('inquiries').select('id, salesperson_phone, sender_phone, sender_name').limit(500);
          const foundInq = (matchedInqRows || []).find(i => (i.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanCode));
          if (foundInq) {
            targetInquiryId = foundInq.id;
          }

          const { data: matchedDealRows } = await supabase.from('deals').select('id, inquiry_id, salesperson_phone, customer_name').limit(500);
          const foundDeal = (matchedDealRows || []).find(d =>
            (d.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanCode) ||
            (d.inquiry_id && d.inquiry_id.replace(/-/g, '').toUpperCase().startsWith(cleanCode)) ||
            (targetInquiryId && d.inquiry_id === targetInquiryId) ||
            (targetInquiryId && d.id === targetInquiryId)
          );
          if (foundDeal) {
            targetDealId = foundDeal.id;
            if (!targetInquiryId && foundDeal.inquiry_id) {
              targetInquiryId = foundDeal.inquiry_id;
            }
          }
        }

        // 2. Handle Inquiries table
        let finalInquiryId = targetInquiryId;
        if (finalInquiryId) {
          await supabase
            .from('inquiries')
            .update({
              stage: 'won',
              status: 'confirmed',
              won_at: new Date().toISOString(),
              po_number: draft.po_number,
              po_date: draft.po_date,
              total_amount: totalAmount,
              delivery_location: draft.delivery_location || null,
              payment_terms: draft.payment_terms || null,
              ai_extraction_json: structuredAiJson,
            })
            .eq('id', finalInquiryId);
        } else {
          const { data: inqRow } = await supabase
            .from('inquiries')
            .insert({
              source_channel: 'WhatsApp',
              customer_name: companyName,
              sender_name: companyName,
              raw_text: humanRawText.trim(),
              sender_phone: senderPhone,
              salesperson_phone: senderPhone,
              status: 'confirmed',
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: draft.po_number,
              po_date: draft.po_date,
              total_amount: totalAmount,
              delivery_location: draft.delivery_location || null,
              payment_terms: draft.payment_terms || null,
              ai_extraction_json: structuredAiJson,
              overall_confidence: 0.98,
              inquiry_type: 'purchase_order',
              created_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (inqRow) finalInquiryId = inqRow.id;
        }

        // 3. Update or Insert inquiry_items
        if (finalInquiryId && structuredLineItems.length > 0) {
          await supabase.from('inquiry_items').delete().eq('inquiry_id', finalInquiryId);
          const inqItemsPayload = structuredLineItems.map(it => ({
            inquiry_id: finalInquiryId,
            sku_text: it.sku_text || it.description,
            dimensions: it.dimensions || it.spec || null,
            grade: it.grade || null,
            quantity: Number(it.quantity) || 0,
            unit: it.unit || 'MT',
            rate: Number(it.rate) || 0,
            amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
            confidence: 0.95,
            created_at: new Date().toISOString(),
          }));
          await supabase.from('inquiry_items').insert(inqItemsPayload);
        }

        // 4. Handle Deals table (Crucial for Orders page in frontend)
        let finalDealId = targetDealId;
        if (finalDealId) {
          const { error: updErr } = await supabase
            .from('deals')
            .update({
              inquiry_id: finalInquiryId || null,
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: draft.po_number,
              po_date: draft.po_date,
              total_amount: totalAmount,
              delivery_location: draft.delivery_location,
              payment_terms: draft.payment_terms,
              customer_name: companyName,
              customer_address: draft.delivery_location || null,
              inquiry_type: 'purchase_order',
            })
            .eq('id', finalDealId);
          if (updErr) console.error('[CatalogFlow] Order deal update error:', updErr);
        } else {
          const { data: newDealRow, error: dealErr } = await supabase
            .from('deals')
            .insert({
              inquiry_id: finalInquiryId || null,
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: draft.po_number,
              po_date: draft.po_date,
              customer_name: companyName,
              customer_address: draft.delivery_location || null,
              delivery_location: draft.delivery_location,
              payment_terms: draft.payment_terms,
              total_amount: totalAmount,
              inquiry_type: 'purchase_order',
              status: 'auto_created',
              salesperson_phone: senderPhone,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (dealErr) console.error('[CatalogFlow] Order deal insert error:', dealErr);
          if (newDealRow) finalDealId = newDealRow.id;
        }

        // 5. Update or Insert deal_items (Crucial for Orders line items in frontend)
        if (finalDealId && structuredLineItems.length > 0) {
          await supabase.from('deal_items').delete().eq('deal_id', finalDealId);
          const itemsPayload = structuredLineItems.map(it => ({
            deal_id: finalDealId,
            sku_text: it.sku_text || it.description,
            dimensions: it.dimensions || it.spec || null,
            grade: it.grade || null,
            quantity: Number(it.quantity) || 0,
            unit: it.unit || 'MT',
            rate: Number(it.rate) || 0,
            amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
            created_at: new Date().toISOString(),
          }));
          await supabase.from('deal_items').insert(itemsPayload);
        }

        // 4. Log KRA 1 (Won Deal)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 1,
          kra_type: 'won_deal',
          value: totalAmount,
          customer_name: companyName,
          description: `Order Logged: PO #${draft.po_number} for ${companyName} (${breakdown.formattedGrandTotal})`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 5. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New order PO: ${draft.po_number || 'N/A'} recorded for ${companyName}${totalAmount ? ` (${breakdown?.formattedGrandTotal || `₹${Number(totalAmount).toLocaleString('en-IN')}`})` : ''}`,
            module: 'Orders',
            customer_name: companyName,
            entity_id: finalDealId || finalInquiryId,
            entity_type: 'deal',
            action_type: 'order_created',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_ORDER:', actErr?.message);
        }

        const inqRaw = (draft.inquiry_id || draft.deal_id || '').trim();
        const cleanInqCode = inqRaw.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        const inqDisplay = cleanInqCode ? `• *Inquiry ID:* INQ-${cleanInqCode}\n` : '';

        let itemsSummaryStr = '';
        if (structuredLineItems.length === 1) {
          const it = structuredLineItems[0];
          const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
          const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
          itemsSummaryStr = `• *Product:* ${it.sku_text || it.description}${specStr}${hsnStr} — ${it.quantity} ${it.unit || 'MT'} @ ₹${Number(it.rate || 0).toLocaleString('en-IN')}/${it.unit || 'MT'}\n`;
        } else if (structuredLineItems.length > 1) {
          itemsSummaryStr = `• *Line Items:*\n`;
          structuredLineItems.forEach((it) => {
            const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
            const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
            itemsSummaryStr += `  • ${it.sku_text || it.description}${specStr}${hsnStr} — ${it.quantity} ${it.unit || 'MT'} @ ₹${Number(it.rate || 0).toLocaleString('en-IN')}/${it.unit || 'MT'} (₹${Number(it.amount || 0).toLocaleString('en-IN')})\n`;
          });
        }

        const totalTonnage = structuredLineItems.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
        const mainUnit = structuredLineItems[0]?.unit || 'MT';
        const tonnageDisplay = totalTonnage > 0 ? `• *Total Tonnage:* ${totalTonnage.toLocaleString('en-IN')} ${mainUnit}\n` : '';

        return `🎉 *Order Recorded & Deal Marked as WON!*\n\n` +
          inqDisplay +
          `• *Customer / Company:* ${companyName}\n` +
          `• *PO Number:* ${draft.po_number}\n` +
          `• *PO Date:* ${draft.po_date}\n` +
          `• *Delivery Location:* ${draft.delivery_location}\n` +
          `• *Payment Terms:* ${draft.payment_terms}\n` +
          itemsSummaryStr +
          tonnageDisplay +
          `• *Sub Total:* ₹${breakdown.formattedSubtotal}\n` +
          `• *GST (18%):* ₹${breakdown.formattedGST}\n` +
          `• *Total Order Value:* ${breakdown.formattedGrandTotal}\n\n` +
          `Updated Sales Achievement Card! 🏆`;
      }

      case 'UPDATE_ORDER': {
        const rawInqId = (draft.inquiry_id || '').trim();
        const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/-/g, '').trim().toUpperCase();
        const rawPo = (draft.updates?.po_number || draft.po_number || '').trim();
        const cleanPo = rawPo.replace(/^(?:PO[-_:#\s]*)/i, '').trim();
        const rawCompany = (draft.company_name || '').trim();

        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        // 1. Fetch recent deals to match
        let dealsQuery = supabase
          .from('deals')
          .select('id, inquiry_id, customer_name, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
          .order('created_at', { ascending: false });

        if (!scope.isAdmin && targetPhones.length > 0) {
          dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
        }

        const { data: deals } = await dealsQuery.limit(500);

        let deal = null;
        if (deals && deals.length > 0) {
          // A. Match by Inquiry ID / Deal ID prefix or exact code
          if (cleanInqId) {
            deal = deals.find(d => {
              const dId = (d.id || '').replace(/-/g, '').toUpperCase();
              const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
              return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
            }) || null;
          }

          // B. Match by existing PO Number (if inquiry ID was not specified)
          if (!deal && rawPo) {
            deal = deals.find(d => {
              if (!d.po_number) return false;
              const dPo = String(d.po_number).trim();
              return dPo.toLowerCase() === rawPo.toLowerCase() ||
                     (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
            }) || null;
          }

          // C. Match by Customer Name
          if (!deal && rawCompany) {
            deal = deals.find(d => d.customer_name && d.customer_name.toLowerCase().includes(rawCompany.toLowerCase())) || null;
          }
        }

        // 2. If not found in deals and cleanInqId was supplied, check inquiries table
        if (!deal && cleanInqId) {
          let inqQuery = supabase
            .from('inquiries')
            .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            inqQuery = inqQuery.in('salesperson_phone', targetPhones);
          }
          const { data: inqRows } = await inqQuery.limit(500);
          if (inqRows) {
            for (const inq of inqRows) {
              const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
              if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
                if (inq.deals && inq.deals.length > 0) {
                  deal = inq.deals[0];
                } else {
                  const inqJson = inq.ai_extraction_json || {};
                  const { data: newDealRows } = await supabase
                    .from('deals')
                    .insert({
                      inquiry_id: inq.id,
                      customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                      salesperson_phone: inq.salesperson_phone || senderPhone,
                      stage: 'won',
                      won_at: new Date().toISOString(),
                      po_number: rawPo || null,
                      po_date: new Date().toISOString().split('T')[0],
                      total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                      delivery_location: inqJson.delivery_location || inqJson.location || null,
                      customer_address: inqJson.delivery_location || inqJson.location || null,
                      payment_terms: inqJson.payment_terms || null,
                      status: 'active',
                    })
                    .select();
                  if (newDealRows && newDealRows.length > 0) {
                    deal = newDealRows[0];
                  }
                }
                break;
              }
            }
          }
        }

        // 2b. Unscoped fallback by cleanInqId or rawPo if not found yet
        if (!deal && (cleanInqId || rawPo)) {
          const { data: allDeals } = await supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
            .order('created_at', { ascending: false })
            .limit(500);

          if (allDeals && allDeals.length > 0) {
            if (cleanInqId) {
              deal = allDeals.find(d => {
                const dId = (d.id || '').replace(/-/g, '').toUpperCase();
                const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
                return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
              }) || null;
            }
            if (!deal && rawPo) {
              deal = allDeals.find(d => {
                if (!d.po_number) return false;
                const dPo = String(d.po_number).trim();
                return dPo.toLowerCase() === rawPo.toLowerCase() ||
                       (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
              }) || null;
            }
          }

          if (!deal && cleanInqId) {
            const { data: allInqRows } = await supabase
              .from('inquiries')
              .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
              .order('created_at', { ascending: false })
              .limit(500);

            if (allInqRows) {
              for (const inq of allInqRows) {
                const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
                if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
                  if (inq.deals && inq.deals.length > 0) {
                    deal = inq.deals[0];
                  } else {
                    const inqJson = inq.ai_extraction_json || {};
                    const { data: newDealRows } = await supabase
                      .from('deals')
                      .insert({
                        inquiry_id: inq.id,
                        customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                        salesperson_phone: inq.salesperson_phone || senderPhone,
                        stage: 'won',
                        won_at: new Date().toISOString(),
                        po_number: rawPo || null,
                        po_date: new Date().toISOString().split('T')[0],
                        total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                        delivery_location: inqJson.delivery_location || inqJson.location || null,
                        customer_address: inqJson.delivery_location || inqJson.location || null,
                        payment_terms: inqJson.payment_terms || null,
                        status: 'active',
                      })
                      .select();
                    if (newDealRows && newDealRows.length > 0) {
                      deal = newDealRows[0];
                    }
                  }
                  break;
                }
              }
            }
          }
        }

        if (!deal) {
          const missingIdentifier = draft.inquiry_id ? `Inquiry ID "${draft.inquiry_id}"` : (rawPo ? `PO Number "${rawPo}"` : (rawCompany ? `Customer "${rawCompany}"` : 'specified reference'));
          return `❌ Could not find an existing order or inquiry matching ${missingIdentifier}.\n\nPlease check the Inquiry ID or PO Number and try again.`;
        }

        const updates = draft.updates || {};
        const dealUpdates = {};

        // Attach / update PO number
        if (rawPo) {
          dealUpdates.po_number = rawPo;
        }
        if (updates.po_date) {
          dealUpdates.po_date = updates.po_date;
        }
        if (updates.delivery_location) {
          dealUpdates.delivery_location = updates.delivery_location;
          dealUpdates.customer_address = updates.delivery_location;
        }
        if (updates.payment_terms) {
          dealUpdates.payment_terms = updates.payment_terms;
        }

        if (updates.status || updates.stage) {
          const s = String(updates.status || updates.stage).toLowerCase();
          if (s.includes('won') || s.includes('order') || s.includes('confirm')) dealUpdates.stage = 'won';
          else if (s.includes('lost') || s.includes('cancel')) dealUpdates.stage = 'lost';
          else if (s.includes('negot')) dealUpdates.stage = 'negotiation';
          else if (s.includes('hold')) dealUpdates.stage = 'on_hold';
          else if (s.includes('quote') || s.includes('price')) dealUpdates.stage = 'quoted';
          else dealUpdates.stage = updates.status || updates.stage;
        }

        // When deal is won, ensure won_at and po_date are set
        if (deal.stage === 'won' || dealUpdates.stage === 'won') {
          if (!deal.won_at && !dealUpdates.won_at) {
            dealUpdates.won_at = new Date().toISOString();
          }
          if (!deal.po_date && !dealUpdates.po_date) {
            dealUpdates.po_date = new Date().toISOString().split('T')[0];
          }
        }

        // Line item updates if any
        if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
          const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
          if (dItems && dItems.length > 0) {
            let totalAmount = 0;
            for (let i = 0; i < dItems.length; i++) {
              const currentItem = dItems[i];
              const curSku = (currentItem.sku_text || currentItem.description || '').toLowerCase();
              const matchedUpd = draft.line_item_updates.find((upd, uIdx) => {
                const updSku = (upd.sku_text || upd.description || '').toLowerCase();
                if (!updSku) return uIdx === i;
                const cleanCur = curSku.replace(/[^a-z0-9]/g, '');
                const cleanUpd = updSku.replace(/[^a-z0-9]/g, '');
                return cleanCur.includes(cleanUpd) || cleanUpd.includes(cleanCur) || uIdx === i;
              });

              let itRate = Number(currentItem.rate) || 0;
              let itQty = Number(currentItem.quantity) || 0;
              if (matchedUpd) {
                if (matchedUpd.rate !== null && matchedUpd.rate !== undefined && matchedUpd.rate !== '') {
                  itRate = Number(String(matchedUpd.rate).replace(/[^\d.]/g, '')) || itRate;
                }
                if (matchedUpd.quantity !== null && matchedUpd.quantity !== undefined && matchedUpd.quantity !== '') {
                  itQty = Number(String(matchedUpd.quantity).replace(/[^\d.]/g, '')) || itQty;
                }
              }
              const itAmt = itQty > 0 && itRate > 0 ? itQty * itRate : 0;
              totalAmount += itAmt;
              await supabase.from('deal_items').update({
                rate: itRate,
                quantity: itQty,
                amount: itAmt,
              }).eq('id', currentItem.id);
            }
            if (totalAmount > 0) dealUpdates.total_amount = totalAmount;
          }
        }

        if (Object.keys(dealUpdates).length > 0) {
          await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
        }

        // Synchronize inquiries table (ai_extraction_json AND raw_text)
        if (deal.inquiry_id) {
          const { data: inqRow } = await supabase.from('inquiries').select('id, raw_text, ai_extraction_json, status').eq('id', deal.inquiry_id).single();
          if (inqRow) {
            const aiJson = inqRow.ai_extraction_json || {};
            if (rawPo) aiJson.po_number = rawPo;
            if (updates.po_date) aiJson.po_date = updates.po_date;
            if (updates.delivery_location) {
              aiJson.delivery_location = updates.delivery_location;
              aiJson.deliveryLocation = updates.delivery_location;
              aiJson.delivery_address = updates.delivery_location;
              if (aiJson.customer) aiJson.customer.address = updates.delivery_location;
            }
            if (updates.payment_terms) {
              aiJson.payment_terms = updates.payment_terms;
              aiJson.paymentTerms = updates.payment_terms;
            }

            let updatedRawText = inqRow.raw_text || '';
            if (rawPo) {
              if (/(?:po\s*(?:number|no)?|purchase\s*order)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:po\s*(?:number|no)?|purchase\s*order)\s*[:=-]\s*([^\n|]+)/i, `PO Number: ${rawPo}`);
              } else {
                updatedRawText += `\nPO Number: ${rawPo}`;
              }
            }
            if (updates.delivery_location) {
              if (/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i, `Delivery Location: ${updates.delivery_location}`);
              } else {
                updatedRawText += `\nDelivery Location: ${updates.delivery_location}`;
              }
            }
            if (updates.payment_terms) {
              if (/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i, `Payment Terms: ${updates.payment_terms}`);
              } else {
                updatedRawText += `\nPayment Terms: ${updates.payment_terms}`;
              }
            }

            const inqPayload = {
              ai_extraction_json: aiJson,
              raw_text: updatedRawText.trim(),
            };
            if (dealUpdates.stage === 'won' || deal.stage === 'won') {
              inqPayload.status = 'confirmed';
            } else if (dealUpdates.stage) {
              inqPayload.status = dealUpdates.stage;
            }
            await supabase.from('inquiries').update(inqPayload).eq('id', deal.inquiry_id);
          }
        }

        const displayPo = dealUpdates.po_number || deal.po_number || rawPo || 'N/A';
        const displayInq = `INQ-${(deal.id || deal.inquiry_id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
        const displayCust = deal.customer_name || draft.company_name || 'Customer';
        const displayTotal = dealUpdates.total_amount || deal.total_amount || 0;
        const displayLoc = dealUpdates.delivery_location || deal.delivery_location;
        const displayPayment = dealUpdates.payment_terms || deal.payment_terms;
        const displayPoDate = dealUpdates.po_date || deal.po_date;

        // Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Order ${displayPo} updated for ${displayCust}${dealUpdates.stage ? ` (Stage: ${dealUpdates.stage})` : ''}`,
            module: 'Orders',
            customer_name: displayCust,
            entity_id: deal.id,
            entity_type: 'deal',
            action_type: 'order_updated',
            change_detail: dealUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_ORDER:', actErr?.message);
        }

        return `✅ *Order Updated Successfully!*\n\n` +
          `• *Inquiry ID:* ${displayInq}\n` +
          `• *Customer / Company:* ${displayCust}\n` +
          `• *PO Number:* ${displayPo}\n` +
          (displayPoDate ? `• *PO Date:* ${displayPoDate}\n` : '') +
          (displayLoc ? `• *Delivery Location:* ${displayLoc}\n` : '') +
          (displayPayment ? `• *Payment Terms:* ${displayPayment}\n` : '') +
          (displayTotal > 0 ? `• *Total Order Value:* ₹${Number(displayTotal).toLocaleString('en-IN')}\n` : '') +
          `\nAttached PO number to won order and logged in Orders module! 🏆`;
      }

      case 'LOG_VISIT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          contact_person: draft.person_met,
          customer_phone: draft.contact_phone,
          city: draft.city_location,
        });

        const visitDateIso = parseDDMMYYYYtoISO(draft.visit_date);
        const parsedFollowUpDate = draft.followup_action ? extractFollowUpDate(draft.followup_action, new Date(visitDateIso)) : null;

        const outcomeTag = draft.visit_outcome ? `[Outcome: ${draft.visit_outcome}] ` : '';
        const locTag = draft.city_location ? `[Location: ${draft.city_location}] ` : '';
        const followupTag = draft.followup_action ? `[FollowUp: ${draft.followup_action}] ` : '';
        const fuDateTag = parsedFollowUpDate ? `[FollowUpDate: ${parsedFollowUpDate}] ` : '';
        const fuStatusTag = draft.followup_action ? `[FollowUpStatus: pending] ` : '';
        const formattedRemarks = `${outcomeTag}${locTag}${followupTag}${fuDateTag}${fuStatusTag}${draft.meeting_remarks || ''}`.trim();

        let employeeId = null;
        try {
          const cleanP = cleanPhone(senderPhone);
          const last10 = cleanP.slice(-10);
          const { data: empData } = await supabase
            .from('employees')
            .select('id')
            .or(`phone.eq.${cleanP},phone.eq.${last10},phone.eq.91${last10},phone.eq.+91${last10}`)
            .limit(1);
          if (empData && empData.length > 0) employeeId = empData[0].id;
        } catch (e) {}

        // 1. Insert into customer_visits
        const visitPayload = {
          salesperson_phone: senderPhone,
          customer_name: companyName,
          customer_address: draft.city_location || null,
          person_met: draft.person_met || null,
          contact_no: draft.contact_phone || null,
          remarks: formattedRemarks,
          visited_at: visitDateIso,
          employee_id: employeeId,
          follow_up_action: draft.followup_action || null,
          follow_up_date: parsedFollowUpDate || null,
          follow_up_status: draft.followup_action ? 'pending' : null,
        };

        const { error: visErr } = await supabase.from('customer_visits').insert(visitPayload);
        if (visErr) {
          console.error('[CatalogFlow] Visit insert error with dedicated columns, retrying fallback:', visErr.message);
          delete visitPayload.follow_up_action;
          delete visitPayload.follow_up_date;
          delete visitPayload.follow_up_status;
          delete visitPayload.employee_id;
          await supabase.from('customer_visits').insert(visitPayload);
        }

        // 2. Log KRA 9 (Site Visit)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 9,
          kra_type: 'site_visit',
          customer_name: companyName,
          description: `Customer Visit: ${companyName} (${draft.city_location}) - Met ${draft.person_met}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 3. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'site_visit',
          customer_name: companyName,
          description: `CRM Activity: Site Visit logged for ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 4. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Customer visit logged for ${companyName}${draft.city_location ? ` (${draft.city_location})` : ''}${draft.person_met ? ` - Met: ${draft.person_met}` : ''}`,
            module: 'Visits',
            customer_name: companyName,
            action_type: 'visit_logged',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_VISIT:', actErr?.message);
        }

        return `📍 *Customer Field Visit Logged Successfully!*\n\n` +
          `• *Customer / Company:* ${companyName}\n` +
          `• *Person Met:* ${draft.person_met}\n` +
          `• *Contact Phone:* ${draft.contact_phone}\n` +
          `• *City / Location:* ${draft.city_location}\n` +
          `• *Visit Date:* ${draft.visit_date}\n` +
          `• *Visit Outcome:* ${draft.visit_outcome}\n` +
          (draft.followup_action ? `• *Follow-up Action:* ${draft.followup_action}\n` : '') +
          `• *Meeting Remarks:* ${draft.meeting_remarks}\n\n` +
          `Logged to Customer Visits Card! ✅`;
      }

      case 'UPDATE_VISIT': {
        const companyName = (draft.company_name || '').trim();
        const visitId = (draft.visit_id || '').trim();
        const targetDate = draft.visit_date || draft.updates?.visit_date || null;

        const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        let visitQuery = supabase.from('customer_visits').select('*').order('visited_at', { ascending: false });
        if (!scope.isAdmin && targetPhones.length > 0) {
          visitQuery = visitQuery.in('salesperson_phone', targetPhones);
        }
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitId);
        if (visitId && isUUID) {
          visitQuery = visitQuery.eq('id', visitId);
        } else if (companyName) {
          visitQuery = visitQuery.ilike('customer_name', `%${companyName}%`);
        }
        const { data: allVisits } = await visitQuery.limit(50);

        // 1. Accessibility filtering by salesperson phone
        let candidateVisits = (allVisits || []).filter(v => {
          if (scope.isAdmin || scope.phones === null) return true;
          return isPhoneInScope(v.salesperson_phone, targetPhones);
        });

        // 2. Separate real site visits from Bigin sync placeholder visits
        const realVisits = candidateVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
        const pool = realVisits.length > 0 ? realVisits : candidateVisits;

        // 3. Match by visit_id or date if specified
        let targetVisit = null;
        if (visitId) {
          targetVisit = pool.find(v => v.id === visitId || v.id.toLowerCase().includes(visitId.toLowerCase())) || null;
        }
        if (!targetVisit && targetDate) {
          const cleanTargetDate = parseDDMMYYYYtoISO(targetDate);
          if (cleanTargetDate) {
            targetVisit = pool.find(v => v.visited_at && v.visited_at.startsWith(cleanTargetDate.slice(0, 10))) || null;
          }
        }

        if (!targetVisit) {
          targetVisit = pool[0] || null;
        }

        if (!targetVisit) {
          return `❌ Could not find an existing customer visit record for "${companyName || visitId}". Please check the customer name and try again.`;
        }

        const updates = draft.updates || {};
        const visitUpdates = {};

        // 1. Extract existing metadata from targetVisit to preserve unedited tags
        const existingOutcome = targetVisit.outcome || targetVisit.remarks?.match(/\[Outcome:\s*([^\]]+)\]/i)?.[1] || null;
        const existingLoc = targetVisit.customer_address || targetVisit.location || targetVisit.remarks?.match(/\[Location:\s*([^\]]+)\]/i)?.[1] || null;
        const existingFollowup = targetVisit.follow_up_action || targetVisit.remarks?.match(/\[(?:Follow-?Up|Follow-?up\s*Action):\s*([^\]]+)\]/i)?.[1] || targetVisit.remarks?.match(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*([^|\]\n]+)/i)?.[1] || null;
        const existingFollowupDate = targetVisit.follow_up_date || targetVisit.remarks?.match(/\[Follow-?UpDate:\s*([^\]]+)\]/i)?.[1] || null;
        const existingFollowupStatus = targetVisit.follow_up_status || targetVisit.remarks?.match(/\[Follow-?UpStatus:\s*([^\]]+)\]/i)?.[1] || (existingFollowup ? 'pending' : null);

        const cleanExistingRemarks = (targetVisit.remarks || '')
          .replace(/\[(?:Outcome|Location|Follow-?Up|Follow-?up\s*Action|Follow-?UpDate|Follow-?UpStatus|Requirement|Requirements|Interests?):[^\]]*\]\s*/gi, '')
          .replace(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*[^|\n]+/gi, '')
          .replace(/^[\s|]+|[\s|]+$/g, '')
          .trim();

        // 2. Compute updated values
        const newOutcome = updates.visit_outcome || existingOutcome || 'Positive';
        const newLocation = updates.city_location || existingLoc || null;

        let newFollowup = existingFollowup;
        let newFollowupDate = existingFollowupDate;
        let newFollowupStatus = existingFollowupStatus;

        if (updates.followup_action !== undefined && updates.followup_action !== null && updates.followup_action !== '') {
          newFollowup = updates.followup_action;
          newFollowupStatus = 'pending';
          const parsedFuDate = extractFollowUpDate(updates.followup_action, new Date(targetVisit.visited_at || Date.now()));
          if (parsedFuDate) {
            newFollowupDate = parsedFuDate;
          }
        }

        // Completion detection
        const isExplicitCompleted = updates.status && /^(?:completed|done|resolved|closed)$/i.test(String(updates.status).trim());
        const isRemarksCompleted = updates.meeting_remarks && /\b(?:quote sent|quotation sent|sent quote|sent official price quotation|po received|order placed|resolved|done|completed)\b/i.test(updates.meeting_remarks) && !updates.followup_action;

        if (isExplicitCompleted || isRemarksCompleted) {
          newFollowupStatus = 'completed';
          visitUpdates.follow_up_completed_at = new Date().toISOString();
        }

        let newRemarksText = cleanExistingRemarks;
        if (updates.meeting_remarks !== undefined && updates.meeting_remarks !== null && updates.meeting_remarks !== '') {
          newRemarksText = updates.meeting_remarks.trim();
        }

        // 3. Construct structured remarks string matching LOG_VISIT
        const outcomeTag = newOutcome ? `[Outcome: ${newOutcome}] ` : '';
        const locTag = newLocation ? `[Location: ${newLocation}] ` : '';
        const followupTag = newFollowup ? `[FollowUp: ${newFollowup}] ` : '';
        const fuDateTag = newFollowupDate ? `[FollowUpDate: ${newFollowupDate}] ` : '';
        const fuStatusTag = newFollowupStatus ? `[FollowUpStatus: ${newFollowupStatus}] ` : '';

        visitUpdates.remarks = `${outcomeTag}${locTag}${followupTag}${fuDateTag}${fuStatusTag}${newRemarksText}`.trim();

        if (newFollowup !== null && newFollowup !== undefined) visitUpdates.follow_up_action = newFollowup;
        if (newFollowupDate !== null && newFollowupDate !== undefined) visitUpdates.follow_up_date = newFollowupDate;
        if (newFollowupStatus !== null && newFollowupStatus !== undefined) visitUpdates.follow_up_status = newFollowupStatus;

        if (updates.person_met) visitUpdates.person_met = updates.person_met;
        if (updates.contact_phone) visitUpdates.contact_no = cleanPhone(updates.contact_phone) || updates.contact_phone;
        if (newLocation) visitUpdates.customer_address = newLocation;
        if (updates.visit_date) visitUpdates.visited_at = parseDDMMYYYYtoISO(updates.visit_date);

        if (Object.keys(visitUpdates).length > 0) {
          const { error: updErr } = await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
          if (updErr) {
            console.error('[CatalogFlow] Visit update error with dedicated columns, retrying fallback:', updErr.message);
            delete visitUpdates.follow_up_action;
            delete visitUpdates.follow_up_date;
            delete visitUpdates.follow_up_status;
            delete visitUpdates.follow_up_completed_at;
            await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
          }

          // Sync customer master profile if contact details changed
          if (updates.person_met || updates.contact_phone || updates.city_location) {
            const custUpdates = { updated_at: new Date().toISOString() };
            if (updates.person_met) custUpdates.contact_person = updates.person_met;
            if (updates.contact_phone) custUpdates.customer_phone = cleanPhone(updates.contact_phone) || updates.contact_phone;
            if (updates.city_location) custUpdates.customer_address = updates.city_location;
            await supabase
              .from('recurring_customers')
              .update(custUpdates)
              .ilike('customer_name', `%${targetVisit.customer_name}%`);
          }
        }

        const resolvedCust = targetVisit ? targetVisit.customer_name : (draft.company_name || 'Customer');

        let updatesSummary = '';
        if (visitUpdates.person_met) updatesSummary += `• *Person Met:* ${visitUpdates.person_met}\n`;
        if (visitUpdates.contact_no) updatesSummary += `• *Contact Phone:* ${visitUpdates.contact_no}\n`;
        if (visitUpdates.customer_address && updates.city_location) updatesSummary += `• *City / Location:* ${visitUpdates.customer_address}\n`;
        if (visitUpdates.visited_at && updates.visit_date) updatesSummary += `• *Visit Date:* ${formatDateDDMMYYYY(visitUpdates.visited_at)}\n`;
        if (updates.visit_outcome) updatesSummary += `• *Visit Outcome:* ${newOutcome}\n`;
        if (updates.followup_action) updatesSummary += `• *Follow-up Action:* ${visitUpdates.follow_up_action}\n`;
        if (newFollowupStatus && (isExplicitCompleted || isRemarksCompleted)) updatesSummary += `• *Follow-up Status:* Completed ✅\n`;
        if (updates.meeting_remarks) updatesSummary += `• *Meeting Remarks:* ${updates.meeting_remarks}\n`;

        // Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Customer visit updated for ${resolvedCust}${visitUpdates.follow_up_action ? ` (Follow-up: ${visitUpdates.follow_up_action})` : ''}`,
            module: 'Visits',
            customer_name: resolvedCust,
            entity_id: targetVisit?.id,
            entity_type: 'visit',
            action_type: 'visit_updated',
            change_detail: visitUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_VISIT:', actErr?.message);
        }

        return `✅ *Field Visit Updated Successfully!*\n\n` +
          `• *Customer / Company:* ${resolvedCust}\n` +
          updatesSummary +
          `\nVisit details updated in Customer Visits Card! ✅`;
      }

      case 'LOG_NEW_CUSTOMER': {
        const companyName = String(draft.company_name || '').trim();
        const contactPerson = draft.contact_person ? String(draft.contact_person).trim() : null;
        const mobileNumber = cleanPhone(draft.mobile_number || draft.phone || draft.contact_phone);
        const deliveryLoc = (draft.delivery_location || draft.city_location || draft.address || '').trim() || null;
        const gstNum = (draft.gst_number || draft.gst || '').trim() || null;
        const email = draft.email ? String(draft.email).trim() : null;

        // 1. Exact duplicate check across recurring_customers
        const { data: existingCusts } = await supabase
          .from('recurring_customers')
          .select('*')
          .ilike('customer_name', companyName)
          .limit(10);

        const exactMatch = (existingCusts || []).find(c =>
          c.customer_name.trim().toLowerCase() === companyName.toLowerCase() ||
          (normalizeCoreCompanyName(c.customer_name) && normalizeCoreCompanyName(c.customer_name) === normalizeCoreCompanyName(companyName))
        );

        if (exactMatch) {
          return `⚠️ *Customer Already Exists!*\n\n` +
            `• *Company Name:* ${exactMatch.customer_name}\n` +
            (exactMatch.contact_person ? `• *Contact Person:* ${exactMatch.contact_person}\n` : '') +
            (exactMatch.customer_phone ? `• *Mobile Number:* ${exactMatch.customer_phone}\n` : '') +
            (exactMatch.customer_address ? `• *Location:* ${exactMatch.customer_address}\n` : '') +
            (exactMatch.customer_gst ? `• *GST:* ${exactMatch.customer_gst}\n` : '') +
            `\n_This customer is already registered in the system. Duplicate record creation was prevented._`;
        }

        // 2. Insert new record into recurring_customers
        const { data: newCust, error: custErr } = await supabase
          .from('recurring_customers')
          .insert({
            customer_name: companyName,
            contact_person: contactPerson,
            customer_phone: mobileNumber || null,
            customer_address: deliveryLoc,
            customer_gst: gstNum,
            notes: email ? `Email: ${email}` : null,
            assigned_salesperson_phone: senderPhone,
            is_active: true,
            avg_order_frequency_days: 30,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (custErr) console.error('[CatalogFlow] Customer insert error:', custErr);

        // 3. Log KRA 2 (New Customer Acquisition)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 2,
          kra_type: 'new_customer',
          customer_name: companyName,
          description: `New Customer Acquired: ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 4. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'new_customer',
          customer_name: companyName,
          description: `Added New Customer: ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 5. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New customer acquired: ${companyName}${contactPerson ? ` (${contactPerson})` : ''}`,
            module: 'Customers',
            customer_name: companyName,
            entity_id: newCust?.id,
            entity_type: 'customer',
            action_type: 'customer_created',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_NEW_CUSTOMER:', actErr?.message);
        }

        const custId = newCust ? newCust.id : '';

        return `🎉 *New Customer Successfully Added!*\n\n` +
          `• *Company Name:* ${companyName}\n` +
          `• *Contact Person:* ${contactPerson || 'N/A'}\n` +
          `• *Mobile Number:* ${mobileNumber || 'N/A'}\n` +
          `• *Delivery Location:* ${deliveryLoc || 'N/A'}\n` +
          (email ? `• *Email:* ${email}\n` : '') +
          (gstNum ? `• *GST Number:* ${gstNum}\n` : '') +
          `\nCustomer record created & added to your portfolio! ✅`;
      }

      case 'LOG_COMPLAINT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, { allowCreate: true });

        const nowIso = new Date().toISOString();
        const slaDueAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
        const normalizedType = normalizeComplaintType(draft.complaint_type || 'quality');

        // Extract affected product
        let product = (draft.affected_product || draft.product_name || '').trim();
        if (!product && draft.complaint_description) {
          product = extractProductFromText(draft.complaint_description) || '';
        }
        if (!product) {
          product = 'Steel Material';
        }

        // If deal_id / po_number wasn't already resolved in draft, resolve via checkOrdersForComplaint
        let targetDealId = draft.deal_id || null;
        let targetPoNumber = draft.po_number || null;

        if (!targetDealId) {
          const ordCheck = await checkOrdersForComplaint('LOG_COMPLAINT', draft, senderPhone);
          if (ordCheck && ordCheck.draft && ordCheck.draft.deal_id) {
            targetDealId = ordCheck.draft.deal_id;
            targetPoNumber = ordCheck.draft.po_number || null;
            if (!draft.affected_product && ordCheck.draft.affected_product) {
              product = ordCheck.draft.affected_product;
            }
          }
        }

        // Clean description of any "Status: In Progress" prefixes
        const sanitizedDesc = (draft.complaint_description || '')
          .replace(/^status:\s*(?:in progress|pending|open|resolved|closed)[,\s]*/i, '')
          .trim() || draft.complaint_description || product;

        // 1. Insert into complaints (ALWAYS status: 'open')
        const { error: cmpErr } = await supabase.from('complaints').insert({
          customer_name: companyName,
          complaint_type: normalizedType,
          description: sanitizedDesc,
          reported_by: senderPhone,
          status: 'open',
          po_number: targetPoNumber,
          deal_id: targetDealId,
          product_name: product || null,
          affected_product: product || null,
          corrective_action: draft.corrective_action || null,
          reported_at: nowIso,
          created_at: nowIso,
          sla_due_at: slaDueAt,
        });

        if (cmpErr) console.error('[CatalogFlow] Complaint insert error:', cmpErr);

        // 2. Log KRA 7 (Quality Complaint)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 7,
          kra_type: 'quality_complaint',
          customer_name: companyName,
          description: `Complaint Logged: ${companyName} - ${normalizedType}: ${sanitizedDesc}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: nowIso,
        });

        // 3. Log bot activity
        try {
          const { logBotActivity } = require('../utils/activityLogger');
          const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.replace(/-/g, '').substring(0, 6).toUpperCase()) : '';
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New complaint logged for ${companyName}${targetPoNumber ? ` (PO: ${targetPoNumber})` : cleanCode ? ` (Inquiry: INQ-${cleanCode})` : ''}`,
            module: 'Complaints',
            customer_name: companyName,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice:', actErr?.message);
        }

        // 4. Auto-resolve pending follow-up tasks
        try {
          const { resolveCustomerFollowupTasks } = require('../kra3');
          await resolveCustomerFollowupTasks(companyName, senderPhone, 'complaint_logged', targetDealId);
        } catch (rErr) {
          console.warn('[CatalogFlow] Follow-up auto-resolution notice:', rErr.message);
        }

        let linkedDisplay = '';
        const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.replace(/-/g, '').substring(0, 6).toUpperCase()) : '';
        if (targetPoNumber) {
          linkedDisplay = `• *Linked Order / Ref:* PO: ${targetPoNumber}${cleanCode ? ` (INQ-${cleanCode})` : ''}\n`;
        } else if (targetDealId) {
          linkedDisplay = `• *Linked Order / Ref:* INQ-${cleanCode}\n`;
        } else if (draft.linked_inquiry_or_po) {
          linkedDisplay = `• *Linked Order / Ref:* ${draft.linked_inquiry_or_po}\n`;
        }

        return `⚠️ *Customer Complaint Logged Successfully!*\n\n` +
          `• *Customer / Company:* ${companyName}\n` +
          linkedDisplay +
          (product ? `• *Product / Material:* ${product}\n` : '') +
          `• *Complaint Type:* ${normalizedType}\n` +
          `• *Description:* ${sanitizedDesc}\n` +
          (draft.corrective_action ? `• *Corrective Action:* ${draft.corrective_action}\n` : '') +
          `• *Status:* Open (48-Hour SLA Clock Started)\n\n` +
          `Logged to Customer Complaints Card! (48h SLA Active) ⏱️`;
      }

      case 'UPDATE_COMPLAINT': {
        const matchedCmp = await findAndMatchComplaint(draft, senderPhone);

        if (!matchedCmp) {
          const refDisplay = draft.company_name || draft.linked_inquiry_or_po || 'specified reference';
          return `⚠️ Could not find an active complaint for *${refDisplay}*.\n\nPlease verify the Customer Name, Inquiry ID, or PO Number.`;
        }

        const updates = draft.updates || {};
        const cmpUpdates = {};

        if (updates.complaint_type) cmpUpdates.complaint_type = normalizeComplaintType(updates.complaint_type);
        if (updates.complaint_description) cmpUpdates.description = updates.complaint_description;
        if (updates.corrective_action) cmpUpdates.corrective_action = updates.corrective_action;
        if (updates.resolution_notes) cmpUpdates.resolution_notes = updates.resolution_notes;
        if (updates.status) {
          const st = updates.status.toLowerCase();
          cmpUpdates.status = st;
          if (st === 'resolved' || st === 'closed') {
            cmpUpdates.resolved_at = new Date().toISOString();
          }
        }

        if (Object.keys(cmpUpdates).length === 0) {
          return `ℹ️ No updates were provided for the complaint of *${matchedCmp.customer_name}*.`;
        }

        const { error: updateErr } = await supabase
          .from('complaints')
          .update(cmpUpdates)
          .eq('id', matchedCmp.id);

        if (updateErr) {
          console.error('[CatalogFlow] Supabase complaint update error:', updateErr);
          return `❌ Failed to update complaint: ${updateErr.message}`;
        }

        // Log to activity_logs
        try {
          const { logBotActivity } = require('../utils/activityLogger');
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Complaint updated for ${matchedCmp.customer_name}: ${Object.entries(cmpUpdates).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            module: 'Complaints',
            customer_name: matchedCmp.customer_name,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice:', actErr?.message);
        }

        const cleanCmpCode = matchedCmp.deal_id ? matchedCmp.deal_id.replace(/^#?(?:INQ|DEAL)-?/i, '').substring(0, 6).toUpperCase() : '';
        const linkedOrderRef = matchedCmp.po_number
          ? `PO: ${matchedCmp.po_number}${cleanCmpCode ? ` (INQ-${cleanCmpCode})` : ''}`
          : matchedCmp.deal_id
          ? `INQ-${cleanCmpCode}`
          : '';

        let fieldsSummary = '';
        if (cmpUpdates.complaint_type) fieldsSummary += `• *Complaint Type:* ${cmpUpdates.complaint_type}\n`;
        if (updates.status) fieldsSummary += `• *Status:* ${updates.status}\n`;
        if (cmpUpdates.description) fieldsSummary += `• *Description:* ${cmpUpdates.description}\n`;
        if (cmpUpdates.corrective_action) fieldsSummary += `• *Corrective Action:* ${cmpUpdates.corrective_action}\n`;
        if (cmpUpdates.resolution_notes) fieldsSummary += `• *Resolution Notes:* ${cmpUpdates.resolution_notes}\n`;

        return `✅ *Customer Complaint Updated Successfully!*\n\n` +
          `• *Customer / Company:* ${matchedCmp.customer_name}\n` +
          (linkedOrderRef ? `• *Linked Order / Ref:* ${linkedOrderRef}\n` : '') +
          fieldsSummary +
          `\nUpdated details saved to Customer Complaints Card! ✅`;
      }

      default:
        return `✅ Action ${action} completed successfully!`;
    }
  } catch (err) {
    console.error(`[CatalogFlow] Execution error for ${action}:`, err.message);
    return `❌ An error occurred while saving: ${err.message}. Please try again.`;
  }
}

// ── OPERATIONAL ACTION & QUERY DETECTION HELPERS ─────────────────────────────

/**
 * Detects queries asking for delivery tracking, dispatch status, vehicle tracking,
 * shipment in transit, or pending orders that haven't been delivered yet.
 * These are currently out of scope for the WhatsApp bot.
 */
function isOutOfScopeDeliveryQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // Guard: If it's pure data entry like "Delivery Location: Mumbai" or "Delivery: Pune" during form filling, NOT out of scope.
  if (/^(?:delivery\s*location|delivery\s*address|delivery\s*city|destination|target\s*delivery\s*date)\s*[:=-]/i.test(lower)) {
    return false;
  }
  // Guard: If it's asking "what is the delivery location on PO 123" -> in scope (delivery_location field)
  if (/\b(?:delivery\s+location|delivery\s+address|site\s+location)\b/i.test(lower) && 
      !/\b(?:deliver(?:ed|ing|y)?\s+(?:status|tracking|update|time|delay|kya|kab|pending)|undelivered|un-delivered|dispatch|transit|tracking|shipped|shipment|consignment|transporter|truck|vehicle|eway|e-way|lr\s*no|lorry)\b/i.test(lower)) {
    return false;
  }

  // Comprehensive Out-of-Scope Patterns for Delivery, Dispatch & Logistics Tracking
  const outOfScopePatterns = [
    // 1. Delivery status / tracking / progress / ETA
    /\b(?:delivery\s+status|delivery\s+tracking|track\s+(?:my\s+|the\s+)?delivery|track\s+(?:my\s+|the\s+)?order\s+delivery|live\s+delivery|delivery\s+update|delivery\s+progress|delivery\s+eta|delivery\s+timeline)\b/i,
    
    // 2. Undelivered / Pending delivery / Not delivered / Yet to be delivered
    /\b(?:haven'?t\s+been\s+delivered|hasn'?t\s+been\s+delivered|have\s+not\s+been\s+delivered|has\s+not\s+been\s+delivered|not\s+(?:yet\s+|been\s+|ever\s+)*delivered)\b/i,
    /\b(?:pending\s+deliver(?:y|ies)|undelivered|un-delivered|non-delivered|non\s+delivered|yet\s+to\s+be\s+delivered|waiting\s+(?:for\s+)?delivery|awaiting\s+delivery)\b/i,
    /\b(?:orders?\s+(?:that\s+)?(?:are\s+|have\s+)?(?:not\s+delivered|pending\s+delivery|in\s+transit|undelivered))\b/i,
    /\b(?:orders?\s+not\s+delivered|pending\s+orders?\s+not\s+delivered|orders?\s+pending\s+delivery|undelivered\s+(?:orders?|pos?|deals?|materials?|goods?))\b/i,
    
    // 3. Questions asking if delivered or when delivered
    /\b(?:has|have|is|was|will|got)\b.*\bdelivered\b/i,
    /\b(?:when\s+will\b.*\bdelivered)\b/i,
    
    // 4. Dispatch status / tracking / date / update
    /\b(?:dispatch\s+status|dispatched\s+status|dispatch\s+tracking|track\s+dispatch|dispatch\s+update|dispatch\s+details|dispatch\s+date|dispatched\s+date)\b/i,
    /\b(?:has|have|is|was|will|got)\b.*\bdispatched\b/i,
    /\b(?:when\s+will\b.*\bdispatched)\b/i,
    /\b(?:dispatched\s+yet|dispatched\s+kya|material\s+dispatched|order\s+dispatched)\b/i,
    
    // 5. In-transit, vehicle, truck & logistics tracking
    /\b(?:in\s+transit|material\s+in\s+transit|goods\s+in\s+transit|orders?\s+in\s+transit)\b/i,
    /\b(?:truck\s+status|truck\s+tracking|vehicle\s+tracking|vehicle\s+status|track\s+truck|track\s+vehicle|where\s+is\s+(?:the\s+|my\s+)?truck)\b/i,
    /\b(?:shipment\s+tracking|track\s+shipment|where\s+is\s+(?:the\s+|my\s+)?shipment|shipment\s+status|where\s+is\s+(?:the\s+|my\s+)?consignment)\b/i,
    /\b(?:logistics\s+status|logistics\s+tracking|transporter\s+details|transporter\s+status|lr\s+(?:no|number)|lorry\s+receipt|eway\s+bill|e-way\s+bill)\b/i,
    /\b(?:where\s+is\s+(?:my\s+|the\s+)?(?:order|delivery|material|consignment)\s*(?:currently|now|reached)?)\b/i,

    // 6. Hinglish delivery / dispatch / truck tracking questions
    /\b(?:deliver\s+(?:hua|ho\s+gaya|kab|nahi|ho\s+chuka))\b/i,
    /\b(?:delivery\s+(?:hui|kab|kahan|pending|nahi))\b/i,
    /\b(?:dispatch\s+(?:hua|ho\s+gaya|kab|nahi|kahan))\b/i,
    /\b(?:gaadi|truck|driver|vehicle)\b.*\b(?:nikli|nikla|kahan|kab|pahunch|aayeg|aaya)\b/i,
  ];

  return outOfScopePatterns.some((pattern) => pattern.test(lower));
}

function isOperationalQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // 1. Explicit greeting or navigation selections / confirmation buttons (Yes, No, Edit, Cancel, 1-10) are NOT queries
  if (/^(?:hi|hello|hey|namaste|yes|no|y|n|1|2|3|4|5|6|7|8|9|10|confirm|edit|cancel|save|discard|stop|exit|quit|upadte|update)$/i.test(lower)) {
    return false;
  }

  // 2. Explicit Operational Logging / Creation / Action Commands
  if (/^(?:log|record|add|create|raise|onboard|acquire)\s+(?:new\s+|a\s+|an\s+)?(?:inquiry|deal|order|visit|complaint|customer|acquisition|po)\b/i.test(lower)) {
    return false;
  }
  if (/^(?:update|change|modify|set|mark|close|resolve|reopen|upadte)\s+(?:the\s+|a\s+)?(?:inquiry|deal|order|visit|complaint|customer|rate|price|status|stage)\b/i.test(lower)) {
    return false;
  }

  // 3. Clear Read / Retrieval / Question Patterns
  if (
    /^(?:show|list|get|check|find|filter|tell me|give me|display|fetch|search|lookup|query|view|see|read|retrieve|track)\b/i.test(lower) ||
    /^(?:what|which|who|whom|whose|when|where|why|how|how many|how much|did we|is there|are there|can you show|can you tell|can you list|can you find|could you show|could you tell|could you list|do we have|have we)\b/i.test(lower) ||
    /\b(?:kya hai|batao|dikhao|dikhaye|kitne|kitna|kaun hai|kaun tha|kiska|kab hua|kahan|list karo|check karo|details batao|kya chal raha hai|kya rate hai|rate kya hai)\b/i.test(lower) ||
    /\b(?:what is the|what was the|what are the|how many|how much|status of|status for|status kya hai|outcome of|last rate|rates? quoted|pending complaints|closed complaints|my visits|my inquiries|my orders|my deals|details of|details for|history of|history for|summary of|summary for|info on|info about|report on|report for)\b/i.test(lower) ||
    lower.endsWith('?')
  ) {
    return true;
  }

  // 4. Standalone lookup terms
  if (/^(?:inquiry id|inquiry ids|deal id|deal ids|order id|order ids|complaint id|complaint ids|visit id|visit ids|summary|leaderboard|pipeline|radar|360|knowledge base|sop|moq|pricing sheet)\b/i.test(lower)) {
    return true;
  }

  return false;
}

/**
 * Fast LLM Query Classifier fallback
 * Classifies whether text is a read query / question vs operational data entry / command
 */
async function isOperationalQueryWithLLM(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 5) return false;
  const clean = text.trim();

  // If starts with clear action commands, not a query
  if (/^(?:1|2|3|4|5|6|7|8|9|10|yes|no|y|n|confirm|edit|cancel|save|discard|stop|exit|quit|upadte|update)$/i.test(clean)) return false;
  if (/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte)\b/i.test(clean)) return false;

  const prompt = `You are a strict classifier for a CRM WhatsApp Bot.
Classify whether this user message is a DATA RETRIEVAL / READ QUERY / SEARCH QUESTION or NOT.

User message: "${clean}"

Options:
- RETRIEVAL: User is asking a question to search, lookup, check status, inspect records, or read data from the database.
- OTHER: User is giving a command to update, create, log data, a general word/typo (like 'upadte', 'update', 'inquiry', 'deal'), or greeting.

Respond with ONLY "RETRIEVAL" or "OTHER".`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)]);
    const result = (typeof res.content === 'string' ? res.content : '').trim().toUpperCase();
    return result.includes('RETRIEVAL');
  } catch (err) {
    return false;
  }
}

/**
 * Recognizes direct stage transition requests on deals / inquiries
 * (e.g. "stage update to won", "mark deal for SS Industries as won", "deal won", "update stage to price quote for above inquiry", etc.)
 */
function isStageUpdatePrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  if (
    /\b(?:stage\s+update|update\s+stage|change\s+stage|set\s+stage|move\s+stage|upadte\s+(?:the\s+)?stage|update\s+(?:the\s+)?stage)\b/i.test(lower) ||
    /\b(?:mark|move|put|change|set|update|upadte)\s+(?:the\s+|a\s+)?(?:deal|inquiry|status|stage)?\s*(?:as\s+|to\s+)?(won|lost|negotiation|quoted|quotated|price\s*quote|price\s*quotation|on\s+hold|hold|new\s*inquiry)\b/i.test(lower) ||
    /\b(?:deal\s+won|deal\s+lost|inquiry\s+won|inquiry\s+lost|deal\s+quoted|deal\s+negotiation|deal\s+on\s+hold)\b/i.test(lower) ||
    /^(?:stage\s+(?:is\s+)?(?:to\s+)?(?:won|lost|negotiation|quoted|on\s+hold|price\s*quote)|marked?\s+(?:as\s+)?(?:won|lost|negotiation|quoted|on\s+hold|price\s*quote))\b/i.test(lower) ||
    /^(?:mark\s+as\s+won|mark\s+as\s+lost|mark\s+as\s+negotiation|mark\s+as\s+quoted|mark\s+as\s+price\s*quote|mark\s+as\s+on\s+hold)$/i.test(lower) ||
    /^(?:won|lost|negotiation|quoted|on\s+hold)$/i.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if incoming text is a data retrieval query (either by pattern or LLM).
 */
async function isMidFlowReadQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();

  // Standalone IDs or references for form fields are NOT mid-flow read queries
  if (/^(?:inq|po|ord|cmp|vis)[-_][a-z0-9]+/i.test(clean)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(clean)) return false;
  if (/^(?:option\s*)?[1-9]\.?$/i.test(clean)) return false;

  if (isOperationalQuery(clean)) return true;
  if (clean.length >= 8 && !/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte|edit|cancel|save|yes|no|discard|btn_)\b/i.test(clean)) {
    return await isOperationalQueryWithLLM(clean);
  }
  return false;
}

/**
 * Handles a read/retrieval query mid-flow without dropping or wiping the active catalog state.
 * Returns the answer along with a prompt to resume the active form and Yes/No quick action buttons.
 */
async function handleMidFlowRetrievalQuery(text, senderPhone, activeState, action, draft) {
  const { runOrchestrator } = require('./orchestrator');
  const queryAnswer = await runOrchestrator(text, senderPhone);

  const actionDisplayName = getModuleDisplayName(action);
  const resumeMsg = `You were in the middle of *${actionDisplayName}* — do you want to continue?`;
  const combinedReply = `${queryAnswer}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft)}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: RESUME_QUERY_BUTTONS,
  };
}

/**
 * Handles a complaint resolution request mid-flow without dropping or wiping the active catalog state.
 * Executes the complaint resolution in Supabase via handleComplaintResolution (kra8.js), logs it,
 * and appends the resume prompt with Yes/No quick action buttons.
 */
async function handleMidFlowComplaintResolution(text, senderPhone, activeState, action, draft) {
  const { handleComplaintResolution } = require('../kra8');
  const resolutionReply = await handleComplaintResolution(text, senderPhone);

  const actionDisplayName = getModuleDisplayName(action);
  const companyLabel = draft?.company_name ? ` for *${draft.company_name}*` : '';
  const resumeMsg = `You were in the middle of ${getActionFriendlyName(action)}${companyLabel} — do you want to continue?`;
  const combinedReply = `${resolutionReply}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft?.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft?.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: RESUME_QUERY_BUTTONS,
  };
}

/**
 * Handles a stage update request mid-flow without dropping or corrupting the active catalog state.
 * Executes the stage update directly against deals and inquiries tables in Supabase with pipeline validation,
 * confirms the update, and appends the resume prompt with Yes/No quick action buttons.
 */
async function handleMidFlowStageUpdate(text, senderPhone, activeState, action, draft) {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  // 1. Identify target stage
  let targetStage = null;
  let stageDisplayName = null;

  if (/\b(?:price\s*quote|price\s*quotation|quoted|quote|proposal|prop)\b/i.test(lower)) {
    targetStage = 'quoted';
    stageDisplayName = 'Price Quote';
  } else if (/\b(?:negotiat(?:ion|ing|e)?|negot)\b/i.test(lower)) {
    targetStage = 'negotiation';
    stageDisplayName = 'Negotiation';
  } else if (/\b(?:on\s*hold|hold)\b/i.test(lower)) {
    targetStage = 'on_hold';
    stageDisplayName = 'On Hold';
  } else if (/\b(?:won|closed\s*won|order\s*confirmed|order\s*placed|deal\s*won)\b/i.test(lower)) {
    targetStage = 'won';
    stageDisplayName = 'Closed Won';
  } else if (/\b(?:lost|closed\s*lost|deal\s*lost|cancelled|canceled|drop)\b/i.test(lower)) {
    targetStage = 'lost';
    stageDisplayName = 'Closed Lost';
  } else if (/\b(?:new\s*inquiry|new\s*enquiry|new)\b/i.test(lower)) {
    targetStage = 'new_inquiry';
    stageDisplayName = 'New Inquiry';
  }

  // 2. Identify target inquiry / deal ID
  let targetInqId = null;
  const directIdMatch = clean.match(/(?:^|[\s#(,])(?:INQ|DEAL)[-_:#\s]+([A-Za-z0-9_-]{4,36})\b/i) ||
    clean.match(/(?:^|[\s#(,])(?:INQ|DEAL)-?([A-Fa-f0-9]{4,36})\b/i) ||
    clean.match(/#([A-Fa-f0-9]{4,8})\b/i) ||
    clean.match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);

  if (directIdMatch) {
    const candidate = directIdMatch[1].replace(/^#+/, '').trim().toUpperCase();
    if (!/^(?:UIRY|UIRE|STATUS|UPDATE|STAGE|RATE|DETAILS?|NOTES?|WITH|FROM|FOR|THE|ABOVE|THIS|DEAL|ORDER)$/i.test(candidate)) {
      targetInqId = candidate;
    }
  }

  // If no explicit ID in text, or user said "above inquiry" / "this inquiry" / "it":
  if (!targetInqId) {
    if (draft && (draft.inquiry_id || draft.deal_id || draft._inquiry_display_id)) {
      const rawInq = draft.inquiry_id || draft.deal_id || draft._inquiry_display_id;
      targetInqId = String(rawInq).replace(/^#?(?:INQ|DEAL)[-_:#\s]*/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();
    }
  }

  // If targetStage or targetInqId is still missing, attempt LLM extraction
  if (!targetStage || !targetInqId) {
    try {
      const extractPrompt = `Extract the target deal/inquiry ID and new pipeline stage from the following message:
Message: "${clean}"
Active draft inquiry ID: "${draft?.inquiry_id || ''}"

Return ONLY JSON:
{
  "inquiry_id": "<Inquiry ID e.g. INQ-D013D7 or null>",
  "target_stage": "quoted|negotiation|on_hold|won|lost|new_inquiry|null"
}`;
      const res = await invokeWithFallback([new HumanMessage(extractPrompt)], null);
      const jsonParsed = safeParseJSON(res.content, {});
      if (!targetStage && jsonParsed.target_stage) {
        targetStage = jsonParsed.target_stage;
        const stageMap = {
          quoted: 'Price Quote',
          negotiation: 'Negotiation',
          on_hold: 'On Hold',
          won: 'Closed Won',
          lost: 'Closed Lost',
          new_inquiry: 'New Inquiry',
        };
        stageDisplayName = stageMap[targetStage] || targetStage;
      }
      if (!targetInqId && jsonParsed.inquiry_id) {
        targetInqId = String(jsonParsed.inquiry_id).replace(/^#?(?:INQ|DEAL)[-_:#\s]*/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();
      }
    } catch (e) {
      console.warn('[CatalogFlow] handleMidFlowStageUpdate LLM extraction notice:', e.message);
    }
  }

  if (!targetStage) {
    targetStage = 'quoted';
    stageDisplayName = 'Price Quote';
  }

  const cleanInqCode = targetInqId ? targetInqId.replace(/-/g, '').toUpperCase() : null;

  // 3. Query deals and inquiries in Supabase
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
  }

  const { data: deals } = await dealsQuery.limit(500);

  let deal = null;
  if (deals && deals.length > 0 && cleanInqCode) {
    deal = deals.find(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
    }) || null;
  }

  let inq = null;
  if (!deal && cleanInqCode) {
    let inqsQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
    }

    const { data: inqRows } = await inqsQuery.limit(500);
    if (inqRows && inqRows.length > 0) {
      for (const iRow of inqRows) {
        const iId = (iRow.id || '').replace(/-/g, '').toUpperCase();
        if (iId.startsWith(cleanInqCode) || iId.includes(cleanInqCode)) {
          inq = iRow;
          if (iRow.deals && iRow.deals.length > 0) {
            deal = iRow.deals[0];
          }
          break;
        }
      }
    }
  }

  // 3b. Unscoped fallback by explicit cleanInqCode if not found in scoped query
  if (!deal && !inq && cleanInqCode) {
    const { data: allDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (allDeals && allDeals.length > 0) {
      deal = allDeals.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
      }) || null;
    }

    if (!deal) {
      const { data: allInqRows } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(500);

      if (allInqRows && allInqRows.length > 0) {
        for (const iRow of allInqRows) {
          const iId = (iRow.id || '').replace(/-/g, '').toUpperCase();
          if (iId.startsWith(cleanInqCode) || iId.includes(cleanInqCode)) {
            inq = iRow;
            if (iRow.deals && iRow.deals.length > 0) {
              deal = iRow.deals[0];
            }
            break;
          }
        }
      }
    }
  }

  // 3c. Fallback by draft company_name ONLY if cleanInqCode was not provided or not matched
  if (!deal && !inq && draft?.company_name) {
    if (deals && deals.length > 0) {
      deal = deals.find(d => isCustomerMatch(draft.company_name, null, d.customer_name, null)) ||
             deals.find(d => d.customer_name && d.customer_name.toLowerCase().includes(draft.company_name.toLowerCase())) || null;
    }

    if (!deal) {
      const { data: matchInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(200);

      if (matchInqs && matchInqs.length > 0) {
        const matched = matchInqs.find(i => {
          const ai = i.ai_extraction_json || {};
          const cName = i.sender_name || ai.companyName || ai.customer_name || '';
          return isCustomerMatch(draft.company_name, null, cName, null);
        });
        if (matched) {
          inq = matched;
          if (matched.deals && matched.deals.length > 0) deal = matched.deals[0];
        }
      }
    }
  }

  // If no deal or inquiry found
  if (!deal && !inq) {
    const errorMsg = `❌ *Inquiry Not Found*\n\nCould not find an inquiry or deal matching ${targetInqId ? `"${targetInqId}"` : 'the specified reference'}.\n\nPlease check the Inquiry ID (e.g. INQ-D013D7) and try again.`;
    const actionDisplayName = getModuleDisplayName(action);
    const resumeMsg = `You were in the middle of *${actionDisplayName}* — do you want to continue?`;
    const combinedReply = `${errorMsg}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', combinedReply, { action_type: action });
    await saveActiveSession(senderPhone, draft?.company_name || 'Customer', `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`);

    return {
      handled: true,
      reply: combinedReply,
      interactiveType: 'buttons',
      interactiveButtons: RESUME_QUERY_BUTTONS,
    };
  }

  // 4. Validate Pipeline Stage Transition Rules
  const rawCurrentStage = (deal ? deal.stage : inq?.status) || 'new_inquiry';
  const currStageLower = String(rawCurrentStage).toLowerCase().trim();
  const formattedDisplayId = deal
    ? `INQ-${(deal.inquiry_id || deal.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`
    : `INQ-${inq.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

  let transitionError = null;

  // Rule: Cannot jump from New Inquiry directly to Won
  if (targetStage === 'won' && ['new_inquiry', 'new', 'auto_created', 'inquiry'].includes(currStageLower)) {
    transitionError = `Order cannot be marked as Won directly from New Inquiry stage. A quotation must be sent and the inquiry must be in Quoted stage before an order can be recorded.`;
  } else if (targetStage === 'won' && ['lost', 'closed lost', 'closed_lost'].includes(currStageLower)) {
    transitionError = `Inquiry ${formattedDisplayId} is marked as Lost. Please reopen or update the inquiry to Quoted or Negotiation before recording an order.`;
  }

  if (transitionError) {
    const actionDisplayName = getModuleDisplayName(action);
    const resumeMsg = `You were in the middle of *${actionDisplayName}* — do you want to continue?`;
    const combinedReply = `⚠️ ${transitionError}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', combinedReply, { action_type: action });
    await saveActiveSession(senderPhone, draft?.company_name || 'Customer', `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`);

    return {
      handled: true,
      reply: combinedReply,
      interactiveType: 'buttons',
      interactiveButtons: RESUME_QUERY_BUTTONS,
    };
  }

  // 5. Execute Stage Update against database
  if (deal) {
    const dealUpdates = {
      stage: targetStage,
    };
    if (targetStage === 'won' && !deal.won_at) {
      dealUpdates.won_at = new Date().toISOString();
    }
    const { error: dUpdErr } = await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
    if (dUpdErr) console.error('[CatalogFlow] handleMidFlowStageUpdate deal update error:', dUpdErr.message);
  }

  const targetInquiryId = deal?.inquiry_id || deal?.id || inq?.id;
  if (targetInquiryId) {
    const inqUpdates = {
      status: targetStage === 'won' ? 'confirmed' : targetStage,
    };
    const { data: inqRow } = await supabase.from('inquiries').select('id, ai_extraction_json').eq('id', targetInquiryId).single();
    if (inqRow && inqRow.ai_extraction_json) {
      inqUpdates.ai_extraction_json = {
        ...inqRow.ai_extraction_json,
        stage: targetStage,
        status: targetStage,
      };
    }
    const { error: iUpdErr } = await supabase.from('inquiries').update(inqUpdates).eq('id', targetInquiryId);
    if (iUpdErr) console.warn('[CatalogFlow] handleMidFlowStageUpdate inq update notice:', iUpdErr.message);
  }

  // Log to activity_logs
  try {
    const custName = draft?.company_name || deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName || 'Customer';
    logBotActivity({
      salesperson_phone: senderPhone,
      description: `Stage for ${formattedDisplayId} (${custName}) updated to ${stageDisplayName}`,
      module: 'Inquiries',
      customer_name: custName,
      entity_id: targetInquiryId,
      entity_type: 'inquiry',
      action_type: 'inquiry_updated',
      change_detail: { stage: targetStage },
    });
  } catch (actErr) {
    console.warn('[CatalogFlow] Activity log notice for handleMidFlowStageUpdate:', actErr?.message);
  }

  // 6. Build Confirmation and Resume Prompt
  if (draft) {
    if (!draft.inquiry_id && formattedDisplayId) {
      draft.inquiry_id = formattedDisplayId;
      draft._inquiry_display_id = formattedDisplayId;
    }
    if (!draft.company_name) {
      draft.company_name = deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName || null;
    }
  }

  const confirmationMsg = `Stage for ${formattedDisplayId} has been updated to ${stageDisplayName}.`;
  const actionDisplayName = getModuleDisplayName(action);
  const resumeMsg = `You were in the middle of the ${actionDisplayName} flow — do you want to continue?`;
  const combinedReply = `${confirmationMsg}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft?.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft?.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: RESUME_QUERY_BUTTONS,
  };
}

/**
 * Restores the exact interrupted flow state and re-prompts the exact pending question or summary.
 * Re-validates and auto-loads database entity records (Inquiry/Deal/Items) merged with user session data.
 */
async function restoreInterruptedFlow(senderPhone, interruptedState, action, draft) {
  const actionName = getActionFriendlyName(action);

  if (action === 'LOG_ORDER') {
    if (draft.inquiry_id || draft.deal_id || draft._inquiry_display_id) {
      const stageCheck = await validateOrderInquiryStage(draft, senderPhone);
      if (!stageCheck.isValid) {
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: stageCheck.reply,
        };
      }
    }

    if (draft.rate && Array.isArray(draft.line_items) && draft.line_items.length > 0) {
      const globalRate = Number(String(draft.rate).replace(/[^\d.]/g, '')) || 0;
      if (globalRate > 0) {
        draft.line_items = draft.line_items.map(it => {
          const qty = Number(it.quantity) || 0;
          const r = globalRate || it.rate;
          return {
            ...it,
            rate: r,
            amount: qty > 0 && r > 0 ? qty * r : (it.amount || 0),
          };
        });
      }
    }

    if (!draft.po_date) {
      draft.po_date = formatDateDDMMYYYY(new Date());
    }
    if (!draft.po_number) {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      draft.po_number = `PO-${todayStr}-${randomNum}`;
    }
    if (!draft.delivery_location) {
      draft.delivery_location = 'Standard / Ex-Works';
    }
    if (!draft.payment_terms) {
      draft.payment_terms = 'Standard Terms';
    }

    const missing = validateMandatoryFields('LOG_ORDER', draft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary('LOG_ORDER', draft);
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const askMissing = `Please provide the remaining mandatory details for this order:\n\n${missingList}`;
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  if (interruptedState === 'catalog_confirm') {
    const summary = buildConfirmationSummary(action, draft);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: summary,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_editing') {
    const editPrompt = getEditPromptForAction(action);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: editPrompt,
      interactiveType: 'buttons',
      interactiveButtons: DISCARD_DRAFT_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_implicit_cust_ask') {
    const askPrompt = `Is *${draft.company_name || 'this customer'}* a new customer you would like to onboard now?`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_cust_ask|${action}|${draft.company_name || 'Customer'}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askPrompt,
      interactiveType: 'buttons',
      interactiveButtons: NEW_CUSTOMER_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_implicit_cust_collect') {
    const missing = validateMandatoryFields('LOG_NEW_CUSTOMER', draft);
    const missingList = missing.map((m) => `• *${m}*`).join('\n');
    const askRemaining = `Please provide the remaining customer details for *${draft.company_name || 'Customer'}*:\n\n${missingList}`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_cust_collect|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askRemaining,
      interactiveType: 'buttons',
      interactiveButtons: DISCARD_DRAFT_BUTTONS,
    };
  }

  // Default: catalog_flow
  const missing = validateMandatoryFields(action, draft);
  if (missing.length === 0) {
    const summary = buildConfirmationSummary(action, draft);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: summary,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  } else {
    const missingList = missing.map((m) => `• *${m}*`).join('\n');
    const indexTag = draft._totalCount > 1 ? ` (${draft._currentIndex || 1} of ${draft._totalCount}: ${draft.company_name || 'Item'})` : '';
    const askMissing = `Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askMissing,
    };
  }
}

function detectOperationalAction(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();

  // If message is a pure query / search, do not intercept
  if (isOperationalQuery(lower)) return null;

  // 1. Customer Acquisition
  if (
    /\b(?:new\s+customer|customer\s+acquisition|onboard\s+customer|add\s+customer|acquire\s+customer|register\s+customer|nayi\s+party|naya\s+customer|customer\s+onboarding)\b/i.test(lower)
  ) {
    return 'LOG_NEW_CUSTOMER';
  }

  // 2. Complaint patterns (prioritized so complaints citing POs or Inquiries are categorized as complaints)
  if (
    /\b(?:complaint|defect|defective|damaged\s+material|rust\s+on|rusty|short\s+delivery|wrong\s+material|rejection|rejected\s+material|material\s+return|wapas\s+kiya|issue\s+aa\s+gaya|quality\s+issue|bad\s+material|damaged\s+coils|damaged\s+sheets)\b/i.test(lower)
  ) {
    if (/\b(?:update|change|modify|set|mark\s+as\s+resolved|mark\s+resolved|resolve|resolved|close|reopen|correct|fix|edit)\b/i.test(lower)) {
      return 'UPDATE_COMPLAINT';
    }
    return 'LOG_COMPLAINT';
  }

  // 3. New Order / PO Received patterns (prioritized before generic po- ID updates)
  if (
    /\b(?:purchase\s+order\s+received|po\s+received|received\s+purchase\s+order|received\s+po|order\s+confirmed|new\s+order|booked\s+order|order\s+logged|order\s+recorded)\b/i.test(lower) ||
    /^\s*(?:log|record|new)\s+(?:purchase\s+order|order|po)\b/i.test(lower)
  ) {
    return 'LOG_ORDER';
  }

  // 4. Visit / Meeting patterns
  if (
    /\b(?:visit(?:ed|ing|s)?|met\b|meet(?:ing)?(?:\s+(?:with|at|in|up|to))?|had\s+a\s+visit|had\s+a\s+meeting|site\s+visit|field\s+visit|client\s+visit|market\s+visit|office\s+visit|factory\s+visit|went\s+to(?:\s+meet)?|gaya\s+tha|mila\s+aaj|milne\s+gaye|visit\s+kiya|visit\s+report)\b/i.test(lower) ||
    /\b(?:visit\s+outcome|person\s+met|discussion\s+notes|meeting\s+remarks|neutral\s+response|positive\s+response|negative\s+response)\b/i.test(lower)
  ) {
    if (/\b(?:update|change|modify|edit|correct|amend)\b/i.test(lower)) {
      return 'UPDATE_VISIT';
    }
    return 'LOG_VISIT';
  }

  // 5. Direct sales agent operations (stage transitions on existing deals) -> UPDATE_INQUIRY
  if (
    /\b(?:mark|move|put)\b.*?\b(negotiation|won|lost|quoted|quotated|on\s+hold|hold)\b/i.test(lower) ||
    /\b(?:is\s+on\s+hold|is\s+lost|is\s+won|is\s+negotiation|is\s+quoted|deal\s+won|deal\s+lost)\b/i.test(lower)
  ) {
    return 'UPDATE_INQUIRY';
  }

  // 6. Standalone rate/quantity updates on existing deals -> UPDATE_INQUIRY
  if (
    /^(?:make\s+the\s+quantity|update\s+rate|change\s+rate|set\s+rate|rate\s+is\b|rate\s+for\b|quantity\s+for\b|change\s+quantity|update\s+quantity)/i.test(lower)
  ) {
    return 'UPDATE_INQUIRY';
  }

  // 7. Explicit ID-based updates (requires update/link verb or standalone ID input)
  if (/\b(?:attach|link|set|update|modify|change|edit)\b.*?\b(?:po-|\bpo\b)/i.test(lower) || /^\s*po-[a-z0-9-]+\s*$/i.test(lower)) {
    return 'UPDATE_ORDER';
  }
  if (/\b(?:inq-)\b/i.test(lower)) {
    if (/\b(?:attach|link|set|update)\b.*?\b(?:po-|\bpo\b)/i.test(lower)) return 'UPDATE_ORDER';
    if (/\b(?:update|change|modify|set|edit|revise)\b/i.test(lower) || /^\s*inq-[a-z0-9-]+\s*$/i.test(lower)) {
      return 'UPDATE_INQUIRY';
    }
  }
  if (/\b(?:vis-)\b/i.test(lower) && /\b(?:update|change|modify|set|edit)\b/i.test(lower)) {
    return 'UPDATE_VISIT';
  }

  // 8. Explicit Update patterns
  if (/\b(?:update|change|modify|set|mark|resolve|close|reopen|attach|link|add\s+po|correct|fix|edit|amend|revise|increase|decrease|reduce|adjust|make)\b/i.test(lower)) {
    // 8a. Complaints
    if (
      /\b(?:complaint|complaints|defect|defective|rejection|damage|damaged|rust)\b/i.test(lower) ||
      /\b(?:mark\s+as\s+resolved|mark\s+resolved|resolve\s+complaint|close\s+complaint|reopen\s+complaint)\b/i.test(lower)
    ) {
      return 'UPDATE_COMPLAINT';
    }

    // 8b. Visits
    if (/\b(?:visit|vis-|site\s+visit|field\s+visit|meeting|person\s+met|contact\s+person)\b/i.test(lower)) {
      return 'UPDATE_VISIT';
    }

    // 8c. Orders
    if (/\b(?:order|orders|purchase\s+order|po\s*no|po\s*number|delivery\s*date|po\s*date|attach\s+po|link\s+po|attach\s+(?:the\s+)?po|set\s+po)\b/i.test(lower)) {
      return 'UPDATE_ORDER';
    }

    // 8d. Inquiries
    if (/\b(?:inquiry|inquiries|deal|deals|quote|quotation|rfq|rate|price|quantity|qty|specs|terms)\b/i.test(lower)) {
      if (/\b(?:po[-_:#\s]*\d+|po\s*no|po\s*number|purchase\s*order)\b/i.test(lower) && /\b(?:attach|link|set)\b/i.test(lower)) {
        return 'UPDATE_ORDER';
      }
      return 'UPDATE_INQUIRY';
    }
  }

  // 9. Order / PO patterns (fallback)
  if (
    /\b(?:purchase\s+order|po\s+received|received\s+po|order\s+confirmed|po-\d+|po\s*no|po\s*number|order\s+logged|order\s+recorded|deal\s+won|new\s+order|booked\s+order|order\s+for)\b/i.test(lower) ||
    /^\s*(?:po|purchase\s+order)\b/i.test(lower)
  ) {
    return 'LOG_ORDER';
  }

  // 10. Inquiry / Requirements patterns
  if (
    /\b(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|rfqs|deal|deals)\b/i.test(lower) ||
    /\b(?:quote|quotes|quotation|quotations|price|pricing|rates?|bhav)\b/i.test(lower) ||
    /\b(?:chahiye|manga|pucha|mang\s+rahe|zaroorat|needs?|requires?|wants?|demands?|asking\s+for|interested\s+in)\b/i.test(lower) ||
    /\b(?:party|client|customer|buyer|company)\s*(?:name)?\s*[:=-]\s*/i.test(lower) ||
    /\b(?:material|product|item|items|description)\s*[:=-]\s*/i.test(lower) ||
    /\b(?:qty|quantity|tonnage|tons?|mt|weight)\s*[:=-]\s*/i.test(lower) ||
    /\b(?:ek\s+)?inquiry\s+(?:aayi\s+hai|aayi|mili|hai)\b/i.test(lower) ||
    /\b(?:log|create|new|add|record|enter|save)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|deal)\b/i.test(lower) ||
    /\b(?:new\s+)?deal\s+(?:for|from|with|creation|logging)\b/i.test(lower) ||
    // Steel product mentioned together with numeric quantity
    (/\b(?:coil|coils|sheet|sheets|plate|plates|structural|beam|beams|channel|channels|pipe|pipes|tube|tubes|tmt|angle|angles|round|flat|square|metal|steel|hr|cr|hrpo|gp|galvalume|chequered)\b/i.test(lower) && /\b\d+(?:\.\d+)?\s*(?:mt|tons?|tonne|kg|pcs|nos|pieces|sheets|plates|coils|bundles|lengths)\b/i.test(lower))
  ) {
    return 'LOG_INQUIRY';
  }

  return null;
}

/**
 * Intelligent Fast LLM Intent Classifier
 * Used as a fallback when rule-based patterns do not trigger, ensuring NO inquiry or CRM prompt is ever missed.
 */
async function detectOperationalActionWithLLM(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 5) return null;
  const clean = text.trim();

  const prompt = `You are the Intent Classification Router for Enlight Metals CRM WhatsApp Bot.
Classify the operational action intended in this salesperson message:
"${clean}"

Possible Actions:
- LOG_INQUIRY: User is sharing a customer inquiry, steel requirement, RFQ, price quote request, customer needing steel material/quantities, multi-item specification, or rate request.
- LOG_ORDER: User is recording a confirmed purchase order with PO number / date.
- LOG_VISIT: User is reporting a customer site visit, field meeting, or discussion notes.
- LOG_COMPLAINT: User is reporting damaged material, quality issue, shortage, or customer complaint.
- LOG_NEW_CUSTOMER: User is creating/onboarding a brand new customer company.
- UPDATE_INQUIRY: User is modifying an existing inquiry or changing fields of an inquiry.
- UPDATE_ORDER: User is updating an order or attaching a PO to an inquiry.
- UPDATE_VISIT: User is updating an existing visit report.
- UPDATE_COMPLAINT: User is updating an existing complaint.
- QUERY: User is asking a question or querying database records.
- NONE: General casual text, greeting, or unclear.

Respond ONLY with the single exact action name (e.g. LOG_INQUIRY) or NONE. No formatting, no extra text.`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)]);
    const rawAction = (typeof res.content === 'string' ? res.content : '').trim().replace(/[*_`]/g, '').toUpperCase();
    const validActions = [
      'LOG_INQUIRY',
      'LOG_ORDER',
      'LOG_VISIT',
      'LOG_COMPLAINT',
      'LOG_NEW_CUSTOMER',
      'UPDATE_INQUIRY',
      'UPDATE_ORDER',
      'UPDATE_VISIT',
      'UPDATE_COMPLAINT',
    ];

    for (const act of validActions) {
      if (rawAction === act || rawAction.startsWith(act)) {
        return act;
      }
    }
  } catch (err) {
    console.warn('[CatalogFlow] LLM intent detection notice:', err.message);
  }

  return null;
}

const DIRECT_ACTION_MAP = [
  // 1. Customer Acquisition
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:log|record|add|create|onboard|acquire)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?customer\b/i, action: 'LOG_NEW_CUSTOMER' },
  { pattern: /^\s*(?:new\s+customer\s+acquisition|customer\s+acquisition|new\s+customer\s+onboarding)\b/i, action: 'LOG_NEW_CUSTOMER' },

  // 2. Complaints Update
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:update|resolve|change|modify|close|reopen|set|mark)\s+(?:the\s+|a\s+)?(?:customer\s+)?complaint\b/i, action: 'UPDATE_COMPLAINT' },
  { pattern: /\b(?:mark|set)\s+(?:the\s+)?complaint\s+(?:as\s+)?(?:resolved|closed|pending|in progress|reopened)\b/i, action: 'UPDATE_COMPLAINT' },
  { pattern: /\b(?:resolve|close|reopen)\s+(?:the\s+)?complaint\b/i, action: 'UPDATE_COMPLAINT' },

  // 3. Complaints Log
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:log|record|raise|report|register|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?complaint\b/i, action: 'LOG_COMPLAINT' },
  { pattern: /^\s*(?:log|record|raise|register|new)\s+complaint\b/i, action: 'LOG_COMPLAINT' },

  // 4. Visits Update
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:update|change|modify|set|correct|fix|edit|amend|revise)\s+(?:the\s+|a\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'UPDATE_VISIT' },

  // 5. Visits Log
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:log|record|add|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'LOG_VISIT' },
  { pattern: /^\s*(?:log|record|new)\s+(?:field\s*|customer\s*|site\s*)?visit\b/i, action: 'LOG_VISIT' },

  // 6. Orders Update
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:update|change|modify)\s+(?:the\s+|a\s+)?(?:purchase\s+)?order\b/i, action: 'UPDATE_ORDER' },
  { pattern: /\b(?:attach|link|update)\s+(?:the\s+)?po\s*(?:no|number|#)?\s+(?:to|for)\b/i, action: 'UPDATE_ORDER' },

  // 7. Orders Log
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:record|log|create|add|place|enter)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:purchase\s+)?order\b/i, action: 'LOG_ORDER' },
  { pattern: /^\s*(?:log|record|create|new)\s+(?:purchase\s+)?order\b/i, action: 'LOG_ORDER' },

  // 8. Inquiries Update
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:update|edit|modify|change|correct|revise|amend)\s+(?:an?\s+|the\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|deal|deals)\b/i, action: 'UPDATE_INQUIRY' },
  { pattern: /\b(?:mark|move|put)\s+(?:the\s+|a\s+)?(?:deal|inquiry)?\s*(?:as\s+|to\s+)?(?:won|lost|negotiation|quoted|on\s+hold|hold)\b/i, action: 'UPDATE_INQUIRY' },

  // 9. Inquiries Log
  { pattern: /\b(?:i\s+want\s+(?:to\s+)?)?(?:log|create|new|add|record|enter|save)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|deal)\b/i, action: 'LOG_INQUIRY' },
  { pattern: /^\s*(?:log|create|new)\s+(?:inquiry|enquiry|rfq|deal)\b/i, action: 'LOG_INQUIRY' },
];

async function classifyActiveSessionIntent(activeActivity, text) {
  if (!activeActivity || !text || typeof text !== 'string') return { classification: 'SAME_ACTIVITY' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { classification: 'SAME_ACTIVITY' };

  // 1. Standalone reference IDs (INQ-*, PO-*, CMP-*, VIS-*, hex UUIDs) are field inputs for active draft
  const isPureRefId = /^#?(?:INQ|DEAL|PO|VIS|CMP|ORD)[-_][A-Z0-9-]+$/i.test(trimmed) ||
    /^[A-F0-9]{6,36}$/i.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(trimmed) ||
    /^#?[A-F0-9]{6,8}$/i.test(trimmed);
  if (isPureRefId) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 2. Candidate disambiguation selections (1, 2, option 1, date strings) are field inputs
  if (/^(?:option\s*|choice\s*|#\s*)?[1-9]\.?$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 3. Pure payment terms, credit terms, or durations (e.g. "45 days", "30 days credit", "advance", "online", "50 days term")
  if (/^\s*(?:\d+\s*(?:days?|din|months?|weeks?)(?:\s*(?:credit|term|terms|advance|net|payment|after\s+delivery))?|100%\s*advance|advance|immediate|pdc|lc|cad|credit|online|rtgs|neft|against\s+delivery|cash\s+on\s+delivery|cod)\s*$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 4. Shorthand customer contact inputs (e.g. "tarak mehta,8945561223" or "Rajesh Sharma 9820123456")
  if (/^[a-zA-Z\s]{2,40}[,\s]+[6-9]\d{9}$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 5. Pure numeric quantities / rates / dimensions
  if (/^\s*₹?\s*\d+(?:,\d+)*(?:\.\d+)?\s*(?:\/\s*mt|\/\s*ton|\/\s*kg|per\s*mt|per\s*ton|mt|ton|tons|tonne|kg|pcs|nos|pieces|mm)?\s*$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  const currentFamily = getModuleFamily(activeActivity);
  const activityDisplayName = getModuleDisplayName(activeActivity);

  const prompt = `You are a strict conversational intent classifier for an active B2B sales workflow session on WhatsApp.

The user is currently in the active [${activeActivity}] (${activityDisplayName}) workflow.
Incoming message: "${trimmed}"

Classify this incoming message:
- If this message is requesting to update, change, set, move, or mark the stage/status of an inquiry or deal (e.g. "update the stage to price quote for above inquiry", "update stage to quoted", "mark as negotiation", "move to on hold", "set status to price quote", "stage won", "set stage to lost") -> STAGE_UPDATE
- If this message is reporting or logging a customer complaint, quality issue, defect, damage, rust, shortage, service problem, or delivery issue -> DIFFERENT_ACTIVITY:LOG_COMPLAINT
- If this message is recording or logging a purchase order / PO -> DIFFERENT_ACTIVITY:LOG_ORDER
- If this message is logging a new customer inquiry, requirement, or RFQ -> DIFFERENT_ACTIVITY:LOG_INQUIRY
- If this message is onboarding a new customer profile -> DIFFERENT_ACTIVITY:LOG_NEW_CUSTOMER
- If this message is logging a customer field visit / client meeting -> DIFFERENT_ACTIVITY:LOG_VISIT
- If this message provides field details (payment terms e.g. "45 days" / "advance", delivery location e.g. "Mumbai" / "Kolhapur", person met, contact phone, meeting remarks, visit date, outcome, company name, rate, tonnage, quantity, notes, make) for the active [${activeActivity}] (${activityDisplayName}) form -> SAME_ACTIVITY
- If this message is asking a read-only data query or search (asking for rates, checking status, listing inquiries, checking orders) -> RETRIEVAL_QUERY

Respond strictly with ONLY the classification label on a single line, nothing else. Valid responses:
SAME_ACTIVITY
DIFFERENT_ACTIVITY:LOG_COMPLAINT
DIFFERENT_ACTIVITY:LOG_VISIT
DIFFERENT_ACTIVITY:LOG_ORDER
DIFFERENT_ACTIVITY:LOG_INQUIRY
DIFFERENT_ACTIVITY:LOG_NEW_CUSTOMER
DIFFERENT_ACTIVITY:UPDATE_VISIT
DIFFERENT_ACTIVITY:UPDATE_COMPLAINT
RETRIEVAL_QUERY
STAGE_UPDATE

Classification:`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)], null);
    const raw = (typeof res.content === 'string' ? res.content : '').trim().replace(/[*`]/g, '');
    console.log('[CatalogFlow] AI active session intent classifier raw response:', JSON.stringify(raw));

    if (/STAGE_UPDATE/i.test(raw)) {
      return { classification: 'STAGE_UPDATE' };
    }

    const diffMatch = raw.match(/DIFFERENT_?ACTIVITY(?:\s*:\s*([A-Z_]+))?/i);
    if (diffMatch) {
      let target = (diffMatch[1] || '').trim().toUpperCase();
      if (!target || target === 'OTHER') {
        target = 'LOG_COMPLAINT';
      }
      const targetFamily = getModuleFamily(target);
      if (targetFamily !== 'OTHER' && targetFamily !== currentFamily) {
        return { classification: 'DIFFERENT_ACTIVITY', targetAction: target };
      }
      return { classification: 'SAME_ACTIVITY' };
    }

    if (/RETRIEVAL_QUERY/i.test(raw)) {
      return { classification: 'RETRIEVAL_QUERY' };
    }

    if (/SAME_ACTIVITY/i.test(raw)) {
      if (isStageUpdatePrompt(trimmed)) {
        return { classification: 'STAGE_UPDATE' };
      }
      // Check if deterministic regex detects a clear cross-module action that LLM might have missed
      const fallbackDiff = detectOutOfScopeActionAttempt(activeActivity, trimmed);
      if (fallbackDiff) {
        return { classification: 'DIFFERENT_ACTIVITY', targetAction: fallbackDiff };
      }
      return { classification: 'SAME_ACTIVITY' };
    }
  } catch (err) {
    console.warn('[CatalogFlow] AI active session intent classifier notice:', err.message);
  }

  // Deterministic fallback if model call failed or was ambiguous
  if (isStageUpdatePrompt(trimmed)) {
    return { classification: 'STAGE_UPDATE' };
  }

  const fallbackDiff = detectOutOfScopeActionAttempt(activeActivity, trimmed);
  if (fallbackDiff) {
    return { classification: 'DIFFERENT_ACTIVITY', targetAction: fallbackDiff };
  }

  if (isOperationalQuery(trimmed)) {
    return { classification: 'RETRIEVAL_QUERY' };
  }

  return { classification: 'SAME_ACTIVITY' };
}

function detectOutOfScopeActionAttempt(currentAction, text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const currentFamily = getModuleFamily(currentAction);

  // 1. If user sent an explicit menu command (1-10 or menu_X)
  const menuAction = matchActionFromInput(trimmed);
  if (menuAction && menuAction !== currentAction) {
    const menuFamily = getModuleFamily(menuAction);
    if (menuFamily !== 'OTHER' && menuFamily !== currentFamily) {
      return menuAction;
    }
  }

  // 2. If the input is primarily a reference ID (INQ-*, PO-*, VIS-*, CMP-*, or hex code),
  // it is data for the active draft (e.g. inquiry_id for LOG_ORDER, po_number for LOG_COMPLAINT).
  // Do NOT treat reference IDs as a switch action!
  const isPureRefId = /^#?(?:INQ|DEAL|PO|VIS|CMP)-[A-Z0-9-]+$/i.test(trimmed) ||
    /^[A-F0-9]{6,36}$/i.test(trimmed) ||
    /^#?[A-F0-9]{6,8}$/i.test(trimmed);
  if (isPureRefId) return null;

  // 3. Check DIRECT_ACTION_MAP for explicit cross-module action intents
  for (const entry of DIRECT_ACTION_MAP) {
    if (entry.pattern.test(trimmed) && entry.action !== currentAction) {
      const targetFamily = getModuleFamily(entry.action);
      if (targetFamily !== 'OTHER' && targetFamily !== currentFamily) {
        return entry.action;
      }
    }
  }

  return null;
}

async function detectNewOperationalIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();

  // If message is a pure query / search, do not intercept
  if (isOperationalQuery(lower)) return null;

  // 1. Menu selection
  const matchedMenuAction = matchActionFromInput(text);
  if (matchedMenuAction) return matchedMenuAction;

  // 2. Direct action regex map
  for (const { pattern, action } of DIRECT_ACTION_MAP) {
    if (pattern.test(text)) {
      return action;
    }
  }

  // 3. Operational action detector
  const opAction = detectOperationalAction(text);
  if (opAction) return opAction;

  // 4. Fallback fast LLM intent classifier
  if (text.length >= 8) {
    const llmAction = await detectOperationalActionWithLLM(text);
    if (llmAction && llmAction !== 'QUERY') return llmAction;
  }

  return null;
}

// ── MAIN CATALOG FLOW HANDLER ────────────────────────────────────────────────

/**
 * Main entry point called by webhook before delegating to LangGraph orchestrator.
 * Returns:
 * { handled: true, reply: "..." } if intercepted and handled by catalog state machine
 * { handled: false } if message should proceed to general LangGraph Orchestrator
 */
async function handleCatalogFlow(rawText, senderPhone) {
  if (!rawText || typeof rawText !== 'string') return { handled: false };
  const text = rawText.trim();
  if (text.length === 0) return { handled: false };

  // ── 1. GREETING CHECK ──────────────────────────────────────────────────────
  if (isGreeting(text)) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    await startNewCatalogSession(senderPhone, CATALOG_MENU);
    return {
      handled: true,
      reply: CATALOG_MENU,
      interactiveType: 'list',
      interactiveList: {
        bodyText: `Welcome to *SalesOS Assistant*!\n\nHere is the menu to start a new activity:`,
        buttonText: 'Choose Action',
        sections: CATALOG_MENU_SECTIONS,
      },
    };
  }

  // ── 1b. OUT-OF-SCOPE DELIVERY / DISPATCH QUERY CHECK ─────────────────────────
  if (isOutOfScopeDeliveryQuery(text)) {
    const outOfScopeMsg = `ℹ️ *Delivery & Dispatch Tracking is Out of Scope*\n\nOrder delivery, shipment, and dispatch tracking are not currently within my scope.\n\nPlease ask questions related to Inquiries, Won Orders, Customer Visits, Complaints, Payments, or Customer Master records.`;
    await recordSessionMessage(senderPhone, 'assistant', outOfScopeMsg);
    return {
      handled: true,
      reply: outOfScopeMsg,
    };
  }

  // ── 2. FETCH ACTIVE SESSION STATE ──────────────────────────────────────────
  const activeSession = await getFullActiveSession(senderPhone);
  let lastIntent = activeSession ? (activeSession.last_intent || '') : '';

  // If currently in a dedicated webhook rejection/payment/unit flow, do not intercept
  if (lastIntent.startsWith('pending_')) {
    return { handled: false };
  }

  const hasActiveCatalogSession = lastIntent.startsWith('catalog_');

  // ── 2a. DIRECT EXPLICIT MENU SELECTION (PREEMPTION) ────────────────────────
  // When user selects any option from catalog list ([Choose Action] or direct action commands),
  // immediately clean up any prior flow and start the newly selected module prompt.
  const explicitAction = isExplicitMenuSelection(text, hasActiveCatalogSession);
  if (explicitAction) {
    if (hasActiveCatalogSession) {
      await finalizeCurrentSession(senderPhone, `Switched to ${getActionFriendlyName(explicitAction)}`);
    }
    await recordSessionMessage(senderPhone, 'user', text);

    if (explicitAction === 'GENERAL_QUERY') {
      const genReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
      await recordSessionMessage(senderPhone, 'assistant', genReply, { action_type: 'GENERAL_QUERY' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: genReply,
      };
    }

    const initialPrompt = MODULE_PROMPTS[explicitAction];
    if (initialPrompt) {
      await startNewCatalogSession(senderPhone, initialPrompt);
      await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: explicitAction });
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${explicitAction}|{}`);
      return {
        handled: true,
        reply: initialPrompt,
      };
    }
  }

  // ── 2b. ACTIVE SESSION SCOPE GUARD (AI INTENT CLASSIFICATION) ──────────────
  if (
    hasActiveCatalogSession &&
    !lastIntent.startsWith('catalog_resume_ask|') &&
    !lastIntent.startsWith('catalog_implicit_cust_ask|') &&
    !lastIntent.startsWith('catalog_implicit_cust_collect|')
  ) {
    const cleanInput = text.toLowerCase().replace(/[^a-z0-9\s_/]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = lastIntent.split('|');
    const activeState = parts[0];
    const currentAction = parts[1];
    const currentDraft = safeParseJSON(parts.slice(2).join('|'), {});

    // Check if user is resolving a complaint mid-flow
    const { isComplaintResolution } = require('../kra8');
    if (isComplaintResolution(text)) {
      return await handleMidFlowComplaintResolution(text, senderPhone, activeState, currentAction, currentDraft);
    }

    const isControlReply =
      isDiscardOrCancelIntent(text) ||
      isDiscardOrCancelIntent(cleanInput) ||
      [
        'yes', 'y', '1', 'confirm', 'save', 'haan', 'ha', 'sahi hai', 'ok', 'sure', 'save / yes', 'save/yes', 'save yes',
        'edit', 'change', '2', 'edit details',
        'cancel', 'discard', 'no', 'n', '3', 'stop', 'exit', 'quit', 'nahi', 'wrong', 'galat',
        'btn_confirm_yes', 'btn_confirm_edit', 'btn_confirm_cancel'
      ].includes(cleanInput);

    if (!isControlReply) {
      // AI Intent Classifier: Classify every non-control incoming message against active session
      const intentResult = await classifyActiveSessionIntent(currentAction, text);
      console.log(`[CatalogFlow] Active session (${currentAction}) AI classification for "${text.slice(0, 50)}...":`, intentResult);

      if (intentResult.classification === 'RETRIEVAL_QUERY') {
        return await handleMidFlowRetrievalQuery(text, senderPhone, activeState, currentAction, currentDraft);
      }

      if (intentResult.classification === 'STAGE_UPDATE') {
        return await handleMidFlowStageUpdate(text, senderPhone, activeState, currentAction, currentDraft);
      }

      if (intentResult.classification === 'DIFFERENT_ACTIVITY') {
        console.log(`[CatalogFlow] Strict activity scope guard: active=${currentAction}, incoming=${intentResult.targetAction}`);
        await recordSessionMessage(senderPhone, 'user', text);
        const outOfScopeRes = buildOutOfScopeActivityResponse(currentAction, intentResult.targetAction);
        await recordSessionMessage(senderPhone, 'assistant', outOfScopeRes.reply, { action_type: 'OUT_OF_SCOPE_REDIRECT' });
        // NOTE: Session state remains 100% intact in the background. DO NOT overwrite or finalize!
        return outOfScopeRes;
      }
      // If SAME_ACTIVITY, proceed into the flow below!
    }
  }

  // ── 3-0. HANDLE RESUME ASK STATE (catalog_resume_ask|interruptedState|action|draftJson) ──
  if (lastIntent.startsWith('catalog_resume_ask|')) {
    const parts = lastIntent.split('|');
    const interruptedState = parts[1] || 'catalog_flow';
    const action = parts[2] || 'LOG_INQUIRY';
    const draftJsonStr = parts.slice(3).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // 1. User says YES -> restore the interrupted flow exactly
    if (
      cleanInput === 'btn_resume_yes' ||
      cleanInput === 'yes, continue' ||
      cleanInput === 'yes continue' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === 'haan' ||
      cleanInput === 'ha' ||
      cleanInput === 'continue' ||
      cleanInput === 'resume' ||
      cleanInput === 'proceed' ||
      cleanInput === 'sure' ||
      cleanInput === 'ok'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const res = await restoreInterruptedFlow(senderPhone, interruptedState, action, draft);
      await recordSessionMessage(senderPhone, 'assistant', res.reply, {
        action_type: action,
        customer_name: draft.company_name || null,
      });
      return res;
    }

    // 2. User says NO / Cancel / Menu -> finalize and show catalog
    if (
      cleanInput === 'btn_resume_no' ||
      cleanInput === 'no, go to menu' ||
      cleanInput === 'no go to menu' ||
      cleanInput === 'no' ||
      cleanInput === 'n' ||
      cleanInput === 'nahi' ||
      cleanInput === 'menu' ||
      cleanInput === 'cancel' ||
      cleanInput === 'discard' ||
      cleanInput === 'btn_post_menu' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft after query interruption`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      const exitMsg = `Activity cancelled.\n\n` + CATALOG_MENU;
      await recordSessionMessage(senderPhone, 'assistant', exitMsg, { action_type: 'CATALOG_MENU' });
      return {
        handled: true,
        reply: exitMsg,
        interactiveType: 'list',
        interactiveList: {
          bodyText: 'Here is the menu to start a new activity:',
          buttonText: 'Choose Action',
          sections: CATALOG_MENU_SECTIONS,
        },
      };
    }

    // 3. User asks mid-resume complaint resolution, stage update, or retrieval query
    const { isComplaintResolution } = require('../kra8');
    if (isComplaintResolution(text)) {
      return await handleMidFlowComplaintResolution(text, senderPhone, interruptedState, action, draft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, interruptedState, action, draft);
    }
    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, interruptedState, action, draft);
    }

    // 4. User directly provides field data / response for the interrupted flow
    lastIntent = `${interruptedState}|${action}|${draftJsonStr}`;
  }

  // ── 3a. HANDLE IMPLICIT CUSTOMER CONFIRMATION ASK (catalog_implicit_cust_ask|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_ask|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const unrecognizedName = parts[2];
    const originalDraftJsonStr = parts.slice(3).join('|');
    const originalDraft = safeParseJSON(originalDraftJsonStr, {});

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Check mid-flow interruptions
    const { isComplaintResolution } = require('../kra8');
    if (isComplaintResolution(text)) {
      return await handleMidFlowComplaintResolution(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }
    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }

    // User confirmed YES (This is a new customer) or provided customer details
    const isDirectCustDetails = /\b[6-9]\d{9}\b/.test(text) || (cleanInput.includes('yes') && text.length > 5);
    if (
      isDirectCustDetails ||
      cleanInput === 'btn_cust_yes' ||
      cleanInput === 'yes, add customer' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === '1' ||
      cleanInput === 'confirm' ||
      cleanInput === 'haan' ||
      cleanInput === 'ha' ||
      cleanInput === 'sahi hai' ||
      cleanInput === 'ok' ||
      cleanInput === 'sure' ||
      cleanInput === 'new customer' ||
      cleanInput === 'add'
    ) {
      let custDraft = {
        action: 'LOG_NEW_CUSTOMER',
        company_name: unrecognizedName,
        contact_person: originalDraft.person_met || originalDraft.contact_person || null,
        mobile_number: originalDraft.contact_phone || originalDraft.mobile_number || originalDraft.phone || null,
        delivery_location: originalDraft.delivery_location || originalDraft.city_location || originalDraft.location || originalDraft.address || null,
        email: originalDraft.email || null,
        gst_number: originalDraft.gst_number || null,
        _parentAction: originalAction,
        _parentDraft: originalDraft,
      };

      if (isDirectCustDetails) {
        custDraft = await extractFieldsWithLLM('LOG_NEW_CUSTOMER', text, custDraft);
      }

      const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', custDraft);

      if (custMissing.length === 0) {
        // All customer mandatory fields already supplied (e.g. from field visit or direct input)
        await executeAction('LOG_NEW_CUSTOMER', custDraft, senderPhone);

        forwardCustomerDetailsToParentDraft(originalAction, originalDraft, custDraft);
        const custProdCheck = validateDraftProducts(originalAction, originalDraft);
        if (!custProdCheck.isValid) {
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n${custProdCheck.clarificationMessage}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
          return { handled: true, reply: resumeMsg };
        }

        const parentMissing = validateMandatoryFields(originalAction, originalDraft);

        if (parentMissing.length === 0) {
          const summary = buildConfirmationSummary(originalAction, originalDraft);
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n` +
            `Now continuing with your ${getActionFriendlyName(originalAction)}:\n\n${summary}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
          return {
            handled: true,
            reply: resumeMsg,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          const parentMissingList = parentMissing.map(m => `• *${m}*`).join('\n');
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n` +
            `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${parentMissingList}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
          return { handled: true, reply: resumeMsg };
        }
      } else {
        const missingList = custMissing.map(m => `• *${m}*`).join('\n');
        const askCustMsg = `👤 *New Customer Acquisition — ${unrecognizedName}*\n\n` +
          `Please provide the required customer details before we continue with your ${getActionFriendlyName(originalAction)}:\n\n` +
          `${missingList}\n\n` +
          `_(e.g. "Contact Person: Rajesh Sharma, Mobile: 9820123456, Delivery Location: Bhosari Pune")_`;

        await recordSessionMessage(senderPhone, 'assistant', askCustMsg, {
          action_type: 'LOG_NEW_CUSTOMER',
          customer_name: unrecognizedName,
        });
        await saveActiveSession(senderPhone, unrecognizedName, `catalog_implicit_cust_collect|${originalAction}|${JSON.stringify(custDraft)}`);
        return { handled: true, reply: askCustMsg };
      }
    }

    // User confirmed NO (Not a new customer -> re-enter correct name)
    if (
      cleanInput === 'btn_cust_no' ||
      cleanInput === 'no / cancel' ||
      cleanInput === 'no/cancel' ||
      cleanInput === 'no' ||
      cleanInput === 'n' ||
      cleanInput === 'nahi' ||
      cleanInput === 'wrong' ||
      cleanInput === 'galat' ||
      cleanInput === 'cancel'
    ) {
      originalDraft.company_name = null;
      const assignedList = await getAssignedCustomersList(senderPhone);
      const listDisplay = assignedList && assignedList.length > 0
        ? `\n\n*Your Assigned Accounts:*\n` + assignedList.slice(0, 10).map((c, i) => `  ${i + 1}. *${c.customer_name}*`).join('\n')
        : '';

      const reEnterPrompt = `Understood! 👍 Please reply with the correct *Company Name* so we can proceed with your ${getActionFriendlyName(originalAction)}.${listDisplay}\n\n` +
        `_(Your other entered details have been preserved)_`;

      await recordSessionMessage(senderPhone, 'assistant', reEnterPrompt, {
        action_type: originalAction,
      });
      await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
      return { handled: true, reply: reEnterPrompt };
    }

    // If user directly typed the correct company name
    const recheckedName = await verifyAndGetCustomerName(text, senderPhone);
    if (recheckedName) {
      originalDraft.company_name = recheckedName;
      const recheckProd = validateDraftProducts(originalAction, originalDraft);
      if (!recheckProd.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', recheckProd.clarificationMessage, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: recheckProd.clarificationMessage };
      }

      const parentMissing = validateMandatoryFields(originalAction, originalDraft);
      if (parentMissing.length === 0) {
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        await recordSessionMessage(senderPhone, 'assistant', summary, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: summary,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const missingList = parentMissing.map(m => `• *${m}*`).join('\n');
        const askMissing = `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${missingList}`;
        await recordSessionMessage(senderPhone, 'assistant', askMissing, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: askMissing };
      }
    }

    const retryPrompt = `Please reply *Yes* to onboard *${unrecognizedName}* as a new customer, or *No* to re-enter the company name.`;
    await recordSessionMessage(senderPhone, 'assistant', retryPrompt);
    return {
      handled: true,
      reply: retryPrompt,
      interactiveType: 'buttons',
      interactiveButtons: NEW_CUSTOMER_BUTTONS,
    };
  }

  // ── 3b. HANDLE IMPLICIT CUSTOMER DETAILS COLLECTION (catalog_implicit_cust_collect|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_collect|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const custDraftJsonStr = parts.slice(2).join('|');
    const custDraft = safeParseJSON(custDraftJsonStr, {});

    await recordSessionMessage(senderPhone, 'user', text);

    if (isDiscardOrCancelIntent(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Discarded customer onboarding flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    // Check mid-flow interruptions
    const { isComplaintResolution } = require('../kra8');
    if (isComplaintResolution(text)) {
      return await handleMidFlowComplaintResolution(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }

    const intentResult = await classifyActiveSessionIntent('LOG_NEW_CUSTOMER', text);
    if (intentResult.classification === 'RETRIEVAL_QUERY') {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }
    if (intentResult.classification === 'DIFFERENT_ACTIVITY') {
      console.log(`[CatalogFlow] Strict activity scope guard in customer collect: active=LOG_NEW_CUSTOMER, incoming=${intentResult.targetAction}`);
      const outOfScopeRes = buildOutOfScopeActivityResponse('LOG_NEW_CUSTOMER', intentResult.targetAction);
      await recordSessionMessage(senderPhone, 'assistant', outOfScopeRes.reply, { action_type: 'OUT_OF_SCOPE_REDIRECT' });
      return outOfScopeRes;
    }

    const updatedCustDraft = await extractFieldsWithLLM('LOG_NEW_CUSTOMER', text, custDraft);
    const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', updatedCustDraft);

    if (custMissing.length === 0) {
      await executeAction('LOG_NEW_CUSTOMER', updatedCustDraft, senderPhone);

      const originalDraft = updatedCustDraft._parentDraft || {};
      forwardCustomerDetailsToParentDraft(originalAction, originalDraft, updatedCustDraft);
      const collectProdCheck = validateDraftProducts(originalAction, originalDraft);
      if (!collectProdCheck.isValid) {
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n${collectProdCheck.clarificationMessage}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: resumeMsg };
      }
      const parentMissing = validateMandatoryFields(originalAction, originalDraft);

      if (parentMissing.length === 0) {
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n` +
          `Now continuing with your ${getActionFriendlyName(originalAction)}:\n\n${summary}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: resumeMsg,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const parentMissingList = parentMissing.map(m => `• *${m}*`).join('\n');
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n` +
          `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${parentMissingList}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: resumeMsg };
      }
    } else {
      const missingList = custMissing.map(m => `• *${m}*`).join('\n');
      const askRemaining = `Please provide the remaining customer details for *${updatedCustDraft.company_name}*:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askRemaining, {
        action_type: 'LOG_NEW_CUSTOMER',
        customer_name: updatedCustDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedCustDraft.company_name, `catalog_implicit_cust_collect|${originalAction}|${JSON.stringify(updatedCustDraft)}`);
      return { handled: true, reply: askRemaining };
    }
  }

  // ── 3c. HANDLE CONFIRMATION STATE (catalog_confirm|...) ──────────────────────
  if (lastIntent.startsWith('catalog_confirm|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_confirm', action, draft);
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Confirm YES
    if (
      cleanInput === 'btn_confirm_yes' ||
      cleanInput === 'save / yes' ||
      cleanInput === 'save/yes' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === '1' ||
      cleanInput === 'confirm' ||
      cleanInput === 'save' ||
      cleanInput === 'haan' ||
      cleanInput === 'sahi hai' ||
      cleanInput === 'ok' ||
      cleanInput === 'sure'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);

      // Verify customer before final execution
      const custCheck = await verifyDraftCustomer(action, draft, senderPhone);
      if (!custCheck.isValid) {
        if (custCheck.isUnrecognizedCustomer) {
          await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
          await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(draft)}`);
          return { handled: true, reply: custCheck.prompt };
        } else {
          draft.company_name = null;
          await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
          await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
          return { handled: true, reply: custCheck.rejectionMessage };
        }
      }

      const reply = await executeAction(action, draft, senderPhone);
      await recordSessionMessage(senderPhone, 'assistant', reply, {
        action_type: action,
        customer_name: draft.company_name,
        po_number: draft.po_number,
        inquiry_id: draft.inquiry_id,
      });

      // Check if there are queued entries (e.g. 2nd customer visit/inquiry)
      if (draft._queue && Array.isArray(draft._queue) && draft._queue.length > 0) {
        const nextEntry = draft._queue.shift();
        nextEntry._queue = draft._queue;
        nextEntry._totalCount = draft._totalCount || (draft._queue.length + 2);
        nextEntry._currentIndex = (draft._currentIndex || 1) + 1;
        const nextAction = nextEntry.action || action;
        const missing = validateMandatoryFields(nextAction, nextEntry);

        if (missing.length === 0) {
          const summary = buildConfirmationSummary(nextAction, nextEntry);
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's confirm the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\n${summary}\n\n💡 _Tip: To skip or finish without logging for ${nextEntry.company_name}, reply "cancel" or "discard"._`;
          await recordSessionMessage(senderPhone, 'assistant', nextPrompt, {
            action_type: nextAction,
            customer_name: nextEntry.company_name,
          });
          await saveActiveSession(senderPhone, nextEntry.company_name || 'Customer', `catalog_confirm|${nextAction}|${JSON.stringify(nextEntry)}`);
          return {
            handled: true,
            reply: nextPrompt,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          const missingList = missing.map((m) => `• *${m}*`).join('\n');
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's complete the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\nPlease provide the remaining mandatory details:\n\n${missingList}\n\n💡 _Tip: To skip or finish without logging for ${nextEntry.company_name}, reply "cancel" or "discard"._`;
          await recordSessionMessage(senderPhone, 'assistant', nextPrompt, {
            action_type: nextAction,
            customer_name: nextEntry.company_name,
          });
          await saveActiveSession(senderPhone, nextEntry.company_name || 'Customer', `catalog_flow|${nextAction}|${JSON.stringify(nextEntry)}`);
          return {
            handled: true,
            reply: nextPrompt,
          };
        }
      }

      await finalizeCurrentSession(senderPhone, null, {
        action_type: action,
        customer_name: draft.company_name,
        po_number: draft.po_number,
        inquiry_id: draft.inquiry_id,
        extracted_data: draft,
      });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply,
        interactiveType: 'buttons',
        interactiveButtons: getPostActivityButtons(action),
      };
    }

    // Request EDIT
    if (
      cleanInput === 'btn_confirm_edit' ||
      cleanInput === 'edit details' ||
      cleanInput === 'edit' ||
      cleanInput === 'change' ||
      cleanInput === 'modify' ||
      cleanInput === 'update' ||
      cleanInput === '2'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const editPrompt = getEditPromptForAction(action);
      await recordSessionMessage(senderPhone, 'assistant', editPrompt);
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${draftJsonStr}`);
      return {
        handled: true,
        reply: editPrompt,
      };
    }

    // CANCEL / DISCARD
    if (
      cleanInput === 'btn_confirm_cancel' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft for ${draft.company_name || 'customer'}`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: cancelReply,
      };
    }

    // Check if user is attempting a write operation for a different module
    const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
    if (outOfScopeAction) {
      console.log(`[CatalogFlow] Strict activity scope guard in catalog_confirm: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
      return buildOutOfScopeActivityResponse(action, outOfScopeAction);
    }

    // Direct inline edit attempt during confirmation
    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = await extractFieldsWithLLM(action, text, draft);
    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    const confirmProdCheck = validateDraftProducts(action, updatedDraft);
    if (!confirmProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', confirmProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: confirmProdCheck.clarificationMessage };
    }

    const missing = validateMandatoryFields(action, updatedDraft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    }

    const retryPrompt = `Please reply with:\n• *Yes* — to save\n• *Edit* — to change a field\n• *Cancel* — to discard`;
    await recordSessionMessage(senderPhone, 'assistant', retryPrompt);
    return {
      handled: true,
      reply: retryPrompt,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  // ── 4. HANDLE EDITING STATE (catalog_editing|...) ───────────────────────────
  if (lastIntent.startsWith('catalog_editing|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Cancel during edit
    if (
      cleanInput === 'btn_confirm_cancel' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft during edit`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    // Edit button tapped again while already in edit mode
    if (cleanInput === 'btn_confirm_edit' || cleanInput === 'edit details' || cleanInput === 'edit') {
      const alreadyEditMsg = `You are currently editing this draft. ${getEditPromptForAction(action)}`;
      return { handled: true, reply: alreadyEditMsg };
    }

    // Check if user is attempting a write operation for a different module
    const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
    if (outOfScopeAction) {
      console.log(`[CatalogFlow] Strict activity scope guard in catalog_editing: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
      return buildOutOfScopeActivityResponse(action, outOfScopeAction);
    }

    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = await extractFieldsWithLLM(action, text, draft);
    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.prompt };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    if (action === 'LOG_COMPLAINT') {
      const ordCheck = await checkOrdersForComplaint(action, updatedDraft, senderPhone, text);
      if (ordCheck && ordCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, { action_type: 'LOG_COMPLAINT' });
        await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|LOG_COMPLAINT|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
        return { handled: true, reply: ordCheck.reply };
      }
      if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
    }

    const editProdCheck = validateDraftProducts(action, updatedDraft);
    if (!editProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', editProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: editProdCheck.clarificationMessage };
    }

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      let askMissing = '';
      if (updatedDraft._permissionNotice) {
        askMissing += `${updatedDraft._permissionNotice}\n\n`;
      }
      askMissing += `Let's finish your ${actionName}${indexTag} first. Please provide the missing mandatory details:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // ── 5. HANDLE DATA COLLECTION FLOW STATE (catalog_flow|...) ────────────────
  if (lastIntent.startsWith('catalog_flow|')) {
    const parts = lastIntent.split('|');
    let action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    let existingDraft = safeParseJSON(draftJsonStr, {});

    await recordSessionMessage(senderPhone, 'user', text);

    // Check if resolving candidate visit selection (by date or number)
    let candidateResolved = false;
    if (existingDraft._visit_candidates && Array.isArray(existingDraft._visit_candidates)) {
      const numIdx = extractCandidateIndex(text, existingDraft._visit_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null && numIdx >= 1 && numIdx <= existingDraft._visit_candidates.length) {
        matchedCandidate = existingDraft._visit_candidates[numIdx - 1];
      } else {
        const normInputDate = normalizeDateToDDMMYYYY(text);
        matchedCandidate = existingDraft._visit_candidates.find(c =>
          c.date === normInputDate ||
          (c.visited_at && c.visited_at.startsWith(parseDDMMYYYYtoISO(normInputDate) || 'NOMATCH')) ||
          text.includes(c.date) ||
          (c.date && text.replace(/[-/.]/g, '').includes(c.date.replace(/[-/.]/g, '')))
        );
      }

      if (matchedCandidate) {
        existingDraft.visit_id = matchedCandidate.id;
        existingDraft.visit_date = matchedCandidate.date;
        delete existingDraft._visit_candidates;
        candidateResolved = true;

        const isPureSelect = isPureOptionSelectorOnly(text);
        const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
          Boolean(existingDraft.person_met || existingDraft.contact_phone || existingDraft.visit_outcome || existingDraft.meeting_remarks);

        if (isPureSelect && !hasUpdates) {
          const prompt = `✏️ **Selected Field Visit for ${matchedCandidate.company_name || 'Customer'} (${matchedCandidate.date}):**\n\n` +
            `- **Person Met:** ${matchedCandidate.person_met || 'Not specified'}\n` +
            `- **Visit Outcome:** ${matchedCandidate.outcome || 'Not specified'}\n` +
            `- **Remarks:** ${matchedCandidate.remarks || 'Not specified'}\n\n` +
            `What details would you like to update?\n` +
            `_(e.g., Person Met, Outcome to Positive, Remarks, or Follow-up Action)_`;

          await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return { handled: true, reply: prompt };
        }
      }
    }

    // Check if resolving candidate inquiry selection (by ID or number)
    let inquiryCandidateResolved = false;
    if (existingDraft._inquiry_candidates && Array.isArray(existingDraft._inquiry_candidates)) {
      const numIdx = extractCandidateIndex(text, existingDraft._inquiry_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null && numIdx >= 1 && numIdx <= existingDraft._inquiry_candidates.length) {
        matchedCandidate = existingDraft._inquiry_candidates[numIdx - 1];
      } else {
        const cleanText = text.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        matchedCandidate = existingDraft._inquiry_candidates.find(c => {
          const cDisplay = (c.displayId || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cId = (c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          return cleanText.length >= 3 && (cleanText.includes(cDisplay) || cDisplay.includes(cleanText) || cleanText.includes(cId) || cId.includes(cleanText));
        });
      }

      if (matchedCandidate) {
        existingDraft.inquiry_id = matchedCandidate.id;
        existingDraft.company_name = matchedCandidate.company_name;
        existingDraft._inquiry_display_id = matchedCandidate.displayId;
        delete existingDraft._inquiry_candidates;
        inquiryCandidateResolved = true;

        const isPureSelect = isPureOptionSelectorOnly(text);
        const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
          (Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0);

        if (isPureSelect && !hasUpdates) {
          const prompt = `✏️ **Selected Inquiry ${matchedCandidate.displayId} (${matchedCandidate.company_name}):**\n\n` +
            `- **Date:** ${matchedCandidate.date}\n` +
            `- **Stage:** ${matchedCandidate.stage}\n` +
            `- **Product / Requirement:** ${matchedCandidate.productSummary}\n` +
            `- **Payment Terms:** ${matchedCandidate.payment_terms}\n` +
            `- **Delivery Location:** ${matchedCandidate.delivery_location}\n\n` +
            `What details would you like to update?\n` +
            `_(e.g., Rate, Quantity, Delivery Location, Payment Terms, or Stage)_`;

          await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return { handled: true, reply: prompt };
        }
      }
    }

    // Check if resolving candidate order selection for LOG_COMPLAINT or UPDATE_ORDER (by number, PO, or INQ)
    let orderCandidateResolved = false;
    if (existingDraft._order_candidates && Array.isArray(existingDraft._order_candidates)) {
      const numIdx = extractCandidateIndex(text, existingDraft._order_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null && numIdx >= 1 && numIdx <= existingDraft._order_candidates.length) {
        matchedCandidate = existingDraft._order_candidates[numIdx - 1];
      } else {
        const cleanText = text.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*/i, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        matchedCandidate = existingDraft._order_candidates.find(c => {
          const cDealCode = (c.deal_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cCleanCode = (c.clean_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cPo = (c.po_number || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cId = (c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          return (
            (cleanText.length >= 2 && cPo && (cleanText.includes(cPo) || cPo.includes(cleanText))) ||
            (cleanText.length >= 3 && (cDealCode.includes(cleanText) || cleanText.includes(cDealCode) || cCleanCode === cleanText || cId.startsWith(cleanText)))
          );
        });
      }

      if (matchedCandidate) {
        existingDraft.deal_id = matchedCandidate.effective_deal_id || matchedCandidate.inquiry_id || matchedCandidate.id;
        existingDraft.po_number = matchedCandidate.po_number || null;
        existingDraft.linked_inquiry_or_po = matchedCandidate.po_number
          ? `PO: ${matchedCandidate.po_number} (${matchedCandidate.deal_code})`
          : matchedCandidate.deal_code;
        const dealProduct = matchedCandidate.product_summary || (matchedCandidate.items && matchedCandidate.items.length > 0 ? matchedCandidate.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
        const isCatProd = existingDraft.affected_product && isValidCatalogProduct(existingDraft.affected_product);
        if ((!existingDraft.affected_product || !isCatProd) && dealProduct) {
          existingDraft.affected_product = dealProduct;
        } else if (isCatProd) {
          const norm = normalizeProductToCatalog(existingDraft.affected_product);
          if (norm.catalogName) existingDraft.affected_product = norm.catalogName;
        }
        delete existingDraft._order_candidates;
        orderCandidateResolved = true;

        if (action === 'UPDATE_ORDER') {
          const isPureSelect = isPureOptionSelectorOnly(text);
          const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
            (Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0);

          if (isPureSelect && !hasUpdates) {
            const prompt = `✏️ **Selected Order ${matchedCandidate.po_number ? `PO: ${matchedCandidate.po_number}` : matchedCandidate.deal_code} (${matchedCandidate.customer_name || 'Customer'}):**\n\n` +
              `- **Date:** ${matchedCandidate.po_date || matchedCandidate.dateFormatted || 'Not specified'}\n` +
              `- **Stage:** ${matchedCandidate.stage || 'Won'}\n` +
              `- **Total Value:** ₹${Number(matchedCandidate.total_amount || 0).toLocaleString('en-IN')}\n\n` +
              `What details would you like to update?\n` +
              `_(e.g., Attach PO Number, Delivery Location, Payment Terms, Rate, or Quantity)_`;

            await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
            await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
            return { handled: true, reply: prompt };
          }
        }
      }
    }

    // Check if user wants to abort / switch (only if not resolving candidate selection)
    if (isDiscardOrCancelIntent(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Discarded ${getActionFriendlyName(action)} flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: cancelReply,
      };
    }

    // Check if user wants to abort / switch (only if not resolving candidate selection)
    if (!candidateResolved && !inquiryCandidateResolved && !orderCandidateResolved) {
      if (text.trim().toLowerCase() === 'general query' || text.trim() === '10' || text.trim() === '10.' || text.trim() === 'menu_10') {
        const queryReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
        await recordSessionMessage(senderPhone, 'assistant', queryReply, { action_type: 'GENERAL_QUERY' });
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return {
          handled: true,
          reply: queryReply,
        };
      }

      const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
      if (outOfScopeAction) {
        console.log(`[CatalogFlow] Strict activity scope guard in catalog_flow: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
        return buildOutOfScopeActivityResponse(action, outOfScopeAction);
      }
    }

    // Check if user is clarifying an ambiguous/invalid product from prior prompt
    const existingProdCheck = validateDraftProducts(action, existingDraft);
    if (!existingProdCheck.isValid && existingProdCheck.invalidProducts.length > 0) {
      const resolvedProd = resolveClarifiedProduct(text, existingProdCheck.invalidProducts[0]);
      if (resolvedProd) {
        if (Array.isArray(existingDraft.line_items) && existingDraft.line_items.length > 0) {
          existingDraft.line_items.forEach((it) => {
            const itNorm = normalizeProductToCatalog(it.sku_text, it.dimensions);
            if (!itNorm.isValid) {
              it.sku_text = resolvedProd;
              it.description = resolvedProd;
              it.is_valid_catalog = true;
            }
          });
        }
        if (existingDraft.product_description) {
          const invRegex = new RegExp(existingProdCheck.invalidProducts[0], 'gi');
          existingDraft.product_description = existingDraft.product_description.replace(invRegex, resolvedProd);
        }
        if (existingDraft.affected_product) {
          existingDraft.affected_product = resolvedProd;
        }
      }
    }

    // Extract fields from user message
    const isPureCandidateSelection = (candidateResolved || inquiryCandidateResolved || orderCandidateResolved) && isPureOptionSelectorOnly(text);

    const updatedDraft = isPureCandidateSelection
      ? { ...existingDraft }
      : await extractFieldsWithLLM(action, text, existingDraft);

    const preserveKeys = [
      'visit_id', 'visit_date', 'inquiry_id', '_inquiry_display_id',
      'deal_id', 'po_number', 'linked_inquiry_or_po', 'affected_product',
      'complaint_type', 'complaint_description', 'company_name',
      'rate', '_customer_verified', '_new_customer_created'
    ];
    for (const key of preserveKeys) {
      if (existingDraft[key] !== undefined && (updatedDraft[key] === undefined || updatedDraft[key] === null || updatedDraft[key] === '')) {
        updatedDraft[key] = existingDraft[key];
      }
    }
    if (existingDraft._inquiry_display_id && !updatedDraft._inquiry_display_id) {
      updatedDraft._inquiry_display_id = existingDraft._inquiry_display_id;
    }

    // 0. LOG_ORDER Inquiry Quoted Stage Gate check
    if (action === 'LOG_ORDER') {
      const stageCheck = await validateOrderInquiryStage(updatedDraft, senderPhone);
      if (!stageCheck.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', stageCheck.reply, { action_type: action });
        await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: stageCheck.reply };
      }
    }

    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    const flowProdCheck = validateDraftProducts(action, updatedDraft);
    if (!flowProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', flowProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: flowProdCheck.clarificationMessage };
    }

    // 1. UPDATE_INQUIRY candidate check & ID verification
    if (action === 'UPDATE_INQUIRY' && (updatedDraft.inquiry_id || updatedDraft.company_name)) {
      const inqCheck = await checkInquiriesForUpdate(action, updatedDraft, senderPhone, text);
      if (inqCheck && inqCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', inqCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (inqCheck.status === 'MULTIPLE_EDITABLE' || inqCheck.status === 'SINGLE_EDITABLE_ASK_DETAILS' || inqCheck.status === 'ID_NOT_FOUND') {
          await saveActiveSession(senderPhone, (inqCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(inqCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: inqCheck.reply };
      }
      if (inqCheck && inqCheck.draft) Object.assign(updatedDraft, inqCheck.draft);
    }

    // 2. UPDATE_ORDER candidate check & ID verification
    if (action === 'UPDATE_ORDER' && (updatedDraft.inquiry_id || updatedDraft.po_number || updatedDraft.company_name)) {
      const ordCheck = await checkOrdersForUpdate(action, updatedDraft, senderPhone, text);
      if (ordCheck && ordCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (ordCheck.status === 'ASK_DETAILS' || ordCheck.status === 'ID_NOT_FOUND') {
          await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: ordCheck.reply };
      }
      if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
    }

    // 3. UPDATE_COMPLAINT candidate check & reference verification
    if (action === 'UPDATE_COMPLAINT' && (updatedDraft.linked_inquiry_or_po || updatedDraft.company_name || updatedDraft.complaint_id)) {
      const cmpCheck = await checkComplaintsForUpdate(action, updatedDraft, senderPhone, text);
      if (cmpCheck && cmpCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', cmpCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (cmpCheck.status === 'ASK_DETAILS' || cmpCheck.status === 'NOT_FOUND') {
          await saveActiveSession(senderPhone, (cmpCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(cmpCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: cmpCheck.reply };
      }
      if (cmpCheck && cmpCheck.draft) Object.assign(updatedDraft, cmpCheck.draft);
    }

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      // Disambiguation check if multiple visits exist for the customer and date was not specified
      if (action === 'UPDATE_VISIT') {
        const disambig = await checkMultipleVisitsForUpdate(action, updatedDraft, senderPhone);
        if (disambig.needsDisambiguation) {
          await recordSessionMessage(senderPhone, 'assistant', disambig.prompt, {
            action_type: action,
            customer_name: updatedDraft.company_name,
          });
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(disambig.draft)}`);
          return { handled: true, reply: disambig.prompt };
        }
      }

      // Order validation & disambiguation for LOG_COMPLAINT if not yet bound to a deal
      if (action === 'LOG_COMPLAINT' && !updatedDraft.deal_id) {
        const ordCheck = await checkOrdersForComplaint(action, updatedDraft, senderPhone, text);
        if (ordCheck && ordCheck.handled) {
          await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, {
            action_type: action,
            customer_name: updatedDraft.company_name,
          });
          if (ordCheck.status === 'MULTIPLE_ORDERS' || ordCheck.status === 'ORDER_NOT_FOUND') {
            await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
          } else {
            await saveActiveSession(senderPhone, 'Unknown', 'general');
          }
          return { handled: true, reply: ordCheck.reply };
        }
        if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
      }

      // All mandatory fields present -> Show confirmation summary
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      // Missing mandatory fields -> Ask only for missing fields
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      let askMissing = '';
      if (updatedDraft._permissionNotice) {
        askMissing += `${updatedDraft._permissionNotice}\n\n`;
      }
      askMissing += `Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // ── 6. DIRECT ACTION ROUTING (Menu Selection 1-10 or Action Keywords) ────────
  const matchedAction = matchActionFromInput(text);
  if (matchedAction) {
    await recordSessionMessage(senderPhone, 'user', text);
    if (matchedAction === 'GENERAL_QUERY') {
      const genReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
      await recordSessionMessage(senderPhone, 'assistant', genReply, { action_type: 'GENERAL_QUERY' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: genReply,
      };
    }

    const initialPrompt = MODULE_PROMPTS[matchedAction];
    if (initialPrompt) {
      await startNewCatalogSession(senderPhone, initialPrompt);
      await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: matchedAction });
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${matchedAction}|{}`);
      return { handled: true, reply: initialPrompt };
    }
  }

  // ── 7. FREE DATA RETRIEVAL QUERIES (Direct DB Lookup, No Catalog, No Flow) ──
  let isQuery = isOperationalQuery(text);
  if (!isQuery && text.length >= 8 && !/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte|edit|cancel|save)\b/i.test(text)) {
    isQuery = await isOperationalQueryWithLLM(text);
  }

  if (isQuery) {
    return { handled: false };
  }

  // ── 8. ALL OTHER MESSAGES OUTSIDE ACTIVE SESSION -> STRICT CATALOG GATING ──
  // Per architecture requirement:
  // Direct write logging outside an active catalog flow is disabled.
  // All write activities (Log/Update Inquiry, Order, Field Visit, Customer Acquisition, Complaint)
  // MUST strictly be initiated via Catalog Menu selection (1–10 / buttons).
  // Direct free-text input in idle state is reserved exclusively for read-only data queries.
  await recordSessionMessage(senderPhone, 'user', text);
  const gatingReply = `To start an activity, please select the relevant option from the menu below:\n\nHere is the menu to start a new activity:\n\n` + CATALOG_MENU;
  await recordSessionMessage(senderPhone, 'assistant', gatingReply, { action_type: 'CATALOG_GATED_PROMPT' });
  await startNewCatalogSession(senderPhone, gatingReply);
  return {
    handled: true,
    reply: gatingReply,
    interactiveType: 'list',
    interactiveList: {
      bodyText: `Here is the menu to start a new activity:`,
      buttonText: 'Choose Action',
      sections: CATALOG_MENU_SECTIONS,
    },
  };
}

module.exports = {
  CATALOG_MENU,
  MODULE_PROMPTS,
  isGreeting,
  matchActionFromInput,
  isExplicitMenuSelection,
  validateMandatoryFields,
  buildConfirmationSummary,
  executeAction,
  handleCatalogFlow,
  isOperationalQuery,
  isStageUpdatePrompt,
  detectOperationalAction,
  extractFieldsWithLLM,
  mergeDraft,
  validateOrderInquiryStage,
  checkInquiriesForUpdate,
  checkOrdersForUpdate,
  checkComplaintsForUpdate,
  isCustomerMatch,
  cleanLegalSuffixes,
  extractFollowUpDate,
  parseDDMMYYYYtoISO,
  formatDateDDMMYYYY,
  getPostActivityButtons,
  RESUME_QUERY_BUTTONS,
  restoreInterruptedFlow,
  handleMidFlowStageUpdate,
  classifyActiveSessionIntent,
  validateDraftProducts,
  resolveClarifiedProduct,
};
