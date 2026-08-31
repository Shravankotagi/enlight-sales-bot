/**
 * tools.js - All LangGraph Tool Definitions
 *
 * Each tool wraps an existing agent function or Supabase query.
 * The LLM (orchestrator) uses these tools to perform any action.
 * Tools are the ONLY way the LLM touches the database - no hardcoded routing.
 *
 * Tool factory `createTools(senderPhone)` pre-binds the salesperson's phone
 * so the LLM does not need to guess or pass senderPhone in tool arguments.
 */

const { tool } = require('@langchain/core/tools');
const { z }    = require('zod');

// ─── Lazy-load agents to avoid circular deps ──────────────────────────────

function getVisitAgent()     { return require('../agents/visitAgent');     }
function getSalesAgent()     { return require('../agents/salesAgent');     }
function getOcrAgent()       { return require('../agents/ocrAgent');       }
function getPaymentAgent()   { return require('../agents/paymentAgent');   }
function getComplaintAgent() { return require('../agents/complaintAgent'); }
function getRetentionAgent() { return require('../agents/retentionAgent'); }
function getCustomerAgent()  { return require('../agents/customerAgent');  }
function getQueryHandler()   { return require('../queryhandler');          }
function getSupabase()       { return require('../supabase');              }

function createTools(senderPhone, rawUserText = '') {
  const logCustomerVisitTool = tool(
    async ({ text }) => {
      try {
        return await getVisitAgent().processVisitMessage(rawUserText || text, senderPhone);
      } catch (err) {
        return `Error logging visit: ${err.message}`;
      }
    },
    {
      name: 'log_customer_visit',
      description: `Use this tool when the salesperson reports visiting a customer site, meeting a customer in person, an office visit, a field visit or market visit. This logs to Customer Visits Card (KRA 9) and updates the customer profile.`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const updateDealStageTool = tool(
    async ({ text }) => {
      try {
        return await getSalesAgent().processSalesMessage(rawUserText || text, senderPhone);
      } catch (err) {
        return `Error updating deal: ${err.message}`;
      }
    },
    {
      name: 'update_deal_stage',
      description: `Use this tool when the salesperson explicitly requests to create a new inquiry, add a deal to the sales pipeline, update a deal stage, progress an RFQ/quotation, or mark a deal as won/lost. DO NOT call this tool for customer site visits (use log_customer_visit) or customer quality complaints / rejection reports (use log_complaint).`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const logPaymentTool = tool(
    async ({ text }) => {
      try {
        return await getPaymentAgent().processPaymentMessage(text, senderPhone);
      } catch (err) {
        return `Error logging payment: ${err.message}`;
      }
    },
    {
      name: 'log_payment',
      description: `Use this tool when the salesperson reports receiving a payment, advance, installment, or outstanding balance from a customer.`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const logComplaintTool = tool(
    async ({ text }) => {
      try {
        return await getComplaintAgent().processComplaintMessage(text, senderPhone);
      } catch (err) {
        return `Error logging complaint: ${err.message}`;
      }
    },
    {
      name: 'log_complaint',
      description: `Use this tool when the salesperson reports a customer complaint about quality, quantity, delivery, or billing, or when a complaint is resolved.`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const logRetentionFollowupTool = tool(
    async ({ text }) => {
      try {
        return await getRetentionAgent().processRetentionMessage(text, senderPhone);
      } catch (err) {
        return `Error logging follow-up: ${err.message}`;
      }
    },
    {
      name: 'log_retention_followup',
      description: `Use this ONLY for explicit follow-up calls or check-ins with existing customers on past orders. Do NOT use for new requirements - use update_deal_stage instead.`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const onboardNewCustomerTool = tool(
    async ({ text }) => {
      try {
        return await getCustomerAgent().processCustomerMessage(text, senderPhone);
      } catch (err) {
        return `Error onboarding customer: ${err.message}`;
      }
    },
    {
      name: 'onboard_new_customer',
      description: `Use this tool when adding a new customer or updating an existing customer's profile details (phone, address, GST, contact person, city).`,
      schema: z.object({
        text: z.string().describe('The message or contextualized query text containing the company name and details'),
      }),
    }
  );

  const queryMyDataTool = tool(
    async ({ text }) => {
      try {
        return await getQueryHandler().handleQuery(text, senderPhone);
      } catch (err) {
        return `Error fetching data: ${err.message}`;
      }
    },
    {
      name: 'query_my_data',
      description: `Use this tool when the salesperson is ASKING for information: Customer 360 overview, company profile, SOP / company policy, MOQ (minimum order quantity), quotation validity, payment terms, outstanding payments, deal pipeline, visit history, KRA performance, customer list, metal rates, sales reports, or any question about existing data.`,
      schema: z.object({
        text: z.string().describe('The query question from the salesperson'),
      }),
    }
  );

  const getContextTool = tool(
    async () => {
      try {
        const { getFullActiveSession } = getSupabase();
        const session = await getFullActiveSession(senderPhone);
        return JSON.stringify({
          activeCustomer: session?.active_customer_name || null,
          lastIntent: session?.last_intent || null,
          sessionUpdatedAt: session?.updated_at || null,
        });
      } catch (err) {
        return JSON.stringify({ activeCustomer: null, lastIntent: null });
      }
    },
    {
      name: 'get_conversation_context',
      description: `Use this FIRST when the message is ambiguous or references "the customer" without naming them. Returns the active customer from the current session.`,
      schema: z.object({}),
    }
  );

  const processSalesImageTool = tool(
    async ({ imageBuffer, mimeType }) => {
      try {
        const buf = Buffer.from(imageBuffer, 'base64');
        return await getOcrAgent().processSalesImage(buf, mimeType, senderPhone);
      } catch (err) {
        return `Error processing document/PO image: ${err.message}`;
      }
    },
    {
      name: 'process_sales_image',
      description: `Use when a salesperson sends a photo or document of an Inquiry / RFQ, Purchase Order (PO), delivery challan, or order confirmation document. Handled by OCR Agent.`,
      schema: z.object({
        imageBuffer: z.string().describe('Base64-encoded image buffer'),
        mimeType: z.string().describe('MIME type e.g. image/jpeg'),
      }),
    }
  );

  const processPaymentImageTool = tool(
    async ({ imageBuffer, mimeType }) => {
      try {
        const buf = Buffer.from(imageBuffer, 'base64');
        return await getPaymentAgent().processPaymentImage(buf, mimeType, senderPhone);
      } catch (err) {
        return `Error processing payment receipt: ${err.message}`;
      }
    },
    {
      name: 'process_payment_image',
      description: `Use when a salesperson sends a photo of a payment receipt, UPI screenshot, bank transfer confirmation, or cheque.`,
      schema: z.object({
        imageBuffer: z.string().describe('Base64-encoded image buffer'),
        mimeType: z.string().describe('MIME type e.g. image/jpeg'),
      }),
    }
  );

  const updateCustomerProfileTool = tool(
    async ({ customer_name, order_frequency_days, contact_person, phone, gst, address_or_city, assigned_salesperson, text }) => {
      try {
        const { updateCustomerProfileRecord } = getSupabase();
        const res = await updateCustomerProfileRecord(senderPhone, customer_name, {
          order_frequency_days,
          contact_person,
          phone,
          gst,
          address_or_city,
          assigned_salesperson,
        });
        return res.message || JSON.stringify(res);
      } catch (err) {
        return `Error updating customer: ${err.message}`;
      }
    },
    {
      name: 'update_customer_profile',
      description: `Use this tool when updating an existing customer's order frequency (e.g. 45 days, 30 days, 60 days), contact details (phone, owner name, city, GST), active status, or reassigning a customer to a salesperson. Finds the customer across the database and updates their record in place with zero duplicates.`,
      schema: z.object({
        customer_name: z.string().optional().nullable().describe('The name of the company or customer to update. If omitted in user message, pass null or the active customer name from context.'),
        order_frequency_days: z.number().optional().nullable().describe('New order frequency in number of days (e.g. 45, 30, 60)'),
        contact_person: z.string().optional().nullable().describe('New contact person / owner name'),
        phone: z.string().optional().nullable().describe('New phone or mobile number'),
        gst: z.string().optional().nullable().describe('New GST number'),
        address_or_city: z.string().optional().nullable().describe('New address or city/location'),
        assigned_salesperson: z.string().optional().nullable().describe('Salesperson name to reassign or associate with this customer (e.g. "Max", "Rahul")'),
        text: z.string().optional().nullable().describe('The original message text'),
      }),
    }
  );

  const getDealIdsTool = tool(
    async ({ company_name, text }) => {
      try {
        return await getQueryHandler().getDealIdsForCompany(senderPhone, text || rawUserText || '', company_name || null);
      } catch (err) {
        return `Error fetching deal IDs: ${err.message}`;
      }
    },
    {
      name: 'get_deal_ids',
      description: `Use this tool when the salesperson asks for the Deal ID(s) or inquiry code(s) for a company (e.g. "What is the deal ID for Radhe Ispat?", "Deal ID for Apex Steel", "Give me deal ID", "Deal ID"). If company name is not provided in message, pass company_name as null so the system uses the active customer session or asks for the company name.`,
      schema: z.object({
        company_name: z.string().nullable().optional().describe('The customer/company name if mentioned, else null'),
        text: z.string().optional().describe('The user query text'),
      }),
    }
  );

  return [
    getDealIdsTool,
    logCustomerVisitTool,
    updateDealStageTool,
    logPaymentTool,
    logComplaintTool,
    logRetentionFollowupTool,
    onboardNewCustomerTool,
    updateCustomerProfileTool,
    queryMyDataTool,
    getContextTool,
    processSalesImageTool,
    processPaymentImageTool,
  ];
}

module.exports = { createTools };
