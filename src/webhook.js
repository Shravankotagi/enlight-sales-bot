const express = require('express');
const router = express.Router();
const { supabase, saveInquiry, saveDeal, getEmployeeByPhone } = require('./supabase');
const { sendTextMessage, downloadMedia } = require('./whatsapp');
const { extractFromText, extractFromImage, classifyIntent } = require('./gemini');
const { transcribeAudio } = require('./assemblyai');
const { isQuery, handleQuery } = require('./queryhandler');
const { handleFollowUpReply } = require('./kra3');
const { handleVisitLog } = require('./kra9');
const { handlePaymentUpdate } = require('./kra5');
const { isComplaintReport, isComplaintResolution, handleComplaintLog, handleComplaintResolution } = require('./kra8');
const { handleNewCustomerAnnouncement } = require('./kra2');

// Dedicated Specialized AI Agents
const { processSalesMessage, processSalesImage } = require('./agents/salesAgent');
const { processPaymentMessage, processPaymentImage } = require('./agents/paymentAgent');
const { processCustomerMessage } = require('./agents/customerAgent');
const { processComplaintMessage } = require('./agents/complaintAgent');
const { processVisitMessage } = require('./agents/visitAgent');
const { processRetentionMessage } = require('./agents/retentionAgent');

/**
 * KRA 6 - CRM Compliance Logger
 * Logs every business activity by a salesperson as a daily CRM touch.
 * Called for every non-greeting, non-query intent so daily compliance is accurately tracked.
 * Uses upsert-by-date so only ONE log per salesperson per day per intent type is created.
 */
async function logKRA6Activity(senderPhone, activityType, customerName) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    // Check if we already logged KRA 6 for this salesperson today with this activity type
    const { data: existing } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('salesperson_phone', senderPhone)
      .eq('kra_number', 6)
      .eq('kra_type', activityType)
      .gte('created_at', `${today}T00:00:00.000Z`)
      .lte('created_at', `${today}T23:59:59.999Z`)
      .limit(1);

    if (existing && existing.length > 0) return; // Already logged today for this activity

    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number:        6,
      kra_type:          activityType,
      customer_name:     customerName || null,
      description:       `CRM Activity: ${activityType} logged via WhatsApp bot`,
      month: new Date().getMonth() + 1,
      year:  new Date().getFullYear(),
    });
  } catch (err) {
    console.error('KRA 6 logging error (non-critical):', err.message);
    // Non-critical — never block the main flow
  }
}

/**
 * GET /webhook
 * Verification endpoint for Meta Webhook setup.
 */
router.get('/', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        console.log('Webhook verified successfully!');
        return res.status(200).send(challenge);
      } else {
        console.error('Webhook verification failed: Verify token mismatch.');
        return res.sendStatus(403);
      }
    }
    return res.sendStatus(400);
  } catch (error) {
    console.error('Error in webhook verification GET:', error);
    return res.sendStatus(500);
  }
});

/**
 * POST /webhook
 * Endpoint to receive incoming WhatsApp messages.
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Log the incoming request body for debugging/traceability
    console.log('Incoming webhook event:', JSON.stringify(body, null, 2));

    if (body.object && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0]) {
      const value = body.entry[0].changes[0].value;

      // Only process message events, ignore status updates (delivered, read, etc.)
      if (value.messages && value.messages[0]) {
        const message = value.messages[0];
        const messageId = message.id;
        const senderPhone = message.from;
        
        // Safely extract sender profile name, fallback to "Customer" if missing
        const senderName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || "Customer";
        const messageType = message.type;

        // Look up employee record for this sender phone
        const employeeRecord = await getEmployeeByPhone(senderPhone);
        const employeeId = employeeRecord ? employeeRecord.employee_id : null;
        if (employeeRecord) {
          console.log(`Employee lookup: ${employeeRecord.name} (${employeeId})`);
        } else {
          console.log(`No employee found for phone: ${senderPhone}`);
        }

        let raw_text = "";
        let media_urls = [];
        let voice_url = null;

        // Parse content based on WhatsApp message type
        switch (messageType) {
          case 'text':
            raw_text = message.text ? message.text.body : "";
            break;
          case 'image':
            raw_text = (message.image && message.image.caption) || "Image received";
            if (message.image && message.image.id) {
              media_urls = [message.image.id];
            }
            break;
          case 'audio':
            raw_text = "Voice note received";
            if (message.audio && message.audio.id) {
              voice_url = message.audio.id;
            }
            break;
          case 'document':
            raw_text = (message.document && message.document.caption) || "Document received";
            if (message.document && message.document.id) {
              media_urls = [message.document.id];
            }
            break;
          default:
            raw_text = `${messageType} message type received`;
            break;
        }

        // Remove surrounding quotes if typed by the salesperson (e.g. from copy-pasting test prompts)
        if (raw_text) {
          raw_text = raw_text.trim();
          if ((raw_text.startsWith('"') && raw_text.endsWith('"')) || 
              (raw_text.startsWith("'") && raw_text.endsWith("'"))) {
            raw_text = raw_text.substring(1, raw_text.length - 1).trim();
          }
        }

        // Truncate raw_text if it is extremely long to prevent LLM timeouts (Edge Case 4)
        if (raw_text && raw_text.length > 2000) {
          raw_text = raw_text.substring(0, 2000) + "... (truncated)";
        }

        // ── 1. EARLY INTERCEPTION FOR CHATBOT ASSISTANT QUERIES ──
        // Questions, policy inquiries, data lookups, and conversational queries
        // route directly to the Central Chatbot Gateway without creating inquiries or modifying deals.
        const { isQuery } = require('./queryhandler');
        const isChatbotQuery = messageType === 'text' && isQuery(raw_text);

        if (isChatbotQuery) {
          console.log(`[Webhook] Intercepted Chatbot Query from ${senderPhone}: "${raw_text.slice(0, 60)}"`);
          const axios = require('axios');
          const backendUrl = process.env.CENTRAL_BACKEND_URL || 'http://127.0.0.1:3000';
          try {
            const res = await axios.post(
              `${backendUrl}/chat/whatsapp/message`,
              {
                senderPhone,
                messageText: raw_text,
              },
              { timeout: 25000 }
            );

            const botReply = res.data?.data?.reply || res.data?.reply;
            if (botReply) {
              await sendTextMessage(senderPhone, botReply);
              return;
            }
          } catch (backendErr) {
            console.error(`[Webhook] Central backend error on query: ${backendErr.message}. Falling back to local query handler.`);
          }

          // Fallback to local query handler if central backend is unreachable
          const { handleQuery } = require('./queryhandler');
          const queryReply = await handleQuery(raw_text, senderPhone);
          if (queryReply) {
            await sendTextMessage(senderPhone, queryReply);
            return;
          }
        }

        const { getFullActiveSession, saveActiveSession } = require('./supabase');

        // --- CHECK ACTIVE REJECTION FLOWS (multi-turn logic) ---
        const activeSession = await getFullActiveSession(senderPhone);
        
        if (activeSession && activeSession.last_intent && activeSession.last_intent.startsWith('pending_loss_reason|')) {
          const parts = activeSession.last_intent.split('|');
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
            '8': 'Cancelled by customer'
          };

          // Clean up response input
          const cleanInput = raw_text.replace(/[️⃣\s]/g, '').trim();
          let selectedReason = cleanInput;
          if (MAP_REASONS[cleanInput]) {
            selectedReason = MAP_REASONS[cleanInput];
          } else {
            // Check if input starts with a number like "1. price"
            const numMatch = cleanInput.match(/^([1-8])/);
            if (numMatch && MAP_REASONS[numMatch[1]]) {
              selectedReason = MAP_REASONS[numMatch[1]];
            } else {
              // Otherwise, use the user's custom typed reason
              selectedReason = raw_text;
            }
          }

          // Fetch current deal amount to pass to KRA logs
          let dealAmount = 0;
          const { data: dealRow } = await supabase
            .from('deals')
            .select('total_amount, deal_items(amount, quantity, rate)')
            .eq('id', dealId)
            .limit(1);
          if (dealRow && dealRow.length > 0) {
            dealAmount = Number(dealRow[0].total_amount || 0);
            if (dealAmount === 0 && dealRow[0].deal_items && dealRow[0].deal_items.length > 0) {
              dealAmount = dealRow[0].deal_items.reduce(
                (sum, item) => sum + (Number(item.amount) || (Number(item.quantity || 0) * Number(item.rate || 0))),
                0,
              );
            }
          }

          // 1. Update deal to lost stage using correct column name lost_reason
          const dealUpdatePayload = {
            stage: 'lost',
            lost_reason: selectedReason,
          };
          if (dealAmount > 0) {
            dealUpdatePayload.total_amount = dealAmount;
          }

          await supabase
            .from('deals')
            .update(dealUpdatePayload)
            .eq('id', dealId);

          // 2. Log to KRA 4 loss analytics (single record to avoid double-counting)
          await supabase.from('kra_logs').insert({
            salesperson_phone: senderPhone,
            kra_number: 4,
            kra_type: 'deal_lost',
            value: dealAmount,
            customer_name: customerName,
            description: `Deal Lost: ${customerName} — Reason: ${selectedReason}`,
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
          });

          // 3. Clear/Reset session intent to general so we exit the loss flow
          await saveActiveSession(senderPhone, customerName, 'general');

          // Send confirmation
          const reply = `❌ *Deal Marked as LOST*\n\n` +
            `Customer: *${customerName}*\n` +
            `Stage: *Closed Lost*\n` +
            `Reason: *${selectedReason}*\n\n` +
            `Updated Loss Analytics Dashboard! 📉`;

          await sendTextMessage(senderPhone, reply);
          return;
        }

        if (activeSession?.last_intent?.startsWith('pending_payment_confirm|')) {
          const parts = activeSession.last_intent.split('|');
          const dealId = parts[1];
          const customerName = parts[2];
          const amountPaid = Number(parts[3]);
          const amountPending = Number(parts[4]);
          const isFullPayment = parts[5] === 'true';

          const cleanInput = raw_text.replace(/[️⃣\s]/g, '').trim();

          if (cleanInput === '2' || cleanInput.toLowerCase().includes('won')) {
            // Fetch existing PO number or generate a unique PO number if missing
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

            // Mark deal as won with auto-generated PO number
            await supabase
              .from('deals')
              .update({
                stage: 'won',
                won_at: new Date().toISOString(),
                po_number: targetPoNumber,
              })
              .eq('id', dealId);

            await saveActiveSession(senderPhone, customerName, 'general');

            const { processPaymentMessage } = require('./agents/paymentAgent');
            const syntheticText =
              `${customerName} paid ₹${amountPaid}` +
              (amountPending > 0 ? ` outstanding ₹${amountPending}` : '') +
              (isFullPayment ? ' full payment' : '');
            const reply = await processPaymentMessage(syntheticText, senderPhone);

            await sendTextMessage(
              senderPhone,
              `🎉 *Deal Marked as WON & Payment Logged!*\n\n` + reply,
            );
            return;
          }

          if (cleanInput === '1' || cleanInput.toLowerCase().includes('yes')) {
            await saveActiveSession(senderPhone, customerName, 'general');

            const { processPaymentMessage } = require('./agents/paymentAgent');
            const syntheticText =
              `${customerName} paid ₹${amountPaid}` +
              (amountPending > 0 ? ` outstanding ₹${amountPending}` : '') +
              (isFullPayment ? ' full payment' : '');
            const reply = await processPaymentMessage(syntheticText, senderPhone);

            await sendTextMessage(senderPhone, reply);
            return;
          }

          await sendTextMessage(
            senderPhone,
            `Please reply *1* to log payment for the open deal, or *2* to mark the deal as Won first.`,
          );
          return;
        }

        if (activeSession?.last_intent?.startsWith('pending_amount_confirm|')) {
          const parts = activeSession.last_intent.split('|');
          const customerName = parts[1];
          const amountPaid = Number(parts[2]);
          const amountPending = Number(parts[3]);
          const isFullPayment = parts[4] === 'true';
          const correctedPending = Number(parts[5]);

          const cleanInput = raw_text.replace(/[️⃣\s]/g, '').trim();
          await saveActiveSession(senderPhone, customerName, 'general');

          if (cleanInput === '3' || cleanInput.toLowerCase().includes('cancel')) {
            await sendTextMessage(
              senderPhone,
              `✅ Cancelled. Please resend the correct payment details when ready.`,
            );
            return;
          }

          let finalPending = amountPending;
          if (cleanInput === '1') {
            finalPending = correctedPending;
          }

          const { processPaymentMessage } = require('./agents/paymentAgent');
          const syntheticText =
            `${customerName} paid ₹${amountPaid}` +
            (finalPending > 0 ? ` outstanding ₹${finalPending}` : ' full payment');
          const reply = await processPaymentMessage(syntheticText, senderPhone);

          await sendTextMessage(senderPhone, reply);
          return;
        }

        if (activeSession?.last_intent?.startsWith('pending_unit_confirm|')) {
          const parts = activeSession.last_intent.split('|');
          const customerName = parts[1];
          const productName = parts[2];
          const qtyNum = parts[3];

          const cleanInput = raw_text.trim();

          // Check if user is sending a brand new inquiry/requirement instead of answering confirmation
          const isNewInquiry = /\b(need|requires|new deal|inquiry|requirement|want|order)\b/i.test(cleanInput);

          if (!isNewInquiry) {
            await saveActiveSession(senderPhone, customerName, 'general');
            const { processSalesMessage } = require('./agents/salesAgent');

            if (cleanInput === '1' || cleanInput.toLowerCase().includes('yes')) {
              // Confirmed as MT
              const syntheticText = `${customerName} requirement ${qtyNum} MT ${productName}`;
              const reply = await processSalesMessage(syntheticText, senderPhone);
              await sendTextMessage(senderPhone, reply);
              return;
            }

            // If salesperson supplied a valid unit answer e.g. "15 MT" or "1500 kg"
            const syntheticText = `${customerName} requirement ${raw_text} ${productName}`;
            const reply = await processSalesMessage(syntheticText, senderPhone);
            await sendTextMessage(senderPhone, reply);
            return;
          }

          // If new inquiry, clear stale session and let orchestrator process fresh
          await saveActiveSession(senderPhone, 'Unknown', 'general');
        }

        if (activeSession?.last_intent?.startsWith('pending_product_for_deal|')) {
          const parts = activeSession.last_intent.split('|');
          const customerName = parts[1];
          const qtyNum = parts[2];
          const unitStr = parts[3] || 'MT';

          const cleanInput = raw_text.trim();
          await saveActiveSession(senderPhone, customerName, 'general');

          const { processSalesMessage } = require('./agents/salesAgent');
          const syntheticText = `${customerName} requirement ${qtyNum} ${unitStr} ${cleanInput}`;
          const reply = await processSalesMessage(syntheticText, senderPhone);
          await sendTextMessage(senderPhone, reply);
          return;
        }

        if (activeSession?.last_intent?.startsWith('pending_custom_rate|')) {
          const parts = activeSession.last_intent.split('|');
          const customerName = parts[1];
          const materialName = parts[2];

          const cleanInput = raw_text.trim();
          await saveActiveSession(senderPhone, customerName, 'general');

          const rateMatch = cleanInput.match(/\d[\d,.]*/);
          const customRate = rateMatch ? Number(rateMatch[0].replace(/,/g, '')) : 0;

          if (customRate > 0) {
            const { processSalesMessage } = require('./agents/salesAgent');
            const syntheticText = `${customerName} requirement ${materialName} rate ${customRate}`;
            const reply = await processSalesMessage(syntheticText, senderPhone);
            await sendTextMessage(senderPhone, reply);
            return;
          }
        }

        if (activeSession?.last_intent?.startsWith('pending_deal_choice|')) {
          const parts = activeSession.last_intent.split('|');
          const customerName = parts[1];
          const dbStage = parts[2];
          const originalMsg = parts[3] || '';

          const cleanInput = raw_text.trim();
          await saveActiveSession(senderPhone, customerName, 'general');

          const { processSalesMessage } = require('./agents/salesAgent');
          const syntheticText = `${originalMsg} deal ${cleanInput}`;
          const reply = await processSalesMessage(syntheticText, senderPhone);
          await sendTextMessage(senderPhone, reply);
          return;
        }

        // ── OPERATIONAL AGENTIC ORCHESTRATOR (LangGraph + Specialized Write Agents) ──
        if (messageType === 'text' && raw_text && raw_text.length >= 2) {
          const { runOrchestrator } = require('./core/orchestrator');
          const empName = employeeRecord ? employeeRecord.name : senderName;

          const reply = await runOrchestrator(raw_text, senderPhone, {
            employeeName:  empName,
            messageType:   'text',
          });

          await sendTextMessage(senderPhone, reply);
          return;
        }
        // ── END ORCHESTRATOR ──────────────────────────────────────────────────

        // Only actual sales inquiries/POs reach here
        // Apply duplicate check only for specific typed text messages (exclude document/image placeholders)
        const isPlaceholderText = ['document received', 'image received', 'voice note received'].includes((raw_text || '').toLowerCase().trim());
        if (raw_text && !isPlaceholderText && raw_text.length > 5) {
          const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
          const { data: duplicateInquiries } = await supabase
            .from('inquiries')
            .select('id, created_at')
            .eq('salesperson_phone', senderPhone)
            .eq('raw_text', raw_text)
            .in('status', ['processed', 'review'])
            .gte('created_at', oneHourAgo);

          if (duplicateInquiries && duplicateInquiries.length > 0) {
            console.log('Duplicate inquiry text detected in the last 1 hour. Skipping processing.');
            await sendTextMessage(senderPhone, `⚠️ *Duplicate message ignored* - This inquiry was already received and processed recently.`);
            return;
          }
        }

        // --- GEMINI EXTRACTION ---
        let extraction = null;
        let mediaDownloadFailed = false;

        if (messageType === 'text' && raw_text && raw_text.length > 5) {
          // Extract from text
          extraction = await extractFromText(raw_text);
        } else if ((messageType === 'image' || messageType === 'document') && media_urls.length > 0) {
          const mediaId = media_urls[0];
          const mediaData = await downloadMedia(mediaId);
          console.log('Media download result:', mediaData ? 'success' : 'failed');

          if (mediaData && mediaData.buffer) {
            const isPaymentKeyword = raw_text && (
              raw_text.toLowerCase().includes('payment') ||
              raw_text.toLowerCase().includes('paid') ||
              raw_text.toLowerCase().includes('receipt') ||
              raw_text.toLowerCase().includes('upi') ||
              raw_text.toLowerCase().includes('advance')
            );

            if (isPaymentKeyword) {
              // Route to Payment Collection Vision Agent (KRA 5)
              const paymentVisionReply = await processPaymentImage(mediaData.buffer, mediaData.mimeType, senderPhone);
              await sendTextMessage(senderPhone, paymentVisionReply);
              return;
            } else {
              // Route to Sales & PO Vision Agent (KRA 1 & Zoho Bigin)
              const salesVisionReply = await processSalesImage(mediaData.buffer, mediaData.mimeType, senderPhone);
              await sendTextMessage(senderPhone, salesVisionReply);
              return;
            }
          } else {
            mediaDownloadFailed = true;
          }
        } else if (messageType === 'audio' && voice_url) {
          console.log('Voice note received, downloading...');
          const mediaData = await downloadMedia(voice_url);
          console.log('Media download result:', mediaData ? 'success' : 'failed');
          
          if (mediaData && mediaData.buffer) {
            console.log('Audio downloaded, sending to AssemblyAI...');
            
            // Transcribe audio
            const transcript = await transcribeAudio(
              mediaData.buffer, 
              mediaData.mimeType
            );
            
            if (transcript) {
              console.log('Transcript:', transcript);
              
              // Update raw_text with transcript
              raw_text = transcript;
              
              // Update inquiry with transcript
              if (savedInquiry && savedInquiry.id) {
                await supabase
                  .from('inquiries')
                  .update({ 
                    raw_text: transcript,
                    voice_url: voice_url
                  })
                  .eq('id', savedInquiry.id);
              }
              
              // Extract inquiry from transcript using Gemini
              extraction = await extractFromText(transcript);
              console.log('Extraction from voice:', JSON.stringify(extraction, null, 2));
            } else {
              console.log('Transcription failed or returned empty');
            }
          } else {
            mediaDownloadFailed = true;
          }
        }

        // Save deal if extraction succeeded and it is a valid inquiry or PO
        let deal = null;
        if (extraction && !extraction.error && extraction.inquiry_type && extraction.inquiry_type !== 'unknown') {
          // 1. Validate Line Items (Product, Quantity, Unit)
          const validUnits = ['mt', 'kg', 'ton', 'tons', 'no', 'nos', 'pc', 'pcs', 'sheet', 'sheets', 'bundle', 'bundles', 'coil', 'coils'];
          const lineItems = extraction.line_items || [];

          // Pre-resolve customer name context so we can use it in clarification prompts
          let extractedCustName = extraction.customer?.name?.trim();
          const { getActiveSession } = require('./supabase');
          const sessionCust = await getActiveSession(senderPhone);
          const currentCustomerLabel = (extractedCustName && 
            extractedCustName.toLowerCase() !== 'customer' && 
            extractedCustName.toLowerCase() !== 'this client' && 
            extractedCustName.toLowerCase() !== 'client') 
            ? extractedCustName 
            : (sessionCust || 'the customer');

          if (lineItems.length === 0) {
            await sendTextMessage(
              senderPhone,
              `❓ *Which metal product/grade does ${currentCustomerLabel} require?*\n\nPlease specify the product name, quantity, and unit (e.g. _15 MT HR Coil_ or _20 sheets MS Plate_).`
            );
            return;
          }

          for (const item of lineItems) {
            if (!item.sku_text || item.sku_text.toLowerCase().trim() === 'unknown' || item.sku_text.toLowerCase().trim() === 'null') {
              await sendTextMessage(
                senderPhone,
                `❓ *Which metal product/grade does ${currentCustomerLabel} require?*\n\nPlease specify the product name (e.g. _HR Coil_ or _MS Sheet_).`
              );
              return;
            }
            if (!item.quantity || Number(item.quantity) <= 0) {
              await sendTextMessage(
                senderPhone,
                `❓ *How much ${item.sku_text} does ${currentCustomerLabel} require?*\n\nPlease specify the quantity (e.g. _10 MT_ or _50 Sheets_).`
              );
              return;
            }
            if (!item.unit || item.unit.toLowerCase().trim() === 'null') {
              await sendTextMessage(
                senderPhone,
                `❓ *What unit should we use for ${item.quantity} of ${item.sku_text}?*\n\nPlease mention a valid unit like MT, Kg, Tons, Nos, or Sheets.`
              );
              return;
            }
            const normUnit = item.unit.toLowerCase().trim();
            if (!validUnits.includes(normUnit)) {
              await sendTextMessage(
                senderPhone,
                `⚠️ *Invalid unit*\n\nUnit *"${item.unit}"* is not a valid unit. Please specify a valid unit like MT, Kg, Tons, Nos, or Sheets for *${item.sku_text}*.`
              );
              return;
            }
          }

          // 2. Validate and Resolve Customer Name
          let extractedCustomerName = extraction.customer?.name?.trim();

          const isPlaceholder = !extractedCustomerName || 
              extractedCustomerName.toLowerCase() === 'customer' || 
              extractedCustomerName.toLowerCase() === 'this client' || 
              extractedCustomerName.toLowerCase() === 'client';

          if (isPlaceholder) {
            // Check if there is an active customer session context in the last 15 minutes
            const { getActiveSession } = require('./supabase');
            const sessionCustomer = await getActiveSession(senderPhone);
            if (sessionCustomer) {
              console.log(`Resolved customer name "${sessionCustomer}" from active session context.`);
              extractedCustomerName = sessionCustomer;
              if (extraction.customer) {
                extraction.customer.name = sessionCustomer;
              } else {
                extraction.customer = { name: sessionCustomer };
              }
            } else {
              await sendTextMessage(
                senderPhone,
                `❓ *Which customer is this inquiry for?*\n\n` +
                `Please specify the customer/company name so I can log this inquiry.\n` +
                `*Example:* _"For Mehta Industries, need 15 MT HR Coil"_`
              );
              return;
            }
          }

          // 3. Perform Customer Verification (handles exact and fuzzy matched typos)
          const { verifyAndGetCustomerName, saveActiveSession } = require('./supabase');
          const officialCustomerName = await verifyAndGetCustomerName(extractedCustomerName, senderPhone);

          if (!officialCustomerName) {
            await sendTextMessage(
              senderPhone,
              `⚠️ *Client Not Found in your Customer List*\n\n` +
              `Client *"${extractedCustomerName}"* is not registered under your salesperson account.\n\n` +
              `Please onboard this customer first under *KRA 2 (Customer Onboarding)* before logging inquiries or orders.\n\n` +
              `*Example to onboard customer:*\n` +
              `_"New customer ${extractedCustomerName} owner Mr. Kapoor location Mumbai phone 9876543210 gst 27AAAAA1111A1Z1"_\n\n` +
              `Once added, you can resend this inquiry.`
            );
            return;
          }

          // Keep session context refreshed with the validated customer name
          await saveActiveSession(senderPhone, officialCustomerName, 'inquiry');

          // Use the official/corrected customer name from the database (fixes typos)
          // Save inquiry in inquiries table with validated customer and line items
          const { saveInquiry } = require('./supabase');
          const savedInquiry = await saveInquiry({
            source_channel: 'whatsapp',
            raw_text: raw_text,
            media_urls: media_urls || [],
            voice_url: voice_url || null,
            sender_phone: senderPhone,
            sender_name: senderName,
            whatsapp_message_id: messageId || null,
            status: extraction.overall_confidence >= 0.85 ? 'processed' : 'review',
            salesperson_phone: senderPhone,
            employee_id: employeeId,
            inquiry_type: extraction.inquiry_type || 'Product Requirement',
            overall_confidence: extraction.overall_confidence || 0.95,
            ai_extraction_json: {
              ...extraction,
              customer: {
                name: officialCustomerName,
                phone: extraction.customer?.phone || null,
                gst: extraction.customer?.gst || null,
                address: extraction.customer?.address || null,
              },
              customer_name: officialCustomerName,
              customer_phone: extraction.customer?.phone || null,
              companyName: officialCustomerName,
            },
          });
          const inquiryId = savedInquiry?.id || null;

          // Save deal + line items
          deal = await saveDeal(inquiryId, extraction, senderPhone, employeeId);

          // --- KRA 2 NEW CUSTOMER CHECK ---
          if (deal && deal.customer_name) {
            const { checkAndLogNewCustomer } = require('./supabase');
            await checkAndLogNewCustomer(deal, senderPhone);
          }
          // --- END KRA 2 CHECK ---

          // --- KRA 4 INQUIRY TRACKING ---
          // Log KRA 4 for every accepted inquiry so conversion rate is tracked accurately.
          // Only log once per deal (check by deal_id or customer_name + month)
          try {
            const month = new Date().getMonth() + 1;
            const year  = new Date().getFullYear();
            const { data: kra4Existing } = await supabase
              .from('kra_logs')
              .select('id')
              .eq('salesperson_phone', senderPhone)
              .eq('kra_number', 4)
              .eq('kra_type', 'inquiry_received')
              .ilike('customer_name', `%${deal.customer_name}%`)
              .eq('month', month)
              .eq('year', year)
              .limit(1);

            if (!kra4Existing || kra4Existing.length === 0) {
              await supabase.from('kra_logs').insert({
                salesperson_phone: senderPhone,
                kra_number:        4,
                kra_type:          'inquiry_received',
                customer_name:     deal.customer_name,
                value:             deal.total_amount || 0,
                description:       `Inquiry logged: ${deal.customer_name} (${extraction.inquiry_type})`,
                month,
                year,
              });
            }
          } catch (kra4Err) {
            console.error('KRA 4 log error (non-critical):', kra4Err.message);
          }
          // --- END KRA 4 INQUIRY TRACKING ---

          // KRA 6 for inquiry/PO submission
          logKRA6Activity(senderPhone, 'inquiry_submitted', deal.customer_name);
        }

        // Build smart reply based on extraction
        let replyMessage;
        if (deal && extraction && extraction.line_items && extraction.line_items.length > 0) {
          const itemSummary = extraction.line_items
            .map((item) => {
              const rateStr = item.rate && item.rate > 0 ? ` @ ₹${Number(item.rate).toLocaleString('en-IN')}/MT` : '';
              const amtStr = item.amount && item.amount > 0 ? `: ₹${Number(item.amount).toLocaleString('en-IN')}` : '';
              return `• ${item.sku_text || 'Metal'} (${item.quantity} ${item.unit || 'MT'}${rateStr})${amtStr}`;
            })
            .join('\n');
          
          const confidence = Math.round((extraction.overall_confidence || 0) * 100);
          const status = extraction.overall_confidence >= 0.85 ? '✅ Auto-logged' : '⚠️ Needs review';
          
          replyMessage = `${status} - Deal #${deal.id.substring(0, 8)}\n\n` +
            `📋 *${extraction.inquiry_type === 'purchase_order' ? 'Purchase Order' : 'Inquiry'}*\n` +
            (extraction.customer?.name ? `🏢 Customer: ${extraction.customer.name}\n` : '') +
            (extraction.po_number ? `📄 PO: ${extraction.po_number}\n` : '') +
            `\n📦 Items:\n${itemSummary}\n` +
            (extraction.total_amount ? `\n💰 Total: ₹${extraction.total_amount.toLocaleString('en-IN')}\n` : '') +
            (extraction.delivery_date ? `📅 Delivery: ${extraction.delivery_date}\n` : '') +
            `\n🎯 Confidence: ${confidence}%`;

          // Append missing customer profile info check
          const { getCustomerMissingInfoPrompt } = require('./supabase');
          const missingInfoPrompt = await getCustomerMissingInfoPrompt(deal.customer_name, senderPhone);
          if (missingInfoPrompt) {
            replyMessage += missingInfoPrompt;
          }
        } else {
          if (mediaDownloadFailed) {
            replyMessage = `⚠️ *Download Error*\n\n` +
              `Failed to download the attachment from WhatsApp. Please check the file and try sending it again.`;
          } else if (messageType === 'audio' && !extraction) {
            replyMessage = `Voice note received but transcription failed. Please send as text.`;
          } else {
            replyMessage = `🤔 Samajh nahi aaya. Kya aap thoda aur detail mein bata sakte hain?\n\n` +
              `For example:\n` +
              `• Deal update ke liye: "ABC ka deal won hua"\n` +
              `• Payment ke liye: "Supreme ne 50000 diya"\n` +
              `• Visit ke liye: "Aaj Mehta ke yahan gaya"`;
          }
        }
        // --- END GEMINI EXTRACTION ---

        // Send WhatsApp reply
        await sendTextMessage(senderPhone, replyMessage);

      } else {
        console.log("No messages in changes (received status update).");
      }
    }
  } catch (error) {
    console.error("Error processing incoming webhook POST:", error);
  } finally {
    // Meta requires a 200 OK response within 5 seconds for all webhook requests
    res.status(200).send('EVENT_RECEIVED');
  }
});

// ── Admin: Sync all database records to Zoho Bigin (POST & GET for Browser) ─
const handleBiginSync = async (req, res) => {
  try {
    const { syncAllDatabaseToBigin } = require('./agents/biginSyncAgent');
    const results = await syncAllDatabaseToBigin();

    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Zoho Bigin Sync Result</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 40px 20px; }
            .card { background: white; max-width: 560px; margin: 0 auto; padding: 32px; border-radius: 20px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
            .badge { display: inline-block; background: #dcfce7; color: #15803d; font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
            h2 { font-size: 22px; margin: 0 0 8px 0; color: #0f172a; }
            p { font-size: 14px; color: #64748b; margin: 0 0 24px 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
            .stat { background: #f1f5f9; padding: 16px; border-radius: 14px; text-align: center; }
            .num { font-size: 28px; font-weight: 800; color: #2563eb; }
            .label { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 4px; }
            .btn { display: inline-block; background: #2563eb; color: white; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">LIVE SYNC COMPLETED</span>
            <h2>✅ Database Synced to Zoho Bigin!</h2>
            <p>All customer profiles and active pipeline deals have been synced to Zoho Bigin CRM.</p>
            
            <div class="grid">
              <div class="stat">
                <div class="num">${results.contactsSynced}</div>
                <div class="label">Contacts Synced</div>
              </div>
              <div class="stat">
                <div class="num">${results.dealsSynced}</div>
                <div class="label">Deals Synced</div>
              </div>
            </div>

            <a href="https://bigin.zoho.in/" target="_blank" class="btn">Open Zoho Bigin ↗</a>
          </div>
        </body>
        </html>
      `);
    }

    res.json({
      success: true,
      message: 'Database synced to Zoho Bigin successfully',
      synced: {
        contacts: results.contactsSynced,
        deals: results.dealsSynced,
      },
      errors: results.errors,
    });
  } catch (err) {
    res.status(500).send(`
      <div style="font-family: system-ui; padding: 40px; max-width: 500px; margin: 0 auto; color: #ef4444;">
        <h3>❌ Zoho Bigin Sync Error</h3>
        <p>${err.message}</p>
      </div>
    `);
  }
};

router.post('/admin/bigin-sync', handleBiginSync);
router.get('/admin/bigin-sync', handleBiginSync);

// ── Admin: Cleanup & re-sync (POST & GET) ────────────────────────────────────
const handleBiginCleanup = async (req, res) => {
  try {
    const { clearAllBiginData, syncAllDatabaseToBigin } = require('./agents/biginSyncAgent');
    const deleteResults = await clearAllBiginData();
    const syncResults = await syncAllDatabaseToBigin();

    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Zoho Bigin Cleanup & Sync Result</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 40px 20px; }
            .card { background: white; max-width: 560px; margin: 0 auto; padding: 32px; border-radius: 20px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
            .badge { display: inline-block; background: #dcfce7; color: #15803d; font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
            h2 { font-size: 22px; margin: 0 0 8px 0; color: #0f172a; }
            p { font-size: 14px; color: #64748b; margin: 0 0 24px 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
            .stat { background: #f1f5f9; padding: 16px; border-radius: 14px; text-align: center; }
            .num { font-size: 28px; font-weight: 800; color: #2563eb; }
            .label { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 4px; }
            .btn { display: inline-block; background: #2563eb; color: white; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">CLEANUP & RE-SYNC COMPLETED</span>
            <h2>✅ Cleaned & Re-synced to Zoho Bigin!</h2>
            <p>Old records cleared and database customers/deals re-synced clean.</p>
            
            <div class="grid">
              <div class="stat">
                <div class="num">${syncResults.contactsSynced}</div>
                <div class="label">Contacts Synced</div>
              </div>
              <div class="stat">
                <div class="num">${syncResults.dealsSynced}</div>
                <div class="label">Deals Synced</div>
              </div>
            </div>

            <a href="https://bigin.zoho.in/" target="_blank" class="btn">Open Zoho Bigin ↗</a>
          </div>
        </body>
        </html>
      `);
    }

    res.json({
      success: true,
      message: 'All Zoho Bigin data cleared and re-synced from database successfully',
      deleted: deleteResults.deleted,
      synced: {
        contacts: syncResults.contactsSynced,
        deals: syncResults.dealsSynced,
      },
      errors: [...deleteResults.errors, ...syncResults.errors],
    });
  } catch (err) {
    res.status(500).send(`
      <div style="font-family: system-ui; padding: 40px; max-width: 500px; margin: 0 auto; color: #ef4444;">
        <h3>❌ Zoho Bigin Error</h3>
        <p>${err.message}</p>
      </div>
    `);
  }
};

router.post('/admin/bigin-cleanup', handleBiginCleanup);
router.get('/admin/bigin-cleanup', handleBiginCleanup);

// ── Admin: Inbound Import (Pull from Bigin → Database) ────────────────────────
const handleBiginImport = async (req, res) => {
  try {
    const { pullBiginToDatabase } = require('./agents/biginSyncAgent');
    const results = await pullBiginToDatabase();

    if (req.method === 'GET' || req.headers.accept?.includes('html')) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Zoho Bigin Import Result</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 40px 20px; }
            .card { background: white; max-width: 560px; margin: 0 auto; padding: 32px; border-radius: 20px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
            .badge { display: inline-block; background: #dbeafe; color: #1e40af; font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
            h2 { font-size: 22px; margin: 0 0 8px 0; color: #0f172a; }
            p { font-size: 14px; color: #64748b; margin: 0 0 24px 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
            .stat { background: #f1f5f9; padding: 16px; border-radius: 14px; text-align: center; }
            .num { font-size: 28px; font-weight: 800; color: #2563eb; }
            .label { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 4px; }
            .btn { display: inline-block; background: #2563eb; color: white; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">INBOUND IMPORT COMPLETED</span>
            <h2>📥 Bigin Data Imported to Database!</h2>
            <p>Customer contacts and active pipeline deals have been pulled from Zoho Bigin into your database.</p>
            
            <div class="grid">
              <div class="stat">
                <div class="num">${results.contactsImported}</div>
                <div class="label">Contacts Imported</div>
              </div>
              <div class="stat">
                <div class="num">${results.dealsImported}</div>
                <div class="label">Deals Imported</div>
              </div>
            </div>

            <a href="/" class="btn">Return to Control Dashboard ↗</a>
          </div>
        </body>
        </html>
      `);
    }

    res.json({
      success: true,
      message: 'Zoho Bigin data imported to database successfully',
      imported: {
        contacts: results.contactsImported,
        deals: results.dealsImported,
      },
      errors: results.errors,
    });
  } catch (err) {
    res.status(500).send(`
      <div style="font-family: system-ui; padding: 40px; max-width: 500px; margin: 0 auto; color: #ef4444;">
        <h3>❌ Bigin Import Error</h3>
        <p>${err.message}</p>
      </div>
    `);
  }
};

router.post('/admin/bigin-import', handleBiginImport);
router.get('/admin/bigin-import', handleBiginImport);

module.exports = router;
