/**
 * pendingStateManager.js - Unified Multi-Turn State Machine for Enlight Sales OS
 *
 * Provides 100% parity across WhatsApp Webhook and Web AI Assistant for all active pending states:
 * 1. pending_loss_reason
 * 2. pending_payment_confirm
 * 3. pending_amount_confirm
 * 4. pending_unit_confirm
 * 5. pending_product_clarification
 * 6. pending_product_for_deal
 * 7. pending_deal_choice
 * 8. pending_delivery_location
 * 9. pending_customer_for_deal (with payload context)
 * 10. pending_customer_for_deal (simple)
 * 11. pending_company_for_deal_lookup
 */

const { supabase, getFullActiveSession, saveActiveSession } = require('../supabase');
const { calculateSubtotal } = require('../utils/pricingEngine');
const { safeParseJSON } = require('../utils/jsonUtils');

async function handlePendingSessionState(rawText, senderPhone) {
  if (!rawText || !senderPhone) return null;

  const activeSession = await getFullActiveSession(senderPhone);
  if (!activeSession || !activeSession.last_intent) return null;

  const lastIntent = activeSession.last_intent;

  // 1. Pending Loss Reason
  if (lastIntent.startsWith('pending_loss_reason|')) {
    const parts = lastIntent.split('|');
    const dealId = parts[1];
    const customerName = parts[2];

    const MAP_REASONS = {
      '1': 'Price',
      '2': 'Credit terms',
      '3': 'Delivery timeline',
      '4': 'Material unavailable',
      '5': 'Spec mismatch',
      '6': 'Competitor relationship',
      '7': 'Customer silent',
      '8': 'Cancelled by customer',
    };

    const cleanInput = rawText.replace(/[️⃣\s]/g, '').trim();
    let selectedReason = cleanInput;
    if (MAP_REASONS[cleanInput]) {
      selectedReason = MAP_REASONS[cleanInput];
    } else {
      const numMatch = cleanInput.match(/^([1-8])/);
      if (numMatch && MAP_REASONS[numMatch[1]]) {
        selectedReason = MAP_REASONS[numMatch[1]];
      } else {
        selectedReason = rawText.trim();
      }
    }

    let dealAmount = 0;
    const { data: dealRow } = await supabase
      .from('deals')
      .select('total_amount, deal_items(amount, quantity, rate)')
      .eq('id', dealId)
      .limit(1);

    if (dealRow && dealRow.length > 0) {
      dealAmount = Number(dealRow[0].total_amount || 0);
      if (dealAmount === 0 && dealRow[0].deal_items && dealRow[0].deal_items.length > 0) {
        dealAmount = calculateSubtotal(dealRow[0].deal_items);
      }
    }

    const dealUpdatePayload = {
      stage: 'lost',
      lost_reason: selectedReason,
    };
    if (dealAmount > 0) {
      dealUpdatePayload.total_amount = dealAmount;
    }

    await supabase.from('deals').update(dealUpdatePayload).eq('id', dealId);

    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 4,
      kra_type: 'deal_lost',
      value: dealAmount,
      customer_name: customerName,
      description: `Deal Lost: ${customerName} - Reason: ${selectedReason}`,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
    });

    await saveActiveSession(senderPhone, customerName, 'general');

    return (
      `Deal Marked as LOST\n\n` +
      `- Customer: ${customerName}\n` +
      `- Stage: Closed Lost\n` +
      `- Reason: ${selectedReason}\n\n` +
      `Updated Loss Analytics Dashboard!`
    );
  }

  // 2. Pending Payment Confirm
  if (lastIntent.startsWith('pending_payment_confirm|')) {
    const parts = lastIntent.split('|');
    const dealId = parts[1];
    const customerName = parts[2];
    const amountPaid = Number(parts[3]);
    const amountPending = Number(parts[4]);
    const isFullPayment = parts[5] === 'true';

    const cleanInput = rawText.replace(/[️⃣\s]/g, '').trim();

    if (cleanInput === '2' || cleanInput.toLowerCase().includes('won')) {
      const { data: existingDealRow } = await supabase
        .from('deals')
        .select('po_number')
        .eq('id', dealId)
        .limit(1);

      let targetPoNumber = existingDealRow?.[0]?.po_number;
      if (!targetPoNumber) {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        targetPoNumber = `PO-${todayStr}-${randomNum}`;
      }

      await supabase
        .from('deals')
        .update({
          stage: 'won',
          won_at: new Date().toISOString(),
          po_number: targetPoNumber,
        })
        .eq('id', dealId);

      await saveActiveSession(senderPhone, customerName, 'general');

      const { processPaymentMessage } = require('../agents/paymentAgent');
      const syntheticText =
        `${customerName} paid ₹${amountPaid}` +
        (amountPending > 0 ? ` outstanding ₹${amountPending}` : '') +
        (isFullPayment ? ' full payment' : '');
      const reply = await processPaymentMessage(syntheticText, senderPhone);

      return `Deal Marked as WON & Payment Logged!\n\n` + reply;
    }

    if (cleanInput === '1' || cleanInput.toLowerCase().includes('yes')) {
      await saveActiveSession(senderPhone, customerName, 'general');

      const { processPaymentMessage } = require('../agents/paymentAgent');
      const syntheticText =
        `${customerName} paid ₹${amountPaid}` +
        (amountPending > 0 ? ` outstanding ₹${amountPending}` : '') +
        (isFullPayment ? ' full payment' : '');
      const reply = await processPaymentMessage(syntheticText, senderPhone);

      return reply;
    }

    return `Please reply 1 to log payment for the open deal, or 2 to mark the deal as Won first.`;
  }

  // 3. Pending Amount Confirm
  if (lastIntent.startsWith('pending_amount_confirm|')) {
    const parts = lastIntent.split('|');
    const customerName = parts[1];
    const amountPaid = Number(parts[2]);
    const amountPending = Number(parts[3]);
    const correctedPending = Number(parts[5]);

    const cleanInput = rawText.replace(/[️⃣\s]/g, '').trim();
    await saveActiveSession(senderPhone, customerName, 'general');

    if (cleanInput === '3' || cleanInput.toLowerCase().includes('cancel')) {
      return `Cancelled. Please resend the correct payment details when ready.`;
    }

    let finalPending = amountPending;
    if (cleanInput === '1') {
      finalPending = correctedPending;
    }

    const { processPaymentMessage } = require('../agents/paymentAgent');
    const syntheticText =
      `${customerName} paid ₹${amountPaid}` +
      (finalPending > 0 ? ` outstanding ₹${finalPending}` : ' full payment');
    const reply = await processPaymentMessage(syntheticText, senderPhone);
    return reply;
  }

  // 4. Pending Unit Confirm
  if (lastIntent.startsWith('pending_unit_confirm|')) {
    const parts = lastIntent.split('|');
    const customerName = parts[1];
    const productName = parts[2];
    const qtyNum = parts[3];

    const cleanInput = rawText.trim();
    const isNewInquiry = /\b(need|requires|new deal|inquiry|requirement|want|order)\b/i.test(cleanInput);

    if (!isNewInquiry) {
      await saveActiveSession(senderPhone, customerName, 'general');
      const { processSalesMessage } = require('../agents/salesAgent');

      if (cleanInput === '1' || cleanInput.toLowerCase().includes('yes')) {
        const syntheticText = `${customerName} requirement ${qtyNum} MT ${productName}`;
        return await processSalesMessage(syntheticText, senderPhone);
      }

      const syntheticText = `${customerName} requirement ${rawText} ${productName}`;
      return await processSalesMessage(syntheticText, senderPhone);
    }

    await saveActiveSession(senderPhone, 'Unknown', 'general');
  }

  // 5. Pending Product Clarification
  if (lastIntent.startsWith('pending_product_clarification|')) {
    const cleanInput = (rawText || '').trim();
    const isNewInquiryOrLongMsg =
      cleanInput.length > 60 ||
      cleanInput.includes('\n') ||
      /^\s*(?:log|create|new|add|inquiry|deal|order|rfq|quote|requirement)\b/i.test(cleanInput);

    if (isNewInquiryOrLongMsg) {
      await saveActiveSession(senderPhone, 'Unknown', 'general');
    } else {
      const parts = lastIntent.split('|');
      const sessionCustomer = parts[1];
      const payloadStr = parts.slice(2).join('|');
      const pendingPayload = safeParseJSON(payloadStr, null);

      const sheetOptions = ['HR Sheet', 'CR Sheet', 'HRPO Sheet', 'GP Sheet', 'Galvalume Sheet', 'Chequered Sheet'];
      const plateOptions = ['HR Plate', 'HR Sheet', 'Chequered Sheet'];

      let resolvedCatalogName = null;
      const numMatch = cleanInput.match(/^(?:option\s*|#\s*)?([1-6])\b/i);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        const isPlate = String(pendingPayload?.invalid_product || '').toLowerCase().includes('plate');
        const optList = isPlate ? plateOptions : sheetOptions;
        if (optList[idx]) {
          resolvedCatalogName = optList[idx];
        }
      }

      if (!resolvedCatalogName) {
        const { normalizeProductToCatalog } = require('../utils/hsnDetector');
        const norm = normalizeProductToCatalog(cleanInput);
        if (norm.isValid) {
          resolvedCatalogName = norm.catalogName;
        }
      }

      if (resolvedCatalogName && pendingPayload) {
        const { normalizeProductToCatalog } = require('../utils/hsnDetector');
        const oldProdName = (pendingPayload.invalid_product || '').trim();
        if (pendingPayload.data && Array.isArray(pendingPayload.data.line_items)) {
          pendingPayload.data.line_items = pendingPayload.data.line_items.filter((itm) => {
            const itmName = (itm.product_requirement || itm.pName || '').trim();
            return itmName && !/^\d+$/.test(itmName) && !/^[0-9.:\s-]+$/.test(itmName) && itmName.length >= 2;
          });
          for (const itm of pendingPayload.data.line_items) {
            const itmName = itm.product_requirement || itm.pName || '';
            const norm = normalizeProductToCatalog(itmName, itm.dimensions);
            if (
              !norm.isValid ||
              itmName.toLowerCase() === oldProdName.toLowerCase() ||
              itmName.toLowerCase().includes(oldProdName.toLowerCase()) ||
              (oldProdName && oldProdName.toLowerCase().includes(itmName.toLowerCase()))
            ) {
              itm.product_requirement = resolvedCatalogName;
              itm.pName = resolvedCatalogName;
            }
          }
          if (
            pendingPayload.data.line_items.length === 1 &&
            !normalizeProductToCatalog(
              pendingPayload.data.line_items[0].product_requirement,
              pendingPayload.data.line_items[0].dimensions,
            ).isValid
          ) {
            pendingPayload.data.line_items[0].product_requirement = resolvedCatalogName;
            pendingPayload.data.line_items[0].pName = resolvedCatalogName;
          }
        }
        if (Array.isArray(pendingPayload.processedItems)) {
          pendingPayload.processedItems = pendingPayload.processedItems.filter((itm) => {
            const itmName = (itm.pName || itm.product_requirement || '').trim();
            return itmName && !/^\d+$/.test(itmName) && !/^[0-9.:\s-]+$/.test(itmName) && itmName.length >= 2;
          });
          for (const itm of pendingPayload.processedItems) {
            const itmName = itm.pName || itm.product_requirement || '';
            const norm = normalizeProductToCatalog(itmName, itm.dimensions);
            if (
              !norm.isValid ||
              itmName.toLowerCase() === oldProdName.toLowerCase() ||
              itmName.toLowerCase().includes(oldProdName.toLowerCase()) ||
              (oldProdName && oldProdName.toLowerCase().includes(itmName.toLowerCase()))
            ) {
              itm.pName = resolvedCatalogName;
              itm.product_requirement = resolvedCatalogName;
            }
          }
          if (
            pendingPayload.processedItems.length === 1 &&
            !normalizeProductToCatalog(
              pendingPayload.processedItems[0].pName,
              pendingPayload.processedItems[0].dimensions,
            ).isValid
          ) {
            pendingPayload.processedItems[0].pName = resolvedCatalogName;
            pendingPayload.processedItems[0].product_requirement = resolvedCatalogName;
          }
        }

        await saveActiveSession(senderPhone, sessionCustomer || 'Unknown', 'general');

        const { processSalesMessage } = require('../agents/salesAgent');
        const reply = await processSalesMessage(
          pendingPayload.raw_text,
          senderPhone,
          pendingPayload.data,
        );
        return reply;
      }
    }
  }

  // 6. Pending Product For Deal
  if (lastIntent.startsWith('pending_product_for_deal|')) {
    const parts = lastIntent.split('|');
    const customerName = parts[1];
    const qtyNum = Number(parts[2]) || 0;
    const unitStr = parts[3] || 'MT';
    const rawContextStr = parts.slice(4).join('|');

    const cleanInput = rawText.trim();
    await saveActiveSession(senderPhone, customerName, 'general');

    const storedContext = safeParseJSON(rawContextStr, null);
    const { processSalesMessage } = require('../agents/salesAgent');

    if (storedContext) {
      const mmM = cleanInput.match(/(\d+(?:\.\d+)?)\s*mm/i);
      storedContext.product_requirement = cleanInput;
      storedContext.line_items = [
        {
          product_requirement: cleanInput,
          dimensions: mmM ? `${mmM[1]}mm` : storedContext.dimensions || null,
          quantity_mt: qtyNum || storedContext.quantity_mt || 0,
          rate_per_mt: null,
        },
      ];
      return await processSalesMessage(storedContext.raw_text || rawText, senderPhone, storedContext);
    }

    const syntheticText = `${customerName} requirement ${qtyNum} ${unitStr} ${cleanInput}`;
    return await processSalesMessage(syntheticText, senderPhone);
  }

  // 7. Pending Deal Choice
  if (lastIntent.startsWith('pending_deal_choice|')) {
    const parts = lastIntent.split('|');
    const customerName = parts[1];
    const originalMsg = parts[3] || '';

    const cleanInput = rawText.trim();
    await saveActiveSession(senderPhone, customerName, 'general');

    const { processSalesMessage } = require('../agents/salesAgent');
    const syntheticText = `${originalMsg} deal ${cleanInput}`;
    return await processSalesMessage(syntheticText, senderPhone);
  }

  // 8. Pending Delivery Location
  if (lastIntent.startsWith('pending_delivery_location|')) {
    const parts = lastIntent.split('|');
    const targetDealId = parts[1];
    const customerName = parts[2];
    const rawContextStr = parts.slice(3).join('|');

    const cleanInput = rawText.trim();
    await saveActiveSession(senderPhone, customerName, 'general');

    const { extractDeliveryLocation, processSalesMessage } = require('../agents/salesAgent');
    const extractedLoc = extractDeliveryLocation(cleanInput) || cleanInput;
    const storedContext = safeParseJSON(rawContextStr, null);

    if (storedContext) {
      storedContext.delivery_location = extractedLoc;
      storedContext.target_stage = 'won';
      return await processSalesMessage(
        storedContext.raw_text || `mark ${customerName} deal as won delivery to ${extractedLoc}`,
        senderPhone,
        storedContext,
      );
    }

    const syntheticText = `mark ${customerName} deal as won delivery to ${extractedLoc}`;
    return await processSalesMessage(syntheticText, senderPhone);
  }

  // 9. Pending Customer For Deal (with stored context)
  if (lastIntent.startsWith('pending_customer_for_deal|')) {
    const rawContextStr = lastIntent.slice('pending_customer_for_deal|'.length);
    const storedContext = safeParseJSON(rawContextStr, {});
    const cleanCompany = rawText.trim();

    await saveActiveSession(senderPhone, cleanCompany, 'general');

    const { processSalesMessage } = require('../agents/salesAgent');
    const syntheticText = `${cleanCompany} requirement ${storedContext.raw_text || ''}`;
    return await processSalesMessage(syntheticText, senderPhone, storedContext.extracted);
  }

  // 10. Pending Customer For Deal (simple)
  if (lastIntent === 'pending_customer_for_deal') {
    const cleanCompany = rawText.trim();
    await saveActiveSession(senderPhone, cleanCompany, 'general');
    const { processSalesMessage } = require('../agents/salesAgent');
    return await processSalesMessage(`Inquiry for ${cleanCompany}`, senderPhone);
  }

  // 11. Pending Company For Deal Lookup
  if (lastIntent === 'pending_company_for_deal_lookup') {
    const cleanCompany = rawText.trim();
    await saveActiveSession(senderPhone, cleanCompany, 'deal_inquiry');
    const { getDealIdsForCompany } = require('../queryhandler');
    return await getDealIdsForCompany(senderPhone, cleanCompany, cleanCompany);
  }

  return null;
}

module.exports = {
  handlePendingSessionState,
};
