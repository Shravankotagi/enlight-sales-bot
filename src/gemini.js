/**
 * gemini.js — Inquiry extraction & classification module using Google Gemini (gemini-2.5-flash)
 */

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage } = require('@langchain/core/messages');
const { safeParseJSON } = require('./utils/jsonUtils');
const { supabase } = require('./supabase');
const { invokeWithFallback } = require('./core/modelRouter');

async function callLightweightModel(prompt) {
  const response = await invokeWithFallback([new HumanMessage(prompt)]);
  return typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
}

const EXTRACTION_PROMPT = `
You are an expert document parser for Enlight Metals, an Indian B2B metal distributor.
Input is a photo or PDF of a business document — either a PURCHASE ORDER (PO) or a MATERIAL REQUIREMENT/INQUIRY/RFQ.

════════════════════════════════════════════════════
🔴 RULE #1 — PO vs INQUIRY (MOST IMPORTANT RULE):
════════════════════════════════════════════════════

STEP 1: Scan the ENTIRE document for a field explicitly labeled:
  "PO No", "P.O. No", "PO Number", "Purchase Order No", "Purchase Order Number", "PO Ref", "P.O. Ref"

STEP 2A — If such a label EXISTS and has a value (e.g. "PO No: 471" or "PO/2026/123"):
  → Set inquiry_type: "purchase_order"
  → Set po_number: "<that exact value>"
  → This is a CONFIRMED PURCHASE ORDER.

STEP 2B — If NO such label exists, OR the document says "Inquiry", "RFQ", "Quotation Request", "Material Requirement":
  → Set inquiry_type: "inquiry"
  → Set po_number: null
  → This is an INQUIRY/RFQ, NOT a purchase order.

⚠️  IMPORTANT: "Ref No", "Inquiry Ref", "Quotation Ref", "Our Ref", "Your Ref" are NOT PO numbers.
    Only fields explicitly labeled PO No / Purchase Order No qualify.
    When in doubt → inquiry_type: "inquiry", po_number: null.
════════════════════════════════════════════════════

Extract the following into ONLY a JSON object (no prose, no markdown, no backticks):

{
  "customer": {
    "name": "",
    "contact_person": "",
    "phone": "",
    "gst": "",
    "address": "",
    "match_status": "matched|fuzzy|new"
  },
  "line_items": [
    {
      "sku_text": "",
      "grade": "",
      "dimensions": "",
      "quantity": 0,
      "unit": "MT|KG|PCS",
      "rate": 0,
      "amount": 0,
      "confidence": 0.0
    }
  ],
  "po_number": null,
  "po_date": null,
  "delivery_location": "",
  "delivery_date": "",
  "payment_terms": "",
  "basic_amount": 0,
  "gst_amount": 0,
  "total_amount": 0,
  "overall_confidence": 0.0,
  "inquiry_type": "purchase_order|inquiry|visiting_card|unknown"
}

Additional Rules:
- Quantities: normalize to MT where unit is tonnes/ton/MT; keep KG/PCS as stated
- SKU text: preserve the customer's exact words in sku_text
- Basic & GST Amounts: extract basic_amount (before tax), gst_amount (18%), and total_amount (grand total including GST).
- If a field is absent return null — never invent values
- DATE RULE: Current Year is 2026. Any date specifying month/day MUST ALWAYS use year 2026 (e.g. 2026-08-14).
- CONFIDENCE RULE:
  * 1.0 (100%) when quantity, product, unit, AND explicit rate/price per MT are stated.
  * 0.85 when rate is auto-derived from rate sheet.
  * 0.75 - 0.80 when rate or customer details are missing.
- Return ONLY the JSON object. No prose. No markdown. No backticks.
`;

async function getLatestActiveRatesText() {
  try {
    const { data: sheets } = await supabase
      .from('rate_sheets')
      .select('id, date, rate_sheet_items(*)')
      .order('created_at', { ascending: false })
      .limit(1);

    if (sheets && sheets.length > 0 && sheets[0].rate_sheet_items?.length > 0) {
      const items = sheets[0].rate_sheet_items;
      const formatted = items
        .map(
          (i) =>
            `- ${i.category || 'Steel'} (${i.grade || 'Standard'}${i.dimensions ? ` ${i.dimensions}` : ''}): ₹${Number(i.price_per_mt || 0).toLocaleString('en-IN')}/MT`,
        )
        .join('\n');
      return `\nOFFICIAL ACTIVE RATE SHEET (Use these per-MT prices to calculate rate and total_amount when rate is not explicitly stated in the input):\n${formatted}\n`;
    }
  } catch (err) {
    console.error('Error fetching rate sheet for Gemini:', err.message);
  }
  return '';
}

function postProcessExtraction(parsed) {
  if (!parsed) return parsed;

  // 0. PO vs Inquiry enforcement: if po_number is set, inquiry_type MUST be purchase_order
  if (
    parsed.po_number &&
    parsed.po_number !== 'null' &&
    parsed.po_number !== 'None' &&
    String(parsed.po_number).trim().length > 2
  ) {
    // Has a real PO number → this IS a purchase order, regardless of what model said
    parsed.inquiry_type = 'purchase_order';
  } else if (parsed.inquiry_type === 'purchase_order') {
    // Model said purchase_order but no PO number found → revert to inquiry
    parsed.inquiry_type = 'inquiry';
    parsed.po_number = null;
    console.warn('[Gemini] postProcess: model set purchase_order but no po_number found — corrected to inquiry');
  }

  // 1. Delivery Date Year Correction (Ensure 2026 or future year)
  if (parsed.delivery_date) {
    const parts = parsed.delivery_date.split('-');
    if (parts.length === 3 && parseInt(parts[0]) < 2026) {
      parsed.delivery_date = `2026-${parts[1]}-${parts[2]}`;
    }
  }

  // 2. Line Item Rate and Amount calculation
  let totalCalculatedAmount = 0;
  let hasMissingRate = false;

  if (Array.isArray(parsed.line_items) && parsed.line_items.length > 0) {
    parsed.line_items.forEach((item) => {
      const qty = Number(item.quantity || 0);
      let rate = Number(item.rate || 0);
      let amount = Number(item.amount || 0);

      if (qty > 0 && amount > 0 && rate === 0) {
        rate = Math.round(amount / qty);
        item.rate = rate;
      }

      if (qty > 0 && rate > 0 && amount === 0) {
        amount = qty * rate;
        item.amount = amount;
      }

      if (rate === 0) {
        hasMissingRate = true;
      }

      totalCalculatedAmount += amount;
    });
  }

  if (totalCalculatedAmount > 0 && (!parsed.total_amount || parsed.total_amount === 0)) {
    parsed.total_amount = totalCalculatedAmount;
  }

  // 3. Realistic Confidence Adjustment
  if (hasMissingRate && parsed.overall_confidence > 0.8) {
    parsed.overall_confidence = 0.8;
  }

  return parsed;
}

async function extractFromText(text) {
  try {
    const rateSheetInfo = await getLatestActiveRatesText();
    const prompt = EXTRACTION_PROMPT + rateSheetInfo + '\n\nInput text:\n' + text;
    const rawText = await callLightweightModel(prompt);
    const parsed = safeParseJSON(rawText, null);
    if (!parsed) throw new Error('Could not parse JSON extraction from Gemini response');
    const postProcessed = postProcessExtraction(parsed);
    console.log('Gemini text extraction successful:', JSON.stringify(postProcessed, null, 2));
    return postProcessed;
  } catch (error) {
    console.error('Gemini text extraction error:', error.message);
    return {
      overall_confidence: 0,
      inquiry_type: 'unknown',
      error: error.message
    };
  }
}

async function extractFromImageOrDoc(buffer, mimeType) {
  try {
    const axios = require('axios');
    const apiKey =
      process.env.GEMINI_PAID_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY_1 ||
      process.env.GEMINI_API_KEY_2;
    if (!apiKey) {
      throw new Error('GEMINI API key missing');
    }

    const cleanBase64 = buffer.toString('base64');
    const cleanMime = mimeType || 'application/pdf';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    // Using gemini-2.5-flash — highest accuracy multimodal model for PO vs Inquiry differentiation

    const response = await axios.post(
      url,
      {
        system_instruction: {
          parts: [
            {
              text: `You are a document classifier for Enlight Metals (Indian B2B metal distributor).
CRITICAL: Before you do ANYTHING else, scan the document for a field labeled "PO No", "P.O. No", "PO Number", "Purchase Order No", or "Purchase Order Number".
- If that label EXISTS with a value → inquiry_type MUST be "purchase_order" and po_number MUST be set to that value.
- If that label does NOT exist → inquiry_type MUST be "inquiry" and po_number MUST be null.
"Ref No", "Inquiry Ref", "Quotation Ref" are NOT PO numbers. Never confuse them with a PO Number.
Return ONLY a valid JSON object. No markdown, no prose, no backticks.`,
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              { text: EXTRACTION_PROMPT },
              {
                inline_data: {
                  mime_type: cleanMime,
                  data: cleanBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.05,
          response_mime_type: 'application/json',
        },
      },
      { timeout: 35000 },
    );

    const rawText =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = safeParseJSON(rawText, null);
    if (!parsed) throw new Error('Could not parse JSON from Gemini vision response');
    const postProcessed = postProcessExtraction(parsed);
    console.log('Gemini document/image extraction successful:', JSON.stringify(postProcessed, null, 2));
    return postProcessed;
  } catch (error) {
    console.error('Gemini vision extraction error:', error.message);
    return {
      overall_confidence: 0,
      inquiry_type: 'unknown',
      error: error.message,
    };
  }
}

async function extractFromImage(imageBuffer, mimeType) {
  return extractFromImageOrDoc(imageBuffer, mimeType || 'image/jpeg');
}

async function extractFromDocument(documentBuffer, mimeType = 'application/pdf') {
  return extractFromImageOrDoc(documentBuffer, mimeType || 'application/pdf');
}

const INTENT_PROMPT = `
You are the intelligent message router for Enlight Metals, an Indian B2B metal distributor.
A salesperson sends a WhatsApp message in English, Hindi, or Hinglish — casually, informally, 
without any fixed format. Your job is to understand the INTENT behind what they are reporting.

Think about what action the salesperson is describing, not what words they used.

Return ONLY a JSON object (no prose, no markdown, no backticks):
{
  "intent": "<one of the intents below>",
  "customer_name": "<extracted customer/company name if mentioned, else null>",
  "amount_paid": <numeric amount paid/collected if mentioned, else 0>,
  "amount_pending": <numeric amount still pending/outstanding if mentioned, else 0>,
  "payment_status": "full|partial|pending|unknown",
  "reasoning": "<one sentence explaining why you chose this intent>",
  "confidence": <float 0.0 to 1.0>
}

INTENT DEFINITIONS — understand the meaning, not the keywords:

"stage_update": The salesperson is telling you the STATUS of a deal changed.
  Examples (all different wordings, same intent):
  - "Supreme ka deal ho gaya" (deal finalized)
  - "Mehta Industries ne mana kar diya" (customer refused)
  - "ABC ke saath baat chal rahi hai" (negotiation ongoing)
  - "Rate bhej diya Maine" (quote was sent)
  - "Order pakka ho gaya 15 ton ka" (order confirmed)
  - "Wo nahi lenge, price jyada lagi unhe" (lost on price)

"payment": The salesperson is reporting money received, advance paid, or outstanding balance.
  Examples:
  - "Supreme ne 50 hazaar diye aaj" (payment received)
  - "Unka 2 lakh abhi bhi baaki hai" (outstanding pending)
  - "Advance aa gaya" (advance received)
  - "Full payment clear ho gayi" (fully paid)
  - "Partial mila, baaki next week" (partial payment)

"visit": The salesperson visited a customer's location or met them in person.
  Examples:
  - "Aaj Mehta ke yahan gaya tha" (visited today)
  - "Factory visit ki ABC ka" (factory visit done)
  - "Mr. Sharma se mila aaj office mein" (met person)
  - "Site pe gaye the, unse baat hui" (went to site)

"new_customer": The salesperson acquired or onboarded a new client they didn't have before, OR they are updating an existing customer's contact details, owner name, phone, address, location, or GST.
  Examples:
  - "Ek naya party mila, XYZ Steels" (new party found)
  - "New customer onboard hua" (new customer onboarded)
  - "Delta Structural Steel phone 9876543210 owner Mr. Kapoor" (customer detail update)
  - "Mehta Industries location Pune gst 27AAAAA1111A1Z1" (customer detail update)

"followup": The salesperson followed up or checked in with an existing customer.
  Examples:
  - "Mehta ko call kiya, soch rahe hain" (called, they're thinking)
  - "Follow kar raha hoon Supreme ka" (following up)
  - "Unse dobara baat ki" (spoke again)
  - "Check in kiya, interested hain" (checked in)

"complaint": A customer raised an issue, rejected material, or reported a problem.
  Examples:
  - "ABC ne material wapas kiya" (material returned)
  - "Quality issue aa gaya unka" (quality issue)
  - "Customer complaint hai Mehta ka" (complaint)
  - "Unhone reject kar diya" (rejected)

"complaint_resolve": A previously reported complaint or issue has been resolved.
  Examples:
  - "Mehta ka issue solve ho gaya" (issue solved)
  - "Complaint fix kar di" (complaint fixed)
  - "Ab theek hai, unhone accept kar liya" (accepted now)

"inquiry": A customer's product requirement — what steel they want to buy.
  Examples:
  - "5 ton HR coil chahiye ABC ko" (product requirement)
  - "Mehta ne rate manga 10mm ka" (rate asked for)
  - "PO aaya hai Supreme ka" (purchase order received)

"query": The salesperson (or admin) is asking for information, reports, data, or stats from the system. This includes ANY request to SEE, SHOW, LIST, GET, or RETRIEVE data. It also includes rate/price questions, dashboard link requests, and general how-to questions about the bot.

"greeting": Just a hello or check-in with no business content.

"unknown": You genuinely cannot determine any business intent.

Return ONLY the JSON object.
`;

async function classifyIntent(text) {
  try {
    const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
    const contextPrompt = `Context:\n- Today's date and time in India: ${nowStr}\n\n`;
    const prompt = contextPrompt + INTENT_PROMPT + '\n\nSalesperson message:\n' + text;
    const rawText = await callLightweightModel(prompt);
    const parsed = safeParseJSON(rawText, null);
    if (parsed && parsed.intent) {
      console.log(`Intent: ${parsed.intent} | Confidence: ${parsed.confidence} | Reason: ${parsed.reasoning || parsed.intent}`);
      return parsed;
    }
    throw new Error('Could not parse intent JSON');
  } catch (error) {
    console.error('Gemini intent classification error:', error.message);
    return { intent: 'unknown', customer_name: null, confidence: 0, reasoning: 'Error during classification' };
  }
}

const QUERY_CLASSIFIER_PROMPT = `
You are an intelligent query router for a B2B metal sales system.
Your job is to classify the salesperson's request into one of the following categories:

DATA & RBAC QUERIES:
- "inquiry_summary": Queries asking how many inquiries received, total inquiry count, inquiry stats (e.g. "How many inquiries have we received this month?", "Inquiry count", "Total inquiries this month", "Kitni inquiries aayi hai", "Number of inquiries", "Total inquiries")
- "order_list": Queries asking to list, filter, find, search, or show specific orders/deals by delivery location, customer name, product/material, status/stage, amount/value, quantity, or date (e.g. "List orders with delivery location Mumbai", "Show orders for Dynamic Industries", "Orders with product HR coil", "Show deals above 10 lakhs", "Orders in Pune", "Filter orders by status won", "List deals delivering to Chakan")
- "customer_360": Questions asking for 360 view, profile, deals, payments, or overview of a specific customer/company (e.g. "Customer 360 for Supreme Steel", "Tell me about Tata Motors", "Profile of Mehta Eng").
- "knowledge_base": Questions about company policies, SOPs, MOQ (minimum order quantity), quotation validity, payment terms, discount slabs, or company guidelines.
- "reorder_queue": Questions asking which recurring customers are due for reorder.
- "churn_radar": Questions asking for churn radar or churn risk customers.
- "loss_analytics": Questions asking for lost deal analysis or why deals were lost.
- "team_pipeline": Questions from managers/admins asking for overall team pipeline or subordinates' deals.
- "inactive_customers": Questions asking for inactive recurring customer accounts.
- "dashboard_link", "sales_summary", "kra_status", "visit_summary", "payment_summary", "complaint_summary", "full_report", "deals_this_week", "pending_deals", "pending_inquiries", "new_customers_summary", "won_customers", "active_deals_detail", "customer_list", "rate_sheet", "visit_list", "payment_aging", "lost_deals"

ASSISTANT QUERIES: "general"
BLOCKED QUERIES: "blocked"

Return ONLY a JSON object (no markdown, no prose, no backticks):
{
  "category": "<one of the categories above>",
  "confidence": <float 0.0 to 1.0>,
  "customer_name": "<extracted customer/company name if category is customer_360, else null>",
  "target_salesperson": "<full name of the salesperson mentioned in the query if any, else null>"
}
`;

async function classifyQueryType(text) {
  try {
    const prompt = QUERY_CLASSIFIER_PROMPT + '\n\nQuery: "' + text + '"';
    const rawText = await callLightweightModel(prompt);
    const parsed = safeParseJSON(rawText, null);
    if (parsed && parsed.category) {
      console.log(`Query Category: ${parsed.category} | Confidence: ${parsed.confidence}`);
      return parsed;
    }
    throw new Error('Could not parse query category JSON');
  } catch (error) {
    console.error('Gemini query classification error:', error.message);
    return { category: 'general', confidence: 0 };
  }
}

module.exports = { extractFromText, extractFromImage, extractFromDocument, classifyIntent, getLatestActiveRatesText, classifyQueryType };
