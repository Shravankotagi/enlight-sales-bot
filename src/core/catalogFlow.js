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
 *    - Strict Schema Compatibility with Enlight Sales OS Frontend (Company Name & Line Items)
 */

const { invokeWithFallback } = require('./modelRouter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { supabase, saveActiveSession, getFullActiveSession, ensureCustomerRecord } = require('../supabase');
const { detectHsnCode } = require('../utils/hsnDetector');
const { safeParseJSON } = require('../utils/jsonUtils');

// ── CATALOG MENU ─────────────────────────────────────────────────────────────

const CATALOG_MENU = `👋 Welcome to *SalesOS Assistant*!

What would you like to do today?

*1️⃣ Log New Inquiry*
*2️⃣ Update Inquiry*
*3️⃣ Log New Order*
*4️⃣ Update Order*
*5️⃣ Log Customer Field Visit*
*6️⃣ Update Field Visit*
*7️⃣ Log Customer Complaint*
*8️⃣ Update Customer Complaint*
*9️⃣ Other / General Query*

Reply with a number (1–9) or type what you'd like to do.`;

// ── MODULE COLLECTION PROMPTS ────────────────────────────────────────────────

const MODULE_PROMPTS = {
  LOG_INQUIRY: `📋 *Log New Inquiry*

Please provide the following details. Fields marked with ⚠️ are mandatory.

⚠️ *Company Name:*
⚠️ *Product Description / SKU:* (e.g. HR Coil, MS Plate, SS 304 Pipe)
*Preferred Make:* (e.g. JSW, SAIL, Tata — optional)
⚠️ *Payment Terms:* (e.g. 30 Days Credit, 100% Advance)
⚠️ *Delivery Location:* (e.g. Chakan Industrial Area, Pune)
*Additional Notes:* (optional)

You can reply in any format — just include the field names or values in order.`,

  UPDATE_INQUIRY: `✏️ *Update Inquiry*

⚠️ *Inquiry ID:* (e.g. INQ-2026-0042)

Which fields do you want to update? Mention the field name and new value.

*Updatable Fields:*
- Product Description / SKU
- Preferred Make
- Payment Terms
- Delivery Location
- Additional Notes
- Status (Open / Quoted / Won / Lost / On Hold)

Example:
"INQ-2026-0042, update payment terms to 45 days credit, status to Quoted"`,

  LOG_ORDER: `🛒 *Record New Order*

Please provide the following details. Fields marked with ⚠️ are mandatory.

⚠️ *Company Name:*
⚠️ *PO Number:* (e.g. PO-2026-0042)
⚠️ *PO Date:* (e.g. 10-09-2026)
⚠️ *Delivery Location:*
⚠️ *Payment Terms:*

⚠️ *Line Items:* (repeat for each product)
  - Product Name / Description
  - Spec (e.g. 8X6000X1500)
  - HSN/SAC Code
  - Quantity & Unit (e.g. 10 MT)
  - Rate (₹ per unit)`,

  UPDATE_ORDER: `✏️ *Update Order*

⚠️ *PO Number:* (e.g. PO-2026-0042)

What would you like to update?

*Updatable Header Fields:*
- PO Date
- Delivery Location
- Payment Terms
- Status (Pending / Processing / Dispatched / Delivered / Cancelled)

*Updatable Line Item Fields:*
- To update a line item, mention the item number or product name and the new values
- You can also add a new line item or remove an existing one

Example:
"PO-2026-0042, update delivery location to Pune MIDC, change item 1 rate to 58000, add new item: MS Plate 10mm, HSN 720837, 5 MT, ₹55000"`,

  LOG_VISIT: `📍 *Log Customer Field Visit*

Please provide the following. Fields marked with ⚠️ are mandatory.

⚠️ *Customer / Company Name:*
⚠️ *Person Met:* (e.g. Suresh Patel)
⚠️ *Contact Phone:*
⚠️ *City / Location:*
⚠️ *Visit Date:* (e.g. 10-09-2026)
⚠️ *Visit Outcome:* (Positive / Negative / Neutral / Follow-up Required)
*Follow-up Action:* (e.g. Send rate quotation — optional)
⚠️ *Meeting Remarks & Requirements:*`,

  UPDATE_VISIT: `✏️ *Update Field Visit*

To identify the visit, provide ONE of the following:
⚠️ *Visit ID:* (e.g. VIS-2026-0015)
OR
⚠️ *Company Name + Visit Date:* (e.g. ABC Steels, 10-09-2026)

What would you like to update?

*Updatable Fields:*
- Person Met
- Contact Phone
- City / Location
- Visit Outcome (Positive / Negative / Neutral / Follow-up Required)
- Follow-up Action
- Meeting Remarks & Requirements
- Status (Completed / Follow-up Pending / Cancelled)

Example:
"ABC Steels visit on 10-09-2026, update outcome to Positive, follow-up action to Send quotation by Friday"`,

  LOG_COMPLAINT: `⚠️ *Log Customer Complaint*

Please provide the following. Fields marked with ⚠️ are mandatory.

⚠️ *Company / Customer Name:*
⚠️ *Linked Inquiry ID / PO Number & Product:*
⚠️ *Complaint Type:*
  (Quality Defect / Short Delivery / Wrong Material / Delayed Delivery / Billing Issue / Other)
⚠️ *Complaint Description:*
*Corrective Action Taken:* (optional — if already actioned)
⚠️ *Initial Status:* (Pending / In Progress / Resolved)`,

  UPDATE_COMPLAINT: `✏️ *Update Complaint*

To identify the complaint, provide ONE of the following:
⚠️ *Complaint ID:* (e.g. CMP-2026-0008)
OR
⚠️ *Linked PO Number / Inquiry ID:*

What would you like to update?

*Updatable Fields:*
- Complaint Type
- Complaint Description
- Corrective Action Taken
- Status (Pending / In Progress / Resolved / Closed)
- Resolution Notes

Example:
"CMP-2026-0008, update status to Resolved, corrective action: replacement dispatched on 09-09-2026"`
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
  const clean = text.trim().toLowerCase().replace(/[️⃣*]/g, '');

  if (clean === '1' || clean === '1.' || clean.includes('log inquiry') || clean.includes('log new inquiry') || clean === 'new inquiry' || clean === 'start_log_inquiry') {
    return 'LOG_INQUIRY';
  }
  if (clean === '2' || clean === '2.' || clean.includes('update inquiry') || clean === 'start_update_inquiry') {
    return 'UPDATE_INQUIRY';
  }
  if (clean === '3' || clean === '3.' || clean.includes('log order') || clean.includes('log new order') || clean.includes('record order') || clean.includes('record new order') || clean === 'new order' || clean === 'start_log_order') {
    return 'LOG_ORDER';
  }
  if (clean === '4' || clean === '4.' || clean.includes('update order') || clean === 'start_update_order') {
    return 'UPDATE_ORDER';
  }
  if (clean === '5' || clean === '5.' || clean.includes('log visit') || clean.includes('log customer field visit') || clean.includes('log customer visit') || clean.includes('log field visit') || clean === 'new visit' || clean === 'start_log_visit') {
    return 'LOG_VISIT';
  }
  if (clean === '6' || clean === '6.' || clean.includes('update visit') || clean.includes('update field visit') || clean === 'start_update_visit') {
    return 'UPDATE_VISIT';
  }
  if (clean === '7' || clean === '7.' || clean.includes('log complaint') || clean.includes('log customer complaint') || clean === 'new complaint' || clean === 'start_log_complaint') {
    return 'LOG_COMPLAINT';
  }
  if (clean === '8' || clean === '8.' || clean.includes('update complaint') || clean.includes('update customer complaint') || clean === 'start_update_complaint') {
    return 'UPDATE_COMPLAINT';
  }
  if (clean === '9' || clean === '9.' || clean === 'other' || clean.includes('general query') || clean === 'other query' || clean === 'general_query') {
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
  if (/^today$/i.test(clean)) {
    return formatDateDDMMYYYY(now);
  }
  if (/^yesterday$/i.test(clean)) {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    return formatDateDDMMYYYY(y);
  }
  if (/^day before yesterday$/i.test(clean) || /^parso$/i.test(clean)) {
    const dby = new Date(now.getTime() - 48 * 3600 * 1000);
    return formatDateDDMMYYYY(dby);
  }

  // Handle DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${day}-${month}-${year}`;
  }

  // Handle YYYY-MM-DD
  const ymdMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
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
  if (!dStr) return new Date().toISOString();
  const m = String(dStr).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    return new Date(`${m[3]}-${m[2]}-${m[1]}T10:00:00.000Z`).toISOString();
  }
  const parsed = new Date(dStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

// ── LLM FIELD EXTRACTION ENGINE ──────────────────────────────────────────────

async function extractFieldsWithLLM(action, userInput, existingDraft = {}) {
  const systemPrompt = `You are the Structured Data Extraction Agent for Enlight Metals CRM WhatsApp Bot.
The user is providing details for the action: "${action}".

Extract the fields according to the following strict schema rules.
Return ONLY a valid JSON object (no markdown, no backticks, no explanation).

Schema by Action:

LOG_INQUIRY:
{
  "action": "LOG_INQUIRY",
  "company_name": "<Customer / Company Name, else null>",
  "product_description": "<Summary of all products/SKUs, else null>",
  "preferred_make": "<JSW, SAIL, Tata, any, etc. if mentioned, else null>",
  "payment_terms": "<e.g. 30 Days Credit, 100% Advance, else null>",
  "delivery_location": "<e.g. Chakan Pune, Taloja, Aurangabad, else null>",
  "additional_notes": "<any extra notes if mentioned, else null>",
  "line_items": [
    {
      "sku_text": "<Core metal product name and gauge/thickness e.g. 'CR Sheet 1.00MM', 'HR Coil 3.15MM', 'Chequered Sheet 4.5MM'>",
      "description": "<Full product text e.g. 'CR Sheet 1.00MM (1000 x 2000 mm)'>",
      "dimensions": "<Dimensions / specifications e.g. '1000 x 2000 mm', '1250 mm width', '1250 x 2500 mm'>",
      "spec": "<Dimensions / specifications>",
      "hsn_sac": "<HSN code if known, else null>",
      "quantity": <numeric quantity e.g. 15>,
      "unit": "<MT | KG | PCS | Sheets | Nos, default MT>",
      "rate": <numeric rate if mentioned, else 0>,
      "amount": <numeric amount if mentioned, else 0>
    }
  ]
}

UPDATE_INQUIRY:
{
  "action": "UPDATE_INQUIRY",
  "inquiry_id": "<Inquiry ID e.g. INQ-2026-0042, INQ-B76516, #INQ-0042, else null>",
  "updates": {
    "product_description": "<if user requested update, else null>",
    "preferred_make": "<if user requested update, else null>",
    "payment_terms": "<if user requested update, else null>",
    "delivery_location": "<if user requested update, else null>",
    "additional_notes": "<if user requested update, else null>",
    "status": "<Open | Quoted | Won | Lost | On Hold if mentioned, else null>"
  }
}

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
  "meeting_remarks": "<meeting remarks & requirements discussed, else null>"
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

LOG_COMPLAINT:
{
  "action": "LOG_COMPLAINT",
  "company_name": "<Company / Customer Name, else null>",
  "linked_inquiry_or_po": "<Linked Inquiry ID or PO Number and Product, else null>",
  "complaint_type": "<Quality Defect | Short Delivery | Wrong Material | Delayed Delivery | Billing Issue | Other>",
  "complaint_description": "<Detailed complaint description, else null>",
  "corrective_action": "<Corrective action taken if mentioned, else null>",
  "initial_status": "<Pending | In Progress | Resolved>"
}

UPDATE_COMPLAINT:
{
  "action": "UPDATE_COMPLAINT",
  "complaint_id": "<Complaint ID e.g. CMP-2026-0008, else null>",
  "linked_inquiry_or_po": "<Linked PO Number / Inquiry ID if mentioned, else null>",
  "updates": {
    "complaint_type": "<if updated, else null>",
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
`;

  const userPrompt = `Existing Draft State:
${JSON.stringify(existingDraft, null, 2)}

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
      return mergeDraft(action, existingDraft, parsed);
    }
  } catch (err) {
    console.error('[CatalogFlow] LLM extraction error:', err.message);
  }

  return existingDraft;
}

// ── MERGE DRAFT HELPER ───────────────────────────────────────────────────────

function mergeDraft(action, baseDraft, newExtracted) {
  const merged = { ...baseDraft, action };

  for (const [key, val] of Object.entries(newExtracted)) {
    if (key === 'action') continue;

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
        }
      } else {
        if (key.includes('date') && typeof val === 'string') {
          merged[key] = normalizeDateToDDMMYYYY(val);
        } else {
          merged[key] = val;
        }
      }
    }
  }

  return merged;
}

// ── VALIDATE MANDATORY FIELDS ────────────────────────────────────────────────

function validateMandatoryFields(action, draft) {
  const missing = [];

  switch (action) {
    case 'LOG_INQUIRY':
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.product_description && (!Array.isArray(draft.line_items) || draft.line_items.length === 0)) {
        missing.push('Product Description / SKU');
      }
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!draft.delivery_location) missing.push('Delivery Location');
      break;

    case 'UPDATE_INQUIRY':
      if (!draft.inquiry_id) missing.push('Inquiry ID (e.g. INQ-2026-0042)');
      const inqUpdates = draft.updates || {};
      const hasInqUpdate = Object.values(inqUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasInqUpdate) missing.push('At least one field to update');
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

    case 'LOG_COMPLAINT':
      if (!draft.company_name) missing.push('Company / Customer Name');
      if (!draft.linked_inquiry_or_po) missing.push('Linked Inquiry ID / PO Number & Product');
      if (!draft.complaint_type) missing.push('Complaint Type');
      if (!draft.complaint_description) missing.push('Complaint Description');
      if (!draft.initial_status) missing.push('Initial Status (Pending / In Progress / Resolved)');
      break;

    case 'UPDATE_COMPLAINT':
      const hasCmpId = Boolean(draft.complaint_id);
      const hasLinkedRef = Boolean(draft.linked_inquiry_or_po);
      if (!hasCmpId && !hasLinkedRef) {
        missing.push('Complaint ID (e.g. CMP-2026-0008) OR Linked PO Number / Inquiry ID');
      }
      const cmpUpdates = draft.updates || {};
      const hasCmpUpdate = Object.values(cmpUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasCmpUpdate) missing.push('At least one field to update');
      break;
  }

  return missing;
}

// ── BUILD CONFIRMATION SUMMARY ───────────────────────────────────────────────

function buildConfirmationSummary(action, draft) {
  let summary = `✅ *Here's what I've captured:*\n\n`;

  switch (action) {
    case 'LOG_INQUIRY':
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
        summary += `• *Products:*\n`;
        draft.line_items.forEach((it, i) => {
          const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
          const qtyStr = it.quantity ? ` — ${it.quantity} ${it.unit || 'MT'}` : '';
          summary += `  ${i + 1}. *${it.sku_text || it.description}*${specStr}${qtyStr}\n`;
        });
      } else {
        summary += `• *Product Description / SKU:* ${draft.product_description}\n`;
      }
      if (draft.preferred_make) summary += `• *Preferred Make:* ${draft.preferred_make}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location}\n`;
      if (draft.additional_notes) summary += `• *Additional Notes:* ${draft.additional_notes}\n`;
      break;

    case 'UPDATE_INQUIRY':
      summary += `• *Inquiry ID:* ${draft.inquiry_id}\n`;
      summary += `*Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `• Updating *${label}* → ${v}\n`;
        }
      }
      break;

    case 'LOG_ORDER':
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      summary += `• *PO Number:* ${draft.po_number}\n`;
      summary += `• *PO Date:* ${draft.po_date}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms}\n\n`;
      summary += `*Line Items:*\n`;
      let totalAmount = 0;
      (draft.line_items || []).forEach((it, i) => {
        const qty = Number(it.quantity) || 0;
        const rate = Number(it.rate) || 0;
        const amount = Number(it.amount) || qty * rate;
        totalAmount += amount;
        const specStr = it.dimensions ? ` (${it.dimensions})` : (it.spec ? ` (${it.spec})` : '');
        const hsnStr = it.hsn_code ? ` [HSN: ${it.hsn_code}]` : (it.hsn_sac ? ` [HSN: ${it.hsn_sac}]` : '');
        summary += `${i + 1}. *${it.sku_text || it.description}*${specStr}${hsnStr}\n`;
        summary += `   • Quantity: ${qty} ${it.unit || 'MT'}\n`;
        summary += `   • Rate: ₹${rate.toLocaleString('en-IN')} / ${it.unit || 'MT'}\n`;
        summary += `   • Amount: ₹${amount.toLocaleString('en-IN')}\n`;
      });
      summary += `\n💰 *Total Order Value:* ₹${totalAmount.toLocaleString('en-IN')}\n`;
      break;

    case 'UPDATE_ORDER':
      summary += `• *PO Number:* ${draft.po_number}\n`;
      if (draft.updates && Object.keys(draft.updates).length > 0) {
        summary += `*Header Updates:*\n`;
        for (const [k, v] of Object.entries(draft.updates)) {
          if (v) {
            const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            summary += `• Updating *${label}* → ${v}\n`;
          }
        }
      }
      if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
        summary += `*Line Item Updates:*\n`;
        draft.line_item_updates.forEach((liu) => {
          summary += `• [${(liu.operation || 'update').toUpperCase()}] ${liu.item_reference || liu.description || 'Line Item'}: Qty ${liu.quantity || '-'}, Rate ₹${liu.rate || '-'}\n`;
        });
      }
      break;

    case 'LOG_VISIT':
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      summary += `• *Person Met:* ${draft.person_met}\n`;
      summary += `• *Contact Phone:* ${draft.contact_phone}\n`;
      summary += `• *City / Location:* ${draft.city_location}\n`;
      summary += `• *Visit Date:* ${draft.visit_date}\n`;
      summary += `• *Visit Outcome:* ${draft.visit_outcome}\n`;
      if (draft.followup_action) summary += `• *Follow-up Action:* ${draft.followup_action}\n`;
      summary += `• *Meeting Remarks:* ${draft.meeting_remarks}\n`;
      break;

    case 'UPDATE_VISIT':
      const targetVis = draft.visit_id || `${draft.company_name} on ${draft.visit_date}`;
      summary += `• *Target Visit:* ${targetVis}\n`;
      summary += `*Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `• Updating *${label}* → ${v}\n`;
        }
      }
      break;

    case 'LOG_COMPLAINT':
      summary += `• *Customer / Company:* ${draft.company_name}\n`;
      summary += `• *Linked Inquiry / PO:* ${draft.linked_inquiry_or_po}\n`;
      summary += `• *Complaint Type:* ${draft.complaint_type}\n`;
      summary += `• *Description:* ${draft.complaint_description}\n`;
      if (draft.corrective_action) summary += `• *Corrective Action:* ${draft.corrective_action}\n`;
      summary += `• *Initial Status:* ${draft.initial_status}\n`;
      break;

    case 'UPDATE_COMPLAINT':
      const targetCmp = draft.complaint_id || draft.linked_inquiry_or_po;
      summary += `• *Target Complaint:* ${targetCmp}\n`;
      summary += `*Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `• Updating *${label}* → ${v}\n`;
        }
      }
      break;
  }

  summary += `\n*Reply:*\n✔️ *Yes* — to save\n✏️ *Edit* — to change something\n❌ *Cancel* — to discard`;
  return summary;
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

        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const hCode = it.hsn_code || it.hsn_sac || detectHsnCode(sText, sDim) || detectHsnCode(it.description || '') || '72083840';
              return {
                sku_text: sText,
                description: it.description || sText,
                dimensions: sDim,
                spec: sDim,
                hsn_code: hCode,
                hsn_sac: hCode,
                quantity: Number(it.quantity) || 0,
                unit: it.unit || 'MT',
                rate: Number(it.rate) || 0,
                amount: Number(it.amount) || Math.round((Number(it.quantity) || 0) * (Number(it.rate) || 0)),
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
                rate: 0,
                amount: 0,
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
          product_requirement: draft.product_description || (structuredLineItems[0] ? structuredLineItems[0].sku_text : null),
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          inquiry_type: 'inquiry',
          overall_confidence: 0.95,
        };

        let humanRawText = `Customer: ${companyName}\n`;
        if (structuredLineItems.length > 0 && structuredLineItems[0].quantity > 0) {
          humanRawText += `Products:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} - ${it.quantity} ${it.unit}`).join('\n') + `\n`;
        } else if (draft.product_description) {
          humanRawText += `Product: ${draft.product_description}\n`;
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
          ? structuredLineItems.map(it => `${it.sku_text || it.description}${it.quantity ? ` - ${it.quantity} ${it.unit || 'MT'}` : ''}`).join(', ')
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
        const cleanId = (draft.inquiry_id || '').replace(/^#?(?:DEAL|INQ)-?/i, '').trim();
        const { data: deals } = await supabase
          .from('deals')
          .select('id, inquiry_id, customer_name, stage')
          .or(`id.ilike.%${cleanId}%,inquiry_id.ilike.%${cleanId}%`)
          .limit(1);

        const deal = deals && deals.length > 0 ? deals[0] : null;
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

      case 'LOG_COMPLAINT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone);

        const nowIso = new Date().toISOString();
        const slaDueAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

        // 1. Insert into complaints
        const { error: cmpErr } = await supabase.from('complaints').insert({
          customer_name: companyName,
          complaint_type: draft.complaint_type || 'quality',
          description: draft.complaint_description,
          reported_by: senderPhone,
          status: (draft.initial_status || 'Pending').toLowerCase(),
          po_number: draft.linked_inquiry_or_po,
          deal_id: draft.linked_inquiry_or_po,
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
          description: `Complaint Logged: ${companyName} - ${draft.complaint_type}: ${draft.complaint_description}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: nowIso,
        });

        return `⚠️ *Customer Complaint Logged Successfully!*

🏢 *Customer:* ${companyName}
🔗 *Linked Ref:* ${draft.linked_inquiry_or_po}
📋 *Complaint Type:* ${draft.complaint_type}
📝 *Description:* ${draft.complaint_description}
🚦 *Status:* ${draft.initial_status}${draft.corrective_action ? `\n🛠️ *Corrective Action:* ${draft.corrective_action}` : ''}

Logged to Customer Complaints Card! (48h SLA Active) ⏱️`;
      }

      case 'UPDATE_COMPLAINT': {
        const targetRef = draft.complaint_id || draft.linked_inquiry_or_po;
        const updates = draft.updates || {};
        const cmpUpdates = {};

        if (updates.complaint_type) cmpUpdates.complaint_type = updates.complaint_type;
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

        if (targetRef) {
          await supabase
            .from('complaints')
            .update(cmpUpdates)
            .or(`id.ilike.%${targetRef}%,po_number.ilike.%${targetRef}%,deal_id.ilike.%${targetRef}%`);
        }

        return `✅ *Customer Complaint Updated Successfully!*

🔗 *Reference:* ${targetRef}
${updates.status ? `🚦 *New Status:* ${updates.status}\n` : ''}Updated details saved to Customer Complaints Card! ✅`;
      }

      default:
        return `✅ Action ${action} completed successfully!`;
    }
  } catch (err) {
    console.error(`[CatalogFlow] Execution error for ${action}:`, err.message);
    return `❌ An error occurred while saving: ${err.message}. Please try again.`;
  }
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
    return {
      handled: true,
      reply: CATALOG_MENU,
    };
  }

  // ── 2. FETCH ACTIVE SESSION STATE ──────────────────────────────────────────
  const activeSession = await getFullActiveSession(senderPhone);
  const lastIntent = activeSession ? (activeSession.last_intent || '') : '';

  // ── 3. HANDLE CONFIRMATION STATE (catalog_confirm|...) ──────────────────────
  if (lastIntent.startsWith('catalog_confirm|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

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
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', 'general');
      const reply = await executeAction(action, draft, senderPhone);
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
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${draftJsonStr}`);
      return {
        handled: true,
        reply: `Which field would you like to change? (e.g. "Rate: 55000" or "Delivery location: Pune")`,
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
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: `❌ Discarded. Send 'Hi' to start again.`,
      };
    }

    // Direct inline edit attempt during confirmation
    const updatedDraft = await extractFieldsWithLLM(action, text, draft);
    const missing = validateMandatoryFields(action, updatedDraft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    }

    return {
      handled: true,
      reply: `Please reply with:\n✔️ *Yes* — to save\n✏️ *Edit* — to change a field\n❌ *Cancel* — to discard`,
    };
  }

  // ── 4. HANDLE EDITING STATE (catalog_editing|...) ───────────────────────────
  if (lastIntent.startsWith('catalog_editing|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    const updatedDraft = await extractFieldsWithLLM(action, text, draft);
    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      const summary = buildConfirmationSummary(action, updatedDraft);
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    } else {
      const missingList = missing.map((m, i) => `${i + 1}. *${m}*`).join('\n');
      const actionName = getActionFriendlyName(action);
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: `Let's finish your ${actionName} first. Please provide the missing mandatory details:\n\n${missingList}`,
      };
    }
  }

  // ── 5. HANDLE DATA COLLECTION FLOW STATE (catalog_flow|...) ────────────────
  if (lastIntent.startsWith('catalog_flow|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const existingDraft = safeParseJSON(draftJsonStr, {});

    // Check if user wants to abort / switch
    const newActionMatch = matchActionFromInput(text);
    if (newActionMatch && newActionMatch !== action) {
      if (newActionMatch === 'GENERAL_QUERY') {
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return {
          handled: true,
          reply: `Please let me know what you would like to search or check in the CRM!`,
        };
      }
      const initialPrompt = MODULE_PROMPTS[newActionMatch];
      if (initialPrompt) {
        await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${newActionMatch}|{}`);
        return { handled: true, reply: initialPrompt };
      }
    }

    if (/^(?:cancel|stop|discard|exit|quit)$/i.test(text)) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: `❌ Discarded. Send 'Hi' to start again.`,
      };
    }

    // Extract fields from user message
    const updatedDraft = await extractFieldsWithLLM(action, text, existingDraft);
    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      // All mandatory fields present -> Show confirmation summary
      const summary = buildConfirmationSummary(action, updatedDraft);
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: summary };
    } else {
      // Missing mandatory fields -> Ask only for missing fields
      const missingList = missing.map((m, i) => `${i + 1}. *${m}*`).join('\n');
      const actionName = getActionFriendlyName(action);
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: `Please provide the remaining mandatory details for this ${actionName}:\n\n${missingList}`,
      };
    }
  }

  // ── 6. DIRECT ACTION ROUTING (Menu Selection 1-9 or Action Keywords) ────────
  const matchedAction = matchActionFromInput(text);
  if (matchedAction) {
    if (matchedAction === 'GENERAL_QUERY') {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: `What would you like to search or know? You can ask about inquiries, visits, won orders, customer profiles, or pipeline status.`,
      };
    }

    const initialPrompt = MODULE_PROMPTS[matchedAction];
    if (initialPrompt) {
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${matchedAction}|{}`);
      return { handled: true, reply: initialPrompt };
    }
  }

  // ── 7. DIRECT 1-SHOT ACTION DETECTION FROM FULL TEXT ───────────────────────
  const directActionMap = [
    { pattern: /^\s*(?:log|create|new|add)\s*(?:new\s*)?inquiry\b/i, action: 'LOG_INQUIRY' },
    { pattern: /^\s*(?:update|change|modify)\s*inquiry\b/i, action: 'UPDATE_INQUIRY' },
    { pattern: /^\s*(?:record|log|create|add)\s*(?:new\s*)?order\b/i, action: 'LOG_ORDER' },
    { pattern: /^\s*(?:update|change|modify)\s*order\b/i, action: 'UPDATE_ORDER' },
    { pattern: /^\s*(?:log|record|add)\s*(?:customer\s*)?(?:field\s*)?visit\b/i, action: 'LOG_VISIT' },
    { pattern: /^\s*(?:update|change|modify)\s*(?:field\s*)?visit\b/i, action: 'UPDATE_VISIT' },
    { pattern: /^\s*(?:log|record|raise|report)\s*(?:customer\s*)?complaint\b/i, action: 'LOG_COMPLAINT' },
    { pattern: /^\s*(?:update|resolve|change|modify)\s*(?:customer\s*)?complaint\b/i, action: 'UPDATE_COMPLAINT' },
  ];

  for (const { pattern, action } of directActionMap) {
    if (pattern.test(text)) {
      const extracted = await extractFieldsWithLLM(action, text, {});
      const missing = validateMandatoryFields(action, extracted);

      if (missing.length === 0) {
        const summary = buildConfirmationSummary(action, extracted);
        await saveActiveSession(senderPhone, extracted.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(extracted)}`);
        return { handled: true, reply: summary };
      } else {
        const missingList = missing.map((m, i) => `${i + 1}. *${m}*`).join('\n');
        const actionName = getActionFriendlyName(action);
        await saveActiveSession(senderPhone, extracted.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(extracted)}`);
        return {
          handled: true,
          reply: `I've noted the initial details for your ${actionName}. Please provide the missing mandatory details:\n\n${missingList}`,
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
};
