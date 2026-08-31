/**
 * KRA 5 - Payment Collection Agent
 * 
 * DESIGN PRINCIPLE: One row per customer in payment_tracking.
 * When a new payment update arrives for an existing customer, we UPDATE that row 
 * rather than inserting a new one. This prevents double-counting.
 */

const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { supabase, verifyAndGetCustomerName } = require('../supabase');
const { getChatHistory } = require('../core/memory');
const { syncActivity } = require('./biginSyncAgent');

const PAYMENT_AGENT_PROMPT = `
You are the Specialized Payment Collection AI Agent (KRA 5) for Enlight Metals.
Your job is to parse salesperson payment reports, advance receipts, outstanding balance updates, or payment mode follow-up answers (e.g. "RTGS", "NEFT", "UPI").

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "customer_name": "<customer/company name, else null>",
  "amount_paid": <numeric amount collected/received/advance THIS TIME ONLY, else 0>,
  "amount_pending": <numeric outstanding/pending amount explicitly stated in this message, else 0>,
  "payment_mode": "<RTGS|NEFT|UPI|Cheque|Cash if mentioned, else null>",
  "is_mode_update_only": <true if message is ONLY providing payment mode like 'paid through RTGS' or 'via NEFT', else false>,
  "payment_type": "advance|installment|full_settlement|outstanding_update|mode_update",
  "is_full_payment": <true ONLY if message explicitly says full/complete payment cleared or zero balance left, else false>,
  "confidence": <float 0.0 to 1.0>
}

CRITICAL RULES:
- "is_full_payment": true ONLY if the salesperson explicitly says "full payment done", "completely paid", "zero balance", "all dues cleared". NEVER set to true for "paid through RTGS" or "via NEFT".
- "is_mode_update_only": set to true if the message is answering a question about payment mode (e.g. "paid through RTGS", "NEFT", "UPI", "by cheque") without stating a NEW payment amount.
- "amount_paid": Only what was actually received/collected THIS time. If no new money is reported (just mode update), set amount_paid=0.
- "amount_pending": Only what is explicitly stated as pending in THIS message.
- "k" or "K" suffix = thousands. "L" or "lakh" suffix = 100000. "cr" = 10000000.

Return ONLY the JSON object.
`;

/**
 * Gets the single payment tracking record for a customer (most recent).
 */
async function getExistingPaymentRecord(customerName, senderPhone) {
  let query = supabase
    .from('payment_tracking')
    .select('*')
    .ilike('customer_name', `%${customerName}%`);

  if (senderPhone) {
    query = query.eq('salesperson_phone', senderPhone);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}

/**
 * Gets the deal total amount for a customer from the deals table.
 */
async function getDealTotal(customerName, senderPhone) {
  let query = supabase
    .from('deals')
    .select('total_amount, stage')
    .ilike('customer_name', `%${customerName}%`);

  if (senderPhone) {
    query = query.eq('salesperson_phone', senderPhone);
  }

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(1);

  if (data && data.length > 0 && data[0].total_amount) {
    return Number(data[0].total_amount) || 0;
  }
  return 0;
}

/**
 * Gets the active (non-won/lost) deal for a customer if one exists.
 */
async function getActiveDealForCustomer(customerName, senderPhone) {
  let query = supabase
    .from('deals')
    .select('id, stage, total_amount, customer_name')
    .ilike('customer_name', `%${customerName}%`)
    .not('stage', 'in', '("won","lost")');

  if (senderPhone) {
    const cleanDigits = senderPhone.replace(/\D/g, '');
    const p10 = cleanDigits.slice(-10);
    const p12 = '91' + p10;
    query = query.or(
      `salesperson_phone.eq.${p10},salesperson_phone.eq.${p12}`,
    );
  }

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Checks if salesperson-reported amounts are consistent with the deal total.
 * Returns null if OK, or a discrepancy object if numbers don't add up.
 */
function checkAmountDiscrepancy(amountPaid, explicitPending, dealTotal) {
  if (!dealTotal || dealTotal <= 0) return null;
  if (amountPaid <= 0 && explicitPending <= 0) return null;

  if (amountPaid > 0 && explicitPending > 0) {
    const reportedTotal = amountPaid + explicitPending;
    const tolerance = dealTotal * 0.05;
    const diff = Math.abs(reportedTotal - dealTotal);

    if (diff > tolerance) {
      const dealTotalFormatted = `₹${Number(dealTotal).toLocaleString('en-IN')}`;
      const reportedTotalFormatted = `₹${Number(reportedTotal).toLocaleString('en-IN')}`;
      const paidFormatted = `₹${Number(amountPaid).toLocaleString('en-IN')}`;
      const pendingFormatted = `₹${Number(explicitPending).toLocaleString('en-IN')}`;
      const correctedPending = Math.max(0, dealTotal - amountPaid);

      return {
        hasDiscrepancy: true,
        message:
          `⚠️ *Amount Mismatch Detected*\n\n` +
          `Deal Total on Record: *${dealTotalFormatted}*\n` +
          `You reported: Paid *${paidFormatted}* + Pending *${pendingFormatted}* = *${reportedTotalFormatted}*\n\n` +
          `These don't add up to the deal total. Please confirm:\n\n` +
          `1️⃣ *Use deal total* - Paid ${paidFormatted}, Pending *₹${correctedPending.toLocaleString('en-IN')}* (correct based on deal)\n` +
          `2️⃣ *Use my numbers* - Paid ${paidFormatted}, Pending ${pendingFormatted} (override)\n` +
          `3️⃣ *Cancel* - I'll re-check and resend\n\n` +
          `Reply *1*, *2*, or *3* to proceed.`,
        correctedPending,
      };
    }
  }

  if (amountPaid > 0 && explicitPending === 0) {
    if (amountPaid > dealTotal * 1.05) {
      return {
        hasDiscrepancy: true,
        message:
          `⚠️ *Amount Exceeds Deal Total*\n\n` +
          `Deal Total on Record: *₹${Number(dealTotal).toLocaleString('en-IN')}*\n` +
          `Amount you reported: *₹${Number(amountPaid).toLocaleString('en-IN')}*\n\n` +
          `The payment exceeds the deal value. Please confirm:\n\n` +
          `1️⃣ *Correct, overpayment received* - log as-is\n` +
          `2️⃣ *Cancel* - I'll re-check and resend`,
        correctedPending: 0,
      };
    }
  }

  return null;
}

/**
 * Get recent deal customer name for context memory.
 */
async function getLastCustomerForSalesperson(senderPhone) {
  const { data } = await supabase
    .from('deals')
    .select('customer_name')
    .eq('salesperson_phone', senderPhone)
    .not('customer_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (data && data.length > 0 && data[0].customer_name) {
    return data[0].customer_name;
  }

  const { data: logs } = await supabase
    .from('kra_logs')
    .select('customer_name')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 5)
    .not('customer_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (logs && logs.length > 0 && logs[0].customer_name) {
    return logs[0].customer_name;
  }

  return null;
}

/**
 * Core upsert logic: Create or update a payment_tracking row for this customer.
 * Always maintains a SINGLE row per customer.
 */
async function upsertPaymentTracking({
  customerName,
  senderPhone,
  newAmountPaid,   // amount received THIS time
  explicitPending, // outstanding as explicitly stated (or 0 if not stated)
  isFullPayment,   // true if message said "full payment done"
  paymentType,
  paymentMode,
  isModeUpdateOnly,
}) {
  const existing = await getExistingPaymentRecord(customerName, senderPhone);
  const dealTotal = await getDealTotal(customerName, senderPhone);

  let finalCollected;
  let finalOutstanding;
  let finalInvoiceAmount;
  let finalStatus;
  let finalPaymentType = paymentType;

  if (existing) {
    // --- UPDATE existing row ---
    const priorCollected = Number(existing.collected_amount) || 0;
    const priorInvoice   = Number(existing.invoice_amount)   || 0;

    finalInvoiceAmount = dealTotal || priorInvoice || (priorCollected + (Number(existing.outstanding) || 0));

    if (isModeUpdateOnly || (newAmountPaid <= 0 && explicitPending <= 0 && !isFullPayment)) {
      // Payment mode update only - preserve existing collected and outstanding amounts!
      finalCollected = priorCollected;
      finalOutstanding = Number(existing.outstanding) || (finalInvoiceAmount > finalCollected ? finalInvoiceAmount - finalCollected : 0);
      finalStatus = finalOutstanding <= 0 ? 'collected' : 'partial';
    } else if (isFullPayment) {
      finalOutstanding = 0;
      finalCollected = finalInvoiceAmount > 0 ? finalInvoiceAmount : priorCollected + newAmountPaid;
      finalPaymentType = 'full_settlement';
      finalStatus = 'collected';
    } else if (paymentType === 'advance' && priorCollected >= newAmountPaid && newAmountPaid > 0) {
      // Re-stating or clarifying advance payment - preserve existing collected amount!
      finalCollected = priorCollected;
      finalOutstanding = finalInvoiceAmount > 0 ? Math.max(0, finalInvoiceAmount - finalCollected) : explicitPending;
      finalStatus = finalOutstanding <= 0 ? 'collected' : 'partial';
    } else {
      finalCollected = priorCollected + newAmountPaid;
      if (explicitPending > 0) {
        finalOutstanding = explicitPending;
      } else if (finalInvoiceAmount > 0) {
        finalOutstanding = Math.max(0, finalInvoiceAmount - finalCollected);
      } else {
        finalOutstanding = Math.max(0, Number(existing.outstanding) - newAmountPaid);
      }
      finalStatus = finalOutstanding <= 0 ? 'collected' : 'partial';
    }

    await supabase
      .from('payment_tracking')
      .update({
        invoice_amount:   finalInvoiceAmount > 0 ? finalInvoiceAmount : null,
        collected_amount: finalCollected,
        outstanding:      finalOutstanding,
        status:           finalStatus,
        payment_type:     finalPaymentType,
        paid_date:        finalStatus === 'collected' ? new Date().toISOString().split('T')[0] : null,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', existing.id);

  } else {
    // --- INSERT new row ---
    finalInvoiceAmount = dealTotal || (newAmountPaid + explicitPending) || newAmountPaid;
    finalCollected     = newAmountPaid;

    if (isFullPayment) {
      finalOutstanding   = 0;
      finalCollected     = finalInvoiceAmount > 0 ? finalInvoiceAmount : newAmountPaid;
      finalPaymentType   = 'full_settlement';
      finalStatus        = 'collected';
    } else if (explicitPending > 0) {
      finalOutstanding   = explicitPending;
      finalStatus        = finalOutstanding <= 0 ? 'collected' : 'partial';
    } else if (dealTotal > 0) {
      finalOutstanding   = Math.max(0, dealTotal - finalCollected);
      finalStatus        = finalOutstanding <= 0 ? 'collected' : 'partial';
    } else {
      finalOutstanding   = 0;
      finalStatus        = 'partial';
    }

    await supabase.from('payment_tracking').insert({
      customer_name:     customerName,
      salesperson_phone: senderPhone,
      invoice_amount:    finalInvoiceAmount > 0 ? finalInvoiceAmount : null,
      collected_amount:  finalCollected,
      outstanding:       finalOutstanding,
      status:            finalStatus,
      payment_type:      finalPaymentType,
      paid_date:         finalStatus === 'collected' ? new Date().toISOString().split('T')[0] : null,
      created_at:        new Date().toISOString(),
    });
  }

  // Auto-resolve any pending follow-up tasks for this customer
  try {
    const { resolveCustomerFollowupTasks } = require('../kra3');
    await resolveCustomerFollowupTasks(customerName, senderPhone, 'payment_logged');
  } catch (rErr) {
    console.warn('[PaymentAgent] Follow-up auto-resolution notice:', rErr.message);
  }

  return {
    finalCollected,
    finalOutstanding,
    finalInvoiceAmount,
    finalStatus,
    dealTotal,
    existing: !!existing,
  };
}

/**
 * Main text message handler.
 */
async function processPaymentMessage(text, senderPhone) {
  try {
    const cleanedText = text
      .replace(/(\d+),(\d{3})/g, '$1$2')
      .replace(/(\d+),(\d{3})/g, '$1$2')
      .replace(/(\d+\.?\d*)\s*[Ll](?:akh)?/g, (_, n) => String(Math.round(parseFloat(n) * 100000)))
      .replace(/(\d+\.?\d*)\s*[Kk]/g, (_, n) => String(Math.round(parseFloat(n) * 1000)));

    const { invokeWithFallback } = require('../core/modelRouter');
    const historyMessages = await getChatHistory(senderPhone);

    const response = await invokeWithFallback([
      new SystemMessage(PAYMENT_AGENT_PROMPT),
      ...historyMessages,
      new HumanMessage('Salesperson message:\n' + cleanedText),
    ]);
    const rawText = (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)).trim();
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(cleaned, null);

    if (!data) {
      return `⚠️ Payment information could not be parsed. Please state the customer name and payment amount.`;
    }

    let customerName = data.customer_name ? data.customer_name.trim() : null;
    if (!customerName) {
      customerName = await getLastCustomerForSalesperson(senderPhone);
    }

    if (!customerName) {
      return `⚠️ *Payment Agent - Customer Missing*\n\nPlease specify the *Customer/Company Name* for this payment record.`;
    }

    const amountPaid       = Math.max(0, Number(data.amount_paid    || 0));
    const amountPending    = Math.max(0, Number(data.amount_pending || 0));
    const isFullPayment    = !!data.is_full_payment;
    const isModeUpdateOnly = !!data.is_mode_update_only || (amountPaid <= 0 && amountPending <= 0 && !!data.payment_mode);
    const paymentMode      = data.payment_mode || null;

    let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);
    if (!officialCustomerName) {
      await supabase.from('recurring_customers').insert({
        customer_name:              customerName,
        assigned_salesperson_phone: senderPhone,
        is_active:                  true,
        avg_order_frequency_days:   30,
      });
      officialCustomerName = customerName;
    }

    const finalCustomerName = officialCustomerName;

    // ── 1. Deal Stage Check (Open/Non-Won Deal) ────────────────────────────────
    const activeDeal = await getActiveDealForCustomer(finalCustomerName, senderPhone);

    if (activeDeal && !isModeUpdateOnly) {
      const { getFullActiveSession, saveActiveSession } = require('../supabase');
      const session = await getFullActiveSession(senderPhone);
      const isPendingPaymentConfirm = session?.last_intent?.startsWith('pending_payment_confirm|');

      if (!isPendingPaymentConfirm) {
        const stageLabels = {
          new_inquiry: 'New Inquiry 📋',
          qualified: 'Qualified ✅',
          quoted: 'Quoted 📄',
          negotiation: 'Negotiation 🤝',
        };
        const stageLabel = stageLabels[activeDeal.stage] || activeDeal.stage;
        const dealValue = activeDeal.total_amount
          ? `₹${Number(activeDeal.total_amount).toLocaleString('en-IN')}`
          : 'value not set';

        await saveActiveSession(
          senderPhone,
          finalCustomerName,
          `pending_payment_confirm|${activeDeal.id}|${finalCustomerName}|${amountPaid}|${amountPending}|${isFullPayment}`,
        );

        return (
          `⚠️ *Payment Confirmation Required*\n\n` +
          `*${finalCustomerName}* currently has an open deal:\n` +
          `Stage: *${stageLabel}*\n` +
          `Deal Value: *${dealValue}*\n\n` +
          `Before logging this payment of *₹${amountPaid.toLocaleString('en-IN')}*, please confirm:\n\n` +
          `1️⃣ *Yes, log payment* - deal will remain at ${stageLabel}\n` +
          `2️⃣ *Mark deal as Won first* - then payment will be logged automatically\n\n` +
          `Reply *1* or *2* to proceed.`
        );
      }
    }

    // ── 2. Amount Discrepancy Check ─────────────────────────────────────────
    const dealTotal = await getDealTotal(finalCustomerName, senderPhone);
    const discrepancy = checkAmountDiscrepancy(amountPaid, amountPending, dealTotal);

    if (discrepancy && !isModeUpdateOnly) {
      const { getFullActiveSession, saveActiveSession } = require('../supabase');
      const session = await getFullActiveSession(senderPhone);
      const isPendingAmountConfirm = session?.last_intent?.startsWith('pending_amount_confirm|');

      if (!isPendingAmountConfirm) {
        await saveActiveSession(
          senderPhone,
          finalCustomerName,
          `pending_amount_confirm|${finalCustomerName}|${amountPaid}|${amountPending}|${isFullPayment}|${discrepancy.correctedPending}`,
        );
        return discrepancy.message;
      }
    }

    // Handle payment mode update only
    if (isModeUpdateOnly) {
      const resultMode = await upsertPaymentTracking({
        customerName:    finalCustomerName,
        senderPhone,
        newAmountPaid:   0,
        explicitPending: 0,
        isFullPayment:   false,
        paymentType:     'mode_update',
        paymentMode:     paymentMode || 'RTGS',
        isModeUpdateOnly: true,
      });

      return `Perfect, I've updated the payment mode for *${finalCustomerName}* to *${paymentMode || 'RTGS'}*.\n\n` +
        `Current Status: *₹${resultMode.finalCollected.toLocaleString('en-IN')}* collected | *₹${resultMode.finalOutstanding.toLocaleString('en-IN')}* remaining balance.\n\n` +
        `Updated Payment Collection Card! ✅`;
    }

    if (amountPaid <= 0 && amountPending <= 0 && !isFullPayment) {
      return `⚠️ *Payment Agent - Amount Missing*\n\nPlease specify the *Payment Amount* or *Outstanding Pending Amount* for *${finalCustomerName}*.`;
    }

    const paymentType = data.payment_type || (amountPaid > 0 ? 'advance' : 'outstanding_update');

    const result2 = await upsertPaymentTracking({
      customerName:    finalCustomerName,
      senderPhone,
      newAmountPaid:   amountPaid,
      explicitPending: amountPending,
      isFullPayment,
      paymentType,
      paymentMode,
      isModeUpdateOnly: false,
    });

    const isFullyPaid = result2.finalStatus === 'collected';
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number:        5,
      kra_type:          isFullyPaid ? 'payment_collected' : 'payment_advance',
      value:             amountPaid > 0 ? amountPaid : 0,
      customer_name:     finalCustomerName,
      description:       `Payment Update: ${finalCustomerName}` +
        (amountPaid > 0 ? ` | Received: ₹${amountPaid.toLocaleString('en-IN')}` : '') +
        (result2.finalOutstanding > 0 ? ` | Outstanding: ₹${result2.finalOutstanding.toLocaleString('en-IN')}` : ' | Fully Settled 🎉'),
      month: new Date().getMonth() + 1,
      year:  new Date().getFullYear(),
    });

    try {
      syncActivity('payment', {
        customer_name: finalCustomerName,
        amount: amountPaid,
        outstanding: result2.finalOutstanding,
      });
    } catch (e) {
      console.error('[PaymentAgent] Zoho sync error:', e.message);
    }

    const lines = [
      `💰 *Payment ${result2.existing ? 'Updated' : 'Logged'}!*`,
      ``,
      `Customer: *${finalCustomerName}*`,
      amountPaid > 0 ? `Amount Received: *₹${amountPaid.toLocaleString('en-IN')}*` : null,
      paymentMode ? `Payment Mode: *${paymentMode}*` : null,
      result2.dealTotal > 0 ? `Total Deal Invoice: *₹${result2.dealTotal.toLocaleString('en-IN')}*` : null,
      `Total Collected: *₹${result2.finalCollected.toLocaleString('en-IN')}*`,
      `Remaining Outstanding: *${result2.finalOutstanding > 0 ? '₹' + result2.finalOutstanding.toLocaleString('en-IN') : '₹0 (Fully Settled 🎉)'}*`,
      `Status: *${result2.finalStatus.toUpperCase()}*`,
      ``,
      `Updated Payment Collection Card! ✅`,
    ].filter(Boolean);

    return lines.join('\n');
  } catch (error) {
    console.error('[PaymentAgent] Error processing payment message:', error);
    return `⚠️ Error logging payment: ${error.message}`;
  }
}

module.exports = {
  processPaymentMessage,
  upsertPaymentTracking,
};
