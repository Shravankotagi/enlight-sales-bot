/**
 * orchestrator.js — LangGraph Agentic Orchestrator
 *
 * This is the central brain of the WhatsApp bot.
 * Flow:
 *   [START] → [agent_node] → (tool calls?) → [tool_node] → [agent_node] → ... → [END]
 *
 * Primary Model: Google Gemini (gemini-3.1-flash-lite)
 */

const { StateGraph, START, END, Annotation, MessagesAnnotation } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const { createTools }        = require('./tools');
const { invokeWithFallback } = require('./modelRouter');
const { getChatHistory, addChatHistory, getActiveContextPrompt } = require('./memory');

// ── System Prompt — Senior Sales Operations Manager Persona & Few-Shot Examples ──

const SYSTEM_PROMPT = `You are the Senior Sales Operations Manager & Intelligence Assistant for "Enlight Metals".

Your role is to manage and support salespersons on WhatsApp with their daily B2B metal sales activities (visits, deals, payments, complaints, customer onboarding) and database updates.

## Your Persona & Communication Style
- Act like an experienced, supportive, highly attentive human Sales Manager.
- Speak naturally in warm, professional English (or Hinglish if the user uses Hinglish).
- Celebrate wins ("Awesome job closing that deal with Mehta Engineering! 🎉").
- ALWAYS be attentive to business context: when a salesperson logs an activity with partial/incomplete information, praise them for the update AND politely ask for the missing details to complete the customer's file in the CRM!

## Chain-of-Thought Instructions (Execute Mentally Before Responding)
1. **Analyze Tool Results**: Check what activities were saved (Visit, Deal, Payment, Complaint).
2. **Identify Missing Fields**: Check if key business fields are missing:
   - Quantity / Tonnage (in MT)
   - Contact Person Name & Direct Mobile Number
   - Target Delivery Location & Target PO Date
   - Payment Terms / Advance Received
3. **Formulate Response**:
   - Step A: Warmly praise the salesperson for the update.
   - Step B: Summarize what was recorded in the database.
   - Step C: Politely ask 2-3 specific numbered questions for the missing fields.
   - Step D: End with the KRA Dashboard confirmation line.

## FEW-SHOT EXAMPLES (Follow these exact response patterns)

### Example 1 (Visit + Requirement with Missing Tonnage/Contact)
User: "Met with Mehta Engineering in Pune. Introduced our products and collected their business card. Interested in CR Sheets and MS Plates"
Tool Results: Synced visit and deal requirement.
Assistant Response:
Awesome work visiting **Mehta Engineering** in Pune! 🚗 It's great to hear they are interested in our **CR Sheets** and **MS Plates**. I've logged your visit in KRA 9 and recorded their requirement in our sales pipeline.

To help us prepare a formal quotation and complete their profile, could you please share a few details from their business card?
1. **Contact Person's Name** and **Mobile Number**
2. Approximately how many **tons (MT)** of CR Sheets & MS Plates do they require?
3. What is their **expected PO / delivery date**?

Keep up the great momentum! 🚀
Updated KRA 9 Visit & KRA 1 Pipeline Dashboards! ✅

### Example 2 (Payment Logged with Partial Info)
User: "Received 5 lakh advance from Delta Steel"
Tool Results: Payment logged: ₹5,00,000 received.
Assistant Response:
Excellent progress! 💰 I've logged the **₹5,00,000** advance payment received from **Delta Steel**.

To keep our financial records 100% accurate:
1. What was the payment mode (NEFT / RTGS / Cheque / UPI)?
2. What is the target date for settling the remaining balance?

Updated KRA 5 Payment Collection Dashboard! ✅

### Example 3 (Follow-up where salesperson provides missing details)
User: "Mehta contact is Rajesh Shah 9822012345, need 50 MT total by 15th Aug"
Tool Results: Updated customer profile and deal requirement.
Assistant Response:
Got it! Updated **Mehta Engineering's** profile with Contact Person **Rajesh Shah** (📱 9822012345) and set the requirement to **50 MT** by **15th August 2026**.

I'll notify the pricing desk to prepare the quotation! 📄

Updated Customer Master & Sales Pipeline! ✅

- **ADMIN PRIVILEGES**: When the user is an Admin, they have full unrestricted read and write permissions across all data, customers, salespeople, and deals. When Admin asks to change or update a customer (e.g. "Change supreme steel order frequency to 45 days", "Max customer - Change supreme steel order frequency to 45 days"), you MUST execute the update immediately using `update_customer_profile`.
- **CUSTOMER PROFILE & ORDER FREQUENCY UPDATES**: When a user requests to update a customer's order frequency (e.g. "Change [customer] order frequency to X days", "set frequency to 45 days"), reassign a customer to a salesperson (e.g. "reassign [customer] to Max"), or update contact details, CALL `update_customer_profile`. Do NOT call `onboard_new_customer` for updating an existing customer's order frequency.
- NEVER output generic 1-line responses like "Activity updated in dashboard". Always format a complete manager response.
- Use *bold* for customer names, products, amounts, and dates.
- Always end with a KRA dashboard confirmation line when logging activities.
- **BLOCKED REQUESTS**: If someone asks you to 'suggest products for [customer]', 'recommend materials', 'lock the rate sheet', 'create/update/delete a rate sheet', respond: "I cannot perform rate sheet or administrative actions via WhatsApp. Please use the Enlight Sales Web Dashboard for administrative actions." Do NOT call any tools.
- **CROSS-SALESPERSON REQUESTS**: If a salesperson (NOT an Admin) asks about ANOTHER salesperson's performance by name, respond: "You can only view your own performance data. Please contact your Sales Lead for team reports." Do NOT retrieve data for other salespersons.
- **TOOL QUESTIONS / WARNINGS**: If a tool returns an interactive question or warning (starting with ⚠️, ❓, or ❌), YOU MUST FORWARD THAT EXACT QUESTION / PROMPT TO THE USER! Do NOT claim a deal was recorded or updated if the tool returned a confirmation prompt or warning!
- **ALWAYS INCLUDE DEAL ID**: Whenever a tool output includes a Deal ID (e.g. #DEAL-B8018B or #DEAL-3FBBB0), YOU MUST EXPLICITLY INCLUDE THAT EXACT DEAL ID IN YOUR RESPONSE TEXT!
- **CUSTOMER DISAMBIGUATION**: Do NOT assume or carry forward a previous customer name from conversation history for a new requirement/inquiry (starting with 'Need...', 'Requires...', 'New inquiry...') unless the user explicitly names the customer in their message or is directly replying to a multi-deal choice option!`;

// ── State Definition ──────────────────────────────────────────────────────

const OrchestratorState = Annotation.Root({
  ...MessagesAnnotation.spec,
  senderPhone:     Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
  employeeName:    Annotation({ reducer: (x, y) => y ?? x, default: () => 'Salesperson' }),
  messageType:     Annotation({ reducer: (x, y) => y ?? x, default: () => 'text' }),
  imageBuffer:     Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
  imageMimeType:   Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
  toolsUsed:       Annotation({ reducer: (x, y) => [...(x || []), ...(y || [])], default: () => [] }),
});

// ── Deterministic Intent Anchor ───────────────────────────────────────────

function getDeterministicIntentHint(text) {
  if (!text || typeof text !== 'string') return '';
  const lower = text.toLowerCase();

  const anchors = [];

  if (/\b(payment|advance|cheque|upi|neft|rtgs|invoice|balance|outstanding|baki|paid|amount received|payment collected)\b/i.test(lower)) {
    anchors.push('CALL log_payment');
  }
  if (/\b(visited|visit|met|meeting|site|factory|plant|office|market visit)\b/i.test(lower)) {
    anchors.push('CALL log_customer_visit');
  }
  if (/\b(complaint|defective|damaged|scratch|rust|quality|rejected|rejection|faulty)\b/i.test(lower)) {
    anchors.push('CALL log_complaint');
  }
  if (/\b(order frequency|frequency|reorder days|order cycle|reassign customer|change frequency)\b/i.test(lower)) {
    anchors.push('CALL update_customer_profile');
  }
  if (/\b(requires|requirement|need|inquiry|quote|quotation|rfq|ton|mt|coil|plate|sheet|tmt|bar|hr|cr|ms)\b/i.test(lower)) {
    anchors.push('CALL update_deal_stage');
  }
  if (/\b(won|lost|closed|confirmed|order placed|po received|deal done|finalized)\b/i.test(lower)) {
    anchors.push('CALL update_deal_stage');
  }

  if (anchors.length === 0) return '';

  return `\n[REQUIRED TOOL CALLS THIS TURN: ${anchors.join(' AND ')}. You MUST call ALL of these tools before responding. Missing any = incomplete action.]`;
}

/**
 * Router: Decides whether to continue to tools or end the conversation.
 */
function shouldContinue(state) {
  const lastMessage = state.messages[state.messages.length - 1];

  if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    return 'tools';
  }

  return END;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Main entry point — called from webhook.js for every incoming message.
 */
async function runOrchestrator(text, senderPhone, options = {}) {
  const {
    employeeName  = 'Salesperson',
    messageType   = 'text',
    imageBuffer   = null,
    imageMimeType = null,
  } = options;

  try {
    console.log(`[Orchestrator] Processing: "${text?.substring(0, 80)}..." from ${senderPhone}`);

    // Create tools with senderPhone and raw text pre-bound per request
    const TOOLS = createTools(senderPhone, text);

    // Request-scoped Agent Node
    const inlineAgentNode = async (state) => {
      const { messages, senderPhone: sp, employeeName: en, messageType: mt } = state;

      const lastHumanMsg = [...messages].reverse().find(
        m => m._getType?.() === 'human' || m.constructor?.name === 'HumanMessage'
      );
      const userText = lastHumanMsg
        ? (typeof lastHumanMsg.content === 'string' ? lastHumanMsg.content : '')
        : '';
      const hasToolResultsAlready = messages.some(
        m => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage'
      );
      const intentAnchor = hasToolResultsAlready ? '' : getDeterministicIntentHint(userText);
      const activeContextPrompt = await getActiveContextPrompt(sp);
      const historyMessages = getChatHistory(sp);

      const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
      const userScope = await getAccessibleSalespersonPhonesForBot(sp);
      const roleDescription = userScope.isAdmin
        ? 'Admin (Full Company-Wide Read & Write Access: can update, view, and manage any customer, salesperson, deal, or order frequency across the entire company)'
        : (userScope.isManager
            ? 'Sales Manager (Team Management Access: can manage assigned team salespersons and their customers)'
            : 'Salesperson (Standard Access)');

      const contextMessages = [
        new SystemMessage(
          SYSTEM_PROMPT +
          `\n\nCurrent user: ${en || 'User'} (Phone: ${sp}, Role: ${roleDescription})\nMessage type: ${mt}${activeContextPrompt}${intentAnchor}`
        ),
        ...historyMessages,
        ...messages,
      ];

      let response;
      try {
        response = await invokeWithFallback(contextMessages, TOOLS);
      } catch (err) {
        console.error('[Orchestrator] Model invocation failed:', err.message);

        // Friendly greeting fallback if simple greeting message was sent
        const cleanUserText = userText.trim().toLowerCase().replace(/[^a-z]/gi, '');
        if (['hi', 'hii', 'hiii', 'hello', 'hey', 'namaste', 'hie', 'goodmorning', 'goodevening'].includes(cleanUserText)) {
          return {
            messages: [new AIMessage(`Namaste! 🙏 Welcome to Enlight Metals Sales Intelligence Bot.\n\nHow can I assist you with your deals, customer visits, payments, or inquiries today?`)],
          };
        }

        throw err;
      }

      return { messages: [response] };
    };

    // Request-scoped Tool Node — returns ToolMessages to allow agent synthesis
    const inlineToolNode = async (state) => {
      const { messages } = state;
      const lastAIMsg = [...messages].reverse().find(m => m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage');

      if (!lastAIMsg || !lastAIMsg.tool_calls || lastAIMsg.tool_calls.length === 0) {
        return { messages: [] };
      }

      const toolResults = [];

      for (const call of lastAIMsg.tool_calls) {
        const toolObj = TOOLS.find(t => t.name === call.name);
        if (toolObj) {
          try {
            const res = await toolObj.invoke(call.args);
            const resStr = typeof res === 'string' ? res : JSON.stringify(res);
            toolResults.push(new ToolMessage({ content: resStr, tool_call_id: call.id }));
          } catch (err) {
            console.error(`[Orchestrator] Tool ${call.name} execution error:`, err.message);
            toolResults.push(new ToolMessage({ content: `Error: ${err.message}`, tool_call_id: call.id }));
          }
        }
      }

      return { messages: toolResults };
    };

    // Build per-request graph: agent → tools → agent → END
    const graph = new StateGraph(OrchestratorState)
      .addNode('agent', inlineAgentNode)
      .addNode('tools', inlineToolNode)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinue)
      .addEdge('tools', 'agent')
      .compile();

    const humanMsg = new HumanMessage(text || 'Image received');

    const finalState = await graph.invoke({
      messages:      [humanMsg],
      senderPhone,
      employeeName,
      messageType,
      imageBuffer:   imageBuffer ? imageBuffer.toString('base64') : null,
      imageMimeType,
    });

    const allMessages = finalState.messages;

    // Direct Forwarding: If any tool returned a direct prompt or error (starting with ❌, ⚠️, or ❓), forward it directly
    for (const m of allMessages) {
      const content = typeof m.content === 'string' ? m.content : '';
      if (content.startsWith('❌') || content.startsWith('⚠️') || content.startsWith('❓')) {
        addChatHistory(senderPhone, text, content);
        console.log(`[Orchestrator] Direct tool warning/error forwarded (${content.length} chars)`);
        return content;
      }
    }

    const lastAIMsg = [...allMessages].reverse().find(
      m => m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage'
    );

    let rawReply = typeof lastAIMsg?.content === 'string' ? lastAIMsg.content : '';
    let reply = rawReply
      .replace(/<function\([\s\S]*?<\/function>/gi, '')
      .replace(/<function\([\s\S]*?>/gi, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .trim();

    if (!reply) {
      reply = '✅ Activity updated in your CRM & KRA Dashboard!';
    }

    // Post-processor: Guarantee Deal ID is always included in response if generated by a tool
    for (const tm of allMessages) {
      const tmContent = typeof tm.content === 'string' ? tm.content : '';
      const dealCodeMatch = tmContent.match(/#DEAL-[A-F0-9]{4,6}/i);
      if (dealCodeMatch && !reply.toUpperCase().includes(dealCodeMatch[0].toUpperCase())) {
        reply += `\n\n📌 *Deal ID: ${dealCodeMatch[0].toUpperCase()}*`;
      }
    }

    addChatHistory(senderPhone, text, reply);

    console.log(`[Orchestrator] Reply ready (${reply.length} chars)`);
    return reply;

  } catch (err) {
    console.error('[Orchestrator] Fatal error:', err);
    const msg = err.message || '';
    if (msg.includes('429') || msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('All Gemini API keys')) {
      return `⏳ *Gemini Traffic Spike*\n\nGoogle Gemini rate limit reached. Please send your message again in 10 seconds.\n\n_(Tip: Add an additional Gemini API key in Railway under GEMINI_API_KEY_1 to double your quota!)_`;
    }
    return `⚠️ Something went wrong processing your message. Please try again.\n\nError: ${err.message}`;
  }
}

module.exports = { runOrchestrator };
