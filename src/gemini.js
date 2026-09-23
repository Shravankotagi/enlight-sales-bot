/**
 * gemini.js - Inquiry extraction & classification module using Google Gemini (gemini-3.5-flash / gemini-3.5-flash-lite)
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
You are an expert OCR & document parser for Enlight Metals Private Limited, a premier Indian B2B metal & steel distributor.
Input is a photo, PDF, scanned copy, or text of a business document - typically a PURCHASE ORDER (PO), MATERIAL REQUIREMENT, INQUIRY, or RFQ formatted in Tally ERP, Busy, SAP, or custom steel ERP formats.

════════════════════════════════════════════════════
🔴 RULE #1 - DOCUMENT TYPE & PO NUMBER RECOGNITION:
════════════════════════════════════════════════════

STEP 1: Scan the document header and tables for standard ERP PO identifiers:
  "Voucher No.", "PO No", "P.O. No", "PO Number", "Purchase Order No", "Purchase Order Number", "Reference No. & Date", "Order No."
  (e.g., "PO/26-27/63", "PO-26-27-00718", "PO No: 471", "EMP/PO/2026/089").

STEP 2A - If an explicit PO / Voucher number is present:
  → Set inquiry_type: "purchase_order"
  → Set po_number: "<exact PO / Voucher string, e.g. 'PO/26-27/63'>"
  → Extract po_date from "Dated" or "Date" field (e.g., "12-Sep-26" → "2026-09-12").

STEP 2B - If NO PO/Voucher label exists, OR document states "Inquiry", "RFQ", "Quotation Request", "Material Requirement":
  → Set inquiry_type: "inquiry"
  → Set po_number: null

⚠️ "Inquiry Ref", "Quotation Ref", "Our Ref", "PR No." without PO context are RFQs/Inquiries.

════════════════════════════════════════════════════
🔴 RULE #2 - SUPPLIER vs BUYER IDENTIFICATION:
════════════════════════════════════════════════════

1. SUPPLIER / SELLER (Bill from / Supplier):
   - "Enlight Metals Private Limited" (Shop No 606 Sn 272, Clover Hills Plaza, NIBM Undri Road, Pune - 411048, GSTIN: 27AAICE5263E1ZN) is OUR company (the supplier).
   - ⚠️ CRITICAL: NEVER set "Enlight Metals" as the customer/buyer!

2. BUYER / CUSTOMER (Invoice To / Bill To / Buyer / Customer / M/s):
   - The Customer is the BUYER issuing this PO or Inquiry (e.g., "Suraj SIM Techno Works Pvt Ltd", "SB Scafform Technovert Pvt. Ltd.").
   - customer.name: STRICTLY the legal company name.
   - customer.address: Street/factory/office address (e.g., "Gut. No. 61/62/63, Shendurwada Road, Village Murmi, Dahegaon (B), Tq. Gangapur, Dist. CH.SAMBHAJINAGAR, Maharashtra - 431133").
   - customer.gst: 15-character GSTIN under Invoice To (e.g., "27ABBCS1589F1Z7").
   - customer.phone: Phone / contact number under Invoice To (e.g., "9371220090").
   - customer.email: Email under Invoice To (e.g., "surajsimtechno123@gmail.com").
   - customer.pan: PAN number if stated (e.g., "ABBCS1589F").

3. CONSIGNEE / SHIP-TO / DELIVERY LOCATION:
   - Extract delivery_location STRICTLY from "Consignee (Ship to)" or "Delivery Address" or "Destination" or "Terms of Delivery".
   - ⚠️ NEVER include Enlight Metals' supplier office address or PIN (411048) in delivery_location!

4. COMMERCIAL TERMS:
   - payment_terms: Extract from "Mode/Terms of Payment" (e.g., "Pmt immediate after delivery", "30 Days Credit", "Advance against PI").
   - delivery_terms: Extract from "Terms of Delivery" / "Remarks" (e.g., "Delivery at Suraj premises, TC & E-way bill required").

════════════════════════════════════════════════════
🔴 RULE #3 - STEEL LINE ITEM EXTRACTION & UOM RULES:
════════════════════════════════════════════════════

Standard Indian Steel ERP tables have columns like:
[Sl No.] | [Description of Goods] | [Due on] | [Quantity] | [Rate] | [per / UOM] | [Amount]

1. Description of Goods (sku_text & dimensions):
   - Split product category and dimensions cleanly:
     * "HR PLATE 05X1500X6300MM" → sku_text: "HR PLATE", dimensions: "05X1500X6300MM"
     * "CR SHEET 1.20X1250X2500MM" → sku_text: "CR SHEET", dimensions: "1.20X1250X2500MM"
     * "MS ANGLE 50X50X6MM" → sku_text: "MS ANGLE", dimensions: "50X50X6MM"
     * "GI PIPE 2 INCH CLASS B" → sku_text: "GI PIPE", dimensions: "2 INCH CLASS B"
     * "TMT 12MM FE550D" → sku_text: "TMT BAR", dimensions: "12MM", grade: "FE550D"

2. Quantity & Unit of Measure (UOM):
   - Extract numeric quantity strictly from "Quantity" column (e.g., "60.000 M.T" → quantity: 60.0).
   - Extract unit strictly from the "Quantity" unit suffix or the "per" / "UOM" column:
     * "M.T", "M.T.", "MT", "Ton", "Tons", "Tonne", "Tonnes", "MTS" → unit: "MT"
     * "Kg", "KG", "KGS", "Kilograms" → unit: "KG"
     * "Nos", "NOS", "No.", "PCS", "Pcs", "Pieces" → unit: "Nos" (or "PCS")
     * "SHT", "Sheets" → unit: "Sheets" (only if unit rate is explicitly per sheet)
   - ⚠️ CRITICAL NEGATIVE CONSTRAINT:
     Words occurring in the product description like "PLATE", "SHEET", "COIL", "PIPE", "BEAM", "ANGLE", "CHANNEL" are PRODUCT NAMES (sku_text), NEVER UNITS!
     If a row says "HR PLATE 05X1500X6300MM" with quantity "60.000 M.T" and per "M.T", the unit is STRICTLY "MT", NEVER "Plates"!

3. Pricing (Pre-GST):
   - rate: Unit rate before tax from "Rate" column (e.g., "63,100.00" → 63100).
   - amount: Line total before tax from "Amount" column (e.g., "37,86,000.00" → 3786000).

4. Due Date:
   - Extract from "Due on" column (e.g., "13-Sep-26" → "2026-09-13").

════════════════════════════════════════════════════

Extract the following into ONLY a JSON object (no prose, no markdown, no backticks):

{
  "customer": {
    "name": "",
    "contact_person": "",
    "phone": "",
    "email": "",
    "gst": "",
    "pan": "",
    "address": "",
    "match_status": "matched|fuzzy|new"
  },
  "line_items": [
    {
      "sku_text": "",
      "grade": "",
      "dimensions": "",
      "hsn_code": "",
      "quantity": 0,
      "unit": "MT|KG|PCS|Nos|Sheets",
      "rate": 0,
      "amount": 0,
      "due_on": null,
      "confidence": 0.0
    }
  ],
  "po_number": null,
  "po_date": null,
  "delivery_location": "",
  "delivery_date": null,
  "payment_terms": "",
  "delivery_terms": "",
  "subtotal": 0,
  "basic_amount": 0,
  "sgst_amount": 0,
  "cgst_amount": 0,
  "igst_amount": 0,
  "gst_amount": 0,
  "grand_total": 0,
  "total_amount": 0,
  "remarks": "",
  "overall_confidence": 0.0,
  "inquiry_type": "purchase_order|inquiry|visiting_card|unknown"
}

Additional Rules:
- Basic Amount / Subtotal: Sum of line item amounts BEFORE GST.
- GST Components: SGST, CGST, IGST if stated, or standard 18%.
- Grand Total: Final PO amount including taxes.
- Date Format: Always convert dates to ISO "YYYY-MM-DD" with Year 2026 (e.g., "12-Sep-26" → "2026-09-12").
- Return ONLY the JSON object.
`;

function normalizeDateToIso(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const s = dateStr.trim();
  
  // Format: 12-Sep-26, 12-Sep-2026, 12/Sep/26
  const monthNames = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const dMmmY = s.match(/^(\d{1,2})[-/\s]([a-zA-Z]{3})[-/\s](\d{2,4})$/);
  if (dMmmY) {
    const day = dMmmY[1].padStart(2, '0');
    const mon = monthNames[dMmmY[2].toLowerCase()] || '01';
    let yr = dMmmY[3];
    if (yr.length === 2) yr = '20' + yr;
    return `${yr}-${mon}-${day}`;
  }

  // Format: 12/09/2026 or 12-09-2026 or 12.09.2026
  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const mon = dmy[2].padStart(2, '0');
    let yr = dmy[3];
    if (yr.length === 2) yr = '20' + yr;
    return `${yr}-${mon}-${day}`;
  }

  // ISO Format: 2026-09-12
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  return s;
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
    parsed.inquiry_type = 'purchase_order';
  } else if (parsed.inquiry_type === 'purchase_order') {
    parsed.inquiry_type = 'inquiry';
    parsed.po_number = null;
    console.warn('[Gemini] postProcess: model set purchase_order but no po_number found - corrected to inquiry');
  }

  // 1. Date normalization (PO Date, Delivery Date)
  if (parsed.po_date) {
    parsed.po_date = normalizeDateToIso(parsed.po_date);
  }
  if (parsed.delivery_date) {
    parsed.delivery_date = normalizeDateToIso(parsed.delivery_date);
  }

  // 2. Customer Company Name vs Building/Address Cleanup
  if (parsed.customer && typeof parsed.customer === 'object') {
    let name = parsed.customer.name || parsed.customer_name || '';
    if (name) {
      const addressPrefixRegex = /^(Akshar Business Park|Business Park|Office No|Plot No|Sector|Industrial Area|MIDC|Gat No|Survey No|Phase)[,\s\-]+/i;
      name = name.replace(addressPrefixRegex, '').trim();

      const splitOnAddress = name.split(/(?:,?\s*(?:Akshar Business Park|Office No|Plot No|Sector \d+|Janta Market|Opp\.|Turbhe|Navi Mumbai|Maharashtra|State Code|PIN|Gat No))/i);
      if (splitOnAddress && splitOnAddress[0] && splitOnAddress[0].trim().length > 3) {
        name = splitOnAddress[0].trim();
      }

      parsed.customer.name = name;
      parsed.customer_name = name;
    }
    if (parsed.customer.phone && !parsed.customer_phone) {
      parsed.customer_phone = parsed.customer.phone;
    }
    if (parsed.customer.gst && !parsed.customer_gst) {
      parsed.customer_gst = parsed.customer.gst;
    }
  }

  // 3. Line Items: Unit Normalization, Rate & Amount verification
  let totalCalculatedItemsAmount = 0;
  let hasMissingRate = false;

  if (Array.isArray(parsed.line_items) && parsed.line_items.length > 0) {
    parsed.line_items.forEach((item) => {
      const qty = Number(item.quantity || 0);
      let rate = Number(item.rate || 0);
      let amount = Number(item.amount || 0);
      let rawUnit = String(item.unit || 'MT').trim();

      // Normalize unit strings
      const uUpper = rawUnit.toUpperCase();
      if (['M.T', 'M.T.', 'MT', 'TON', 'TONS', 'TONNE', 'TONNES', 'MTS', 'T'].includes(uUpper)) {
        item.unit = 'MT';
      } else if (['KG', 'KGS', 'KILOGRAM', 'KILOGRAMS'].includes(uUpper)) {
        item.unit = 'KG';
      } else if (['NOS', 'NO', 'NO.', 'NUMBER', 'NUMBERS'].includes(uUpper)) {
        item.unit = 'Nos';
      } else if (['PCS', 'PC', 'PIECE', 'PIECES'].includes(uUpper)) {
        item.unit = 'PCS';
      }

      // Safeguard: Protect against OCR hallucinating product category ('Plates', 'Sheets', 'Coils') as unit
      if (
        /^(?:plate|plates|sheet|sheets|coil|coils|beam|beams|channel|pipe|pipes|bar|bars)$/i.test(item.unit) &&
        (rate > 1000 || /m\.?t/i.test(item.sku_text || '') || /m\.?t/i.test(item.dimensions || ''))
      ) {
        item.unit = 'MT';
      }

      // Normalize due_on date if present
      if (item.due_on) {
        item.due_on = normalizeDateToIso(item.due_on);
      }

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
    parsed.calculation_warning = `Calculated total (₹${calculatedGrandTotal.toLocaleString('en-IN')}) does not match PO document total (₹${statedGrandTotal.toLocaleString('en-IN')}) - please review`;
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
      process.env.GEMINI_API_KEY;
    const apiKeys = [
      process.env.GEMINI_PAID_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
    ].filter(Boolean);

    if (apiKeys.length === 0) {
      throw new Error('GEMINI API key missing');
    }

    const cleanBase64 = buffer.toString('base64');
    const cleanMime = mimeType || 'application/pdf';

    const candidateModels = [
      process.env.GEMINI_PRIMARY_MODEL || 'gemini-3.7-flash',
      process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.0-flash',
      process.env.GEMINI_LITE_MODEL || 'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
    ];

    let lastError = null;

    for (const apiKey of apiKeys) {
      for (const model of candidateModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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
          if (parsed) {
            const postProcessed = postProcessExtraction(parsed);
            console.log(
              'Gemini document/image extraction successful:',
              JSON.stringify(postProcessed, null, 2),
            );
            return postProcessed;
          }
        } catch (err) {
          lastError = err;
          console.warn(
            `Gemini vision extraction with model ${model} failed: ${err.message}`,
          );
        }
      }
    }

    throw lastError || new Error('Could not parse JSON from Gemini vision response');
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
A salesperson sends a WhatsApp message in English, Hindi, or Hinglish - casually, informally, 
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

INTENT DEFINITIONS - understand the meaning, not the keywords:

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

"inquiry": A customer's product requirement - what steel they want to buy.
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
- "deal_id_lookup": Questions asking for the Inquiry ID, inquiry IDs, deal numbers, or active inquiry codes for a company or asking "What is the inquiry ID?" / "What is the deal ID?" (e.g. "What is the inquiry ID for Radhe Ispat?", "Inquiry ID for Apex Steel", "Give me inquiry ID", "Deal ID", "Inquiry ID", "Show inquiry IDs", "Find inquiry ID for Supreme Steel", "Inquiry code of Mehta").
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
