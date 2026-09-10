/**
 * tools.js - All LangGraph Tool Definitions for WhatsApp Bot
 *
 * Combines:
 * - 10 Operational Write Tools (salesAgent, visitAgent, complaintAgent, paymentAgent, ocrAgent, retentionAgent, customerAgent)
 * - 11 Data Retrieval & Intelligence Tools (get_inquiries, get_visits, get_complaints, get_customer_360, get_my_open_deals, get_reorder_queue, get_team_pipeline, get_churn_radar, get_loss_analytics, get_deal_ids, search_knowledge_base)
 */

const { tool } = require('@langchain/core/tools');
const { z }    = require('zod');
const {
  resolveCallerContext,
  executeGetInquiries,
  executeGetVisits,
  executeGetComplaints,
  executeGetCustomer360,
  executeGetMyOpenDeals,
  executeGetReorderQueue,
  executeGetTeamPipeline,
  executeGetChurnRadar,
  executeGetLossAnalytics,
  executeGetDealIds,
  executeSearchKnowledgeBase,
} = require('./retrievalTools');

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
  // ─── Operational Write Tools ──────────────────────────────────────────────

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
      description: `Use this tool when the salesperson creates a new inquiry, updates deal rates, updates quantities or units, adds/removes line items, updates payment terms, delivery address, delivery date, notes, customer details, or updates deal stage/status (e.g. "update status to quoted", "mark as won", "deal lost", "update stage to negotiation", "status is quotated"). DO NOT call this tool for emailing/dispatching PDF quotations (use send_quotation), customer site visits (use log_customer_visit), or complaints (use log_complaint).`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
      }),
    }
  );

  const sendQuotationTool = tool(
    async ({ text, email, customer_name, deal_id }) => {
      try {
        return await getSalesAgent().handleSendQuotationMessage(rawUserText || text, senderPhone, email, customer_name, deal_id);
      } catch (err) {
        return `Error sending quotation: ${err.message}`;
      }
    },
    {
      name: 'send_quotation',
      description: `Use this tool ONLY when the salesperson explicitly requests to send, email, mail, or dispatch a quotation / quote PDF document to an email address or recipient (e.g. "Send quotation to client@gmail.com", "Mail quote to test@example.com", "Send quote to customer via email"). DO NOT use this tool when the user is simply updating the deal status or stage to quoted/quotated (use update_deal_stage instead).`,
      schema: z.object({
        text: z.string().describe('The full original message from the salesperson'),
        email: z.string().optional().nullable().describe('The email address if mentioned e.g. client@gmail.com, else null'),
        customer_name: z.string().optional().nullable().describe('Customer or company name if mentioned, else null'),
        deal_id: z.string().optional().nullable().describe('Inquiry ID if mentioned e.g. #INQ-A983FC, else null'),
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

  // ─── 11 Data Retrieval & Intelligence Tools ────────────────────────────────

  const getInquiriesTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetInquiries(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching inquiries: ${err.message}`;
      }
    },
    {
      name: 'get_inquiries',
      description: `Retrieves customer inquiries, raw WhatsApp messages, and resulting deal status. Supports direct inquiry ID lookups (#INQ-XXXXXX), channel breakdown (WhatsApp vs Dashboard), conversion breakdown, highest tonnage inquiry, salesperson conversion rankings, open inquiries from dormant buyers, month-over-month comparison, and monthly summary.`,
      schema: z.object({
        inquiry_id: z.string().optional().nullable().describe('Optional specific Inquiry ID or Deal ID (e.g. "#INQ-2C788F", "INQ-2C788F", or UUID) to fetch status and details for that exact inquiry.'),
        status_filter: z.string().optional().nullable().describe('Optional filter by inquiry status or deal outcome: "all", "won" / "orders", "lost", "review", "pending", "quoted", "negotiation".'),
        source_channel: z.string().optional().nullable().describe('Optional filter by incoming channel: "all", "whatsapp", "dashboard", "whatsapp_text", "web_dashboard".'),
        source_type: z.string().optional().nullable().describe('Optional filter by inquiry format: "all", "ocr_document" (documents/PDFs/images), "text".'),
        date_range: z.string().optional().nullable().describe('Optional date filter: "today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days", "this_month", "last_month", "all".'),
        customer_name_search: z.string().optional().nullable().describe('Optional search term for customer or company name.'),
        mode: z.string().optional().nullable().describe('Query mode: "list", "conversion_breakdown", "rep_conversion", "open_inquiries_dormant_buyers", "month_comparison", "monthly_summary", "at_risk_inquiries", "highest_tonnage", "channel_breakdown".'),
        limit: z.number().optional().nullable().describe('Maximum number of inquiries to return (default: 20).'),
      }),
    }
  );

  const getVisitsTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetVisits(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching visits: ${err.message}`;
      }
    },
    {
      name: 'get_visits',
      description: `Retrieves customer site and field visit logs, visit outcomes (positive, neutral, negative), location filtering (e.g. "Mumbai", "Pune", "Nashik"), salesperson visit leaderboard, week-over-week visit comparison, duplicate visits, and visits missing location or contact person.`,
      schema: z.object({
        customer_name_search: z.string().optional().nullable().describe('Optional search term for customer name.'),
        salesperson_name: z.string().optional().nullable().describe('Optional filter by salesperson name (e.g. "Max", "Rishabh Makwana").'),
        location: z.string().optional().nullable().describe('Optional filter by visit city or destination (e.g. "Nashik", "Pune", "Mumbai").'),
        outcome_filter: z.string().optional().nullable().describe('Optional filter by visit outcome: "positive", "neutral", "negative", "all".'),
        date_range: z.string().optional().nullable().describe('Optional date filter: "today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days", "this_month", "last_month", "all".'),
        mode: z.string().optional().nullable().describe('Query mode: "list", "rep_leaderboard", "week_comparison", "duplicates", "missing_location", "missing_contact_person", "pending_followup".'),
        limit: z.number().optional().nullable().describe('Maximum number of visits to return (default: 20).'),
      }),
    }
  );

  const getComplaintsTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetComplaints(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching complaints: ${err.message}`;
      }
    },
    {
      name: 'get_complaints',
      description: `Retrieves customer quality and delivery complaints, 48-hour SLA performance, open vs resolved tracking, sales rep complaints leaderboard / comparison, product category breakdown (Coil vs Plate vs Structural Steel), and negative visit correlation patterns.`,
      schema: z.object({
        customer_name: z.string().optional().nullable().describe('Optional filter by customer or company name.'),
        salesperson_name: z.string().optional().nullable().describe('Optional filter by salesperson name.'),
        status_filter: z.string().optional().nullable().describe('Optional filter: "open", "resolved", "all".'),
        date_range: z.string().optional().nullable().describe('Optional date filter: "today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days", "this_month", "last_month", "all".'),
        mode: z.string().optional().nullable().describe('Query mode: "list", "rep_complaints", "product_category_breakdown", "visit_correlation".'),
        limit: z.number().optional().nullable().describe('Maximum number of complaints to return (default: 20).'),
      }),
    }
  );

  const getCustomer360Tool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetCustomer360(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching customer profile: ${err.message}`;
      }
    },
    {
      name: 'get_customer_360',
      description: `Retrieves comprehensive Customer 360 overview for a specific customer (profile, pipeline deals, payments, site visits, complaints, segment, health status), OR customer count, directory, and segmentation breakdown (New, Key Account, Growth) when customer_name is omitted.`,
      schema: z.object({
        customer_name: z.string().optional().nullable().describe('Optional name of customer or company (e.g. "Supreme Steel"). Omit to retrieve directory and segmentation stats.'),
        segment_filter: z.string().optional().nullable().describe('Optional segment filter: "all", "key_account", "growth", "new".'),
        limit: z.number().optional().nullable().describe('Maximum number of customer records (default: 50).'),
      }),
    }
  );

  const getMyOpenDealsTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetMyOpenDeals(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching deals: ${err.message}`;
      }
    },
    {
      name: 'get_my_open_deals',
      description: `Retrieves deals and confirmed orders (negotiations, quotations, won orders, or lost deals). Can filter by stage (e.g. stage_filter="won" for orders), customer name, date range, PO number, or delivery location. Supports modes: "invalid_delivery_locations" (flag bad/incomplete addresses), "highest_tonnage", and total items/tonnage metrics.`,
      schema: z.object({
        stage_filter: z.string().optional().nullable().describe('Optional filter by deal stage: "all", "won" (orders), "quoted", "negotiation", "review", "lost".'),
        customer_name: z.string().optional().nullable().describe('Optional customer name filter.'),
        po_number: z.string().optional().nullable().describe('Optional PO number filter.'),
        delivery_location: z.string().optional().nullable().describe('Optional delivery destination city.'),
        date_range: z.string().optional().nullable().describe('Optional date filter: "today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days", "this_month", "last_month", "all".'),
        mode: z.string().optional().nullable().describe('Query mode: "list", "highest_tonnage", "invalid_delivery_locations".'),
        limit: z.number().optional().nullable().describe('Maximum number of deals to return (default: 20).'),
      }),
    }
  );

  const getReorderQueueTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetReorderQueue(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching reorder queue: ${err.message}`;
      }
    },
    {
      name: 'get_reorder_queue',
      description: `Retrieves recurring customer reorder predictions, list of customers due for repeat orders, and average reorder cycle (cadence) analytics across all tracked customer accounts.`,
      schema: z.object({
        mode: z.string().optional().nullable().describe('Query mode: "list", "average_cycle" (calculates average reorder cycle and cadence distribution across all tracked accounts).'),
        max_results: z.number().optional().nullable().describe('Maximum number of records to return (default: 20).'),
      }),
    }
  );

  const getTeamPipelineTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetTeamPipeline(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching team pipeline: ${err.message}`;
      }
    },
    {
      name: 'get_team_pipeline',
      description: `Retrieves team-wide sales pipeline summary and sales rep conversion rankings (which rep converts the most inquiries into orders).`,
      schema: z.object({
        stage_filter: z.string().optional().nullable().describe('Optional deal stage filter.'),
        mode: z.string().optional().nullable().describe('Query mode: "pipeline_summary", "rep_conversion".'),
      }),
    }
  );

  const getChurnRadarTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetChurnRadar(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching churn radar: ${err.message}`;
      }
    },
    {
      name: 'get_churn_radar',
      description: `Identifies customer accounts at risk of churn based on order frequency, days since last order, and purchasing inactivity.`,
      schema: z.object({
        risk_level: z.string().optional().nullable().describe('Optional risk level: "high", "medium", "low".'),
      }),
    }
  );

  const getLossAnalyticsTool = tool(
    async (args) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetLossAnalytics(args, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching loss analytics: ${err.message}`;
      }
    },
    {
      name: 'get_loss_analytics',
      description: `Analyzes lost deals, common loss reasons, total lost revenue, and lost deal trends.`,
      schema: z.object({
        timeframe_days: z.number().optional().nullable().describe('Optional timeframe in days (e.g. 30, 90).'),
      }),
    }
  );

  const getDealIdsTool = tool(
    async ({ company_name, customer_name }) => {
      try {
        const target = company_name || customer_name || '';
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeGetDealIds({ company_name: target }, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error fetching deal IDs: ${err.message}`;
      }
    },
    {
      name: 'get_deal_ids',
      description: `Use this tool when the salesperson asks for the Inquiry ID(s) or inquiry code(s) for a company (e.g. "What is the inquiry ID for Radhe Ispat?", "Inquiry ID for Apex Steel", "Give me inquiry ID", "Inquiry ID", "Deal ID").`,
      schema: z.object({
        company_name: z.string().optional().nullable().describe('The customer/company name if mentioned, else null'),
        customer_name: z.string().optional().nullable().describe('Customer name alias'),
      }),
    }
  );

  const searchKnowledgeBaseTool = tool(
    async ({ query }) => {
      try {
        const caller = await resolveCallerContext(senderPhone);
        const res = await executeSearchKnowledgeBase({ query }, caller);
        return JSON.stringify(res.data, null, 2);
      } catch (err) {
        return `Error searching knowledge base: ${err.message}`;
      }
    },
    {
      name: 'search_knowledge_base',
      description: `Searches company Knowledge Base documents (SOPs, product specifications, steel grade tables, discount policies, MOQ, and quotation validity).`,
      schema: z.object({
        query: z.string().describe('The search query or policy question to look up in the Knowledge Base.'),
      }),
    }
  );

  const queryMyDataTool = tool(
    async ({ text, query }) => {
      try {
        const effectiveText = text || query || rawUserText;
        return await getQueryHandler().handleQuery(effectiveText, senderPhone);
      } catch (err) {
        return `Error fetching data: ${err.message}`;
      }
    },
    {
      name: 'query_my_data',
      description: `Use this tool when the salesperson is ASKING for information about deals, customers, visits, complaints, payments, KRA metrics, or general data.`,
      schema: z.object({
        text: z.string().optional().nullable().describe('The query question from the salesperson'),
        query: z.string().optional().nullable().describe('Alias for query text'),
      }),
    }
  );

  return [
    // Operational Write Tools
    updateDealStageTool,
    logCustomerVisitTool,
    sendQuotationTool,
    logPaymentTool,
    logComplaintTool,
    logRetentionFollowupTool,
    onboardNewCustomerTool,
    updateCustomerProfileTool,
    processSalesImageTool,
    processPaymentImageTool,

    // Data Retrieval & Intelligence Tools
    getInquiriesTool,
    getVisitsTool,
    getComplaintsTool,
    getCustomer360Tool,
    getMyOpenDealsTool,
    getReorderQueueTool,
    getTeamPipelineTool,
    getChurnRadarTool,
    getLossAnalyticsTool,
    getDealIdsTool,
    searchKnowledgeBaseTool,
    queryMyDataTool,
    getContextTool,
  ];
}

module.exports = { createTools };
