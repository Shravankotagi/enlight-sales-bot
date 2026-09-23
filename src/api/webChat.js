const express = require('express');
const router = express.Router();
const { handleCatalogFlow } = require('../core/catalogFlow');
const { runOrchestrator } = require('../core/orchestrator');
const { getFullActiveSession, saveActiveSession, supabase } = require('../supabase');
const { handlePendingSessionState } = require('../core/pendingStateManager');
const { clearActiveSession } = require('../core/sessionManager');

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
 * Streamlines menu responses for Web AI Assistant by removing duplicate 1-10 text list items
 * when interactive menu cards are rendered.
 */
function streamlineMenuReplyForWeb(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return rawReply;

  const hasCatalogMenu =
    rawReply.includes('SalesOS Assistant') ||
    rawReply.includes('Log New Inquiry') ||
    rawReply.includes('Here is the menu to start a new activity') ||
    /\b1\.\s+\*?\*?Log New Inquiry/i.test(rawReply);

  if (hasCatalogMenu) {
    let prefix = '';
    if (rawReply.includes('Activity cancelled')) {
      prefix = 'Activity cancelled.\n\n';
    } else if (rawReply.includes('currently in the')) {
      const parts = rawReply.split(/\n\nHere is the menu/i);
      if (parts.length > 1) {
        prefix = parts[0].trim() + '\n\n';
      } else {
        const firstPara = rawReply.split(/\n\n/)[0];
        if (firstPara) prefix = firstPara.trim() + '\n\n';
      }
    } else if (rawReply.includes('To start an activity, please select')) {
      prefix = 'To start an activity, please select the relevant option from the menu below:\n\n';
    }

    return `${prefix}Welcome to **SalesOS Assistant**!\n\nWhat would you like to do today? Reply with a number (1–10) or type what you'd like to do.`;
  }

  return rawReply;
}

/**
 * Formats bot replies for web markdown presentation:
 * 1. Strips all emojis for clean B2B professional presentation.
 * 2. Normalizes inline and line-start bullets (•, ⁃, ◦, ▪, ▫, *, +) to standard hyphen list items (- ).
 * 3. Normalizes WhatsApp single asterisks (*Header*, *Field:*) to standard Markdown bold (**Header**, **Field:**).
 * 4. Ensures clean list isolation and paragraph spacing.
 */
function formatForWeb(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;

  // 1. Remove all emojis (strict zero emoji rule)
  out = out.replace(
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{200D}\u{FE0F}]/gu,
    ''
  );
  out = out.replace(/[ \t]{2,}/g, ' ');

  // 2. Convert mid-sentence / inline Unicode bullets to separate line items
  out = out.replace(/([^\n])\s*[•⁃◦▪▫►◆]\s+/g, '$1\n- ');

  // 3. Normalize list bullets at start of line (•, ⁃, ◦, ▪, ▫, *, +, –, —) to standard Markdown "- "
  out = out.replace(/^(\s*)[•⁃◦▪▫►◆–—*+]\s+/gm, '$1- ');

  // 4. Normalize WhatsApp-style bold labels in list items ("- *Field:*") to standard Markdown ("- **Field:**")
  out = out.replace(/^([ \t]*-\s*)\*([^*:\n]+:)\*/gm, '$1**$2**');

  // 5. Normalize standalone WhatsApp-style bold title lines ("*Title*") to Markdown bold ("**Title**")
  out = out.replace(/^([ \t]*)\*([^*\n]+)\*([ \t]*)$/gm, '$1**$2**$3');

  // 6. Ensure blank line before list blocks if preceded by regular text
  out = out.replace(/([^\n\-\*\+\d])\n([ \t]*[-*+]\s+)/g, '$1\n\n$2');
  out = out.replace(/([^\n\-\*\+\d])\n([ \t]*\d+\.\s+)/g, '$1\n\n$2');

  // 7. Ensure blank line after list blocks if followed by regular paragraph
  out = out.replace(/(\n[ \t]*[-*+]\s+[^\n]+)\n([^\n\s\-*+\d])/g, '$1\n\n$2');
  out = out.replace(/(\n[ \t]*\d+\.\s+[^\n]+)\n([^\n\s\-*+\d])/g, '$1\n\n$2');

  // 8. Clean up 3+ blank lines to 2
  out = out.replace(/\n{3,}/g, '\n\n');

  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
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
 * POST /chat/web/reset
 * Resets the active conversation state and draft sessions for an employee.
 */
router.post('/reset', requireWebApiKey, async (req, res) => {
  try {
    const { employeePhone } = req.body;
    let cleanPhone = String(employeePhone || '').replace(/\D/g, '');
    if (cleanPhone.length < 10) cleanPhone = '9619226169';

    await saveActiveSession(cleanPhone, 'Unknown', 'general');
    await clearActiveSession(cleanPhone);

    return res.json({ success: true, message: 'Session reset successfully' });
  } catch (err) {
    console.error('[WebChat] Error resetting session:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /chat/web/message
 * Entry point for Web AI Assistant messages.
 * Body: { message: string, employeePhone?: string, userId?: string, employeeName?: string, role?: string, resetSession?: boolean }
 */
router.post('/message', requireWebApiKey, async (req, res) => {
  try {
    const { message, employeePhone, userId, employeeName, role, resetSession } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message string is required' });
    }

    let cleanPhone = String(employeePhone || '').replace(/\D/g, '');
    if (cleanPhone.length >= 10) {
      cleanPhone = cleanPhone.slice(-10);
    } else {
      cleanPhone = '9619226169'; // Default fallback phone for sales ops
    }

    // Optional reset if starting fresh conversation
    if (resetSession === true) {
      await saveActiveSession(cleanPhone, 'Unknown', 'general');
      await clearActiveSession(cleanPhone);
    }

    const rawText = normalizeIncomingButtonPayload(message);
    const empName = employeeName || 'Sales Staff';

    console.log(`[WebChat] Processing message from ${empName} (${cleanPhone}): "${rawText.slice(0, 80)}"`);

    // LAYER 1: Guided Catalog & Conversational Form Flow (Greetings, 1-10 Routing, Confirmations)
    const catalogResult = await handleCatalogFlow(rawText, cleanPhone);
    if (catalogResult && catalogResult.handled && catalogResult.reply) {
      let replyToSend = catalogResult.reply;
      if (catalogResult.interactiveType === 'list' && catalogResult.interactiveList?.sections) {
        replyToSend = streamlineMenuReplyForWeb(replyToSend);
      }
      const formattedReply = formatForWeb(replyToSend);
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

    // LAYER 2: Unified Active Session Pending State Machine
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
