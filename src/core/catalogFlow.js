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
} = require('../supabase');
const { detectHsnCode } = require('../utils/hsnDetector');
const { safeParseJSON } = require('../utils/jsonUtils');
const {
  startNewCatalogSession,
  recordSessionMessage,
  finalizeCurrentSession,
} = require('./sessionManager');

function cleanPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// ── CATALOG MENU ─────────────────────────────────────────────────────────────

const CATALOG_MENU = `👋 Welcome to *SalesOS Assistant*!

What would you like to do today?

*1️⃣ Log New Inquiry*
*2️⃣ Update Inquiry*
*3️⃣ Log New Order*
*4️⃣ Update Order*
*5️⃣ Log Customer Field Visit*
*6️⃣ Update Field Visit*
*7️⃣ New Customer Acquisition*
*8️⃣ Log Customer Complaint*
*9️⃣ Update Customer Complaint*
*🔟 Other / General Query*

Reply with a number (1–10) or type what you'd like to do.`;

// ── MODULE COLLECTION PROMPTS ────────────────────────────────────────────────

const MODULE_PROMPTS = {
  LOG_INQUIRY: `📋 *Log New Inquiry*

Please provide the following details. Fields marked with * are mandatory:

• *Company Name:* *
• *Product Description / Quantity:* *
• *Rate:* (optional)
• *Preferred Make:* (optional)
• *Payment Terms:* *
• *Delivery Location:* *
• *Additional Notes:* (optional)

You can reply in any format — just include the field names or values in order.`,

  UPDATE_INQUIRY: `✏️ *Update Inquiry*

• *Inquiry ID:* * (e.g. INQ-2026-0042)

Which fields do you want to update? Mention the field name and new value.

*Updatable Fields:*
• Product Description / Quantity
• Rate
• Preferred Make
• Payment Terms
• Delivery Location
• Additional Notes
• Status (Open / Quoted / Won / Lost / On Hold)

Example:
"INQ-2026-0042, update rate to 54000, payment terms to 45 days credit, status to Quoted"`,

  LOG_ORDER: `🛒 *Record New Order*

Please provide the following details. Fields marked with * are mandatory:

• *Company Name:* *
• *PO Number:* * (e.g. PO-2026-0042)
• *PO Date:* * (e.g. 10-09-2026)
• *Delivery Location:* *
• *Payment Terms:* *

• *Line Items:* * (repeat for each product)
  - Product Name / Description
  - Spec
  - HSN/SAC Code
  - Quantity & Unit
  - Rate (₹ per unit)`,

  UPDATE_ORDER: `✏️ *Update Order*

• *PO Number:* * (e.g. PO-2026-0042)

What would you like to update?

*Updatable Header Fields:*
• PO Date
• Delivery Location
• Payment Terms
• Status (Pending / Processing / Dispatched / Delivered / Cancelled)

*Updatable Line Item Fields:*
• To update a line item, mention the item number or product name and the new values
• You can also add a new line item or remove an existing one

Example:
"PO-2026-0042, update delivery location to Pune MIDC, change item 1 rate to 58000, add new item: MS Plate 10mm, HSN 720837, 5 MT, ₹55000"`,

  LOG_VISIT: `📍 *Log Customer Field Visit*

Please provide the following details. Fields marked with * are mandatory:

• *Customer / Company Name:* *
• *Person Met:* *
• *Contact Phone:* *
• *City / Location:* *
• *Visit Date:* *
• *Visit Outcome:* * (Positive / Negative / Neutral / Follow-up Required)
• *Follow-up Action:* (optional)
• *Meeting Remarks & Requirements:* *`,

  UPDATE_VISIT: `✏️ *Update Field Visit*

To identify the visit, provide ONE of the following:
• *Visit ID:* * (e.g. VIS-2026-0015)
OR
• *Company Name + Visit Date:* * (e.g. ABC Steels, 10-09-2026)

What would you like to update?

*Updatable Fields:*
• Person Met
• Contact Phone
• City / Location
• Visit Outcome (Positive / Negative / Neutral / Follow-up Required)
• Follow-up Action
• Meeting Remarks & Requirements
• Status (Completed / Follow-up Pending / Cancelled)

Example:
"ABC Steels visit on 10-09-2026, update outcome to Positive, follow-up action to Send quotation by Friday"`,

  LOG_NEW_CUSTOMER: `👤 *New Customer Acquisition*

Please provide the following customer details. Fields marked with * are mandatory:

• *Company Name:* *
• *Contact Person:* *
• *Mobile Number:* *
• *Delivery Location:* *
• *Email:* (optional)
• *GST Number:* (optional)

You can reply in any format — just include the field names or values in order.

Example:
"Apex Steel Structures, Contact: Rajesh Sharma, Phone: 9820123456, Location: Chakan Pune, Email: rajesh@apexsteel.com, GST: 27AABCU9603R1ZM"`,

  LOG_COMPLAINT: `⚠️ *Log Customer Complaint*

Please provide the following details. Fields marked with * are mandatory:

• *Company / Customer Name:* *
• *Complaint Description & Affected Material:* * (e.g. 12 MT MS angle with bending damage)
• *Complaint Type:* (optional: Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
• *Linked PO Number or Inquiry ID:* (optional, auto-linked if customer has active orders)
• *Corrective Action Taken:* (optional)

Example:
"Shree Balaji Pre-Engineered Buildings received 12 MT MS angle with bending damage and edge cuts during truck unloading"`,

  UPDATE_COMPLAINT: `✏️ *Update Complaint*

To identify the complaint, provide ONE of the following:
• *Linked PO Number or Inquiry ID:* * (e.g. PO-2026-TI-101 or #INQ-8971B1)
• *Customer Name:* (e.g. Tech Industries)

What would you like to update?

*Updatable Fields:*
• Complaint Type (Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
• Complaint Description
• Corrective Action Taken
• Resolution Notes
• Status (Pending / In Progress / Resolved / Closed)

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

// ── GREETING & ROUTING MATCHERS ──────────────────────────────────────────────

function isGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().replace(/[!.,?]/g, '');
  const greetings = [
    'hi', 'hello', 'hey', 'start', 'menu', 'main menu', 'options',
    'namaste', 'good morning', 'good afternoon', 'good evening',
    'hii', 'hiii', 'heyy', 'catalog', 'help'
  ];
  if (greetings.includes(clean)) return true;
  return /^(?:hi|hello|hey|start|menu|namaste)\b/i.test(clean) && clean.length <= 15;
}

function matchActionFromInput(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim().toLowerCase().replace(/[️⃣*]/g, '').trim();

  // If text is a full sentence with arguments/details, let natural action detection & LLM extraction handle it
  if (clean.length > 35 || /\b(?:for|to|on|of|with|at|rate|qty|status|inq-|po-|midc|midc\s+pune|midc\s+bhosari|mt|tons|plate|sheet|coil)\b/i.test(clean)) {
    if (!/^(?:1|2|3|4|5|6|7|8|9|10)\.?$/i.test(clean) && !/^(?:log|update|record|start_log_|start_update_)\s*(?:new\s*)?(?:inquiry|order|visit|complaint|customer|customer acquisition|field visit|customer visit|customer complaint)$/i.test(clean)) {
      return null;
    }
  }

  if (clean === '1' || clean === '1.' || clean === 'log inquiry' || clean === 'log new inquiry' || clean === 'new inquiry' || clean === 'start_log_inquiry') {
    return 'LOG_INQUIRY';
  }
  if (clean === '2' || clean === '2.' || clean === 'update inquiry' || clean === 'start_update_inquiry') {
    return 'UPDATE_INQUIRY';
  }
  if (clean === '3' || clean === '3.' || clean === 'log order' || clean === 'log new order' || clean === 'record order' || clean === 'record new order' || clean === 'new order' || clean === 'start_log_order') {
    return 'LOG_ORDER';
  }
  if (clean === '4' || clean === '4.' || clean === 'update order' || clean === 'start_update_order') {
    return 'UPDATE_ORDER';
  }
  if (clean === '5' || clean === '5.' || clean === 'log visit' || clean === 'log customer field visit' || clean === 'log customer visit' || clean === 'log field visit' || clean === 'new visit' || clean === 'start_log_visit') {
    return 'LOG_VISIT';
  }
  if (clean === '6' || clean === '6.' || clean === 'update visit' || clean === 'update field visit' || clean === 'start_update_visit') {
    return 'UPDATE_VISIT';
  }
  if (clean === '7' || clean === '7.' || clean === 'new customer' || clean === 'new customer acquisition' || clean === 'customer acquisition' || clean === 'add customer' || clean === 'onboard customer' || clean === 'log customer' || clean === 'start_log_customer') {
    return 'LOG_NEW_CUSTOMER';
  }
  if (clean === '8' || clean === '8.' || clean === 'log complaint' || clean === 'log customer complaint' || clean === 'new complaint' || clean === 'start_log_complaint') {
    return 'LOG_COMPLAINT';
  }
  if (clean === '9' || clean === '9.' || clean === 'update complaint' || clean === 'update customer complaint' || clean === 'start_update_complaint') {
    return 'UPDATE_COMPLAINT';
  }
  if (clean === '10' || clean === '10.' || clean === 'other' || clean === 'general query' || clean === 'other query' || clean === 'general_query') {
    return 'GENERAL_QUERY';
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
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
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
      "sku_text": "<Core metal product name and gauge/thickness e.g. 'MS Sheet 5MM', 'CR Sheet 1.00MM', 'HR Coil 3.15MM'>",
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
  "inquiry_id": "<Inquiry ID e.g. INQ-2026-0042, INQ-1BB6F1, INQ-B76516, #INQ-0042, else null>",
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
  "company_name": "<Company Name, else null>",
  "po_number": "<PO Number e.g. PO-2026-0042, else null>",
  "po_date": "<PO Date in DD-MM-YYYY format, else null>",
  "delivery_location": "<Delivery Location, else null>",
  "payment_terms": "<Payment Terms, else null>",
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
      "company_name": "<Company Name>",
      "po_number": "<PO Number>",
      "po_date": "<PO Date>",
      "delivery_location": "<Location>",
      "payment_terms": "<Payment Terms>",
      "line_items": []
    }
  ]
}

UPDATE_ORDER:
{
  "action": "UPDATE_ORDER",
  "po_number": "<PO Number e.g. PO-2026-0042, else null>",
  "updates": {
    "po_date": "<new PO date if updated, else null>",
    "delivery_location": "<new delivery location if updated, else null>",
    "payment_terms": "<new payment terms if updated, else null>",
    "status": "<Pending | Processing | Dispatched | Delivered | Cancelled if updated, else null>"
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
  "visit_id": "<Visit ID e.g. VIS-2026-0015 if mentioned, else null>",
  "company_name": "<Company Name if mentioned, else null>",
  "visit_date": "<Visit Date if mentioned, else null>",
  "updates": {
    "person_met": "<if updated, else null>",
    "contact_phone": "<if updated, else null>",
    "city_location": "<if updated, else null>",
    "visit_outcome": "<Positive | Negative | Neutral | Follow-up Required if updated, else null>",
    "followup_action": "<if updated, else null>",
    "meeting_remarks": "<if updated, else null>",
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
  "affected_product": "<specific product/material affected e.g. '12 MT MS angle', 'CR Sheet 1.20mm coils' - else null>",
  "linked_inquiry_or_po": "<Linked Inquiry ID e.g. #INQ-8971B1 or PO Number e.g. PO-2026-TI-101 if mentioned, else null>",
  "complaint_type": "<Quality Defect | Physical Damage | Quantity Shortage | Delivery Delay | Billing Mismatch | Specification Mismatch | Other, if mentioned or inferred from issue, else null>",
  "complaint_description": "<Detailed complaint description, else null>",
  "corrective_action": "<Corrective action taken if mentioned, else null>",
  "initial_status": "<Pending | In Progress | Resolved, defaults to Pending>",
  "entries": [
    {
      "company_name": "<Company Name>",
      "affected_product": "<Product, else null>",
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
  "linked_inquiry_or_po": "<Linked PO Number or Inquiry ID e.g. #INQ-8971B1, PO-2026-TI-101 if mentioned, else null>",
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
            merged.updates[uKey] = uVal;
          }
        }
      } else if (key === 'line_items' && Array.isArray(val)) {
        if (val.length > 0) {
          merged.line_items = val.map((item) => {
            const qty = Number(item.quantity) || 0;
            const rate = Number(item.rate) || 0;
            const amt = item.amount ? Number(item.amount) : (qty && rate ? qty * rate : 0);
            const skuText = item.sku_text || item.description || '';
            const itemDim = item.dimensions || item.spec || '';
            const hsn = item.hsn_code || item.hsn_sac || detectHsnCode(skuText, itemDim) || detectHsnCode(item.description || '') || '72083840';
            return {
              sku_text: skuText,
              description: item.description || skuText,
              dimensions: itemDim,
              spec: itemDim,
              hsn_sac: hsn,
              hsn_code: hsn,
              quantity: qty || '',
              unit: item.unit || 'MT',
              rate: rate || '',
              amount: amt || '',
            };
          });

          if (!merged.product_description || merged.product_description.length < 5) {
            merged.product_description = merged.line_items.map(it => `${it.sku_text || it.description}${it.quantity ? ` - ${it.quantity} ${it.unit || 'MT'}` : ''}`).join(', ');
          }
        }
      } else if (key === 'line_item_updates' && Array.isArray(val)) {
        if (val.length > 0) {
          merged.line_item_updates = val;
          if (merged.updates) {
            delete merged.updates.rate;
            delete merged.updates.product_description;
          }
        }
      } else {
        if (key.includes('date') && typeof val === 'string') {
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
    return merged;
  }

  return mergeSingleDraft(action, baseDraft, newExtracted, userInput);
}

// ── VALIDATE MANDATORY FIELDS ────────────────────────────────────────────────

function validateMandatoryFields(action, draft) {
  const missing = [];

  switch (action) {
    case 'LOG_INQUIRY':
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.product_description && (!Array.isArray(draft.line_items) || draft.line_items.length === 0)) {
        missing.push('Product Description / Quantity');
      }
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!draft.delivery_location) missing.push('Delivery Location');
      break;

    case 'UPDATE_INQUIRY':
      if (!draft.inquiry_id) missing.push('Inquiry ID (e.g. INQ-2026-0042)');
      const inqUpdates = draft.updates || {};
      const hasInqUpdate = Object.values(inqUpdates).some(v => v !== null && v !== undefined && v !== '');
      const hasInqLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      if (!hasInqUpdate && !hasInqLineUpdates) missing.push('At least one field to update');
      break;

    case 'LOG_ORDER':
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
      }
      break;

    case 'UPDATE_ORDER':
      if (!draft.po_number) missing.push('PO Number (e.g. PO-2026-0042)');
      const ordUpdates = draft.updates || {};
      const hasOrdHeader = Object.values(ordUpdates).some(v => v !== null && v !== undefined && v !== '');
      const hasLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      if (!hasOrdHeader && !hasLineUpdates) missing.push('At least one header or line item update');
      break;

    case 'LOG_VISIT':
      if (!draft.company_name) missing.push('Customer / Company Name');
      if (!draft.person_met) missing.push('Person Met');
      if (!draft.contact_phone) missing.push('Contact Phone');
      if (!draft.city_location) missing.push('City / Location');
      if (!draft.visit_date) missing.push('Visit Date (e.g. 10-09-2026)');
      if (!draft.visit_outcome) missing.push('Visit Outcome (Positive / Negative / Neutral / Follow-up Required)');
      if (!draft.meeting_remarks) missing.push('Meeting Remarks & Requirements');
      break;

    case 'UPDATE_VISIT':
      const hasVisitId = Boolean(draft.visit_id);
      const hasCompanyAndDate = Boolean(draft.company_name && draft.visit_date);
      if (!hasVisitId && !hasCompanyAndDate) {
        missing.push('Visit ID (e.g. VIS-2026-0015) OR Company Name + Visit Date');
      }
      const visUpdates = draft.updates || {};
      const hasVisUpdate = Object.values(visUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasVisUpdate) missing.push('At least one field to update');
      break;

    case 'LOG_NEW_CUSTOMER':
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
  if (action === 'LOG_NEW_CUSTOMER') return { isValid: true };

  const rawName = String(draft.company_name).trim();
  if (!rawName || rawName.toLowerCase() === 'null' || rawName.toLowerCase() === 'unknown') {
    draft.company_name = null;
    return { isValid: true };
  }

  // Attempt verification against assigned accounts / scope
  const officialName = await verifyAndGetCustomerName(rawName, senderPhone);
  if (officialName) {
    draft.company_name = officialName;
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

// ── BUILD CONFIRMATION SUMMARY ───────────────────────────────────────────────

function buildConfirmationSummary(action, draft) {
  const indexTag = draft._totalCount && draft._totalCount > 1 ? ` (${draft._currentIndex || 1} of ${draft._totalCount}: ${draft.company_name || 'Item'})` : '';
  let summary = `✅ *Here's what I've captured${indexTag}:*\n\n`;

  switch (action) {
    case 'LOG_INQUIRY': {
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
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
        summary += `• *Product:* ${draft.product_description}${rateStr}\n`;
      }
      if (draft.preferred_make) summary += `• *Preferred Make:* ${draft.preferred_make}\n`;
      if (draft.payment_terms) summary += `• *Payment Terms:* ${draft.payment_terms}\n`;
      if (draft.delivery_location) summary += `• *Delivery Location:* ${draft.delivery_location}\n`;
      if (draft.additional_notes) summary += `• *Additional Notes:* ${draft.additional_notes}\n`;
      break;
    }

    case 'UPDATE_INQUIRY': {
      summary += `• *Inquiry ID:* ${draft.inquiry_id}\n`;
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
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      summary += `• *PO Number:* ${draft.po_number}\n`;
      summary += `• *PO Date:* ${draft.po_date}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms}\n`;
      let totalAmount = 0;
      if (Array.isArray(draft.line_items) && draft.line_items.length === 1) {
        const it = draft.line_items[0];
        const qty = Number(it.quantity) || 0;
        const rate = Number(it.rate) || 0;
        const amount = Number(it.amount) || qty * rate;
        totalAmount += amount;
        const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
        const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
        summary += `• *Product:* ${it.sku_text || it.description}${specStr}${hsnStr} — ${qty} ${it.unit || 'MT'} @ ₹${rate.toLocaleString('en-IN')}/${it.unit || 'MT'}\n`;
        summary += `• *Total Order Value:* ₹${totalAmount.toLocaleString('en-IN')}\n`;
      } else if (Array.isArray(draft.line_items) && draft.line_items.length > 1) {
        summary += `• *Line Items:*\n`;
        (draft.line_items || []).forEach((it) => {
          const qty = Number(it.quantity) || 0;
          const rate = Number(it.rate) || 0;
          const amount = Number(it.amount) || qty * rate;
          totalAmount += amount;
          const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
          const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
          summary += `  • ${it.sku_text || it.description}${specStr}${hsnStr} — ${qty} ${it.unit || 'MT'} @ ₹${rate.toLocaleString('en-IN')}/${it.unit || 'MT'} (₹${amount.toLocaleString('en-IN')})\n`;
        });
        summary += `• *Total Order Value:* ₹${totalAmount.toLocaleString('en-IN')}\n`;
      }
      break;
    }

    case 'UPDATE_ORDER': {
      summary += `• *PO Number:* ${draft.po_number}\n`;
      if (draft.updates && Object.keys(draft.updates).length > 0) {
        summary += `• *Header Updates:*\n`;
        for (const [k, v] of Object.entries(draft.updates)) {
          if (v) {
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
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      summary += `• *Person Met:* ${draft.person_met}\n`;
      summary += `• *Contact Phone:* ${draft.contact_phone}\n`;
      summary += `• *City / Location:* ${draft.city_location}\n`;
      summary += `• *Visit Date:* ${draft.visit_date}\n`;
      summary += `• *Visit Outcome:* ${draft.visit_outcome}\n`;
      if (draft.followup_action) summary += `• *Follow-up Action:* ${draft.followup_action}\n`;
      summary += `• *Meeting Remarks:* ${draft.meeting_remarks}\n`;
      break;
    }

    case 'UPDATE_VISIT': {
      const targetVis = draft.visit_id || `${draft.company_name} on ${draft.visit_date}`;
      summary += `• *Target Visit:* ${targetVis}\n`;
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
      summary += `• *Company Name:* ${draft.company_name}\n`;
      summary += `• *Contact Person:* ${draft.contact_person}\n`;
      const phoneVal = draft.mobile_number || draft.phone || draft.contact_phone;
      summary += `• *Mobile Number:* ${phoneVal}\n`;
      const locVal = draft.delivery_location || draft.city_location || draft.address;
      summary += `• *Delivery Location:* ${locVal}\n`;
      if (draft.email) summary += `• *Email:* ${draft.email}\n`;
      const gstVal = draft.gst_number || draft.gst;
      if (gstVal) summary += `• *GST Number:* ${gstVal}\n`;
      break;
    }

    case 'LOG_COMPLAINT': {
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      if (draft.affected_product || draft.product_name) {
        summary += `• *Product / Material:* ${draft.affected_product || draft.product_name}\n`;
      }
      if (draft.linked_inquiry_or_po) {
        summary += `• *Linked Order / Ref:* ${draft.linked_inquiry_or_po}\n`;
      }
      summary += `• *Complaint Type:* ${draft.complaint_type || 'Physical Damage'}\n`;
      summary += `• *Description:* ${draft.complaint_description || draft.affected_product}\n`;
      if (draft.corrective_action) summary += `• *Corrective Action:* ${draft.corrective_action}\n`;
      summary += `• *Initial Status:* ${draft.initial_status || 'Pending'}\n`;
      break;
    }

    case 'UPDATE_COMPLAINT': {
      const targetCmp = draft.linked_inquiry_or_po || draft.company_name || draft.complaint_id || 'Active Complaint';
      summary += `• *Target Complaint:* ${targetCmp}\n`;
      if (draft.company_name && draft.linked_inquiry_or_po && draft.company_name !== draft.linked_inquiry_or_po) {
        summary += `• *Customer:* ${draft.company_name}\n`;
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

  summary += `\n*Reply:*\n• *Yes* — to save\n• *Edit* — to change something\n• *Cancel* — to discard`;
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

async function findAndMatchComplaint(draft) {
  const targetRef = (draft.linked_inquiry_or_po || draft.target_ref || draft.complaint_id || '').trim();
  const companyName = (draft.company_name || '').trim();

  const { data: allComplaints } = await supabase
    .from('complaints')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

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
      const { data: deals } = await supabase
        .from('deals')
        .select('id, po_number, customer_name')
        .limit(100);

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
        await ensureCustomerRecord(companyName, senderPhone);

        const hexCode = Math.random().toString(16).substring(2, 8).toUpperCase();
        const inquiryCode = `INQ-${hexCode}`;

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

        // 1. Insert into inquiries
        const { data: inqRow, error: inqErr } = await supabase
          .from('inquiries')
          .insert({
            source_channel: 'WhatsApp',
            raw_text: humanRawText.trim(),
            sender_phone: senderPhone,
            salesperson_phone: senderPhone,
            status: 'auto_created',
            ai_extraction_json: structuredAiJson,
            overall_confidence: 0.95,
            inquiry_type: 'inquiry',
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (inqErr) console.error('[CatalogFlow] Inquiry insert error:', inqErr);

        // 2. Insert into deals
        const { data: dealRow, error: dealErr } = await supabase
          .from('deals')
          .insert({
            inquiry_id: inqRow ? inqRow.id : null,
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

        if (dealErr) console.error('[CatalogFlow] Deal insert error:', dealErr);

        // 3. Insert line items into deal_items
        if (dealRow && structuredLineItems.length > 0) {
          const itemsPayload = structuredLineItems.map(it => ({
            deal_id: dealRow.id,
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

        // 4. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'new_inquiry',
          customer_name: companyName,
          description: `Logged New Inquiry #${inquiryCode} for ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        const productSummaryStr = structuredLineItems.length > 0
          ? structuredLineItems.map(it => `${it.sku_text || it.description}${it.quantity ? ` - ${it.quantity} ${it.unit || 'MT'}` : ''}${it.rate ? ` (₹${Number(it.rate).toLocaleString('en-IN')})` : ''}`).join(', ')
          : (draft.product_description || 'Steel Material');

        return `🎉 *Inquiry Successfully Created!*

📋 *Inquiry ID:* #${inquiryCode}
🏢 *Customer:* ${companyName}
📦 *Product:* ${productSummaryStr}
📍 *Delivery Location:* ${draft.delivery_location}
💳 *Payment Terms:* ${draft.payment_terms}${draft.preferred_make ? `\n🏷️ *Preferred Make:* ${draft.preferred_make}` : ''}

Logged to Sales Pipeline & Inquiries! ✅`;
      }

      case 'UPDATE_INQUIRY': {
        const rawId = (draft.inquiry_id || '').trim();
        const cleanId = rawId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/-/g, '').trim().toUpperCase();

        const { data: deals } = await supabase
          .from('deals')
          .select('id, inquiry_id, customer_name, stage')
          .order('created_at', { ascending: false })
          .limit(50);

        let deal = null;
        if (deals && deals.length > 0) {
          deal = deals.find(d => {
            const dId = (d.id || '').replace(/-/g, '').toUpperCase();
            const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
            return (cleanId && (dId.startsWith(cleanId) || inqId.startsWith(cleanId))) ||
                   (cleanId && (dId.includes(cleanId) || inqId.includes(cleanId))) ||
                   (d.customer_name && d.customer_name.toLowerCase().includes(rawId.toLowerCase()));
          }) || null;
        }

        const updates = draft.updates || {};
        const dealUpdates = {};

        if (updates.payment_terms) dealUpdates.payment_terms = updates.payment_terms;
        if (updates.delivery_location) dealUpdates.delivery_location = updates.delivery_location;
        if (updates.status) {
          const s = updates.status.toLowerCase();
          if (s.includes('won')) dealUpdates.stage = 'won';
          else if (s.includes('lost')) dealUpdates.stage = 'lost';
          else if (s.includes('quote')) dealUpdates.stage = 'quoted';
          else dealUpdates.stage = updates.status;
        }

        if (deal) {
          const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
          let totalAmount = 0;
          let itemsUpdated = false;

          // 1. Specific line item updates (e.g. MS Sheet 5MM - 20, MS Sheet 6MM - 30)
          if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0 && dItems && dItems.length > 0) {
            for (let i = 0; i < dItems.length; i++) {
              const currentItem = dItems[i];
              const curSku = (currentItem.sku_text || currentItem.description || '').toLowerCase();

              // Find matching update in line_item_updates
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

          // Synchronize inquiries.ai_extraction_json
          if (deal.inquiry_id && itemsUpdated) {
            const { data: inqRow } = await supabase.from('inquiries').select('ai_extraction_json').eq('id', deal.inquiry_id).single();
            if (inqRow?.ai_extraction_json) {
              const aiJson = inqRow.ai_extraction_json;
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
              await supabase.from('inquiries').update({ ai_extraction_json: aiJson }).eq('id', deal.inquiry_id);
            }
          }
        }

        if (deal && Object.keys(dealUpdates).length > 0) {
          await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
        }

        return `✅ *Inquiry Updated Successfully!*

📋 *Inquiry ID:* ${draft.inquiry_id}
🏢 *Customer:* ${deal ? deal.customer_name : 'Customer'}

Updated details saved to Sales Pipeline & Inquiries! 📈`;
      }

      case 'LOG_ORDER': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone);

        let totalAmount = 0;
        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const qty = Number(it.quantity) || 0;
              const rate = Number(it.rate) || 0;
              const amt = Number(it.amount) || qty * rate;
              totalAmount += amt;
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

        const structuredAiJson = {
          customer: {
            name: companyName,
            phone: null,
            address: draft.delivery_location || null,
            match_status: 'matched',
          },
          customer_name: companyName,
          companyName: companyName,
          po_number: draft.po_number,
          po_date: draft.po_date,
          delivery_location: draft.delivery_location || null,
          delivery_address: draft.delivery_location || null,
          payment_terms: draft.payment_terms || null,
          product_requirement: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          total_amount: totalAmount,
          inquiry_type: 'purchase_order',
          overall_confidence: 0.98,
        };

        let humanRawText = `Customer: ${companyName}\nPO Number: ${draft.po_number}\nPO Date: ${draft.po_date}\n`;
        if (structuredLineItems.length > 0) {
          humanRawText += `Line Items:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} ${it.dimensions ? `(${it.dimensions})` : ''} - ${it.quantity} ${it.unit} @ ₹${it.rate}/${it.unit}`).join('\n') + `\n`;
        }
        if (draft.payment_terms) humanRawText += `Payment Terms: ${draft.payment_terms}\n`;
        if (draft.delivery_location) humanRawText += `Delivery Location: ${draft.delivery_location}\n`;

        // 1. Insert into inquiries
        const { data: inqRow } = await supabase
          .from('inquiries')
          .insert({
            source_channel: 'WhatsApp',
            raw_text: humanRawText.trim(),
            sender_phone: senderPhone,
            salesperson_phone: senderPhone,
            status: 'auto_created',
            ai_extraction_json: structuredAiJson,
            overall_confidence: 0.98,
            inquiry_type: 'purchase_order',
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        // 2. Insert into deals (stage = 'won')
        const { data: dealRow, error: dealErr } = await supabase
          .from('deals')
          .insert({
            inquiry_id: inqRow ? inqRow.id : null,
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

        // 3. Insert line items
        if (dealRow && structuredLineItems.length > 0) {
          const itemsPayload = structuredLineItems.map(it => ({
            deal_id: dealRow.id,
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
          description: `Order Logged: PO #${draft.po_number} for ${companyName} (₹${totalAmount.toLocaleString('en-IN')})`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        return `🎉 *Order Recorded & Deal Marked as WON!*

🛒 *PO Number:* ${draft.po_number}
🏢 *Customer:* ${companyName}
📅 *PO Date:* ${draft.po_date}
📍 *Delivery Location:* ${draft.delivery_location}
💳 *Payment Terms:* ${draft.payment_terms}
💰 *Total Order Value:* ₹${totalAmount.toLocaleString('en-IN')}

Updated Sales Achievement Card! 🏆`;
      }

      case 'UPDATE_ORDER': {
        const cleanPo = (draft.po_number || '').trim();
        const { data: deals } = await supabase
          .from('deals')
          .select('id, po_number, customer_name')
          .ilike('po_number', `%${cleanPo}%`)
          .limit(1);

        const deal = deals && deals.length > 0 ? deals[0] : null;
        const updates = draft.updates || {};
        const dealUpdates = {};

        if (updates.po_date) dealUpdates.po_date = updates.po_date;
        if (updates.delivery_location) dealUpdates.delivery_location = updates.delivery_location;
        if (updates.payment_terms) dealUpdates.payment_terms = updates.payment_terms;
        if (updates.status) dealUpdates.stage = updates.status.toLowerCase();

        if (deal && Object.keys(dealUpdates).length > 0) {
          await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
        }

        return `✅ *Order Updated Successfully!*

🛒 *PO Number:* ${draft.po_number}
🏢 *Customer:* ${deal ? deal.customer_name : 'Customer'}

Order details updated in Sales Achievement Card! 🏆`;
      }

      case 'LOG_VISIT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone);

        const visitDateIso = parseDDMMYYYYtoISO(draft.visit_date);
        const outcomeTag = draft.visit_outcome ? `[Outcome: ${draft.visit_outcome}] ` : '';
        const followupTag = draft.followup_action ? ` | Follow-up: ${draft.followup_action}` : '';
        const formattedRemarks = `${outcomeTag}${draft.meeting_remarks || ''}${followupTag}`.trim();

        // 1. Insert into customer_visits
        const { error: visErr } = await supabase.from('customer_visits').insert({
          salesperson_phone: senderPhone,
          customer_name: companyName,
          customer_address: draft.city_location,
          person_met: draft.person_met,
          contact_no: draft.contact_phone,
          remarks: formattedRemarks,
          visited_at: visitDateIso,
        });

        if (visErr) console.error('[CatalogFlow] Visit insert error:', visErr);

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

        return `📍 *Customer Field Visit Logged Successfully!*

🏢 *Customer:* ${companyName}
👤 *Person Met:* ${draft.person_met} (${draft.contact_phone})
📍 *Location:* ${draft.city_location}
📅 *Date:* ${draft.visit_date}
📊 *Outcome:* ${draft.visit_outcome}${draft.followup_action ? `\n🎯 *Follow-up:* ${draft.followup_action}` : ''}
📝 *Remarks:* ${draft.meeting_remarks}

Logged to Customer Visits Card! ✅`;
      }

      case 'UPDATE_VISIT': {
        const { data: visits } = await supabase
          .from('customer_visits')
          .select('id, customer_name, visited_at')
          .ilike('customer_name', `%${(draft.company_name || '').trim()}%`)
          .order('visited_at', { ascending: false })
          .limit(1);

        const targetVisit = visits && visits.length > 0 ? visits[0] : null;
        const updates = draft.updates || {};
        const visitUpdates = {};

        if (updates.person_met) visitUpdates.person_met = updates.person_met;
        if (updates.contact_phone) visitUpdates.contact_no = updates.contact_phone;
        if (updates.city_location) visitUpdates.customer_address = updates.city_location;
        if (updates.meeting_remarks || updates.visit_outcome || updates.followup_action) {
          const outcomeTag = updates.visit_outcome ? `[Outcome: ${updates.visit_outcome}] ` : '';
          const followupTag = updates.followup_action ? ` | Follow-up: ${updates.followup_action}` : '';
          visitUpdates.remarks = `${outcomeTag}${updates.meeting_remarks || ''}${followupTag}`.trim();
        }

        if (targetVisit && Object.keys(visitUpdates).length > 0) {
          await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
        }

        return `✅ *Field Visit Updated Successfully!*

🏢 *Customer:* ${draft.company_name || (targetVisit ? targetVisit.customer_name : 'Customer')}
Visit details updated in Customer Visits Card! ✅`;
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

        const custId = newCust ? newCust.id : '';

        return `🎉 *New Customer Successfully Added!*

🏢 *Company Name:* ${companyName}
👤 *Contact Person:* ${contactPerson || 'N/A'}
📱 *Mobile Number:* ${mobileNumber || 'N/A'}
📍 *Delivery Location:* ${deliveryLoc || 'N/A'}${email ? `\n📧 *Email:* ${email}` : ''}${gstNum ? `\n🧾 *GST Number:* ${gstNum}` : ''}

Customer record created & added to your portfolio! ✅`;
      }

      case 'LOG_COMPLAINT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone);

        const nowIso = new Date().toISOString();
        const slaDueAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
        const normalizedType = normalizeComplaintType(draft.complaint_type || 'quality');

        // Extract affected product
        let product = (draft.affected_product || draft.product_name || '').trim();
        if (!product && draft.complaint_description) {
          product = extractProductFromText(draft.complaint_description) || '';
        }

        // Try to match or look up genuine deal/PO for this customer
        let targetPoNumber = draft.linked_inquiry_or_po || draft.po_number || null;
        let targetDealId = null;

        // If user gave a PO or INQ ref, look it up in deals table
        if (targetPoNumber) {
          const rawRef = targetPoNumber.replace(/^#?(?:INQ|DEAL|PO)-?/i, '').trim();
          try {
            const { data: matchedDeals } = await supabase
              .from('deals')
              .select('id, po_number, customer_name, deal_items(sku_text, dimensions, quantity, unit)')
              .or(`po_number.ilike.%${rawRef}%,inquiry_id.ilike.%${rawRef}%,id.ilike.%${rawRef}%`)
              .limit(1);

            if (matchedDeals && matchedDeals.length > 0) {
              targetDealId = matchedDeals[0].id;
              targetPoNumber = matchedDeals[0].po_number || targetPoNumber;
              if (!product && matchedDeals[0].deal_items && matchedDeals[0].deal_items.length > 0) {
                product = matchedDeals[0].deal_items.map(it => `${it.sku_text || ''} ${it.dimensions || ''} ${it.quantity ? `(${it.quantity} ${it.unit || 'MT'})` : ''}`.trim()).filter(Boolean).join(', ');
              }
            }
          } catch (e) {
            console.warn('[CatalogFlow] Deal lookup error by ref:', e?.message);
          }
        }

        // If no PO/deal matched or provided, auto-link to customer's won deal/order
        if (!targetDealId && companyName && companyName !== 'Customer') {
          try {
            const { data: custDeals } = await supabase
              .from('deals')
              .select('id, po_number, stage, deal_items(sku_text, dimensions, quantity, unit)')
              .ilike('customer_name', `%${companyName}%`)
              .order('created_at', { ascending: false })
              .limit(5);

            if (custDeals && custDeals.length > 0) {
              let matchedDeal = null;
              if (product) {
                const pLower = product.toLowerCase();
                matchedDeal = custDeals.find(d =>
                  (d.deal_items || []).some(it =>
                    pLower.includes((it.sku_text || '').toLowerCase()) ||
                    (it.sku_text && (it.sku_text.toLowerCase().includes(pLower) || pLower.includes(it.sku_text.toLowerCase()))) ||
                    (it.dimensions && pLower.includes(it.dimensions.toLowerCase()))
                  )
                );
              }
              if (!matchedDeal) {
                matchedDeal = custDeals.find(d => d.stage === 'won' && d.po_number) || custDeals[0];
              }

              if (matchedDeal) {
                targetDealId = matchedDeal.id;
                targetPoNumber = matchedDeal.po_number || null;
                if (!product && matchedDeal.deal_items && matchedDeal.deal_items.length > 0) {
                  product = matchedDeal.deal_items.map(it => `${it.sku_text || ''} ${it.dimensions || ''} ${it.quantity ? `(${it.quantity} ${it.unit || 'MT'})` : ''}`.trim()).filter(Boolean).join(', ');
                }
              }
            }
          } catch (e) {
            console.warn('[CatalogFlow] Deal lookup error by customer:', e?.message);
          }
        }

        // 1. Insert into complaints
        const { error: cmpErr } = await supabase.from('complaints').insert({
          customer_name: companyName,
          complaint_type: normalizedType,
          description: draft.complaint_description,
          reported_by: senderPhone,
          status: (draft.initial_status || 'Pending').toLowerCase(),
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
          description: `Complaint Logged: ${companyName} - ${normalizedType}: ${draft.complaint_description}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: nowIso,
        });

        let linkedDisplay = '';
        if (targetPoNumber) {
          linkedDisplay = `\n🔗 *Linked Order:* PO: *${targetPoNumber}*`;
        } else if (targetDealId) {
          linkedDisplay = `\n🔗 *Linked Ref:* Inquiry *#INQ-${targetDealId.substring(0, 6).toUpperCase()}*`;
        }

        return `⚠️ *Customer Complaint Logged Successfully!*

🏢 *Customer:* ${companyName}${linkedDisplay}${product ? `\n📦 *Product Affected:* ${product}` : ''}
📋 *Complaint Type:* ${normalizedType}
📝 *Description:* ${draft.complaint_description}
🚦 *Status:* ${draft.initial_status || 'Pending'}${draft.corrective_action ? `\n🛠️ *Corrective Action:* ${draft.corrective_action}` : ''}

Logged to Customer Complaints Card! (48h SLA Active) ⏱️`;
      }

      case 'UPDATE_COMPLAINT': {
        const matchedCmp = await findAndMatchComplaint(draft);

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

        const linkedOrderRef = matchedCmp.po_number
          ? `PO: *${matchedCmp.po_number}*`
          : matchedCmp.deal_id
          ? `Inquiry: *#INQ-${matchedCmp.deal_id.replace(/^#?(?:INQ|DEAL)-?/i, '').substring(0, 6).toUpperCase()}*`
          : '';

        let fieldsSummary = '';
        if (cmpUpdates.complaint_type) fieldsSummary += `• *Complaint Type:* ${cmpUpdates.complaint_type}\n`;
        if (updates.status) fieldsSummary += `• *Status:* ${updates.status}\n`;
        if (cmpUpdates.description) fieldsSummary += `• *Description:* ${cmpUpdates.description}\n`;
        if (cmpUpdates.corrective_action) fieldsSummary += `• *Corrective Action:* ${cmpUpdates.corrective_action}\n`;
        if (cmpUpdates.resolution_notes) fieldsSummary += `• *Resolution Notes:* ${cmpUpdates.resolution_notes}\n`;

        return `✅ *Customer Complaint Updated Successfully!*\n\n` +
          `🏢 *Customer:* *${matchedCmp.customer_name}*\n` +
          (linkedOrderRef ? `🔗 *Linked Order:* ${linkedOrderRef}\n` : '') +
          `\n*Updated Fields:*\n` +
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

function isOperationalQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // If message begins with an action verb, it is NEVER a read query
  if (/^(?:update|change|modify|set|mark|log|record|create|add|raise|report|new|submit|resolve)\b/i.test(lower)) {
    return false;
  }

  // Common query patterns
  if (/^(?:show|list|get|check|find|filter|tell me|what|which|how many|total|status of|view|search|is there|who has|compare|rankings|leaderboard)\b/i.test(lower)) {
    return true;
  }

  if (/\b(?:kya hai|batao|dikhao|dikhaye|kitne|kitna|kaun hai|kiska|list karo|check karo)\b/i.test(lower)) {
    return true;
  }

  if (/\b(?:inquiry id|deal id|summary|leaderboard|pipeline|radar|360|knowledge base|sop|moq|pricing sheet)\b/i.test(lower)) {
    return true;
  }

  if (/\b(?:kya status hai|status check|status kya hai|status of)\b/i.test(lower)) {
    return true;
  }

  return false;
}

function detectOperationalAction(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();

  // If message is a pure query / search, do not intercept
  if (isOperationalQuery(lower)) return null;

  // 1. Explicit Update patterns
  if (/\b(?:update|change|modify|set|mark|resolve|close|reopen)\b/i.test(lower)) {
    // 1a. Complaints (Check FIRST: user messages updating a complaint often cite #INQ-xxx or PO-xxx)
    if (
      /\b(?:complaint|complaints|defect|defective|rejection|damage|damaged|rust)\b/i.test(lower) ||
      /\b(?:mark\s+as\s+resolved|mark\s+resolved|resolve\s+complaint|close\s+complaint|reopen\s+complaint)\b/i.test(lower)
    ) {
      return 'UPDATE_COMPLAINT';
    }

    // 1b. Visits (Check SECOND: visits might mention inquiries discussed)
    if (/\b(?:visit|vis-|site\s+visit|field\s+visit|meeting|person\s+met)\b/i.test(lower)) {
      return 'UPDATE_VISIT';
    }

    // 1c. Orders
    if (/\b(?:order|orders|purchase\s+order|po\s*no|po\s*number|delivery\s*date|po\s*date)\b/i.test(lower)) {
      return 'UPDATE_ORDER';
    }

    // 1d. Inquiries
    if (/\b(?:inquiry|inquiries|deal|quote|quotation|rfq)\b/i.test(lower)) {
      return 'UPDATE_INQUIRY';
    }

    // 1e. ID-only updates without explicit entity keyword
    if (/\b(?:inq-)\b/i.test(lower)) return 'UPDATE_INQUIRY';
    if (/\b(?:po-)\b/i.test(lower)) return 'UPDATE_ORDER';
    if (/\b(?:vis-)\b/i.test(lower)) return 'UPDATE_VISIT';
  }

  // 2. Complaint patterns (prioritized because complaints often cite PO numbers or visit dates)
  if (
    /\b(?:complaint|defect|defective|damaged\s+material|rust\s+on|rusty|short\s+delivery|wrong\s+material|rejection|rejected\s+material|material\s+return|wapas\s+kiya|issue\s+aa\s+gaya|quality\s+issue|bad\s+material|damaged\s+coils|damaged\s+sheets)\b/i.test(lower)
  ) {
    return 'LOG_COMPLAINT';
  }

  // 3. Visit / Meeting patterns (comprehensive coverage of any visit phrasing)
  if (
    /\b(?:visit(?:ed|ing|s)?|met\b|meet(?:ing)?(?:\s+(?:with|at|in|up|to))?|had\s+a\s+visit|had\s+a\s+meeting|site\s+visit|field\s+visit|client\s+visit|market\s+visit|office\s+visit|factory\s+visit|went\s+to(?:\s+meet)?|gaya\s+tha|mila\s+aaj|milne\s+gaye|visit\s+kiya|visit\s+report)\b/i.test(lower) ||
    /\b(?:visit\s+outcome|person\s+met|discussion\s+notes|meeting\s+remarks|neutral\s+response|positive\s+response|negative\s+response)\b/i.test(lower)
  ) {
    return 'LOG_VISIT';
  }

  // 4. Order / PO patterns
  if (
    /\b(?:purchase\s+order|po\s+received|received\s+po|order\s+confirmed|po-\d+|po\s*no|po\s*number|order\s+logged|order\s+recorded|deal\s+won|new\s+order|booked\s+order|order\s+for)\b/i.test(lower) ||
    /^\s*(?:po|purchase\s+order)\b/i.test(lower)
  ) {
    return 'LOG_ORDER';
  }

  // 5. Inquiry / Requirements patterns
  if (
    /\b(?:inquiry|inquiries|requirement|requirements|rfq|enquiry|enquiries|rate\s+manga|chahiye|need|needs|requires|require|interested\s+in|quote\s+for|rates?\s+for|price\s+for|quotation\s+for)\b/i.test(lower)
  ) {
    if (/\b(?:coil|sheet|plate|structural|beam|channel|pipe|tube|tmt|steel|metal|iron|mt|ton|tons|kg|pieces|sheets|rate|advance|credit|mm|thk)\b/i.test(lower)) {
      return 'LOG_INQUIRY';
    }
  }

  // 6. Customer Acquisition patterns
  if (
    /\b(?:new\s+customer|customer\s+acquisition|onboard\s+customer|add\s+customer|acquire\s+customer|register\s+customer|nayi\s+party|naya\s+customer|customer\s+onboarding)\b/i.test(lower)
  ) {
    return 'LOG_NEW_CUSTOMER';
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
    };
  }

  // ── 2. FETCH ACTIVE SESSION STATE ──────────────────────────────────────────
  const activeSession = await getFullActiveSession(senderPhone);
  const lastIntent = activeSession ? (activeSession.last_intent || '') : '';

  // If currently in a dedicated webhook rejection/payment/unit flow, do not intercept
  if (lastIntent.startsWith('pending_')) {
    return { handled: false };
  }

  // ── 3a. HANDLE IMPLICIT CUSTOMER CONFIRMATION ASK (catalog_implicit_cust_ask|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_ask|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const unrecognizedName = parts[2];
    const originalDraftJsonStr = parts.slice(3).join('|');
    const originalDraft = safeParseJSON(originalDraftJsonStr, {});

    if (isOperationalQuery(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: false };
    }

    await recordSessionMessage(senderPhone, 'user', text);
    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // User confirmed YES (This is a new customer)
    if (
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
      const custDraft = {
        action: 'LOG_NEW_CUSTOMER',
        company_name: unrecognizedName,
        contact_person: originalDraft.person_met || null,
        mobile_number: originalDraft.contact_phone || null,
        delivery_location: originalDraft.delivery_location || originalDraft.city_location || null,
        email: null,
        gst_number: null,
        _parentAction: originalAction,
        _parentDraft: originalDraft,
      };

      const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', custDraft);

      if (custMissing.length === 0) {
        // All customer mandatory fields already supplied (e.g. from field visit)
        await executeAction('LOG_NEW_CUSTOMER', custDraft, senderPhone);

        originalDraft.company_name = custDraft.company_name;
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
          return { handled: true, reply: resumeMsg };
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
      const parentMissing = validateMandatoryFields(originalAction, originalDraft);
      if (parentMissing.length === 0) {
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        await recordSessionMessage(senderPhone, 'assistant', summary, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: summary };
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
    return { handled: true, reply: retryPrompt };
  }

  // ── 3b. HANDLE IMPLICIT CUSTOMER DETAILS COLLECTION (catalog_implicit_cust_collect|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_collect|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const custDraftJsonStr = parts.slice(2).join('|');
    const custDraft = safeParseJSON(custDraftJsonStr, {});

    if (isOperationalQuery(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: false };
    }

    await recordSessionMessage(senderPhone, 'user', text);

    if (/^(?:cancel|stop|discard|exit|quit)$/i.test(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Discarded customer onboarding flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    const updatedCustDraft = await extractFieldsWithLLM('LOG_NEW_CUSTOMER', text, custDraft);
    const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', updatedCustDraft);

    if (custMissing.length === 0) {
      await executeAction('LOG_NEW_CUSTOMER', updatedCustDraft, senderPhone);

      const originalDraft = updatedCustDraft._parentDraft || {};
      originalDraft.company_name = updatedCustDraft.company_name;
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
        return { handled: true, reply: resumeMsg };
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

    if (isOperationalQuery(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: false };
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Confirm YES
    if (
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
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's confirm the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\n${summary}`;
          await recordSessionMessage(senderPhone, 'assistant', nextPrompt, {
            action_type: nextAction,
            customer_name: nextEntry.company_name,
          });
          await saveActiveSession(senderPhone, nextEntry.company_name || 'Customer', `catalog_confirm|${nextAction}|${JSON.stringify(nextEntry)}`);
          return {
            handled: true,
            reply: nextPrompt,
          };
        } else {
          const missingList = missing.map((m) => `• *${m}*`).join('\n');
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's complete the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\nPlease provide the remaining mandatory details:\n\n${missingList}`;
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
      });
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', 'general');
      return { handled: true, reply };
    }

    // Request EDIT
    if (
      cleanInput === 'edit' ||
      cleanInput === 'change' ||
      cleanInput === 'modify' ||
      cleanInput === 'update' ||
      cleanInput === '2'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const editPrompt = `Which field would you like to change? (e.g. "Rate: 55000" or "Delivery location: Pune")`;
      await recordSessionMessage(senderPhone, 'assistant', editPrompt);
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${draftJsonStr}`);
      return {
        handled: true,
        reply: editPrompt,
      };
    }

    // CANCEL
    if (
      cleanInput === 'cancel' ||
      cleanInput === 'discard' ||
      cleanInput === 'no' ||
      cleanInput === '3' ||
      cleanInput === 'stop'
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

    // Direct inline edit attempt during confirmation
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

    const missing = validateMandatoryFields(action, updatedDraft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    }

    const retryPrompt = `Please reply with:\n• *Yes* — to save\n• *Edit* — to change a field\n• *Cancel* — to discard`;
    await recordSessionMessage(senderPhone, 'assistant', retryPrompt);
    return {
      handled: true,
      reply: retryPrompt,
    };
  }

  // ── 4. HANDLE EDITING STATE (catalog_editing|...) ───────────────────────────
  if (lastIntent.startsWith('catalog_editing|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    if (isOperationalQuery(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: false };
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

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    } else {
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      const askMissing = `Let's finish your ${actionName}${indexTag} first. Please provide the missing mandatory details:\n\n${missingList}`;
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
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const existingDraft = safeParseJSON(draftJsonStr, {});

    if (isOperationalQuery(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: false };
    }

    await recordSessionMessage(senderPhone, 'user', text);

    // Check if user wants to abort / switch
    const newActionMatch = matchActionFromInput(text);
    if (newActionMatch && newActionMatch !== action) {
      if (newActionMatch === 'GENERAL_QUERY') {
        const queryReply = `Please let me know what you would like to search or check in the CRM!`;
        await recordSessionMessage(senderPhone, 'assistant', queryReply, { action_type: 'GENERAL_QUERY' });
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return {
          handled: true,
          reply: queryReply,
        };
      }
      const initialPrompt = MODULE_PROMPTS[newActionMatch];
      if (initialPrompt) {
        await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: newActionMatch });
        await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${newActionMatch}|{}`);
        return { handled: true, reply: initialPrompt };
      }
    }

    if (/^(?:cancel|stop|discard|exit|quit)$/i.test(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      await finalizeCurrentSession(senderPhone, `Discarded ${getActionFriendlyName(action)} flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: cancelReply,
      };
    }

    // Extract fields from user message
    const updatedDraft = await extractFieldsWithLLM(action, text, existingDraft);
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

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      // All mandatory fields present -> Show confirmation summary
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    } else {
      // Missing mandatory fields -> Ask only for missing fields
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      const askMissing = `Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
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
      const genReply = `What would you like to search or know? You can ask about inquiries, visits, won orders, customer profiles, or pipeline status.`;
      await recordSessionMessage(senderPhone, 'assistant', genReply, { action_type: 'GENERAL_QUERY' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: genReply,
      };
    }

    const initialPrompt = MODULE_PROMPTS[matchedAction];
    if (initialPrompt) {
      await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: matchedAction });
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${matchedAction}|{}`);
      return { handled: true, reply: initialPrompt };
    }
  }

  // ── 7. NATURAL OPERATIONAL ACTION DETECTION (Visits, Inquiries, Orders, Complaints, Customers) ──
  const directActionMap = [
    // Customer Acquisition
    { pattern: /\b(?:log|record|add|create|onboard|acquire)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?customer\b/i, action: 'LOG_NEW_CUSTOMER' },
    { pattern: /\b(?:new\s+customer\s+acquisition|customer\s+acquisition|new\s+customer\s+onboarding|new\s+customer)\b/i, action: 'LOG_NEW_CUSTOMER' },

    // Complaints
    { pattern: /\b(?:log|record|raise|report|create|add)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?complaint\b/i, action: 'LOG_COMPLAINT' },
    { pattern: /\b(?:update|resolve|change|modify|close|reopen|set|mark)\s+(?:the\s+|a\s+)?(?:customer\s+)?complaint\b/i, action: 'UPDATE_COMPLAINT' },
    { pattern: /\b(?:change|update|modify|set)\s+(?:the\s+)?complaint\s+(?:type|status|description|action|notes)\b/i, action: 'UPDATE_COMPLAINT' },
    { pattern: /\b(?:mark|set)\s+(?:the\s+)?complaint\s+(?:as\s+)?(?:resolved|closed|pending|in progress|reopened)\b/i, action: 'UPDATE_COMPLAINT' },

    // Visits
    { pattern: /\b(?:log|record|add|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'LOG_VISIT' },
    { pattern: /\b(?:update|change|modify|set)\s+(?:the\s+|a\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'UPDATE_VISIT' },

    // Orders
    { pattern: /\b(?:record|log|create|add)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:purchase\s+)?order\b/i, action: 'LOG_ORDER' },
    { pattern: /\b(?:update|change|modify)\s+(?:the\s+|a\s+)?(?:purchase\s+)?order\b/i, action: 'UPDATE_ORDER' },

    // Inquiries
    { pattern: /\b(?:log|create|new|add)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?inquiry\b/i, action: 'LOG_INQUIRY' },
    { pattern: /\b(?:update|change|modify)\s+(?:the\s+|a\s+)?inquiry\b/i, action: 'UPDATE_INQUIRY' },
  ];

  let detectedAction = null;
  for (const { pattern, action } of directActionMap) {
    if (pattern.test(text)) {
      detectedAction = action;
      break;
    }
  }

  if (!detectedAction) {
    detectedAction = detectOperationalAction(text);
  }

  if (detectedAction) {
    await recordSessionMessage(senderPhone, 'user', text);
    const extracted = await extractFieldsWithLLM(detectedAction, text, {});
    const custCheck = await verifyDraftCustomer(detectedAction, extracted, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: detectedAction });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${detectedAction}|${custCheck.unverifiedName}|${JSON.stringify(extracted)}`);
        return { handled: true, reply: custCheck.prompt };
      } else {
        extracted.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: detectedAction });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${detectedAction}|${JSON.stringify(extracted)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    const hasCompany = Boolean(extracted.company_name || (Array.isArray(extracted.entries) && extracted.entries.some(e => e.company_name)));
    const hasLineItems = Array.isArray(extracted.line_items) && extracted.line_items.length > 0;
    const hasUpdates = extracted.updates && Object.keys(extracted.updates).length > 0;

    if (hasCompany || hasLineItems || hasUpdates || extracted.product_description) {
      const missing = validateMandatoryFields(detectedAction, extracted);

      if (missing.length === 0) {
        const summary = buildConfirmationSummary(detectedAction, extracted);
        await recordSessionMessage(senderPhone, 'assistant', summary, {
          action_type: detectedAction,
          customer_name: extracted.company_name,
        });
        await saveActiveSession(senderPhone, extracted.company_name || 'Customer', `catalog_confirm|${detectedAction}|${JSON.stringify(extracted)}`);
        return { handled: true, reply: summary };
      } else {
        const missingList = missing.map((m) => `• *${m}*`).join('\n');
        const actionName = getActionFriendlyName(detectedAction);
        const indexTag = extracted._totalCount > 1 ? ` (${extracted._currentIndex || 1} of ${extracted._totalCount}: ${extracted.company_name || 'Item'})` : '';
        const askMissing = `Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
        await recordSessionMessage(senderPhone, 'assistant', askMissing, {
          action_type: detectedAction,
          customer_name: extracted.company_name,
        });
        await saveActiveSession(senderPhone, extracted.company_name || 'Customer', `catalog_flow|${detectedAction}|${JSON.stringify(extracted)}`);
        return {
          handled: true,
          reply: askMissing,
        };
      }
    }
  }

  // Not intercepted by catalog flow -> let general LangGraph Orchestrator process
  return { handled: false };
}

module.exports = {
  CATALOG_MENU,
  MODULE_PROMPTS,
  isGreeting,
  matchActionFromInput,
  validateMandatoryFields,
  buildConfirmationSummary,
  executeAction,
  handleCatalogFlow,
  isOperationalQuery,
  detectOperationalAction,
  extractFieldsWithLLM,
  mergeDraft,
};
