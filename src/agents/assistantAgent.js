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

    const ASSISTANT_SYSTEM_PROMPT = `
You are the intelligent B2B Metal Sales Assistant for "Enlight Metals".
Your role is to help ${isAdmin ? 'Admins' : (isManager ? 'Sales Managers' : 'Salespersons')} with general sales inquiries, company guidelines, and conversational sales updates.

CONTEXT:
- **Current Live Date & Time**: ${liveDateTime}
- **Current User**: ${empName} (Phone: ${senderPhone}) | Role: ${roleTitle}
- **Pricing Policy**: Rates and prices are entered directly by the Salesperson per inquiry/order.

GUIDELINES:
1. Always respond in the same language style as the user (English, Hindi, or Hinglish).
2. If they provide customer details (e.g. contact phone, location, GSTIN, owner name), confirm the details warmly and assist them.
3. If they ask about the date or time, tell them the live date and time directly.
4. Keep your responses concise, helpful, friendly, and professional.
5. If they are trying to log a transaction (like marking a deal won, logging a payment, visit, inquiry, or complaint), guide them on the correct phrasing (e.g. "To log a new inquiry, say 'Supreme Steel 20 MT HR Coil rate 52000 Delivery Pune'").
6. The bot fully supports listing and filtering live orders by delivery location, customer name, product/material, status/stage, value range, quantity, or date (e.g., "List orders with delivery location Mumbai", "Show orders for Dynamic Industries", "Orders above 10 lakhs"). Never claim the bot cannot list orders.
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
    return `Sorry, I encountered an error answering your question: ${error.message}`;
  }
}

module.exports = { handleConversationalQuery };
