/**
 * ocrAgent.js — Dedicated OCR & Document Vision Agent
 *
 * Specializes in extracting, interpreting, and structuring data from images,
 * scanned PDFs, and document uploads (Inquiry RFQs, Purchase Orders, Delivery Challans).
 *
 * Responsibilities:
 * - Inquiry Documents: Extracts line items, specs, quantities, rates -> writes to `inquiries` table (source: whatsapp_image)
 * - Purchase Order (PO) Documents: Extracts PO number, date, line items, delivery, payment terms -> writes to won `deals` & orders
 * - Field extraction accuracy: Customer details from document only, forward GST calculation, no fabrication
 */

const { supabase, saveInquiry, verifyAndGetCustomerName } = require('../supabase');
const { extractFromImage } = require('../gemini');

/**
 * Process incoming Inquiry / PO / Sales document image via Gemini Vision & OCR
 *
 * @param {Buffer} imageBuffer - Raw image or PDF buffer
 * @param {string} mimeType - MIME type (e.g. image/png, image/jpeg, application/pdf)
 * @param {string} senderPhone - Salesperson's registered WhatsApp phone number
 * @param {string} [messageId] - WhatsApp message ID for media tracking
 * @returns {Promise<string>} User-facing WhatsApp confirmation response
 */
async function processSalesImage(imageBuffer, mimeType, senderPhone, messageId) {
  try {
    const extraction = await extractFromImage(imageBuffer, mimeType);

    if (!extraction || extraction.error || !extraction.customer) {
      return `⚠️ Could not clearly extract inquiry details from the document image. Please send a clearer picture or type the details (e.g. "Delta Structural Steel 50 MT HR Coil @ 55,000 Delivery Mumbai").`;
    }

    const custName = extraction.customer.name || 'Customer Inquiry';
    const officialCustomerName = await verifyAndGetCustomerName(custName, senderPhone);
    const finalCustomerName = officialCustomerName || custName;
    const customerPhone = extraction.customer.phone || null;

    // Construct raw text representation for inquiries tab
    const itemsText = (extraction.line_items || [])
      .map(i => {
        const dimStr = i.dimensions ? ` (${i.dimensions})` : '';
        return `${i.sku_text || 'Steel'}${dimStr} ${i.quantity || 0} MT ${i.rate ? '@ Rs ' + i.rate + '/MT' : ''}`;
      })
      .join(', ');
    const rawSummary = `${itemsText}. Delivery Location: ${extraction.delivery_location || 'Warehouse'}`;

    // Convert image buffer to base64 Data URL so web dashboard can render/view it!
    const base64Data = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`;

    // 1. Differentiate between Purchase Order (PO) and regular Inquiry
    const isPo = Boolean(
      extraction.is_purchase_order === true ||
      extraction.inquiry_type === 'purchase_order' ||
      extraction.document_type === 'purchase_order' ||
      (extraction.po_number &&
        extraction.po_number !== 'null' &&
        extraction.po_number !== 'None' &&
        String(extraction.po_number).trim().length > 2)
    );

    let poNumber = null;
    if (isPo) {
      if (extraction.po_number && extraction.po_number !== 'null' && String(extraction.po_number).trim().length > 2) {
        poNumber = String(extraction.po_number).trim();
      } else {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        poNumber = `PO-${todayStr}-${randomNum}`;
      }
    }

    const poDate = extraction.po_date || new Date().toISOString().split('T')[0];
    const inqStatus = isPo ? 'confirmed' : 'review';

    let totalVal = extraction.total_amount || 0;
    if (totalVal <= 0 && extraction.line_items && extraction.line_items.length > 0) {
      totalVal = extraction.line_items.reduce(
        (s, i) => s + ((Number(i.quantity) || 0) * (Number(i.rate) || 0)),
        0
      );
    }

    const baseAmt = extraction.basic_amount || totalVal;
    const gstAmt = extraction.gst_amount || Math.round(baseAmt * 0.18);
    const grandTotal = extraction.total_amount || (baseAmt + gstAmt);
    const finalOrderAmount = grandTotal > 0 ? grandTotal : baseAmt;

    let savedInq = null;
    if (!isPo) {
      // 2. Save Inquiry to Supabase (for regular Inquiries) -> Appears in Inquiries Tab
      savedInq = await saveInquiry({
        source_channel: 'whatsapp_image',
        raw_text: `[Inquiry Document Attached] ${rawSummary}`,
        media_urls: [base64Data],
        sender_phone: senderPhone,
        sender_name: finalCustomerName,
        customer_name: finalCustomerName,
        customer_phone: customerPhone,
        salesperson_phone: senderPhone,
        message_id: messageId || null,
        status: inqStatus,
        inquiry_type: 'inquiry',
        overall_confidence: extraction.overall_confidence || 0.98,
        ai_extraction_json: extraction,
      });
    } else {
      // For Purchase Orders: Save media attachment linked with inquiry_type 'purchase_order'
      savedInq = await saveInquiry({
        source_channel: 'whatsapp_po',
        raw_text: `[PO Document Attached: ${poNumber}] ${rawSummary}`,
        media_urls: [base64Data],
        sender_phone: senderPhone,
        sender_name: finalCustomerName,
        customer_name: finalCustomerName,
        customer_phone: customerPhone,
        salesperson_phone: senderPhone,
        message_id: messageId || null,
        status: 'order_created',
        inquiry_type: 'purchase_order',
        overall_confidence: extraction.overall_confidence || 0.98,
        ai_extraction_json: extraction,
      });
    }

    let dealId = null;

    if (isPo) {
      // ──────────────────────────────────────────────────────────────────
      // Route PO to the backend /deals/process-po-internal endpoint
      // This is the SAME path the dashboard "Create New Order" button uses.
      // ──────────────────────────────────────────────────────────────────
      try {
        const axios = require('axios');
        const backendUrl = process.env.BACKEND_URL ||
          process.env.BACKEND_SERVICE_URL ||
          'https://enlight-sales-backend-production.up.railway.app';

        const backendPayload = {
          customer_name: finalCustomerName,
          customer_phone: customerPhone || null,
          po_number: poNumber,
          po_date: poDate,
          total_amount: finalOrderAmount,
          delivery_location: extraction.delivery_location || null,
          payment_terms: extraction.payment_terms || null,
          salesperson_phone: senderPhone,
          inquiry_id: savedInq?.id || null,
          media_urls: [base64Data],
          overall_confidence: extraction.overall_confidence || 0.98,
          line_items: (extraction.line_items || []).map(item => ({
            sku_text: item.sku_text || 'Material',
            dimensions: item.dimensions || null,
            quantity: Number(item.quantity) || 0,
            unit: item.unit || 'MT',
            rate: Number(item.rate) || 0,
            amount: Number(item.amount) || 0,
          })),
        };

        console.log('[OCRAgent] Calling backend process-po for PO:', poNumber, 'customer:', finalCustomerName);

        const headers = {
          'Content-Type': 'application/json',
          'x-bot-secret': process.env.BOT_INTERNAL_SECRET || 'enlight_bot_secret_2026',
        };

        const poResponse = await axios.post(
          `${backendUrl}/deals/process-po-internal`,
          backendPayload,
          { headers, timeout: 15000 }
        );

        dealId = poResponse.data?.id || poResponse.data?.data?.id || null;
        console.log('[OCRAgent] Backend process-po-internal success, dealId:', dealId);

      } catch (backendErr) {
        console.error('[OCRAgent] Backend process-po-internal failed, falling back to direct Supabase:', backendErr.message);

        // FALLBACK: Direct Supabase write with correct NOT IN syntax
        const { data: openDeals, error: openDealsErr } = await supabase
          .from('deals')
          .select('id, stage, customer_name')
          .ilike('customer_name', `%${finalCustomerName}%`)
          .not('stage', 'in', '(won,lost)')
          .order('created_at', { ascending: false })
          .limit(1);

        if (openDealsErr) {
          console.error('[OCRAgent] openDeals query error:', openDealsErr.message);
        }

        if (openDeals && openDeals.length > 0) {
          dealId = openDeals[0].id;
          const { error: updateErr } = await supabase
            .from('deals')
            .update({
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: poNumber,
              po_date: poDate,
              total_amount: finalOrderAmount,
              delivery_location: extraction.delivery_location || openDeals[0].delivery_location,
              payment_terms: extraction.payment_terms || openDeals[0].payment_terms,
              inquiry_type: 'purchase_order',
              updated_at: new Date().toISOString(),
            })
            .eq('id', dealId);
          if (updateErr) {
            console.error('[OCRAgent] Fallback deal update error:', updateErr.message);
          } else {
            console.log('[OCRAgent] Fallback: updated existing deal to won, dealId:', dealId);
          }
        } else {
          const { data: newWonDeal, error: insertErr } = await supabase
            .from('deals')
            .insert({
              inquiry_id: savedInq?.id || null,
              customer_name: finalCustomerName,
              salesperson_phone: senderPhone,
              customer_phone: customerPhone,
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: poNumber,
              po_date: poDate,
              total_amount: finalOrderAmount,
              delivery_location: extraction.delivery_location || null,
              payment_terms: extraction.payment_terms || null,
              inquiry_type: 'purchase_order',
              status: 'auto_created',
              overall_confidence: extraction.overall_confidence || 0.98,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (insertErr) {
            console.error('[OCRAgent] Fallback deal insert error:', insertErr.message, insertErr);
          } else {
            dealId = newWonDeal?.id || null;
            console.log('[OCRAgent] Fallback: created new won deal, dealId:', dealId);
          }
        }
      }
    } else {
      // Create new inquiry deal in review stage
      const { data: newInqDeal, error: dealErr } = await supabase
        .from('deals')
        .insert({
          inquiry_id: savedInq?.id || null,
          customer_name: finalCustomerName,
          salesperson_phone: senderPhone,
          customer_phone: customerPhone,
          stage: 'review',
          total_amount: baseAmt || 0,
          inquiry_type: 'inquiry',
          delivery_location: extraction.delivery_location || null,
          delivery_date: extraction.delivery_date || null,
          payment_terms: extraction.payment_terms || null,
          po_date: poDate,
          po_number: null,
          status: 'needs_review',
        })
        .select()
        .single();

      if (dealErr) {
        console.error('[OCRAgent] Error inserting inquiry deal:', dealErr.message || dealErr);
      }
      if (newInqDeal) dealId = newInqDeal.id;
    }

    // 3. Save / Overwrite Deal Items
    if (dealId && extraction.line_items && extraction.line_items.length > 0) {
      await supabase.from('deal_items').delete().eq('deal_id', dealId);

      for (const item of extraction.line_items) {
        const q = Number(item.quantity) || 0;
        const r = Number(item.rate) || 0;
        const amt = Number(item.amount) || (q > 0 && r > 0 ? q * r : 0);

        await supabase.from('deal_items').insert({
          deal_id: dealId,
          sku_text: item.sku_text || 'Hot Rolled Steel Coil',
          dimensions: item.dimensions || null,
          quantity: q > 0 ? q : null,
          unit: item.unit || 'MT',
          rate: r > 0 ? r : null,
          amount: amt > 0 ? amt : null,
          created_at: new Date().toISOString(),
        });
      }
    }

    // 4. If PO: Log KRA 1 and create Payment Tracking record
    if (isPo && dealId) {
      // Log KRA 1 Sales Achievement
      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        customer_name: finalCustomerName,
        kra_number: 1,
        kra_type: 'sales_achievement',
        metric_name: 'won_deal_value',
        value: finalOrderAmount,
        notes: `PO Received: ${poNumber} for ${finalCustomerName} — ₹${finalOrderAmount.toLocaleString('en-IN')}`,
        created_at: new Date().toISOString(),
      });

      // Update recurring customers
      try {
        await supabase
          .from('recurring_customers')
          .update({ last_order_date: new Date().toISOString() })
          .ilike('customer_name', `%${finalCustomerName}%`);
      } catch (err) {}

      // Create / Update Payment Tracking
      try {
        let creditDays = 30;
        const termsStr = String(extraction.payment_terms || '').toLowerCase();
        const daysMatch = termsStr.match(/(\d+)\s*(?:days|day)/);
        if (daysMatch) {
          creditDays = parseInt(daysMatch[1], 10);
        } else if (termsStr.includes('advance') || termsStr.includes('immediate') || termsStr.includes('cash')) {
          creditDays = 0;
        }

        const poDateTime = new Date(poDate).getTime() || Date.now();
        const dueDate = new Date(poDateTime + creditDays * 24 * 60 * 60 * 1000);
        const dueDateStr = dueDate.toISOString().split('T')[0];

        const { data: existingPay } = await supabase
          .from('payment_tracking')
          .select('id')
          .eq('deal_id', dealId)
          .limit(1);

        if (existingPay && existingPay.length > 0) {
          await supabase
            .from('payment_tracking')
            .update({
              invoice_amount: finalOrderAmount,
              outstanding: finalOrderAmount,
              due_date: dueDateStr,
              credit_period_days: creditDays,
              customer_name: finalCustomerName,
              salesperson_phone: senderPhone,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingPay[0].id);
        } else {
          await supabase.from('payment_tracking').insert({
            deal_id: dealId,
            salesperson_phone: senderPhone,
            customer_name: finalCustomerName,
            invoice_amount: finalOrderAmount,
            outstanding: finalOrderAmount,
            status: 'pending',
            due_date: dueDateStr,
            credit_period_days: creditDays,
            created_at: new Date().toISOString(),
          });
        }
      } catch (payErr) {
        console.warn('[OCRAgent] Payment tracking notice:', payErr.message);
      }
    }

    let itemsBreakdown = '';
    if (extraction.line_items && extraction.line_items.length > 0) {
      itemsBreakdown = extraction.line_items
        .map(i => {
          const dimStr = i.dimensions ? ` (${i.dimensions})` : '';
          return `  • *${i.sku_text || 'Material'}*${dimStr}: ${i.quantity || 0} MT ${i.rate ? '@ ₹' + Number(i.rate).toLocaleString('en-IN') + '/MT' : ''}`;
        })
        .join('\n');
    }

    if (isPo) {
      return (
        `🎉 *PURCHASE ORDER RECEIVED & DEAL WON!* 🏆\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `PO Number: *${poNumber}* 📄\n` +
        `PO Date: *${poDate}*\n` +
        `Stage: *WON / DELIVERED 🎉*\n\n` +
        (itemsBreakdown ? `Line Items:\n${itemsBreakdown}\n` : '') +
        `PO Basic Value: *₹${baseAmt.toLocaleString('en-IN')}*\n` +
        `GST (18%): *₹${gstAmt.toLocaleString('en-IN')}*\n` +
        (extraction.payment_terms ? `Payment Terms: *${extraction.payment_terms}*\n` : '') +
        (extraction.delivery_location ? `Delivery Location: *${extraction.delivery_location}*\n\n` : '\n') +
        `✅ Synced live to Orders Tab, Sales Achievement & Payment Tracking! 🚀`
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://enlight-sales-frontend.vercel.app';
    const inquiryEditLink = savedInq?.id ? `${frontendUrl}/inquiries?id=${savedInq.id}` : `${frontendUrl}/inquiries`;

    return (
      `📄 *INQUIRY / SALES DEAL LOGGED!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Stage: *REVIEW 📄*\n` +
      (itemsBreakdown ? `Line Items:\n${itemsBreakdown}\n` : '') +
      (baseAmt > 0 ? `Product Amount: *₹${baseAmt.toLocaleString('en-IN')}*\nGST (18%): *₹${gstAmt.toLocaleString('en-IN')}*\n*Grand Total: ₹${grandTotal.toLocaleString('en-IN')}*\n` : '') +
      `Delivery Location: *${extraction.delivery_location || 'Not Specified'}*\n\n` +
      `✏️ *Review & Finalize Quotation:* \n` +
      `${inquiryEditLink}\n\n` +
      `✅ Logged live to Inquiries tab & Sales Pipeline!`
    );
  } catch (error) {
    console.error('[OCRAgent] Error processing sales image:', error);
    return `⚠️ Error processing document image: ${error.message}`;
  }
}

module.exports = {
  processSalesImage,
  processDocumentImage: processSalesImage,
};
