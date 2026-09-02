/**
 * KRA 7 & KRA 8 - Quality Complaints & Complaint Resolution Agent
 *
 * KRA 7 = Log new quality complaints (reported by salesperson or forwarded from customer)
 * KRA 8 = Complaint resolved within SLA (target: 48 hours)
 *
 * ENFORCEMENTS & FLOWS:
 * 1. Multi-Complaint Support:
 *    - If a salesperson reports multiple complaints in one message (different companies or different items),
 *      each is extracted and created as an independent row in the database.
 * 2. PO Priority for Won Deals:
 *    - Won deals reference PO number as primary (e.g. "PO: DEW/RFQ/2026/089 (#DEAL-1BBB57)").
 *    - Deals without PO or non-won deals reference Deal ID as primary.
 * 3. Exact Timestamps & Mandatory Resolution Notes.
 */

const { supabase } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');
const { logBotActivity } = require('../utils/activityLogger');

const COMPLAINT_AGENT_PROMPT = `
You are the Specialized Quality & Complaint AI Agent (KRA 7 & KRA 8) for Enlight Metals.
Your job is to parse quality complaints, material rejection reports, or complaint resolution updates.

CRITICAL INSTRUCTION - MULTIPLE COMPLAINTS:
A salesperson message may contain MULTIPLE separate complaints for different companies or different issues (e.g. "Complaint from Dynamic Engineering: HR Coil rust. Complaint from Tech Industries: CR Sheet crack").
You MUST extract each distinct complaint as a separate item in the "complaints" array.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "complaints": [
    {
      "action": "report|resolve",
      "customer_name": "<customer/company name, else null>",
      "deal_id": "<deal ID e.g. 'DEAL-C538B6' or UUID if mentioned in text, else null>",
      "po_number": "<PO number e.g. 'PO-2026-001' or 'DEW/RFQ/2026/089' if mentioned, else null>",
      "complaint_type": "quality|delivery|quantity|billing|specification|other",
      "affected_product": "<specific product/material affected e.g. 'HR Coil 12 MT', 'CR Sheet 1.20mm coils' - else null>",
      "description": "<detailed description of complaint or resolution notes for this specific customer/incident>",
      "is_confirmation": <true if the user is replying 'yes', 'confirm', 'haan', 'correct', 'right', 'sahi hai' to a previous deal confirmation question, else false>,
      "confidence": <float 0.0 to 1.0>
    }
  ]
}

Rules:
- "action": "report" -> new issue, defect, rejection, wrong material, shortage, delivery delay, billing dispute.
- "action": "resolve" -> issue settled, sorted, material replaced, customer accepted, resolved.
- If multiple companies or separate complaint sentences exist, CREATE A SEPARATE ENTRY IN THE "complaints" ARRAY FOR EACH ONE!
- "affected_product": Extract specific steel category, dimensions, or product form for that specific complaint.
- "deal_id": Extract any #DEAL-XXXXXX or DEAL code mentioned.
- "po_number": Extract any PO number (PO-XXXX, Purchase Order #) mentioned.

Return ONLY the JSON object.
`;

/**
 * Fetch won/active deals for a customer.
 */
async function getCustomerActiveDeals(customerName) {
  if (!customerName) return [];
  const { data: deals } = await supabase
    .from('deals')
    .select('id, stage, po_number, customer_name, total_amount, created_at')
    .ilike('customer_name', `%${customerName.trim()}%`)
    .eq('stage', 'won')
    .order('created_at', { ascending: false })
    .limit(6);

  if (!deals || deals.length === 0) return [];

  const dealIds = deals.map(d => d.id);
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

  return deals.map(d => ({
    ...d,
    deal_code: `#DEAL-${d.id.substring(0, 6).toUpperCase()}`,
    items: itemMap.get(d.id) || [],
  }));
}

/**
 * Find the most recent OPEN complaint for a customer or specific deal.
 */
async function getOpenComplaint(customerName, senderPhone, dealId = null) {
  let query = supabase
    .from('complaints')
    .select('*')
    .in('status', ['open', 'reported', 'reopened']);

  if (dealId) {
    query = query.eq('deal_id', dealId);
  } else if (customerName) {
    query = query.ilike('customer_name', `%${customerName.trim()}%`);
  }

  if (senderPhone) {
    query = query.eq('reported_by', senderPhone);
  }

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(1);

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Extract steel product name from text using smart pattern recognition
 */
function extractProductFromText(text) {
  if (!text) return null;
  const str = String(text).trim();

  // Pattern 1: e.g. "60 MT MS plates", "15 MT CR Sheet 1.20mm", "10 MT HR Coil"
  const m1 = str.match(/(?:(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?|bundle|bundles))\s+)?\b(MS\s+Plates?|MS\s+Sheets?|HR\s+Coils?|HR\s+Sheets?|CR\s+Coils?|CR\s+Sheets?|TMT\s+Bars?|GI\s+Sheets?|GI\s+Coils?|GP\s+Sheets?|GP\s+Coils?|Chequered\s+Plates?|MS\s+Pipes?|Seamless\s+Pipes?|ERW\s+Pipes?|Beams?|Channels?|Angles?|Flats?|Rounds?|Square\s+Bars?|Alloy\s+Steel|Stainless\s+Steel|IS\s+2062(?:\s+E250)?)\b(?:\s+([0-9.]+\s*mm(?:(?:\s*x\s*[0-9.]+\s*mm)+)?))?(?:\s+(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?)))?/i);
  if (m1) {
    const qty = (m1[1] || m1[4] || '').trim();
    const prod = m1[2].trim();
    const dims = (m1[3] || '').trim();
    let res = prod;
    if (dims) res += ` ${dims}`;
    if (qty) res += ` (${qty})`;
    return res;
  }

  // Pattern 2: e.g. "MS Plate", "HR Coil", "CR Sheet", "TMT Bar"
  const m2 = str.match(/\b(MS\s+Plate|MS\s+Plates|MS\s+Sheet|MS\s+Sheets|HR\s+Coil|HR\s+Coils|HR\s+Sheet|HR\s+Sheets|CR\s+Coil|CR\s+Coils|CR\s+Sheet|CR\s+Sheets|TMT\s+Bar|TMT\s+Bars|GI\s+Sheet|GI\s+Sheets|GI\s+Coil|GI\s+Coils|Chequered\s+Plate|Chequered\s+Plates|MS\s+Pipe|MS\s+Pipes)\b/i);
  if (m2) {
    return m2[1];
  }

  return null;
}

/**
 * Resolve the real product name from explicit input, linked deal items, text, or fallback
 */
async function resolveProductFromContext(dealId, poNumber, customerName, affectedProduct, text) {
  // 1. If explicit affectedProduct is provided and NOT generic, use it
  if (affectedProduct && typeof affectedProduct === 'string') {
    const clean = affectedProduct.trim();
    const lower = clean.toLowerCase();
    if (
      clean.length > 1 &&
      lower !== 'general material' &&
      lower !== 'general steel material' &&
      lower !== 'steel material' &&
      lower !== 'material' &&
      lower !== 'steel' &&
      lower !== 'null' &&
      lower !== 'undefined' &&
      lower !== 'other'
    ) {
      return clean;
    }
  }

  // 2. Extract from raw message or description text
  const textProd = extractProductFromText(text);
  if (textProd) {
    return textProd;
  }

  // 3. Lookup from linked deal_items via dealId
  if (dealId) {
    try {
      const cleanDeal = String(dealId).replace(/^#?DEAL-/i, '').trim().toLowerCase();
      const { data: dealRows } = await supabase
        .from('deals')
        .select('id, deal_items(sku_text, dimensions, quantity, unit)')
        .or(`id.eq.${cleanDeal},id.ilike.${cleanDeal}%`)
        .limit(1);

      if (dealRows && dealRows.length > 0 && dealRows[0].deal_items && dealRows[0].deal_items.length > 0) {
        const items = dealRows[0].deal_items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from dealId:', e.message);
    }
  }

  // 4. Lookup from linked deal_items via poNumber
  if (poNumber) {
    try {
      const { data: poDeals } = await supabase
        .from('deals')
        .select('id, deal_items(sku_text, dimensions, quantity, unit)')
        .ilike('po_number', `%${poNumber.trim()}%`)
        .limit(1);

      if (poDeals && poDeals.length > 0 && poDeals[0].deal_items && poDeals[0].deal_items.length > 0) {
        const items = poDeals[0].deal_items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from poNumber:', e.message);
    }
  }

  // 5. Lookup from customer's latest won deal
  if (customerName) {
    try {
      const activeDeals = await getCustomerActiveDeals(customerName);
      if (activeDeals && activeDeals.length > 0 && activeDeals[0].items && activeDeals[0].items.length > 0) {
        const items = activeDeals[0].items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from customer won deals:', e.message);
    }
  }

  return 'Steel Material';
}

/**
 * Check if a KRA 8 log already exists for this complaint resolution.
 */
async function isKRA8AlreadyLogged(senderPhone, customerName) {
  const { data } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 8)
    .ilike('customer_name', `%${customerName.trim()}%`)
    .eq('month', new Date().getMonth() + 1)
    .eq('year', new Date().getFullYear())
    .limit(1);

  return data && data.length > 0;
}

/**
 * Process a single complaint object.
 */
async function processSingleComplaint(data, originalText, senderPhone) {
  const { verifyAndGetCustomerName, saveActiveSession, getActiveSession, getFullActiveSession } = require('../supabase');

  // Check active session for pending confirmation draft
  const activeSessionObj = await getFullActiveSession(senderPhone);
  if (activeSessionObj && activeSessionObj.last_intent && activeSessionObj.last_intent.startsWith('complaint_confirm_deal|')) {
    const rawPayload = activeSessionObj.last_intent.replace('complaint_confirm_deal|', '');
    try {
      const draft = JSON.parse(rawPayload);
      const isAffirmative = /^(yes|haan|confirm|correct|right|sahi|sahi hai|yep|yup|ok|okay|ha|bilkul)$/i.test(originalText.trim()) || Boolean(data.is_confirmation);
      if (isAffirmative) {
        if (!data.customer_name && draft.customer_name) data.customer_name = draft.customer_name;
        if (!data.deal_id && draft.dealId) data.deal_id = draft.dealId;
        if (!data.po_number && draft.poNumber) data.po_number = draft.poNumber;
        if (!data.affected_product && draft.product) data.affected_product = draft.product;
        if ((!data.description || data.description === originalText) && draft.description) data.description = draft.description;
        if ((!data.complaint_type || data.complaint_type === 'other') && draft.complaintType) data.complaint_type = draft.complaintType;
        data.is_confirmation = true;
      }
    } catch (e) {
      console.warn('Error parsing complaint draft from session:', e.message);
    }
  }

  // Missing customer name check - try active session first
  if (!data.customer_name) {
    const activeCustomer = await getActiveSession(senderPhone);
    if (activeCustomer && activeCustomer.toLowerCase() !== 'unknown' && activeCustomer.toLowerCase() !== 'null') {
      data.customer_name = activeCustomer;
    }
  }

  if (!data.customer_name) {
    const dealIdMatch = originalText.match(/#?DEAL-([A-F0-9]{6})/i);
    if (dealIdMatch) {
      const shortCode = dealIdMatch[1].toLowerCase();
      const { data: matchedDeals } = await supabase
        .from('deals')
        .select('id, customer_name, po_number')
        .limit(100);
      const found = (matchedDeals || []).find(d => d.id.toLowerCase().startsWith(shortCode));
      if (found) {
        data.customer_name = found.customer_name;
        data.deal_id = found.id;
        if (found.po_number && !data.po_number) data.po_number = found.po_number;
      }
    }
  }

  if (!data.customer_name) {
    return `⚠️ *Customer Complaints - Missing Information*\n\nPlease specify the *Customer / Company Name* for this complaint.\nExample: _"Quality complaint for Delta Structural Steel - surface rust on 10 MT HR Coil"_`;
  }

  const customerName = data.customer_name.trim();

  // Verify and get official customer name
  let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);

  if (!officialCustomerName) {
    await supabase.from('recurring_customers').insert({
      customer_name: customerName,
      assigned_salesperson_phone: senderPhone,
      is_active: true,
      avg_order_frequency_days: 30,
    }).select().single();
    officialCustomerName = customerName;
  }

  const finalCustomerName = officialCustomerName;
  const complaintType = data.complaint_type || 'quality';
  const affectedProduct = data.affected_product || null;
  const cleanDescription = data.description || originalText;

  // ── RESOLVE FLOW ──────────────────────────────────────────────────
  if (data.action === 'resolve') {
    const openComplaint = await getOpenComplaint(finalCustomerName, senderPhone, data.deal_id);

    let resolutionNotes = (data.description || '').trim();
    const isGenericResolveText = /^(resolved|resolve|issue sorted|fixed|done|ho gaya|settled)$/i.test(resolutionNotes);
    if (!resolutionNotes || isGenericResolveText) {
      return `ℹ️ *Resolution Notes Required for ${finalCustomerName}*\n\n` +
        `Please provide the resolution details (e.g. replacement material dispatched / commercial settlement).\n` +
        `Example: _"Resolved complaint for ${finalCustomerName} - replacement 10 MT plates dispatched and accepted."_`;
    }

    if (openComplaint) {
      const resolvedAt = new Date();
      const reportedAt = new Date(openComplaint.created_at || openComplaint.reported_at || Date.now());
      const resolutionTimeHrs = Math.max(1, Math.round(
        (resolvedAt.getTime() - reportedAt.getTime()) / (1000 * 60 * 60)
      ));
      const isSlaBreached = resolutionTimeHrs > 48;
      const isSlaCompliant = !isSlaBreached;

      // If openComplaint has 'General Material' or null for product, update it with real product!
      const existingProd = openComplaint.product_name || openComplaint.affected_product;
      const isGeneric = !existingProd || ['general material', 'general steel material', 'steel material', 'material', 'steel', 'null'].includes(existingProd.toLowerCase().trim());
      let updatedProduct = existingProd;
      if (isGeneric) {
        updatedProduct = await resolveProductFromContext(
          openComplaint.deal_id || data.deal_id,
          openComplaint.po_number || data.po_number,
          finalCustomerName,
          affectedProduct,
          openComplaint.description || cleanDescription || resolutionNotes
        );
      }

      const updatePayload = {
        status: 'resolved',
        resolution_notes: resolutionNotes,
        resolved_at: resolvedAt.toISOString(),
        resolution_time_hrs: resolutionTimeHrs,
        escalated: isSlaBreached,
      };
      if (isGeneric && updatedProduct && updatedProduct !== 'General Material') {
        updatePayload.product_name = updatedProduct;
        updatePayload.affected_product = updatedProduct;
      }

      await supabase
        .from('complaints')
        .update(updatePayload)
        .eq('id', openComplaint.id);

      const alreadyLogged = await isKRA8AlreadyLogged(senderPhone, finalCustomerName);
      if (!alreadyLogged) {
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 8,
          kra_type: 'complaint_resolved',
          customer_name: finalCustomerName,
          description: `Complaint Resolved: ${finalCustomerName} (${resolutionTimeHrs}h - ${isSlaCompliant ? 'Within SLA ✅' : 'SLA BREACHED ⚠️'})`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: resolvedAt.toISOString(),
        });
      }

      try {
        syncActivity('complaint_resolved', {
          customerName: finalCustomerName,
          complaintType,
          description: resolutionNotes,
          affectedProduct: updatedProduct || affectedProduct,
          action: 'resolve',
          resolutionTimeHrs,
          senderPhone,
        });
      } catch (e) {
        console.warn('[ComplaintAgent] Bigin sync notice:', e.message);
      }

      try {
        logBotActivity({
          salesperson_phone: senderPhone,
          description: `Complaint resolved for ${finalCustomerName}: ${resolutionNotes}`,
          module: 'Complaints',
          customer_name: finalCustomerName,
        });
      } catch (actErr) {
        console.warn('[ComplaintAgent] Activity log notice:', actErr?.message);
      }

      const orderRef = openComplaint.po_number
        ? `PO: *${openComplaint.po_number}* (#DEAL-${(openComplaint.deal_id || '').substring(0, 6).toUpperCase()})`
        : openComplaint.deal_id ? `Deal: *#DEAL-${openComplaint.deal_id.substring(0, 6).toUpperCase()}*` : '';

      await saveActiveSession(senderPhone, finalCustomerName, 'complaint_resolved');

      // Auto-resolve open follow-up tasks for this customer
      try {
        const { resolveCustomerFollowupTasks } = require('../kra3');
        await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'complaint_resolved', openComplaint.deal_id);
      } catch (rErr) {
        console.warn('[ComplaintAgent] Follow-up auto-resolution notice:', rErr.message);
      }

      return `✅ *Customer Complaint Resolved!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        (orderRef ? `Linked Order: ${orderRef}\n` : '') +
        `Product: *${updatedProduct || 'Steel Material'}*\n` +
        `Resolution Notes: ${resolutionNotes}\n` +
        `Resolution Time: *${resolutionTimeHrs} Hours*\n` +
        `SLA Target (48h): *${isSlaCompliant ? '✅ Achieved - Within SLA Target!' : '⚠️ Breached - Escalated!'}*\n\n` +
        `Updated Customer Complaints Card! ✅`;

    } else {
      const nowIso = new Date().toISOString();
      const resolvedDirectProduct = await resolveProductFromContext(
        data.deal_id,
        data.po_number,
        finalCustomerName,
        affectedProduct,
        cleanDescription || originalText || resolutionNotes
      );

      await supabase.from('complaints').insert({
        customer_name: finalCustomerName,
        deal_id: data.deal_id || null,
        po_number: data.po_number || null,
        product_name: resolvedDirectProduct,
        affected_product: resolvedDirectProduct,
        reported_by: senderPhone,
        complaint_type: complaintType,
        description: cleanDescription,
        resolution_notes: resolutionNotes,
        status: 'resolved',
        created_at: nowIso,
        reported_at: nowIso,
        resolved_at: nowIso,
        resolution_time_hrs: 0,
        escalated: false,
      });

      await saveActiveSession(senderPhone, finalCustomerName, 'complaint_resolved');

      return `✅ *Customer Complaint Resolved!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Product: *${resolvedDirectProduct}*\n` +
        `Resolution Notes: ${resolutionNotes}\n` +
        `_Note: Created and marked resolved directly._\n\n` +
        `Updated Customer Complaints Card! ✅`;
    }
  }

  // ── REPORT / CREATE FLOW ───────────────────────────────────────────

  // Step 1: Check if Deal ID / PO is already identified or explicitly in text
  let targetDealId = null;
  let targetPoNumber = data.po_number || null;

  const candidateDealCode = (data.deal_id || '').match(/#?DEAL-([A-F0-9]{6})/i)?.[1]
    || originalText.match(/#?DEAL-([A-F0-9]{6})/i)?.[1]
    || null;

  if (candidateDealCode) {
    const shortCode = candidateDealCode.toLowerCase();
    const { data: matchedDeals } = await supabase
      .from('deals')
      .select('id, po_number, customer_name')
      .or(`id.eq.${shortCode},id.ilike.${shortCode}%`)
      .limit(5);
    if (matchedDeals && matchedDeals.length > 0) {
      targetDealId = matchedDeals[0].id;
      if (matchedDeals[0].po_number) targetPoNumber = matchedDeals[0].po_number;
    } else {
      targetDealId = candidateDealCode;
    }
  } else if (data.deal_id) {
    const cleanId = data.deal_id.replace(/^#?DEAL-/i, '').trim().toLowerCase();
    const { data: matchedDeals } = await supabase
      .from('deals')
      .select('id, po_number, customer_name')
      .or(`id.eq.${cleanId},id.ilike.${cleanId}%`)
      .limit(5);
    if (matchedDeals && matchedDeals.length > 0) {
      targetDealId = matchedDeals[0].id;
      if (matchedDeals[0].po_number) targetPoNumber = matchedDeals[0].po_number;
    } else {
      targetDealId = data.deal_id;
    }
  }

  if (!targetPoNumber) {
    const poMatch = originalText.match(/PO[-:\s]*([A-Z0-9\/-]+)/i);
    if (poMatch) {
      const poCandidate = poMatch[1].trim();
      const { data: matchedDeals } = await supabase
        .from('deals')
        .select('id, po_number')
        .ilike('po_number', `%${poCandidate}%`)
        .limit(1);
      if (matchedDeals && matchedDeals.length > 0) {
        targetPoNumber = matchedDeals[0].po_number;
        if (!targetDealId) targetDealId = matchedDeals[0].id;
      }
    }
  }

  // If targetDealId is present but targetPoNumber is still missing, lookup deal's po_number
  if (targetDealId && !targetPoNumber) {
    const cleanId = targetDealId.replace(/^#?DEAL-/i, '').trim().toLowerCase();
    const { data: matchedDeals } = await supabase
      .from('deals')
      .select('id, po_number')
      .or(`id.eq.${cleanId},id.ilike.${cleanId}%`)
      .limit(1);
    if (matchedDeals && matchedDeals.length > 0) {
      targetDealId = matchedDeals[0].id;
      if (matchedDeals[0].po_number) targetPoNumber = matchedDeals[0].po_number;
    }
  }

  // Step 2: If no Deal ID or PO provided, lookup customer's active won deals
  if (!targetDealId && !targetPoNumber) {
    const activeDeals = await getCustomerActiveDeals(finalCustomerName);

    if (activeDeals.length === 1 && !data.is_confirmation) {
      const d = activeDeals[0];
      const itemSummary = d.items.length > 0
        ? d.items.map(it => `${it.sku_text} ${it.dimensions || ''} ${it.quantity ? `${it.quantity} ${it.unit || 'MT'}` : ''}`.trim()).join(', ')
        : (affectedProduct || 'Steel Material');

      const poDisplay = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;

      const resolvedDraftProd = affectedProduct || itemSummary;
      const draftPayload = JSON.stringify({
        customer_name: finalCustomerName,
        dealId: d.id,
        poNumber: d.po_number || null,
        product: resolvedDraftProd,
        complaintType: complaintType,
        description: cleanDescription,
      });

      await saveActiveSession(senderPhone, finalCustomerName, `complaint_confirm_deal|${draftPayload}`);

      return `🔍 *Confirm Linked Order for Complaint*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Found 1 won order in pipeline:\n` +
        `• ${poDisplay} — ${itemSummary}\n\n` +
        `Is this complaint for ${poDisplay}?\n` +
        `👉 Reply *"Yes"* to confirm, or provide the PO Number / Deal ID.`;
    } else if (activeDeals.length > 1 && !data.is_confirmation) {
      // Multiple active won deals -> List with PO primary
      const dealListFormatted = activeDeals.map((d, idx) => {
        const itemSummary = d.items.length > 0
          ? d.items.map(it => `${it.sku_text} ${it.dimensions || ''} ${it.quantity ? `${it.quantity}${it.unit || 'MT'}` : ''}`.trim()).join(', ')
          : 'Steel Material';
        if (d.po_number) {
          return `${idx + 1}. PO: *${d.po_number}* (${d.deal_code}) — ${itemSummary}`;
        }
        return `${idx + 1}. *${d.deal_code}* — ${itemSummary}`;
      }).join('\n');

      const samplePo = activeDeals[0].po_number || activeDeals[0].deal_code;

      const draftPayload = JSON.stringify({
        customer_name: finalCustomerName,
        product: affectedProduct || null,
        complaintType: complaintType,
        description: cleanDescription,
      });

      await saveActiveSession(senderPhone, finalCustomerName, `complaint_confirm_deal|${draftPayload}`);

      return `⚠️ *Multiple Won Orders Found for ${finalCustomerName}*\n\n` +
        `Please specify which order or PO this complaint is about:\n\n` +
        `${dealListFormatted}\n\n` +
        `👉 Please reply with the *PO Number* (e.g. _"${samplePo}"_) or *Deal ID*.`;
    } else if (activeDeals.length === 1 && data.is_confirmation) {
      targetDealId = activeDeals[0].id;
      targetPoNumber = activeDeals[0].po_number || null;
    }
  }

  // Step 3: Insert new complaint record
  const nowIso = new Date().toISOString();
  const reportedAt = new Date();
  const slaDueAt = new Date(reportedAt.getTime() + 48 * 60 * 60 * 1000); // 48h SLA

  const finalProduct = await resolveProductFromContext(
    targetDealId,
    targetPoNumber,
    finalCustomerName,
    affectedProduct,
    cleanDescription || originalText
  );

  const insertPayload = {
    customer_name: finalCustomerName,
    deal_id: targetDealId || null,
    po_number: targetPoNumber || null,
    product_name: finalProduct,
    affected_product: finalProduct,
    reported_by: senderPhone,
    complaint_type: complaintType,
    description: cleanDescription,
    status: 'open',
    created_at: nowIso,
    reported_at: nowIso,
    sla_due_at: slaDueAt.toISOString(),
    escalated: false,
  };

  const { error: insertError } = await supabase
    .from('complaints')
    .insert(insertPayload)
    .select()
    .single();

  if (insertError) {
    console.error('[ComplaintAgent] Error inserting complaint:', insertError);
  }

  await saveActiveSession(senderPhone, finalCustomerName, 'complaint_logged');

  // Log KRA 7
  await supabase.from('kra_logs').insert({
    salesperson_phone: senderPhone,
    kra_number: 7,
    kra_type: 'quality_complaint',
    customer_name: finalCustomerName,
    description: `Complaint Logged: ${finalCustomerName} - ${complaintType}: ${finalProduct}`,
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    created_at: nowIso,
  });

  // Log to activity_logs
  try {
    logBotActivity({
      salesperson_phone: senderPhone,
      description: `New complaint logged for ${finalCustomerName}${targetPoNumber ? ` (PO: ${targetPoNumber})` : targetDealId ? ` (Deal: #DEAL-${targetDealId.substring(0, 6).toUpperCase()})` : ''}`,
      module: 'Complaints',
      customer_name: finalCustomerName,
    });
  } catch (actErr) {
    console.warn('[ComplaintAgent] Activity log notice:', actErr?.message);
  }

  // Auto-resolve pending follow-up tasks for this customer
  try {
    const { resolveCustomerFollowupTasks } = require('../kra3');
    await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'complaint_logged', targetDealId);
  } catch (rErr) {
    console.warn('[ComplaintAgent] Follow-up auto-resolution notice:', rErr.message);
  }

  const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') ? targetDealId.replace(/^DEAL-/, '') : targetDealId.substring(0, 6).toUpperCase()) : '';
  const orderRef = targetPoNumber
    ? `PO: *${targetPoNumber}* ${cleanCode ? `(#DEAL-${cleanCode})` : ''}`
    : cleanCode ? `#DEAL-${cleanCode}` : 'Unlinked';

  return `🚨 *Customer Complaint Logged*\n\n` +
    `Customer: *${finalCustomerName}*\n` +
    `Linked Order: ${orderRef}\n` +
    `Product: *${finalProduct}*\n` +
    `Type: *${complaintType.toUpperCase()}*\n` +
    `Details: ${cleanDescription}\n` +
    `Status: *Open ⏱️ (48-Hour SLA Clock Started)*\n` +
    `SLA Due: *${slaDueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}*\n\n` +
    `Updated Customer Complaints Card! ✅\n\n` +
    `When resolved, reply: _"Resolved complaint for ${finalCustomerName}: [resolution notes]"_ ✅`;
}

async function processComplaintMessage(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(COMPLAINT_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);
    if (!data) throw new Error('Could not parse complaint JSON from LLM response');

    // Extract list of complaints
    const rawComplaints = Array.isArray(data.complaints) && data.complaints.length > 0
      ? data.complaints
      : [data];

    const results = [];
    for (const comp of rawComplaints) {
      const res = await processSingleComplaint(comp, text, senderPhone);
      results.push(res);
    }

    return results.join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n');

  } catch (error) {
    console.error('Complaint Agent Error:', error.message);
    return `⚠️ Could not process complaint: ${error.message}`;
  }
}

module.exports = { processComplaintMessage };
