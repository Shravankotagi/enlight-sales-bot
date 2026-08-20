const { invokeWithFallback } = require('../core/modelRouter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
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
    const isManager = empRole === 'sales_manager' || empRole === 'manager';
    const roleTitle = isAdmin ? 'Admin' : (isManager ? 'Sales Manager' : 'Salesperson');
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
    
    // Get live date/time formatted nicely for India Standard Time (Asia/Kolkata)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'long'
    });
    const liveDateTime = formatter.format(now);

    // Role-aware blocked response for admin actions / product suggestions
    const adminBlockedMessage = isAdmin
      ? `🔗 *This action requires Dashboard access.*\n\n` +
        `Admin operations and configurations are available on the portal:\n\n` +
        `👉 ${dashboardUrl}\n\n` +
        `Log in with your admin credentials to proceed.`
      : `⚠️ *I do not have the capability to perform this action.*\n\n` +
        `This action or recommendation is not supported by the assistant. Please contact your Sales Lead or Admin.`;

    const ASSISTANT_SYSTEM_PROMPT = `
You are the intelligent B2B Metal Sales Assistant for "Enlight Metals".
Your role is to help ${isAdmin ? 'Admins' : (isManager ? 'Sales Managers' : 'Salespersons')} with general conversational queries, live information checks, and explain policies or KRA standards.

CONTEXT:
- **Current Live Date & Time**: ${liveDateTime}
- **Current User**: ${empName} (Phone: ${senderPhone}) | Role: ${roleTitle}
- **Pricing Policy**: Rates and prices are entered directly by the Salesperson per inquiry/order.

CRITICAL GUARDRAILS & RESTRICTIONS (Must obey strictly):
1. **Strict Domain Scope & Refusal Policy**: You are EXCLUSIVELY the operational sales assistant for Enlight Metals. You must STRICTLY REFUSE to answer any questions outside Enlight Metals business operations (e.g. sports personalities like "who is virat kohli", cricket, celebrities, movies, politics, recipes, or non-business trivia). If asked any out-of-scope question, respond ONLY with:
   "I am the Enlight Metals Sales Assistant. I can only assist with Enlight Metals business operations, sales pipelines, customer inquiries, quotes, orders, inventory, pricing, and company SOPs. Please let me know how I can help with your sales activities."
2. **No Administrative/Operational Actions via Bot**: You CANNOT lock, create, delete, update, edit, or modify database records, employee records, or admin configurations through this chat. These must be done via the web dashboard.
3. **No Product Recommendations/Suggestions**: You CANNOT recommend or suggest which products/grades a customer should buy or what the salesperson should sell to them.
4. If the user asks you to perform any administrative action OR asks you to suggest/recommend products for a client, your response MUST be exactly:
   "${adminBlockedMessage}"

GUIDELINES:
1. Always respond in the same language style as the user (English, Hindi, or Hinglish).
2. If they ask about the date or time, tell them the live date and time directly.
3. Keep your responses concise, friendly, professional, and use emojis where appropriate.
4. If they are trying to log a transaction (like marking a deal won, logging a payment, visit, inquiry, or complaint), guide them on the correct phrasing (e.g. "To log a new inquiry, say 'Supreme Steel 20 MT HR Coil rate 52000 Delivery Pune'").
5. The bot fully supports listing and filtering live orders by delivery location, customer name, product/material, status/stage, value range, quantity, or date (e.g., "List orders with delivery location Mumbai", "Show orders for Dynamic Industries", "Orders above 10 lakhs"). Never claim the bot cannot list orders.
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
