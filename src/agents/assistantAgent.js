const { invokeWithFallback } = require('../core/modelRouter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { getLatestActiveRatesText } = require('../gemini');
const { getEmployeeByPhone } = require('../supabase');

const axios = require('axios');

async function handleConversationalQuery(text, senderPhone) {
  try {
    const backendUrl = process.env.CENTRAL_BACKEND_URL || 'http://127.0.0.1:3000';
    const res = await axios.post(
      `${backendUrl}/chat/whatsapp/message`,
      {
        senderPhone,
        messageText: text,
      },
      { timeout: 20000 }
    );

    if (res.data && res.data.reply) {
      return res.data.reply;
    }
  } catch (err) {
    console.warn(`[AssistantAgent] Central backend gateway unreachable (${err.message}). Using local fallback.`);
  }

  try {
    const employee = await getEmployeeByPhone(senderPhone);
    const empName = employee ? employee.name : 'Salesperson';
    const empRole = employee ? (employee.role || 'salesperson') : 'salesperson';
    const isAdmin = empRole === 'admin';
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
    
    // Get live date/time formatted nicely for India Standard Time (Asia/Kolkata)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'long'
    });
    const liveDateTime = formatter.format(now);
    
    // Get active rate sheet
    const activeRates = await getLatestActiveRatesText();

    // Role-aware blocked response for admin actions / product suggestions
    const adminBlockedMessage = isAdmin
      ? `🔗 *This action requires Dashboard access.*\n\n` +
        `Admin operations like rate sheet management, pricing configuration, and product analytics are available on the portal:\n\n` +
        `👉 ${dashboardUrl}\n\n` +
        `Log in with your admin credentials to proceed.`
      : `⚠️ *I do not have the capability to perform this action.*\n\n` +
        `This action or recommendation is not supported by the assistant. Please contact your Sales Lead or Admin.`;

    const ASSISTANT_SYSTEM_PROMPT = `
You are the intelligent B2B Metal Sales Assistant for "Enlight Metals".
Your role is to help ${isAdmin ? 'admins and salespersons' : 'salespersons'} with general conversational queries, live information checks, rate sheets, and explain policies or KRA standards.

CONTEXT:
- **Current Live Date & Time**: ${liveDateTime}
- **Current User**: ${empName} (Phone: ${senderPhone}) | Role: ${empRole}
${activeRates ? `- **Live Rates Info**:\n${activeRates}` : '- No active rates set currently.'}

CRITICAL GUARDRAILS & RESTRICTIONS (Must obey strictly):
1. **No Administrative/Operational Actions via Bot**: You CANNOT lock, create, delete, update, edit, or modify rate sheets, metal prices, database records, employee records, or admin configurations through this chat. These must be done via the web dashboard.
2. **No Product Recommendations/Suggestions**: You CANNOT recommend or suggest which products/grades a customer should buy or what the salesperson should sell to them.
3. If the user asks you to perform any administrative action OR asks you to suggest/recommend products for a client, your response MUST be exactly:
   "${adminBlockedMessage}"

GUIDELINES:
1. Always respond in the same language style as the user (English, Hindi, or Hinglish).
2. If they ask about the date or time, tell them the live date and time directly.
3. If they ask about prices, rate sheet, or metal rates, provide the rates from the context.
4. Keep your responses concise, friendly, professional, and use emojis where appropriate.
5. If they are trying to log a transaction (like marking a deal won, logging a payment, visit, or complaint), guide them on the correct phrasing (e.g. "To log a payment, say 'Delta paid 500000'").
6. Never make up metal prices or dates. Only use the provided context.
`;

    const response = await invokeWithFallback([
      new SystemMessage(ASSISTANT_SYSTEM_PROMPT),
      new HumanMessage(text),
    ]);

    let reply = (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)).trim();

    if (!reply) {
      reply = 'I am here to help you with Enlight Metals sales updates!';
    }
    return reply;
  } catch (error) {
    console.error('Conversational assistant error:', error.message);
    return `⚠️ Sorry, I encountered an error answering your question: ${error.message}`;
  }
}

module.exports = { handleConversationalQuery };
