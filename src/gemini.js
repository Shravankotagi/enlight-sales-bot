/**
 * gemini.js — Inquiry extraction & classification module using Google Gemini (gemini-3.5-flash / gemini-3.5-flash-lite)
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
Input is a photo, PDF, or text of a business document — either a PURCHASE ORDER (PO) or a MATERIAL REQUIREMENT/INQUIRY/RFQ.

════════════════════════════════════════════════════
🔴 RULE #1 — PO vs INQUIRY (MOST IMPORTANT RULE):
════════════════════════════════════════════════════

STEP 1: Scan the ENTIRE document for a field explicitly labeled:
  "PO No", "P.O. No", "PO Number", "Purchase Order No", "Purchase Order Number", "PO Ref", "P.O. Ref", "Order No."

STEP 2A — If such a label EXISTS and has a value (e.g. "PO No: 471" or "PO-26-27-00718"):
  → Set inquiry_type: "purchase_order"
  → Set po_number: "<that exact value>"
  → This is a CONFIRMED PURCHASE ORDER.

STEP 2B — If NO such label exists, OR the document says "Inquiry", "RFQ", "Quotation Request", "Material Requirement":
  → Set inquiry_type: "inquiry"
  → Set po_number: null
  → This is an INQUIRY/RFQ, NOT a purchase order.

⚠️  IMPORTANT: "Ref No", "Inquiry Ref", "Quotation Ref", "Our Ref", "Your Ref", "PR No." are NOT PO numbers.
    Only fields explicitly labeled PO No / Purchase Order No / Order No qualify.
    When in doubt → inquiry_type: "inquiry", po_number: null.

════════════════════════════════════════════════════
🔴 RULE #2 — CUSTOMER / COMPANY NAME vs ADDRESS:
════════════════════════════════════════════════════

1. CUSTOMER COMPANY NAME (customer.name):
   - In Purchase Orders, the Customer is the BUYER who issued the PO (found under "Invoice To:", "Bill To:", "Buyer:", "Customer:", "M/s:").
   - The Customer Name is STRICTLY the Legal Company / Enterprise Name on the FIRST line under "Invoice To:" (e.g. "SB Scafform Technovert Pvt. Ltd.", "ABC Fabricators Pvt. Ltd.").
   - ⚠️ CRITICAL: NEVER include the building name, commercial complex, industrial estate, plot number, road, or city name in the customer name!
     * Example: "Akshar Business Park, Office No - 1068, 1st Floor, Turbhe Navi Mumbai" is the OFFICE/BUILDING ADDRESS, NOT the company name.
     * Correct customer.name: "SB Scafform Technovert Pvt. Ltd."
     * INCORRECT: "Akshar Technovart Pvt. Ltd." or "Akshar Business Park".
   - ⚠️ CRITICAL: The Supplier / Seller is "Enlight Metals Private Limited" (our own company). NEVER set "Enlight Metals" as the customer.name!

2. CUSTOMER BILLING ADDRESS (customer.address):
   - The street/building/city address under "Invoice To:" (e.g. "Akshar Business Park, Office No - 1068, 1st Floor, U - Wing Plot No - 03, Sector - 25, Turbhe, Navi Mumbai, PIN: 400703").

3. CUSTOMER GSTIN (customer.gst):
   - The 15-character GSTIN number belonging to the customer under "Invoice To:" (e.g. "27AARCS0956R1ZB").

4. DELIVERY LOCATION (delivery_location):
   - In Purchase Orders, extract delivery_location STRICTLY from the "Delivery Address:" / "Ship To:" / "Consignee Address:" section.
   - Format cleanly as the destination site/city (e.g. "Gat No / Plot No PAP V - 149/2, Village Vasuli, Taluka Khed, Pune, PIN: 410501").
   - ⚠️ NEVER include Enlight Metals' supplier address, supplier PIN (411048), or billing office in the delivery_location!

5. LINE ITEMS & UNITS (line_items):
   - Extract exact quantity and EXACT UOM (unit of measure) stated in the line item table.
   - If the document table specifies UOM as "Kg" or "KG" and Qty "5000.0", set quantity: 5000 and unit: "KG".
   - If the document table specifies UOM as "MT" or "Tons", set unit: "MT".
   - If the document table specifies UOM as "PCS" or "Sheets", set unit: "PCS" / "Sheets".
   - NEVER convert unit to MT if the document table explicitly says Kg!
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
  "subtotal": 0,
  "basic_amount": 0,
  "sgst_amount": 0,
  "cgst_amount": 0,
  "igst_amount": 0,
  "gst_amount": 0,
  "grand_total": 0,
  "total_amount": 0,
  "overall_confidence": 0.0,
  "inquiry_type": "purchase_order|inquiry|visiting_card|unknown"
}

Additional Rules:
- Line Items: Extract each line item's quantity, unit rate, and line amount separately (these are always pre-GST values).
- Subtotal / Basic Amount: Sum of line item amounts BEFORE GST. If the document shows a pre-tax total (e.g. "Total: ₹10,33,000.00"), use that exact pre-GST amount. NEVER store the PO Grand Total as subtotal or basic_amount!
- GST Components: Extract SGST (e.g. 9%), CGST (e.g. 9%), IGST (e.g. 18%), and total GST amount as stated in the document.
- Grand Total: The final GST-inclusive value stated in the PO document (e.g. "Grand Total: ₹12,18,940.00").
- SKU text: preserve the customer's exact words in sku_text
- If a field is absent return null — never invent values
- DATE RULE: Current Year is 2026. Any date specifying month/day MUST ALWAYS use year 2026 (e.g. 2026-08-14).
- CONFIDENCE RULE:
  * 1.0 (100%) when quantity, product, unit, AND explicit rate/price per MT are stated.
  * 0.75 - 0.85 when rate or customer details are missing.
- Return ONLY the JSON object. No prose. No markdown. No backticks.
`;

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

  // 2. Customer Company Name vs Building/Address Cleanup
  if (parsed.customer && typeof parsed.customer === 'object') {
    let name = parsed.customer.name || parsed.customer_name || '';
    if (name) {
      // Remove address keywords from company name if mistakenly included
      const addressPrefixRegex = /^(Akshar Business Park|Business Park|Office No|Plot No|Sector|Industrial Area|MIDC|Gat No|Survey No|Phase)[,\s\-]+/i;
      name = name.replace(addressPrefixRegex, '').trim();

      const splitOnAddress = name.split(/(?:,?\s*(?:Akshar Business Park|Office No|Plot No|Sector \d+|Janta Market|Opp\.|Turbhe|Navi Mumbai|Maharashtra|State Code|PIN|Gat No))/i);
      if (splitOnAddress && splitOnAddress[0] && splitOnAddress[0].trim().length > 3) {
        name = splitOnAddress[0].trim();
      }

      parsed.customer.name = name;
      parsed.customer_name = name;
    }
  }

  // 3. Line Item Rate and Amount calculation (Always Pre-GST)
  let totalCalculatedItemsAmount = 0;
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

      totalCalculatedItemsAmount += amount;
    });
  }

  // Pre-GST Subtotal
  const preGstSubtotal = totalCalculatedItemsAmount > 0
    ? totalCalculatedItemsAmount
    : Number(parsed.basic_amount || parsed.subtotal || 0);

  parsed.basic_amount = preGstSubtotal;
  parsed.subtotal = preGstSubtotal;

  // Stated or Calculated GST
  const statedGst = Number(
    parsed.gst_amount ||
    (Number(parsed.sgst_amount || 0) + Number(parsed.cgst_amount || 0) + Number(parsed.igst_amount || 0)) ||
    0
  );
  const calculatedGst = Math.round(preGstSubtotal * 0.18);
  parsed.gst_amount = statedGst > 0 ? statedGst : calculatedGst;

  // Stated or Calculated Grand Total (GST-inclusive)
  const statedGrandTotal = Number(parsed.grand_total || parsed.total_amount || 0);
  const calculatedGrandTotal = preGstSubtotal + parsed.gst_amount;

  if (statedGrandTotal > 0 && Math.abs(statedGrandTotal - calculatedGrandTotal) <= 2) {
    parsed.grand_total = statedGrandTotal;
    parsed.total_amount = statedGrandTotal;
  } else if (statedGrandTotal > 0 && Math.abs(statedGrandTotal - preGstSubtotal) <= 2) {
    parsed.grand_total = calculatedGrandTotal;
    parsed.total_amount = calculatedGrandTotal;
  } else if (statedGrandTotal > 0) {
    parsed.grand_total = statedGrandTotal;
    parsed.total_amount = statedGrandTotal;
    parsed.calculation_warning = `Calculated total (₹${calculatedGrandTotal.toLocaleString('en-IN')}) does not match PO document total (₹${statedGrandTotal.toLocaleString('en-IN')}) — please review`;
    console.warn('[Gemini OCR]', parsed.calculation_warning);
  } else {
    parsed.grand_total = calculatedGrandTotal;
    parsed.total_amount = calculatedGrandTotal;
  }

  // 4. Realistic Confidence Adjustment
  if (hasMissingRate && parsed.overall_confidence > 0.8) {
    parsed.overall_confidence = 0.8;
  }

  return parsed;
}

async function extractFromText(text) {
  try {
    const prompt = EXTRACTION_PROMPT + '\n\nInput text:\n' + text;
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
    // Using gemini-3.5-flash — highest accuracy multimodal model for PO vs Inquiry differentiation

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

module.exports = { extractFromText, extractFromImage, extractFromDocument, classifyIntent, classifyQueryType };
