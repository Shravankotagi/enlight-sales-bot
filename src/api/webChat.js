const express = require('express');
const router = express.Router();
const { handleCatalogFlow } = require('../core/catalogFlow');
const { runOrchestrator } = require('../core/orchestrator');
const { getFullActiveSession, saveActiveSession, supabase } = require('../supabase');

/**
 * Authentication middleware for Web Chat API.
 */
function requireWebApiKey(req, res, next) {
  const configuredKey = process.env.WEB_CHAT_API_KEY || 'enlight_ai_engine_secret_2026_auth_key';
  const headerKey = req.headers['x-web-api-key'] || req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  const bearerKey = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  const providedKey = headerKey || bearerKey;
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
  }
  next();
}

/**
 * Formats bot replies for web markdown presentation:
 * 1. Strips all emojis for clean B2B professional presentation.
 * 2. Normalizes list bullets (*, +, -) to standard hyphen bullets (- ).
 * 3. Cleans up multiple empty lines and trailing whitespace.
 */
function formatForWeb(text) {
  if (!text) return '';
  let out = text;

  // 1. Remove all emojis (strict zero emoji rule)
  out = out.replace(
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{200D}\u{FE0F}]/gu,
    ''
  );
  out = out.replace(/[ \t]{2,}/g, ' ');

  // 2. Normalize list bullets at start of line (* item, + item) to - item
  out = out.replace(/^(\s*)[*+]\s+/gm, '$1- ');

  // 3. Clean up 3+ blank lines to 2
  out = out.replace(/\n{3,}/g, '\n\n');

  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Handles active multi-turn session pending states (loss reason, payment confirmation, etc.)
 */
async function handlePendingSessionState(rawText, senderPhone) {
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
        selectedReason = rawText;
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
        dealAmount = dealRow[0].deal_items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
      }
    }

    await supabase
      .from('deals')
      .update({ stage: 'lost', lost_reason: selectedReason, ...(dealAmount > 0 ? { total_amount: dealAmount } : {}) })
      .eq('id', dealId);

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

    return `Deal Marked as LOST\n\n- Customer: ${customerName}\n- Stage: Closed Lost\n- Reason: ${selectedReason}\n\nUpdated Loss Analytics Dashboard!`;
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

  return null;
}

/**
 * Normalizes incoming interactive button IDs / action triggers into standard flow commands.
 */
function normalizeIncomingButtonPayload(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const text = rawInput.trim();

  // Specific Button ID mappings to action commands
  if (text === 'btn_confirm_yes' || text === 'btn_cust_yes' || text === 'btn_resume_yes') {
    return 'yes';
  }
  if (text === 'btn_confirm_edit') {
    return 'edit';
  }
  if (text === 'btn_confirm_cancel' || text === 'btn_cust_no') {
    return 'cancel';
  }
  if (text === 'btn_resume_no' || text === 'btn_post_menu') {
    return 'menu';
  }
  if (text.startsWith('btn_repeat_log_inquiry')) {
    return '1';
  }
  if (text.startsWith('btn_repeat_update_inquiry')) {
    return '2';
  }
  if (text.startsWith('btn_repeat_log_order')) {
    return '3';
  }
  if (text.startsWith('btn_repeat_update_order')) {
    return '4';
  }
  if (text.startsWith('btn_repeat_log_visit')) {
    return '5';
  }
  if (text.startsWith('btn_repeat_update_visit')) {
    return '6';
  }
  if (text.startsWith('btn_repeat_log_new_customer')) {
    return '7';
  }
  if (text.startsWith('btn_repeat_log_complaint')) {
    return '8';
  }
  if (text.startsWith('btn_repeat_update_complaint')) {
    return '9';
  }
  if (text.startsWith('menu_')) {
    return text.replace('menu_', '');
  }
  return text;
}

/**
 * POST /chat/web/message
 * Entry point for Web AI Assistant messages.
 * Body: { message: string, employeePhone?: string, userId?: string, employeeName?: string, role?: string }
 */
router.post('/message', requireWebApiKey, async (req, res) => {
  try {
    const { message, employeePhone, userId, employeeName, role } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message string is required' });
    }

    let cleanPhone = String(employeePhone || '').replace(/\D/g, '');
    if (cleanPhone.length >= 10) {
      cleanPhone = cleanPhone.slice(-10);
    } else {
      cleanPhone = '9619226169'; // Default fallback phone for sales ops
    }

    const rawText = normalizeIncomingButtonPayload(message);
    const empName = employeeName || 'Sales Staff';

    console.log(`[WebChat] Processing message from ${empName} (${cleanPhone}): "${rawText.slice(0, 80)}"`);

    // LAYER 1: Guided Catalog & Conversational Form Flow (Greetings, 1-10 Routing, Confirmations)
    const catalogResult = await handleCatalogFlow(rawText, cleanPhone);
    if (catalogResult && catalogResult.handled && catalogResult.reply) {
      const formattedReply = formatForWeb(catalogResult.reply);
      const interactiveType = catalogResult.interactiveType || 'text';
      return res.json({
        success: true,
        reply: formattedReply,
        type: interactiveType,
        interactiveType,
        interactiveButtons: catalogResult.interactiveButtons || null,
        interactiveList: catalogResult.interactiveList || null,
        data: catalogResult.interactiveButtons || catalogResult.interactiveList || null,
      });
    }

    // LAYER 2: Active Session Pending State Machine
    const pendingReply = await handlePendingSessionState(rawText, cleanPhone);
    if (pendingReply) {
      const formattedReply = formatForWeb(pendingReply);
      return res.json({
        success: true,
        reply: formattedReply,
        type: 'text',
        interactiveType: 'text',
        interactiveButtons: null,
        interactiveList: null,
      });
    }

    // LAYER 3: LangGraph Agentic Orchestrator (Google Gemini + 23 Tools)
    const reply = await runOrchestrator(rawText, cleanPhone, {
      employeeName: empName,
      messageType: 'text',
    });

    const formattedReply = formatForWeb(reply);
    return res.json({
      success: true,
      reply: formattedReply,
      type: 'text',
    });
  } catch (err) {
    console.error('[WebChat] Fatal error processing message:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      reply: 'An error occurred while processing your request. Please try again.',
    });
  }
});

module.exports = router;
