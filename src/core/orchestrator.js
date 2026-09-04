/**
 * orchestrator.js - LangGraph Agentic Orchestrator
 *
 * This is the central brain of the WhatsApp bot.
 * Flow:
 *   [START] → [agent_node] → (tool calls?) → [tool_node] → [agent_node] → ... → [END]
 *
 * Primary Model: Google Gemini (gemini-3.5-flash-lite)
 */

const { StateGraph, START, END, Annotation, MessagesAnnotation } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const { createTools }        = require('./tools');
const { invokeWithFallback } = require('./modelRouter');
const { getChatHistory, addChatHistory, getActiveContextPrompt } = require('./memory');

// ── System Prompt - Senior Sales Operations Manager Persona & Few-Shot Examples ──

const SYSTEM_PROMPT = `You are the Senior Sales Operations Manager & Intelligence Assistant for "Enlight Metals".

Your role is to manage and support salespersons on WhatsApp with their daily B2B metal sales activities (visits, deals, payments, complaints, customer onboarding) and database updates.

## Your Persona & Communication Style
- Act like an experienced, supportive, highly attentive human Sales Manager.
- Speak naturally in professional, clean English (or Hinglish if the user uses Hinglish).
- Celebrate wins ("Awesome job closing that deal with Mehta Engineering!").
- ALWAYS be attentive to business context: when a salesperson logs an activity with partial/incomplete information, praise them for the update AND politely ask for the missing details to complete the customer's file in the CRM!

## STRICT WHATSAPP FORMATTING & CLEANLINESS RULES (MANDATORY)
1. NO EMOJIS: Never use any emojis or emoticons anywhere in your response. Keep the tone professional, clean, and modern.
2. NO ASTERISK BULLETS: When creating lists or item breakdowns, NEVER start bullet lines with asterisks (* Item). ALWAYS use hyphen-space (- Item) or numbered lists (1. Item).
3. BOLD TEXT: To make text bold for WhatsApp, wrap in single asterisks (*Bold Text*), NEVER double asterisks (**Bold Text**). Do not leave unclosed asterisks.

## Chain-of-Thought Instructions (Execute Mentally Before Responding)
1. **Analyze Tool Results**: Check what activities were saved (Visit, Deal, Payment, Complaint).
2. **Identify Missing Fields**: Check if key business fields are missing:
   - Quantity / Tonnage (in MT)
   - Contact Person Name & Direct Mobile Number
   - Target Delivery Location & Target PO Date
   - Payment Terms / Advance Received
3. **Formulate Response**:
   - Step A: Warmly praise the salesperson for the update.
   - Step B: Summarize what was recorded in the database using clean hyphen-bullet lists (- Customer: ...).
   - Step C: Politely ask 2-3 specific numbered questions for the missing fields (1. ... 2. ...).
   - Step D: End with the official Card confirmation line (e.g. "Logged to Sales Pipeline & Inquiries!" for inquiries, or "Updated Sales Achievement Card!" for won deals).

## STRICT CARD NAMING RULES (MANDATORY)
Always strictly use the official Card name when referencing updates, metrics, or logs:
- **Sales Achievement Card** (for WON deals and PO confirmations ONLY - NEVER at inquiry creation stage)
- **Sales Pipeline & Inquiries** (for new inquiries, quotations, and pipeline stage updates)
- **New Customer Acquisition Card** (for new client onboardings and customer master)
- **Customer Retention Card** (for re-orders, recurring customer follow-ups)
- **Enquiry Conversion Card** (for inquiry-to-won conversion rate)
- **Payment Collection Card** (for advances, cheque, UPI, full payments, outstanding)
- **CRM Compliance Card** (for daily sales activity tracking)
- **Zero Rejection Card** (for rejection-free deliveries)
- **Customer Complaints Card** (for quality issues, damages, resolutions)
- **Customer Visits Card** (for customer site visits, factory meetings)

NEVER output generic numbers like "KRA 1", "KRA 2", "KRA 9", "KRA 5", etc. Always use the actual Card Name!

## AMOUNT GUARDRAIL FOR TEXT INQUIRIES
When confirming or discussing any text-based customer inquiry, requirement, or deal stage update, NEVER mention or output any estimated total price, rate per MT, or currency amount (Rs.). Quantities (in MT), metal specifications, delivery location, and target delivery dates are encouraged. The salesperson customizes and finalizes pricing directly on the dashboard. (Note: Only confirmed won orders with an official PO number or uploaded PO documents may include confirmed amounts).

## FEW-SHOT EXAMPLES (Follow these exact response patterns)

### Example 1 (Customer Visit Logged with Discussed Requirement)
User: "Visited ABC Steel Mumbai office today, discussed next HR Coil requirement and future monthly consumption. Customer showed positive interest."
Tool Results: log_customer_visit returned success: Visit logged with ABC Steel, location: Mumbai, outcome: Positive, requirement: HR Coil / future monthly requirement, follow-up: Collect required quantity, expected PO/delivery date, and customer details.
Assistant Response:
Great work visiting *ABC Steel* at their *Mumbai* office today! It's fantastic that the meeting had a *Positive* outcome and that you discussed their upcoming *HR Coil* requirement and future monthly consumption.

I've successfully logged your visit details in our *Customer Visits Card*!

To follow up effectively:
1. *Contact Details:* Could you share the contact person's name & direct mobile number?
2. *Quantity & Timeline:* What is their estimated tonnage (MT) and expected PO date?

*Potential Opportunity:* If you would like to create a sales pipeline deal for this requirement, simply reply "Create deal for ABC Steel".

Updated Customer Visits Card!

### Example 2 (Payment Logged with Partial Info)
User: "Received 5 lakh advance from Delta Steel"
Tool Results: Payment logged: Rs. 5,00,000 received.
Assistant Response:
Excellent progress! I've logged the *Rs. 5,00,000* advance payment received from *Delta Steel*.

To keep our financial records 100% accurate:
1. What was the payment mode (NEFT / RTGS / Cheque / UPI)?
2. What is the target date for settling the remaining balance?

Updated Payment Collection Card!

### Example 3 (Follow-up where salesperson provides missing details)
User: "Mehta contact is Rajesh Shah 9822012345, need 50 MT total by 15th Aug"
Tool Results: Updated customer profile and deal requirement.
Assistant Response:
Got it! Updated *Mehta Engineering's* profile with Contact Person *Rajesh Shah* (9822012345) and set the requirement to *50 MT* by *15th August 2026*.

I'll notify the pricing desk to prepare the quotation!

Updated New Customer Acquisition Card!

### Example 4 (Text Inquiry)
User: "ABC Steel requires 25 MT HR Coil 8mm for delivery to Mumbai before 25 August. Please create an inquiry."
Tool Results: Created inquiry #INQ-07578A.
Assistant Response:
Fantastic work, Max! I've successfully created an inquiry for *ABC Steel* for *25 MT HR Coil 8mm* for delivery to *Mumbai* before *25 August*.

The inquiry has been logged with *Inquiry ID #INQ-07578A* in our sales pipeline.

Logged to Sales Pipeline & Inquiries!

## Critical Rules
- **INQUIRY ID & INQUIRY LOOKUPS**: When the salesperson asks for the Inquiry ID(s), inquiry code(s), reference numbers, or active inquiry details for any customer (or asks "What is the inquiry ID?", "Inquiry ID kya hai?", "Give me inquiry ID", "Deal ID", "inquiry code", "reference ID" in ANY phrasing, style, or natural language):
  - Call get_deal_ids. If a company is mentioned, pass company_name: "<company_name>". If no company is mentioned, pass company_name: null so the system automatically uses active session or prompts the user. Output the tool response directly to the user.
- **VISIT VS DEAL LOGGING**: Customer site visits, meetings, and in-person check-ins MUST ONLY call log_customer_visit. NEVER call update_deal_stage or create a deal for a visit report. A visit report must ONLY update the **Customer Visits Card** (never Sales Achievement Card). Positive customer interest or requirements discussed during a visit are visit context and must NOT trigger automatic deal creation.
- **ADMIN PRIVILEGES**: When the user is an Admin, they have full unrestricted read and write permissions across all data, customers, salespeople, and deals. When Admin asks to change or update a customer (e.g. "Change supreme steel order frequency to 45 days", "Max customer - Change supreme steel order frequency to 45 days"), you MUST execute the update immediately using update_customer_profile tool.
- **CUSTOMER PROFILE & ORDER FREQUENCY UPDATES**: When a user requests to update a customer's order frequency (e.g. "Change [customer] order frequency to X days", "set frequency to 45 days"), reassign a customer to a salesperson (e.g. "reassign [customer] to Max"), or update contact details, CALL update_customer_profile. Do NOT call onboard_new_customer for updating an existing customer's order frequency.
- NEVER output generic 1-line responses like "Activity updated in dashboard". Always format a complete manager response.
- ONLY include a confirmation line (e.g. "Updated Sales Achievement Card!") when a deal is officially WON (Closed Won / PO confirmed). For new inquiries, qualified, quoted, and negotiation stage deals, ALWAYS end with "Logged to Sales Pipeline & Inquiries!" instead! NEVER append "Updated Sales Achievement Card!" on non-won deals or informational queries!
- **SALESPERSON RATE & PRICE UPDATES (FULLY SUPPORTED)**: Salespersons dynamically set and update product rates for each deal and product directly via WhatsApp. When a message contains rate updates for an inquiry (e.g. "update the rates for Traders Pvt. Ltd. for inquiry id INQ-F91CAB: CR Sheet 1mm - 15, CR Sheet 1.2mm - 18, HR sheet 1.6mm -12"), CALL update_deal_stage to update the deal item rates and inquiry. NEVER reject or block rate updates.
- **BLOCKED REQUESTS**: If someone asks you to 'suggest products for [customer]' or 'recommend materials', respond: "Product recommendations are not available via WhatsApp. Please consult your sales catalog." Do NOT call any tools.
- **CROSS-SALESPERSON REQUESTS**: If a salesperson (NOT an Admin) asks about ANOTHER salesperson's performance by name, respond: "You can only view your own performance data. Please contact your Sales Lead for team reports." Do NOT retrieve data for other salespersons.
- **TOOL QUESTIONS / WARNINGS**: If a tool returns an interactive question or warning, YOU MUST FORWARD THAT EXACT QUESTION / PROMPT TO THE USER! Do NOT claim a deal was recorded or updated if the tool returned a confirmation prompt or warning!
- **ALWAYS INCLUDE INQUIRY ID**: Whenever a tool output includes an Inquiry ID (e.g. #INQ-B8018B or #INQ-3FBBB0), YOU MUST EXPLICITLY INCLUDE THAT EXACT INQUIRY ID IN YOUR RESPONSE TEXT!
- **VALID NEW INQUIRY**: A New Inquiry requires at minimum: Customer/Company Name AND at least one Product Name (e.g. HR Coil, CR Sheet, MS Plate, TMT Bar). If the message contains only supporting fields (delivery location, rate, payment terms, quantity) without a product name and without an Inquiry ID, prompt the user: "Which inquiry is this for? Please provide the Inquiry ID (e.g. #INQ-XXXXXX) or company name."
- **INQUIRY ID & MISSING FIELDS**: When logging an inquiry or updating an existing inquiry, always include the Inquiry ID and clearly state if any mandatory fields (Quantity & Unit, Rate, Delivery Location, Payment Terms) are still needed to complete the inquiry.
- **STANDALONE COMPANY NAMES / SEARCH LOOKUPS**: If the user sends only a company/customer name (e.g. "XYZ steel", "Radhe Ispat Industries", "ABC Metals") without any product quantities, dimensions, or inquiry verbs (need/inquiry/quote/order), ALWAYS call query_my_data to check their customer profile and past records. DO NOT call update_deal_stage or create an inquiry for a standalone company name.
- **CUSTOMER DISAMBIGUATION**: Do NOT assume or carry forward a previous customer name from conversation history for a new requirement/inquiry (starting with 'Need...', 'Requires...', 'New inquiry...') unless the user explicitly names the customer in their message or is directly replying to a multi-deal choice option!
- **COMPLAINTS & QUALITY ISSUES**: When a salesperson reports a customer defect, rust, damage, quality complaint, wrong delivery, or complaint resolution, CALL log_complaint. If log_complaint returns an interactive confirmation question or deal list, output that exact prompt directly to the user so the salesperson can confirm or specify the Inquiry ID.`;

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
  const lower = text.toLowerCase().trim();

  const isSendQuotation =
    /\b(?:send|mail|email|forward|share|dispatch)\b.*?\b(?:quotation|quote|pdf)\b/i.test(lower) ||
    /\b(?:quotation|quote)\b.*?\b(?:bhejo|bhej|send|mail|email|share|forward)\b/i.test(lower) ||
    (/\b(?:send\s+to|mail\s+to|email\s+to)\b/i.test(lower) && /\b(?:quotation|quote)\b/i.test(lower));

  if (isSendQuotation) {
    return '\n[REQUIRED TOOL CALLS THIS TURN: CALL send_quotation. The salesperson is requesting to send, email, or dispatch a quotation to a customer or email address.]';
  }

  const isExplicitDealCommand =
    /\b(create|log|add|new|record|enter|post)\s+(?:new\s+)?(?:deal|inquiry|requirement|rfq|quote|quotation|order)\b/i.test(lower) ||
    /^(?:log\s+)?new\s+inquiry\b/i.test(lower) ||
    /\b(company\s+name|material|grade\/spec|target\s+price)\s*:/i.test(lower) ||
    /\b(upadte|updt|updte|update|set|give|enter|new)\s+(?:the\s+)?(?:rates?|prices?|pricing)\b/i.test(lower) ||
    /\b(?:rates?|prices?)\s+(?:for|of)\b/i.test(lower) ||
    /\b(update|upadte|change|move|set|mark)\b.*?\b(status|stage|negotiation|qualified|quoted|won|lost)\b/i.test(lower) ||
    /\b(status|stage)\b.*?\b(negotiation|qualified|quoted|won|lost)\b/i.test(lower) ||
    /\b(?:deal|inquiry)\s+(?:is\s+|moved\s+to\s+|marked\s+as\s+)?(won|lost|quoted|negotiation|qualified)\b/i.test(lower) ||
    /\b(deal\s+won|deal\s+lost|mark\s+as\s+won|mark\s+as\s+lost|stage\s+update|po\s+received|order\s+placed|order\s+confirmed)\b/i.test(lower) ||
    /#?(?:DEAL|INQ)-[A-F0-9]{4,6}\b/i.test(lower);

  const isVisit = /\b(visited|met with|meeting at|site visit|factory visit|plant visit|market visit)\b/i.test(lower);
  const isPayment = /\b(received payment|paid rs|paid inr|received advance|collected payment|advance of|payment received|neft done|upi done|cheque received)\b/i.test(lower);
  const isComplaint = /\b(complaint|defective|damaged|scratch|rust|quality|rejected|rejection|faulty|crack|cracks|bending issue|thickness variation)\b/i.test(lower);
  const isProfileUpdate =
    /\b(location|city|address|gst|gstin|gst number|contact person|owner|phone|mobile|phone number|mobile number|order frequency|frequency|reorder days|order cycle|reassign customer|change frequency)\b/i.test(lower) ||
    /^(?:location\s*[-:]|gst\s*(?:no|number)?\s*[-:]|phone\s*[-:]|owner\s*[-:])/i.test(lower);

  const hasInquiryVerb = /\b(requires|requirement|need|needs|inquiry|rfq|quote|quotation|rates?|chahiye|mangwa)\b/i.test(lower);
  const hasQuantityUnit = /\b\d+(?:\.\d+)?\s*(?:ton|tons|tonne|tonnes|mt|kg|kgs|sheet|sheets|plate|plates|coil|coils|bar|bars|pcs|nos)\b/i.test(lower);

  // Standalone company name lookup: Short message with no operational verbs or quantities
  const cleanTokens = lower.replace(/[^\w\s]/g, '').trim().split(/\s+/).filter(Boolean);
  const isBareCompanyName =
    cleanTokens.length <= 5 &&
    !isExplicitDealCommand &&
    !isVisit &&
    !isPayment &&
    !isComplaint &&
    !isProfileUpdate &&
    !hasInquiryVerb &&
    !hasQuantityUnit;

  if (isBareCompanyName) {
    return '\n[REQUIRED TOOL CALLS THIS TURN: CALL query_my_data. The message is a customer/company lookup. Check customer records and profile first before performing any action.]';
  }

  const anchors = [];

  if (isPayment) {
    anchors.push('CALL log_payment');
  }
  if (isVisit) {
    anchors.push('CALL log_customer_visit');
  }
  if (isComplaint) {
    // CRITICAL: A complaint report must ONLY call log_complaint and NEVER create/update an inquiry deal
    anchors.push('CALL log_complaint');
  } else {
    if (isProfileUpdate) {
      anchors.push('CALL update_customer_profile');
    }
    if (!isVisit || isExplicitDealCommand) {
      if (isExplicitDealCommand || hasInquiryVerb || hasQuantityUnit) {
        anchors.push('CALL update_deal_stage');
      }
    }
  }

  if (anchors.length > 0) {
    return `\n[REQUIRED TOOL CALLS THIS TURN: ${anchors.join(' AND ')}. You MUST call ALL of these tools before responding. Missing any = incomplete action.]`;
  }

  // Guard: ONLY if NO operational write action is detected, check if user is asking an informational query
  const isQueryPattern =
    /^(how many|how much|what is|what's|whats|show me|show|list|tell me|give me|check|is there|which|kitni|kitna|summary|status|report|view)\b/i.test(lower) ||
    /\b(how many|how much|total count|inquiry count|deal count|order summary|kra status|full report|aging|outstanding balance|revenue this month)\b/i.test(lower);

  if (isQueryPattern) {
    return '\n[REQUIRED TOOL CALLS THIS TURN: CALL query_my_data. You MUST call query_my_data to fetch accurate CRM data before responding.]';
  }

  return '';
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
 * Main entry point - called from webhook.js for every incoming message.
 */
async function runOrchestrator(textOrParams, senderPhoneParam, options = {}) {
  let text = typeof textOrParams === 'string' ? textOrParams : textOrParams?.text;
  let senderPhone = typeof textOrParams === 'object' && textOrParams?.senderPhone ? textOrParams.senderPhone : senderPhoneParam;
  let opts = typeof textOrParams === 'object' && !Array.isArray(textOrParams) ? { ...textOrParams, ...options } : options;
  const {
    employeeName  = 'Salesperson',
    messageType   = 'text',
    imageBuffer   = null,
    imageMimeType = null,
  } = opts;

  try {
    console.log(`[Orchestrator] Processing: "${text?.substring(0, 80)}..." from ${senderPhone}`);

    // Create tools with senderPhone and raw text pre-bound per request
    const TOOLS = createTools(senderPhone, text);

    const { getAccessibleSalespersonPhonesForBot } = require('../supabase');

    // Fetch active context, chat history, and user permissions ONCE concurrently for ultra-low latency
    const [activeContextPrompt, historyMessages, userScope] = await Promise.all([
      getActiveContextPrompt(senderPhone),
      getChatHistory(senderPhone),
      getAccessibleSalespersonPhonesForBot(senderPhone),
    ]);

    const roleDescription = userScope.isAdmin
      ? 'Admin (Full Company-Wide Read & Write Access: can update, view, and manage any customer, salesperson, deal, or order frequency across the entire company)'
      : (userScope.isManager
          ? 'Sales Manager (Team Management Access: can manage assigned team salespersons and their customers)'
          : 'Salesperson (Standard Access)');

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
        const toolsToBind = hasToolResultsAlready ? null : TOOLS;
        response = await invokeWithFallback(contextMessages, toolsToBind);
      } catch (err) {
        console.error('[Orchestrator] Model invocation failed:', err.message);

        // Friendly greeting fallback if simple greeting message was sent
        const cleanUserText = userText.trim().toLowerCase().replace(/[^a-z]/gi, '');
        if (['hi', 'hii', 'hiii', 'hello', 'hey', 'namaste', 'hie', 'goodmorning', 'goodevening'].includes(cleanUserText)) {
          return {
            messages: [new AIMessage(`Namaste! Welcome to Enlight Metals Sales Intelligence Bot.\n\nHow can I assist you with your deals, customer visits, payments, or inquiries today?`)],
          };
        }

        throw err;
      }

      return { messages: [response] };
    };

    // Request-scoped Tool Node - returns ToolMessages to allow agent synthesis
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

    // Extract metadata for 7-message context window
    let turnAgent = 'orchestrator';
    let turnDealId = null;
    let turnCustomerName = null;

    for (const m of allMessages) {
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const toolName = tc.name;
          if (toolName === 'update_deal_stage') turnAgent = 'sales';
          else if (toolName === 'log_customer_visit') turnAgent = 'visit';
          else if (toolName === 'log_complaint') turnAgent = 'complaint';
          else if (toolName === 'log_payment') turnAgent = 'payment';
          else if (toolName === 'onboard_new_customer' || toolName === 'update_customer_profile') turnAgent = 'customer';
          else if (toolName === 'query_my_data' || toolName === 'get_deal_ids') turnAgent = 'query';
          else if (toolName === 'process_sales_image') turnAgent = 'ocr';
          else if (toolName === 'log_retention_followup') turnAgent = 'retention';

          if (tc.args?.customer_name) turnCustomerName = tc.args.customer_name;
          if (tc.args?.company_name) turnCustomerName = tc.args.company_name;
          if (tc.args?.deal_id) turnDealId = tc.args.deal_id;
        }
      }

      const tmContent = typeof m.content === 'string' ? m.content : '';
      const dealMatch = tmContent.match(/#?(?:DEAL|INQ)-([A-F0-9]{4,8})/i);
      if (dealMatch && !turnDealId) {
        turnDealId = dealMatch[1].toUpperCase();
      }
      const custMatch = tmContent.match(/(?:Customer|Company):\s*\*?([A-Za-z0-9\s&.,-]+?)\*?(?:\n|$|,)/i);
      if (custMatch && !turnCustomerName && custMatch[1].trim() !== 'Customer') {
        turnCustomerName = custMatch[1].trim();
      }
    }

    // Direct Forwarding: If any tool returned a direct prompt, warning, stage gate rejection, or error
    for (const m of allMessages) {
      const content = typeof m.content === 'string' ? m.content : '';
      if (
        content.startsWith('❌') ||
        content.startsWith('⚠️') ||
        content.startsWith('❓') ||
        content.startsWith('This deal is currently in New Inquiry stage') ||
        content.startsWith('This inquiry is currently in New Inquiry stage') ||
        content.startsWith('This deal must go through Negotiation') ||
        content.startsWith('This inquiry must go through Negotiation') ||
        content.startsWith('This deal is already marked as') ||
        content.startsWith('This inquiry is already marked as')
      ) {
        await addChatHistory(senderPhone, text, content, {
          agent: turnAgent,
          deal_id: turnDealId,
          customer_name: turnCustomerName,
        });
        console.log(`[Orchestrator] Direct tool warning/rejection/error forwarded (${content.length} chars)`);
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
      reply = 'Activity updated in your CRM & KRA Dashboard!';
    }

    // Post-processor: Guarantee Inquiry ID is always included in response if generated by a tool in current turn
    const isRejectionOrError = reply.startsWith('❌') || reply.startsWith('⚠️') || reply.startsWith('❓') || reply.startsWith('This deal') || reply.startsWith('This inquiry');
    if (!isRejectionOrError) {
      for (const tm of allMessages) {
        if (tm._getType?.() === 'tool' || tm.constructor?.name === 'ToolMessage') {
          const tmContent = typeof tm.content === 'string' ? tm.content : '';
          const dealCodeMatch = tmContent.match(/#(?:DEAL|INQ)-[A-F0-9]{4,6}/i);
          if (dealCodeMatch) {
            const formattedCode = dealCodeMatch[0].toUpperCase().replace(/^#DEAL-/i, '#INQ-');
            if (!reply.toUpperCase().includes(dealCodeMatch[0].toUpperCase()) && !reply.toUpperCase().includes(formattedCode)) {
              reply += `\n\n*Inquiry ID: ${formattedCode}*`;
            }
          }
        }
      }
    }

    await addChatHistory(senderPhone, text, reply, {
      agent: turnAgent,
      deal_id: turnDealId,
      customer_name: turnCustomerName,
    });

    console.log(`[Orchestrator] Reply ready (${reply.length} chars)`);
    return reply;

  } catch (err) {
    console.error('[Orchestrator] Fatal error:', err);
    const msg = err.message || '';
    if (msg.includes('429') || msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('All Gemini API keys')) {
      return `*Gemini Traffic Spike*\n\nGoogle Gemini rate limit reached. Please send your message again in 10 seconds.\n\n_(Tip: Add an additional Gemini API key in Railway under GEMINI_API_KEY_1 to double your quota!)_`;
    }
    return `Something went wrong processing your message. Please try again.\n\nError: ${err.message}`;
  }
}

module.exports = { runOrchestrator, getDeterministicIntentHint };
