/**
 * catalogFlow.js - Guided Catalog & Interactive Conversational Forms for WhatsApp Bot
 *
 * Implements:
 * 1. Greeting Detection & 9-Option Menu
 * 2. 1-9 & Keyword Action Routing
 * 3. Structured Data Collection for Inquiries, Orders, Field Visits, Complaints
 * 4. AI-Powered Free-Form Field Extraction, Multi-Product Parsing & Date Normalization
 * 5. Multi-Turn Clarification & Missing Field Prompts
 * 6. Interactive Confirmation Summary (Yes / Edit / Cancel) State Machine
 * 7. Clean Database Execution into Supabase (Inquiries, Deals, Customer Visits, Complaints)
 *    - Strict Schema Compatibility with Enlight Sales OS Frontend (Company Name, Rate, & Line Items)
 */

const { invokeWithFallback } = require('./modelRouter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  supabase,
  saveActiveSession,
  getFullActiveSession,
  ensureCustomerRecord,
  verifyAndGetCustomerName,
  getAssignedCustomersList,
  normalizeCoreCompanyName,
  getAccessibleSalespersonPhonesForBot,
  expandPhoneVariants,
  isPhoneInScope,
  getCustomProductsList,
  getCachedCustomProducts,
  createCustomProductRecord,
  procurementStampForSalesperson,
} = require('../supabase');
const {
  nextVisitPrompts,
  assertReadyToSave,
  visitRowColumns,
  requestVisitCode,
  verifyVisitCode,
  consumeVisitCode,
  releaseVisitCode,
  fillVisitCity,
  attachVisitMedia,
} = require('./visitRequirements');
const {
  customerTargetNote,
  prematureUpdateReply,
  orderRateReply,
  isSalesPriceText,
  isFullPriceEntry,
  isBareAddPriceChoice,
  handleSalesPriceChat,
  handleFullSalesPrice,
} = require('./salesPriceFlow');
const {
  detectHsnCode,
  normalizeProductToCatalog,
  isValidCatalogProduct,
  getUnknownProductClarificationMessage,
  MASTER_PRODUCTS_CATALOG,
  extractThickness,
  extractHeight,
} = require('../utils/hsnDetector');
const {
  calculateQuotationBreakdown,
  normalizeUnit,
  convertLineItemToMt,
  calculateLineItem,
  calculateLineItems,
} = require('../utils/pricingEngine');
const {
  ensureDraftSystemPo,
  resolveFinalPo,
  claimPoNumber,
  releasePoReservation,
} = require('./poResolver');
const {
  startNewCatalogSession,
  recordSessionMessage,
  finalizeCurrentSession,
  getSessionEnvelope,
} = require('./sessionManager');
const { logBotActivity } = require('../utils/activityLogger');
const { safeParseJSON } = require('../utils/jsonUtils');

function cleanPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function getPhoneVariants(phone) {
  if (!phone) return [];
  const clean = String(phone).replace(/\D/g, '');
  const variants = new Set();
  if (clean.length === 10) {
    variants.add(clean);
    variants.add(`91${clean}`);
    variants.add(`+91${clean}`);
  } else if (clean.length === 12 && clean.startsWith('91')) {
    variants.add(clean);
    variants.add(clean.slice(2));
    variants.add(`+${clean}`);
  } else {
    variants.add(clean);
  }
  return Array.from(variants);
}

function extractPhotoAndGps(rawText, options = {}) {
  let photoDataUrl = null;
  const mimeType = options.imageMimeType || options.mimeType || options.image?.mimeType || options.type || 'image/jpeg';

  if (options.photoDataUrl) {
    photoDataUrl = options.photoDataUrl;
  } else if (options.url) {
    photoDataUrl = options.url;
  } else if (options.image && options.image.base64) {
    const base64Clean = options.image.base64.replace(/^data:image\/\w+;base64,/, '');
    photoDataUrl = options.image.base64.startsWith('data:')
      ? options.image.base64
      : `data:${mimeType};base64,${base64Clean}`;
  } else if (options.imageBuffer) {
    photoDataUrl = `data:${mimeType};base64,${options.imageBuffer.toString('base64')}`;
  }

  let gpsData = null;
  if (options.gps && typeof options.gps.latitude === 'number' && typeof options.gps.longitude === 'number') {
    gpsData = {
      latitude: options.gps.latitude,
      longitude: options.gps.longitude,
      accuracy: typeof options.gps.accuracy === 'number' ? options.gps.accuracy : null,
    };
  } else if (typeof rawText === 'string') {
    const gpsMatch = rawText.match(/\[GPS:\s*([-+]?\d*\.?\d+),\s*([-+]?\d*\.?\d+)(?:\s*\(accuracy:\s*±?(\d+)m\))?\]/i);
    if (gpsMatch) {
      gpsData = {
        latitude: parseFloat(gpsMatch[1]),
        longitude: parseFloat(gpsMatch[2]),
        accuracy: gpsMatch[3] ? parseInt(gpsMatch[3], 10) : null,
      };
    }
  }

  let attachmentObj = null;
  if (photoDataUrl) {
    const isPdf = (mimeType || '').includes('pdf');
    attachmentObj = {
      name: options.name || options.fileName || `attachment-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`,
      url: photoDataUrl,
      type: mimeType,
      uploaded_at: new Date().toISOString(),
      ...(gpsData ? { gps: gpsData } : {}),
    };
  }

  const incomingAttachments = Array.isArray(options.attachments) && options.attachments.length > 0
    ? options.attachments
    : (attachmentObj ? [attachmentObj] : []);

  return { photoDataUrl, gpsData, attachmentObj: incomingAttachments[0] || attachmentObj, incomingAttachments };
}

async function persistComplaintAttachments(attachments, senderPhone) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const bucket = 'complaint-evidence';
  const phonePart = String(senderPhone || 'unknown').replace(/\D/g, '').slice(-10) || 'unknown';
  return Promise.all(attachments.slice(0, 3).map(async (attachment, index) => {
    const source = attachment.file_url || attachment.url || '';
    const dataMatch = String(source).match(/^data:([^;]+);base64,(.+)$/s);
    if (!dataMatch) return attachment;

    const mimeType = attachment.file_type || attachment.type || dataMatch[1] || 'application/octet-stream';
    const extension = mimeType.includes('pdf') ? 'pdf' : mimeType.split('/')[1] || 'bin';
    const storagePath = `complaints/${phonePart}/${Date.now()}-${index}.${extension}`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, Buffer.from(dataMatch[2], 'base64'), {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Failed to store complaint evidence: ${error.message}`);
    }

    return {
      ...attachment,
      url: storagePath,
      file_url: storagePath,
      storage_path: storagePath,
    };
  }));
}

const CATALOG_MENU = `👋 Welcome to **SalesOS Assistant**!

What would you like to do today?

1. **Log New Inquiry**
2. **Update Inquiry**
3. **Log New Order**
4. **Update Order**
5. **Add Price to Inquiry**
6. **Log Customer Field Visit**
7. **Update Field Visit**
8. **New Customer Acquisition**
9. **Log Customer Complaint**
10. **Update Customer Complaint**
11. **Other / General Query**

Reply with a number (1–11), or type what you'd like to do.`;

const CONFIRMATION_BUTTONS = [
  { id: 'btn_confirm_yes', title: 'Save / Yes' },
  { id: 'btn_confirm_edit', title: 'Edit Details' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const DISCARD_DRAFT_BUTTONS = [
  { id: 'btn_confirm_cancel', title: 'Discard Draft' },
];

const NON_EDITABLE_REPLY_BUTTONS = [
  { id: 'btn_confirm_edit', title: 'Edit Details' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const NEW_CUSTOMER_BUTTONS = [
  { id: 'btn_cust_yes', title: 'Yes, Add Customer' },
  { id: 'btn_cust_no', title: 'No / Cancel' },
];

const CUST_MATCH_BUTTONS = [
  { id: 'btn_confirm_yes', title: 'Yes' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const UNKNOWN_PRODUCT_BUTTONS = [
  { id: 'btn_add_product', title: 'Add Product' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const ADD_PRODUCT_CONFIRM_BUTTONS = [
  { id: 'btn_prod_save', title: 'Save Product' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

const RESUME_QUERY_BUTTONS = [
  { id: 'btn_resume_yes', title: 'Yes, Continue' },
  { id: 'btn_resume_no', title: 'No, Go to Menu' },
];

const STAGE_UPDATE_RESUME_BUTTONS = [
  { id: 'btn_resume_yes', title: 'Yes, Continue' },
  { id: 'btn_resume_no', title: 'Cancel' },
];

const ATTACHMENT_PROMPT_BUTTONS = [
  { id: 'btn_att_no', title: 'No' },
];

const DIRECT_ORDER_BUTTONS = [
  { id: 'log_order_direct', title: 'Create directly' },
];

const DIRECT_ORDER_PROMPT = `🛒 *Record New Order*

No Inquiry available - Create Order Directly

Send the order in your own words, or send the PO document (photo or PDF).

*Required:*
• *Company Name*
• *PO Number*
• *PO Date*
• *Delivery Location*
• *Payment Terms*
• *Line Items* (Product, Quantity, Rate)

You can send some of these now. I will ask only for what is still missing.`;

function isDirectOrderRequest(text) {
  const clean = String(text || '').toLowerCase().replace(/[!.,?*]/g, '').replace(/\s+/g, ' ').trim();
  return (
    clean === 'log_order_direct' ||
    clean === 'create directly' ||
    clean === 'no inquiry available - create order directly' ||
    clean === 'no inquiry available create order directly'
  );
}

function catalogSelectionResult(selectionRes) {
  const result = { handled: true, reply: selectionRes.reply };
  if (selectionRes && selectionRes.interactiveButtons) {
    result.interactiveType = 'buttons';
    result.interactiveButtons = selectionRes.interactiveButtons;
  }
  return result;
}

async function beginDirectOrder(senderPhone, sourceChannel) {
  const draft = { _direct_order: true };
  if (sourceChannel) draft.source_channel = sourceChannel;
  await ensureDraftSystemPo(
    draft,
    `catalog-direct:${senderPhone}:${Date.now()}`,
  );
  const prompt = `${DIRECT_ORDER_PROMPT}\n\n🔢 *System PO Number:* ${draft.po_number}\n_This number is generated automatically and can be edited before confirmation._`;
  await recordSessionMessage(senderPhone, 'user', 'Create directly');
  await startNewCatalogSession(senderPhone, prompt);
  await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: 'LOG_ORDER' });
  await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
  return { handled: true, reply: prompt };
}

function isComplaintAttachmentSkip(text, draft) {
  const clean = String(text || '').trim();
  return draft?._attachments_asked === true &&
    /^(?:btn_att_no|no|nah|none|no\s*photos?|no\s*evidence|skip|done|proceed|next|nahi)\b/i.test(clean);
}

function getPostActivityButtons(action, draft) {
  switch (action) {
    case 'LOG_COMPLAINT':
      return [
        { id: 'btn_repeat_log_complaint', title: 'Log Another Complaint' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_COMPLAINT':
      return [
        { id: 'btn_repeat_update_complaint', title: 'Update Complaint' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_VISIT':
      return [
        { id: 'btn_repeat_log_visit', title: 'Log Another Visit' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_VISIT':
      return [
        { id: 'btn_repeat_update_visit', title: 'Update Another Visit' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_INQUIRY': {
      const number = draft?.procurement_number;
      return [
        { id: 'btn_repeat_log_inquiry', title: 'Log Another Inquiry' },
        { id: number ? `btn_price_current|${number}` : 'btn_price_current', title: 'Price This Inquiry' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    }
    case 'UPDATE_INQUIRY':
      return [
        { id: 'btn_repeat_update_inquiry', title: 'Update Another Inq' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_ORDER':
      return [
        { id: 'btn_repeat_log_order', title: 'Record Another Order' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'UPDATE_ORDER':
      return [
        { id: 'btn_repeat_update_order', title: 'Update Another Order' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    case 'LOG_NEW_CUSTOMER':
      return [
        { id: 'btn_repeat_log_new_customer', title: 'Onboard Another' },
        { id: 'btn_post_menu', title: 'Menu' },
      ];
    default:
      return [
        { id: 'btn_post_menu', title: 'Menu' },
      ];
  }
}

/**
 * Parses a money value such as 55000, "55,000", "₹1,25,000/-", "Rs. 52000 per MT",
 * "1.5 lakh", "2 crore" or "55k". Returns null when no number is present, so callers
 * can tell a real 0 apart from a missing value.
 */
function parseIndianAmount(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).toLowerCase().replace(/₹|\brs\b\.?|\binr\b|\/-/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  let num = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unitMatch = s.slice(m.index + m[0].length).match(/^\s*(lakhs?|lacs?|crores?|thousand|k)(?![a-z])/);
  const unit = unitMatch ? unitMatch[1] : '';
  if (unit.startsWith('lakh') || unit.startsWith('lac')) num *= 100000;
  else if (unit.startsWith('crore')) num *= 10000000;
  else if (unit === 'k' || unit === 'thousand') num *= 1000;
  return Math.round(num * 100) / 100;
}

/** Parses a plain numeric value such as 10, "10 MT" or "1,000". Returns null when absent. */
function parseNumericValue(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value).match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const num = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

/**
 * Builds the "Total Tonnage" text for a list of line items.
 * Same unit everywhere → plain sum in that unit. MT/KG mix → converted to MT.
 * Anything else that cannot be converted → per-unit totals ("10 MT + 50 Pcs").
 */
function formatLineItemsTonnage(items) {
  const list = (Array.isArray(items) ? items : []).filter(it => (parseNumericValue(it?.quantity) || 0) > 0);
  if (list.length === 0) return '';
  const round = (n) => Math.round(n * 1000) / 1000;
  const units = list.map(it => normalizeUnit(it.unit || 'MT'));
  if (units.every(u => u === units[0])) {
    const sum = list.reduce((s, it) => s + (parseNumericValue(it.quantity) || 0), 0);
    return `${round(sum).toLocaleString('en-IN')} ${list[0].unit || 'MT'}`;
  }
  if (units.every(u => u === 'MT' || u === 'KG')) {
    const mt = list.reduce((s, it) => s + convertLineItemToMt({ ...it, quantity: parseNumericValue(it.quantity) || 0 }), 0);
    return `${round(mt).toLocaleString('en-IN')} MT`;
  }
  const byUnit = new Map();
  list.forEach((it, i) => {
    const u = units[i];
    const label = u === 'MT' || u === 'KG' ? 'MT' : (it.unit || u);
    const qty = u === 'MT' || u === 'KG'
      ? convertLineItemToMt({ ...it, quantity: parseNumericValue(it.quantity) || 0 })
      : (parseNumericValue(it.quantity) || 0);
    byUnit.set(label, (byUnit.get(label) || 0) + qty);
  });
  return Array.from(byUnit.entries()).map(([u, q]) => `${round(q).toLocaleString('en-IN')} ${u}`).join(' + ');
}

// executeAction reports database write failures with these prefixes; "not found" style
// replies are intentionally not treated as retryable failures.
/**
 * True when remarks say the follow-up was actually completed ("quote sent", "done").
 * Negated phrases ("not done", "quote not sent yet", "done nahi hua", "yet to be completed") do not count.
 */
function isAffirmativeCompletionRemark(text) {
  const s = String(text || '').toLowerCase();
  const completionRe = /\b(?:quote sent|quotation sent|sent quote|sent official price quotation|po received|order placed|resolved|done|completed)\b/g;
  const negBefore = /\b(?:not|no|never|yet\s+to(?:\s+be)?|still\s+not|pending|isn'?t|is\s+not|hasn'?t(?:\s+been)?|has\s+not(?:\s+been)?|haven'?t(?:\s+been)?|have\s+not(?:\s+been)?|wasn'?t|was\s+not|didn'?t|did\s+not|don'?t|do\s+not|without)\s+(?:yet\s+|been\s+|be\s+|fully\s+|properly\s+)*$/;
  const negAfter = /^\s*(?:yet\s+)?(?:nahi|nahin|nai|not|na)\b/;
  let m;
  while ((m = completionRe.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 40), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 15);
    if (negBefore.test(before) || negAfter.test(after)) continue;
    return true;
  }
  return false;
}

const VALID_DEAL_STAGES = ['new_inquiry', 'review', 'quoted', 'negotiation', 'on_hold', 'won', 'lost'];

/** Returns the canonical deal stage key for a raw stage value, or null if it is not a pipeline stage. */
function normalizeDealStageKey(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return VALID_DEAL_STAGES.includes(key) ? key : null;
}

/**
 * Maps an order status update to { stage, fulfillment }.
 * Delivery progress (pending / processing / dispatched / delivered) never becomes a deal stage.
 */
function mapOrderStatusUpdate(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return { stage: null, fulfillment: null };
  if (/\bpo\s+received\b/.test(s)) return { stage: 'won', fulfillment: null };
  if (/\b(?:delivered|delivery\s+(?:done|completed))\b/.test(s) && !/\b(?:not|pending|yet\s+to)\b|\bundelivered\b/.test(s)) {
    return { stage: null, fulfillment: 'delivered' };
  }
  if (/\b(?:dispatch(?:ed)?|shipped|in\s+transit|transit)\b/.test(s)) return { stage: null, fulfillment: 'dispatched' };
  if (/\bprocessing\b|\bin\s+process\b|\bin\s+production\b/.test(s)) return { stage: null, fulfillment: 'processing' };
  if (/^pending\b/.test(s)) return { stage: null, fulfillment: 'pending' };
  if (s.includes('won') || s.includes('order') || s.includes('confirm')) return { stage: 'won', fulfillment: null };
  if (s.includes('lost') || s.includes('cancel')) return { stage: 'lost', fulfillment: null };
  if (s.includes('negot')) return { stage: 'negotiation', fulfillment: null };
  if (s.includes('hold')) return { stage: 'on_hold', fulfillment: null };
  if (s.includes('quote') || s.includes('price')) return { stage: 'quoted', fulfillment: null };
  return { stage: normalizeDealStageKey(raw), fulfillment: null };
}

/** True when a general rate is just a repeat of a rate already given on a specific line item. */
function isGeneralRateDuplicateOfLineRate(generalRate, lineUpdates) {
  const general = parseIndianAmount(generalRate);
  if (!(general > 0) || !Array.isArray(lineUpdates)) return false;
  return lineUpdates.some(upd => parseIndianAmount(upd && upd.rate) === general);
}

function isExecutionFailureReply(reply) {
  if (typeof reply !== 'string') return false;
  return /^\s*(?:[❌⚠️]\s*)?\*?(?:Failed to\b|An error occurred while saving\b|Order Cannot Be Created\b|Order Already Recorded\b|Inquiry Not Found or Inaccessible\b|Customer Already\b)/i.test(reply);
}

const RECENT_SAVE_WINDOW_MS = 15 * 1000;
const recentConfirmedSaves = new Map();
function markRecentConfirmedSave(senderPhone) {
  if (!senderPhone) return;
  const now = Date.now();
  for (const [phone, time] of recentConfirmedSaves.entries()) {
    if (now - time > RECENT_SAVE_WINDOW_MS) recentConfirmedSaves.delete(phone);
  }
  recentConfirmedSaves.set(String(senderPhone), now);
}
function isRecentConfirmedSave(senderPhone) {
  const time = recentConfirmedSaves.get(String(senderPhone || ''));
  return Boolean(time && Date.now() - time <= RECENT_SAVE_WINDOW_MS);
}
const SAVE_CONFIRM_WORDS = new Set([
  'btn_confirm_yes', 'save / yes', 'save/yes', 'yes', 'y', '1', 'confirm', 'save', 'haan', 'sahi hai', 'ok', 'sure',
]);

// ── INACTIVE DRAFT & STALE BUTTON TRACKING ──────────────────────────────────
const lastInactiveDraftMetadata = new Map();

function releaseOrderDraftPoReservation(action, draft, status) {
  const d = (typeof draft === 'object' && draft !== null) ? draft : {};
  const isOrderDraft =
    action === 'LOG_ORDER' ||
    action === 'UPDATE_ORDER' ||
    d._direct_order === true;
  const token = d.po_reservation_token;
  if (!isOrderDraft || !token || status === 'saved') return;

  const poNumber = d.generated_po_number || d.po_number;
  void releasePoReservation(token, poNumber, d.deal_id || d.order_id)
    .catch(error => {
      console.error('[SystemPO] Bot order draft release failed', {
        action,
        reservationToken: token,
        poNumber,
        dealId: d.deal_id || d.order_id || null,
        error,
      });
    });
}

function recordInactiveDraft(senderPhone, action, draft, status = 'discarded') {
  if (!senderPhone) return;
  const canonicalPhone = cleanPhone(senderPhone);
  const d = (typeof draft === 'object' && draft !== null) ? draft : {};
  releaseOrderDraftPoReservation(action || d._action, d, status);
  lastInactiveDraftMetadata.set(canonicalPhone, {
    action: action || d._action || null,
    draft: d,
    status: status || 'discarded',
    company_name: d.company_name || d.customer_name || null,
    inquiry_id: d.inquiry_id || d.deal_id || null,
    po_number: d.po_number || null,
    order_id: d.order_id || null,
    complaint_id: d.complaint_id || null,
    visit_id: d.visit_id || null,
    timestamp: Date.now(),
  });
}

function getModuleCatalogName(action) {
  switch (action) {
    case 'LOG_INQUIRY': return 'Log New Inquiry';
    case 'UPDATE_INQUIRY': return 'Update Inquiry';
    case 'LOG_ORDER': return 'Log New Order';
    case 'UPDATE_ORDER': return 'Update Order';
    case 'LOG_VISIT': return 'Log Field Visit';
    case 'UPDATE_VISIT': return 'Update Field Visit';
    case 'LOG_NEW_CUSTOMER': return 'Log New Customer';
    case 'LOG_COMPLAINT': return 'Log Complaint';
    case 'UPDATE_COMPLAINT': return 'Update Complaint';
    default: return 'the relevant activity';
  }
}

function formatDraftContextLabel(meta) {
  if (!meta) return '';
  let id = meta.inquiry_id || meta.po_number || meta.order_id || meta.complaint_id || meta.visit_id || meta.deal_id;
  if (id && meta.action === 'UPDATE_INQUIRY' && !String(id).toUpperCase().startsWith('INQ-')) {
    id = `INQ-${String(id).toUpperCase()}`;
  }
  const company = meta.company_name;

  if (id && company) {
    return `for ${id} (${company})`;
  } else if (id) {
    return `for ${id}`;
  } else if (company) {
    return `for ${company}`;
  }
  return '';
}

async function getLastInactiveDraft(senderPhone) {
  if (!senderPhone) return null;
  const canonicalPhone = cleanPhone(senderPhone);
  const mem = lastInactiveDraftMetadata.get(canonicalPhone);
  if (mem) {
    return mem;
  }
  try {
    const envelope = await getSessionEnvelope(senderPhone);
    if (envelope && envelope.last_completed_activity) {
      const act = envelope.last_completed_activity;
      const isDiscarded = Boolean(
        act.summary && (
          act.summary.toLowerCase().includes('cancelled') ||
          act.summary.toLowerCase().includes('discarded')
        )
      );
      return {
        action: act.action_type || null,
        draft: act.extracted_data || {},
        status: isDiscarded ? 'discarded' : 'saved',
        company_name: act.customer_name || null,
        inquiry_id: act.inquiry_id || act.deal_id || null,
        po_number: act.po_number || null,
        timestamp: act.completed_at ? new Date(act.completed_at).getTime() : Date.now(),
      };
    }
  } catch (err) {
    // Ignore error
  }
  return null;
}

const STALE_CONFIRM_ACTIONS = new Set([
  'btn_confirm_yes',
  'btn_cust_yes',
  'btn_add_product',
  'btn_prod_save',
  'save / yes',
  'save/yes',
  'save yes',
  'save changes',
  'confirm',
  'save',
  'yes',
  'y',
  'haan',
  'sahi hai',
]);

const STALE_EDIT_ACTIONS = new Set([
  'btn_confirm_edit',
  'edit details',
  'edit',
  'change details',
  'modify details',
  'modify',
  'change',
  'update',
]);

const STALE_DISCARD_ACTIONS = new Set([
  'btn_confirm_cancel',
  'btn_flow_discard',
  'btn_cust_no',
  'discard draft',
  'cancel draft',
]);

const STALE_RESUME_YES_ACTIONS = new Set([
  'btn_resume_yes',
  'yes, continue',
  'yes continue',
]);

const STALE_RESUME_NO_ACTIONS = new Set([
  'btn_resume_no',
  'btn_post_menu',
  'no, go to menu',
  'no go to menu',
]);

function isStaleDraftButtonAction(cleanInput) {
  if (!cleanInput) return false;
  return (
    STALE_CONFIRM_ACTIONS.has(cleanInput) ||
    STALE_EDIT_ACTIONS.has(cleanInput) ||
    STALE_DISCARD_ACTIONS.has(cleanInput) ||
    STALE_RESUME_YES_ACTIONS.has(cleanInput)
  );
}

function isStaleResumeNoAction(cleanInput) {
  if (!cleanInput) return false;
  return STALE_RESUME_NO_ACTIONS.has(cleanInput);
}

async function handleStaleDraftButton(text, senderPhone, canUpdateVisits) {
  const meta = await getLastInactiveDraft(senderPhone);
  const userMenu = getCatalogMenu(canUpdateVisits);
  const userSections = getCatalogMenuSections(canUpdateVisits);

  let explanation = '';
  if (meta && meta.timestamp && (Date.now() - meta.timestamp <= 48 * 60 * 60 * 1000)) {
    const contextLabel = formatDraftContextLabel(meta);
    const targetModule = getModuleCatalogName(meta.action);
    if (meta.status === 'saved') {
      explanation = contextLabel
        ? `This draft ${contextLabel} was already saved. To make further changes, please start again with ${targetModule}.`
        : `This draft was already saved. To make further changes, please start again with ${targetModule}.`;
    } else {
      explanation = contextLabel
        ? `This draft ${contextLabel} was already discarded, so nothing was saved. To make these changes, please start again with ${targetModule}.`
        : `This draft was already discarded, so nothing was saved. To make these changes, please start again with ${targetModule}.`;
    }
  } else {
    explanation = `This draft was already discarded or expired, so nothing was saved. To make these changes, please start again with the relevant activity.`;
  }

  const fullReply = `${explanation}\n\nHere is the menu to start a new activity:\n\n${userMenu}`;
  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'CATALOG_MENU' });

  return {
    handled: true,
    reply: fullReply,
    interactiveType: 'list',
    interactiveList: {
      bodyText: 'Here is the menu to start a new activity:',
      buttonText: 'Choose Action',
      sections: userSections,
    },
  };
}

async function handleResumeMenuButton(text, senderPhone, canUpdateVisits) {
  const userMenu = getCatalogMenu(canUpdateVisits);
  const userSections = getCatalogMenuSections(canUpdateVisits);
  const fullReply = `Activity cancelled.\n\n${userMenu}`;
  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'CATALOG_MENU' });

  return {
    handled: true,
    reply: fullReply,
    interactiveType: 'list',
    interactiveList: {
      bodyText: 'Here is the menu to start a new activity:',
      buttonText: 'Choose Action',
      sections: userSections,
    },
  };
}

function buildDuplicateCustomerResponse(message) {
  return {
    handled: true,
    reply: message,
    interactiveType: 'buttons',
    interactiveButtons: DISCARD_DRAFT_BUTTONS,
  };
}

function isDiscardOrCancelIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

  // 1. Exact button IDs & single-phrase control commands
  const exactCancelWords = new Set([
    'btn_confirm_cancel',
    'btn_cust_no',
    'btn_flow_discard',
    'cancel',
    'discard',
    'stop',
    'exit',
    'quit',
    'abort',
    'drop',
    'skip',
    'nahi',
    'galat',
    'no',
    'no cancel',
    'discard draft',
    'cancel draft',
    'discard activity',
    'cancel activity',
    'discard complaint',
    'cancel complaint',
    'discard order',
    'cancel order',
    'discard inquiry',
    'cancel inquiry',
    'discard visit',
    'cancel visit',
    'cancel logging',
    'discard logging',
    'skip remaining',
    'discard remaining',
    'cancel remaining',
    'cancel this',
    'discard this',
    'cancel it',
    'discard it',
    'cancel now',
    'discard now',
    'mat karo',
    'nahi chahiye',
    'nahi karna',
    'cancel kar do',
    'discard kar do',
    'cancel karo',
    'discard karo',
  ]);

  if (exactCancelWords.has(clean)) {
    return true;
  }

  // 2. Strict start-to-end command patterns (where the entire intent of the message is cancellation)
  const fullCommandPatterns = [
    /^(?:please\s+)?(?:cancel|discard|abort|drop|stop|quit|clear)\s+(?:this\s+)?(?:draft|inquiry|order|visit|complaint|flow|activity|form|session|process|entry|logging|creation|action)\s*$/i,
    /^(?:please\s+)?(?:cancel|discard|abort|drop|stop|quit)\s+(?:it|this|that|all|now|please)\s*$/i,
    /^(?:i\s+)?(?:don\s*t|dont|do\s+not)\s+want\s+to\s+(?:log|create|save|record|continue|proceed|enter)(?:\s+(?:this|it|anymore))?\s*$/i,
    /^(?:never\s+mind|leave\s+it|forget\s+it|drop\s+it)\s*$/i,
    /^(?:cancel|discard)\s+kar\s*(?:do|de|diya|dena)?\s*$/i,
    /^(?:mat\s+karo|nahi\s+karna\s+hai|nahi\s+chahiye|band\s+karo)\s*$/i,
  ];

  for (const pattern of fullCommandPatterns) {
    if (pattern.test(clean)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a candidate option index (1-based integer) from anywhere within natural language text.
 * Supports:
 * - "option 1", "opt 1", "choice 2", "no. 1", "#1", "in option 1", "for option 2"
 * - "1st option", "2nd one", "3rd inquiry", "1st", "2nd", "3rd", "10th"
 * - "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "last"
 * - Standalone "1", "1.", "1)", "1️⃣"
 */
const MONTH_WORD_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * True when the number found at [start, end) in text reads as a calendar day
 * ("on 15th", "15th Oct", "15 Sept", "15-09-2026") rather than a menu option.
 */
function isDateLikeNumberAt(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const rest = after.replace(/^\s*(?:st|nd|rd|th)?\s*(?:of\s+)?/i, '');
  if (new RegExp(`^${MONTH_WORD_PATTERN}\\b`, 'i').test(rest)) return true;
  if (/^[-/.]\d/.test(after)) return true;
  if (/\b(?:on|by|till|until|before|after|from|dated?|next|this|coming|due|kal|follow[\s-]?up(?:\s+(?:on|by|date))?|followup(?:\s+(?:on|by|date))?)\s+(?:the\s+)?$/i.test(before)) return true;
  return false;
}

function extractCandidateIndex(text, candidateCount = 10) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  // Pattern 1: Explicit "option 1", "opt 1", "choice 2", "no. 1", "#1", "in option 1", "for option 2" anywhere in text
  const optMatch = clean.match(/\b(?:in\s+|for\s+|from\s+|of\s+)?(?:option|opt|choice|no\.?|number|#|item|row)\s*([1-9]\d*)\b/i);
  if (optMatch) {
    const idx = parseInt(optMatch[1], 10);
    if (idx >= 1 && idx <= candidateCount) return idx;
  }

  // Pattern 2: "1st option", "2nd one", "3rd inquiry", "1st", "2nd", "3rd", "10th"
  const ordMatch = clean.match(/\b([1-9]\d*)\s*(?:st|nd|rd|th)\b/i);
  if (ordMatch && !isDateLikeNumberAt(clean, ordMatch.index, ordMatch.index + ordMatch[1].length)) {
    const idx = parseInt(ordMatch[1], 10);
    if (idx >= 1 && idx <= candidateCount) return idx;
  }

  // Pattern 3: English ordinals up to 10th
  const wordOrdinals = {
    first: 1,
    '1st': 1,
    second: 2,
    '2nd': 2,
    third: 3,
    '3rd': 3,
    fourth: 4,
    '4th': 4,
    fifth: 5,
    '5th': 5,
    sixth: 6,
    '6th': 6,
    seventh: 7,
    '7th': 7,
    eighth: 8,
    '8th': 8,
    ninth: 9,
    '9th': 9,
    tenth: 10,
    '10th': 10,
    last: candidateCount,
  };
  for (const [word, val] of Object.entries(wordOrdinals)) {
    const wordRegex = new RegExp(`\\b(?:in\\s+|for\\s+|from\\s+|of\\s+)?(?:the\\s+)?${word}\\s*(?:option|choice|inquiry|order|visit|complaint|deal|one|item|row)?\\b`, 'i');
    const wordMatch = wordRegex.exec(clean);
    if (wordMatch && val <= candidateCount) {
      if (/^\d/.test(word)) {
        const numStart = wordMatch.index + wordMatch[0].toLowerCase().indexOf(word);
        const digitsLen = word.match(/^\d+/)[0].length;
        if (isDateLikeNumberAt(clean, numStart, numStart + digitsLen)) continue;
      }
      return val;
    }
  }

  // Pattern 4: Standalone / start-of-line number ("1", "1.", "1)", "1 -", "#1", "1️⃣")
  // Do NOT treat explicit menu commands/titles (e.g. "2. Update Inquiry", "menu_2") as candidate indexes!
  if (isExplicitMenuSelection(clean, true)) {
    return null;
  }

  const cleanKeycap = clean.replace(/([1-9]|10)️⃣/g, '$1');
  const startNumMatch = cleanKeycap.match(/^\s*(?:option\s*|no\.?\s*|#\s*)?([1-9]\d*)\s*(?:[.)\-:\s]|$)/i);
  if (startNumMatch) {
    const numStart = startNumMatch.index + startNumMatch[0].indexOf(startNumMatch[1]);
    if (!isDateLikeNumberAt(cleanKeycap, numStart, numStart + startNumMatch[1].length)) {
      const idx = parseInt(startNumMatch[1], 10);
      if (idx >= 1 && idx <= candidateCount) return idx;
    }
  }

  return null;
}

/**
 * Detects if the user entered an out-of-bounds numeric option (e.g. user typed Option 8 when only 3 options exist).
 */
function detectOutOfBoundsCandidateIndex(text, candidateCount = 10) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  const optMatch = clean.match(/\b(?:in\s+|for\s+|from\s+|of\s+)?(?:option|opt|choice|no\.?|number|#|item|row)\s*([1-9]\d*)\b/i);
  if (optMatch) {
    const idx = parseInt(optMatch[1], 10);
    if (idx > candidateCount) return idx;
  }

  const cleanKeycap = clean.replace(/([1-9]|10)️⃣/g, '$1');
  const startNumMatch = cleanKeycap.match(/^\s*(?:option\s*|no\.?\s*|#\s*)?([1-9]\d*)\s*(?:[.)\-:\s]|$)/i);
  if (startNumMatch) {
    const numStart = startNumMatch.index + startNumMatch[0].indexOf(startNumMatch[1]);
    const idx = parseInt(startNumMatch[1], 10);
    if (idx > candidateCount && !isDateLikeNumberAt(cleanKeycap, numStart, numStart + startNumMatch[1].length)) return idx;
  }

  return null;
}

/**
 * Detects if the user requested pagination ("view more", "more", "next", "page 2", etc.)
 */
function isPaginationRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim();
  return (
    clean === 'view more' ||
    clean === 'more' ||
    clean === 'view more records' ||
    clean === 'show more' ||
    clean === 'next' ||
    clean === 'next page' ||
    clean === 'page 2' ||
    clean === 'page 3' ||
    clean === 'load more' ||
    clean === 'see more' ||
    clean === 'aur dikhao' ||
    clean === 'agla page' ||
    clean === 'btn_next_customers' ||
    clean === 'next 10 customers' ||
    clean === 'next 10' ||
    clean === 'next customers' ||
    clean === 'next customer' ||
    clean === 'aage' ||
    clean === 'agla'
  );
}

/**
 * Detects if the user requested previous page navigation ("prev", "previous", "back", etc.)
 */
function isPreviousPaginationRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim();
  return (
    clean === 'prev' ||
    clean === 'previous' ||
    clean === 'back' ||
    clean === 'btn_prev_customers' ||
    clean === 'previous 10' ||
    clean === 'previous customers' ||
    clean === 'pehle wala' ||
    clean === 'piche'
  );
}

/**
 * Checks if the user message is purely an option/identifier selector without any field update instructions.
 */
function isPureOptionSelectorOnly(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim();
  // Phone numbers (7-15 digits, optionally with +, -, spaces) or PIN codes are NOT option selectors
  const digitsOnly = clean.replace(/[\s+-]/g, '');
  if (/^\d{7,15}$/.test(digitsOnly)) return false;

  if (/^\s*(?:option|choice|no\.?|#)\s*[1-9]\d*\.?\s*$/i.test(clean)) return true;
  if (/^\s*[1-9]\d{0,1}\.?\s*$/i.test(clean)) return true;
  if (/^\s*(?:the\s+)?(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s*(?:option|choice|inquiry|order|visit|one)?\.?\s*$/i.test(clean)) return true;
  if (/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*[0-9A-Za-z-]+$/i.test(clean)) return true;
  return false;
}

/**
 * Checks if the user message is purely a numeric or ordinal option choice (e.g. "1", "2", "option 3", "#2", "second").
 * Used to ensure numeric menu choices are NEVER misinterpreted as rates, prices, quantities, or dimensions.
 */
function isNumericOptionSelector(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  // Phone numbers (7-15 digits, optionally with +, -, spaces) or PIN codes are NOT option selectors
  const digitsOnly = clean.replace(/[\s+-]/g, '');
  if (/^\d{7,15}$/.test(digitsOnly)) return false;

  if (/^\s*(?:option|choice|no\.?|#)\s*[1-9]\d*\.?\s*$/i.test(clean)) return true;
  if (/^\s*[1-9]\d{0,1}\.?\s*$/i.test(clean)) return true;
  if (/^\s*(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th|last)\s*(?:option|choice|inquiry|order|visit|one)?\.?\s*$/i.test(clean)) return true;
  return false;
}

const CATALOG_MENU_SECTIONS = [
  {
    title: 'Inquiries & Orders',
    rows: [
      { id: 'menu_1', title: '1. Log New Inquiry', description: 'Capture customer requirements' },
      { id: 'menu_2', title: '2. Update Inquiry', description: 'Update rates, specs or stage' },
      { id: 'menu_3', title: '3. Log New Order', description: 'Record new confirmed PO' },
      { id: 'menu_4', title: '4. Update Order', description: 'Attach PO, update items' },
      { id: 'menu_price', title: '5. Add Price to Inquiry', description: 'Awaiting or price ready' },
    ],
  },
  {
    title: 'Visits & Customers',
    rows: [
      { id: 'menu_5', title: '6. Log Field Visit', description: 'Record client meeting' },
      { id: 'menu_6', title: '7. Update Field Visit', description: 'Update meeting outcome' },
      { id: 'menu_7', title: '8. New Acquisition', description: 'Add new customer profile' },
    ],
  },
  {
    title: 'Complaints & Queries',
    rows: [
      { id: 'menu_8', title: '9. Log Complaint', description: 'Report quality or delay' },
      { id: 'menu_9', title: '10. Update Complaint', description: 'Update resolution status' },
      { id: 'menu_10', title: '11. General Query', description: 'Ask any data retrieval query' },
    ],
  },
];

async function canUserUpdateVisits(senderPhone) {
  if (!senderPhone) return true;
  try {
    const { can } = require('../utils/permissions');
    return can(senderPhone, 'visits.update');
  } catch (err) {
    console.error('Error checking visit update permissions:', err?.message);
    return false;
  }
}

function getCatalogMenu(isAuthorizedForVisits = true) {
  if (isAuthorizedForVisits) {
    return CATALOG_MENU;
  }
  return `Welcome to **SalesOS Assistant**!

What would you like to do today?

1. **Log New Inquiry**
2. **Update Inquiry**
3. **Log New Order**
4. **Update Order**
5. **Add Price to Inquiry**
6. **Log Customer Field Visit**
7. **New Customer Acquisition**
8. **Log Customer Complaint**
9. **Update Customer Complaint**
10. **Other / General Query**

Reply with a number (1–10), or type what you'd like to do.`;
}

function getCatalogMenuSections(isAuthorizedForVisits = true) {
  if (isAuthorizedForVisits) {
    return CATALOG_MENU_SECTIONS;
  }
  return [
    {
      title: 'Inquiries & Orders',
      rows: [
        { id: 'menu_1', title: '1. Log New Inquiry', description: 'Capture customer requirements' },
        { id: 'menu_2', title: '2. Update Inquiry', description: 'Update specs or details' },
        { id: 'menu_3', title: '3. Log New Order', description: 'Record new confirmed PO' },
        { id: 'menu_4', title: '4. Update Order', description: 'Attach PO, update items' },
        { id: 'menu_price', title: '5. Add Price to Inquiry', description: 'Awaiting or price ready' },
      ],
    },
    {
      title: 'Visits & Customers',
      rows: [
        { id: 'menu_5', title: '6. Log Field Visit', description: 'Record client meeting' },
        { id: 'menu_7', title: '7. New Acquisition', description: 'Add new customer profile' },
      ],
    },
    {
      title: 'Complaints & Queries',
      rows: [
        { id: 'menu_8', title: '8. Log Complaint', description: 'Report quality or delay' },
        { id: 'menu_9', title: '9. Update Complaint', description: 'Update resolution status' },
        { id: 'menu_10', title: '10. General Query', description: 'Ask any data retrieval query' },
      ],
    },
  ];
}

// ── MODULE COLLECTION PROMPTS ────────────────────────────────────────────────

const INQUIRY_PAYMENT_TERMS = ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', 'LC', 'BG', 'PDC'];
const INQUIRY_PREFERRED_MAKES = ['TATA', 'JSW', 'AM/NS India', 'SAIL', 'NMDC', 'Apollo', 'Others'];

function normInquiryOpt(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function inquiryOptDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function inquiryWordClose(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  if (!a || !b || Math.abs(a.length - b.length) > 2) return false;
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.7) return false;
  const limit = Math.max(a.length, b.length) >= 6 ? 2 : 1;
  return inquiryOptDistance(a, b) <= limit;
}

function matchInquiryOption(raw, options) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const n = normInquiryOpt(text);
  if (!n) return '';
  const exact = options.find((opt) => normInquiryOpt(opt) === n);
  if (exact) return exact;
  if (n === 'amns' || n === 'amnsindia') {
    const amns = options.find((opt) => opt === 'AM/NS India');
    if (amns) return amns;
  }
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = new Set();
  for (const opt of options) {
    const optWords = opt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!optWords.length || words.length < optWords.length) continue;
    for (let i = 0; i + optWords.length <= words.length; i++) {
      if (optWords.every((word, idx) => inquiryWordClose(words[i + idx], word))) hits.add(opt);
    }
  }
  if (hits.size === 1) return [...hits][0];
  if (hits.size > 1) return null;
  if (words.length <= 3) {
    const joined = words.join('');
    let best = null;
    let bestDist = 99;
    for (const opt of options) {
      const no = normInquiryOpt(opt);
      if (no.length <= 3) continue;
      if (Math.abs(no.length - joined.length) > 2) continue;
      if (Math.min(no.length, joined.length) / Math.max(no.length, joined.length) < 0.7) continue;
      const dist = inquiryOptDistance(joined, no);
      if (dist < bestDist) {
        bestDist = dist;
        best = opt;
      }
    }
    const limit = joined.length >= 6 ? 2 : 1;
    if (best && bestDist > 0 && bestDist <= limit) return best;
  }
  return null;
}

function pickInquiryOptionFromReply(text, options) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const labeled = raw.match(/(?:payment\s*terms?|preferred\s*(?:brand|make))\s*[:=-]?\s*([^\n,;.]+)/i);
  if (labeled) {
    const labeledHit = matchInquiryOption(labeled[1], options);
    if (labeledHit) return labeledHit;
  }
  if (raw.split(/\s+/).length <= 3) {
    const hit = matchInquiryOption(raw, options);
    return hit || '';
  }
  return '';
}

function applyInquiryChoices(action, merged, userInput) {
  if (action !== 'LOG_INQUIRY' && action !== 'UPDATE_INQUIRY') return;
  const notices = [];
  const take = (value, options, label) => {
    if (value == null || String(value).trim() === '') return undefined;
    const matched = matchInquiryOption(value, options);
    if (matched) return matched;
    notices.push(`${label} must be one of: ${options.join(', ')}`);
    return null;
  };
  const payment = take(
    action === 'UPDATE_INQUIRY' ? (merged.updates && merged.updates.payment_terms) || merged.payment_terms : merged.payment_terms,
    INQUIRY_PAYMENT_TERMS,
    'Payment Terms',
  );
  const make = take(
    action === 'UPDATE_INQUIRY' ? (merged.updates && merged.updates.preferred_make) || merged.preferred_make : merged.preferred_make,
    INQUIRY_PREFERRED_MAKES,
    'Preferred Brand',
  );
  if (action === 'LOG_INQUIRY') {
    if (payment !== undefined) merged.payment_terms = payment;
    else if (!merged.payment_terms) {
      const fromText = pickInquiryOptionFromReply(userInput, INQUIRY_PAYMENT_TERMS);
      if (fromText) merged.payment_terms = fromText;
    }
    if (make !== undefined) merged.preferred_make = make;
    else if (!merged.preferred_make) {
      const fromText = pickInquiryOptionFromReply(userInput, INQUIRY_PREFERRED_MAKES);
      if (fromText) merged.preferred_make = fromText;
    }
  } else {
    merged.updates = merged.updates || {};
    if (payment !== undefined) {
      if (payment) merged.updates.payment_terms = payment;
      else delete merged.updates.payment_terms;
      merged.payment_terms = payment;
    }
    if (make !== undefined) {
      if (make) merged.updates.preferred_make = make;
      else delete merged.updates.preferred_make;
      merged.preferred_make = make;
    }
  }
  if (notices.length) merged._inquiry_option_notice = notices.join('\n');
  else delete merged._inquiry_option_notice;
}

const MODULE_PROMPTS = {
  LOG_INQUIRY: `📋 **Log New Inquiry**

Please provide the following details:

- **Customer / Company:** *
- **Email ID:** (optional)
- **Product Description / Quantity:** *
- **Rate:** (optional)
- **Preferred Brand:** (optional) TATA, JSW, AM/NS India, SAIL, NMDC, Apollo, Others
- **Payment Terms:** * Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC
- **Delivery Location:** *
- **Additional Notes:** (optional)

A price typed here is kept as a customer target. It is not the sell rate. Procurement adds the base price first.

You can reply in any format — just include the field names or values in order.`,

  UPDATE_INQUIRY: `✏️ **Update Inquiry**

- **Inquiry ID:** * (e.g. INQ-2026-0042)

Which fields do you want to update? Mention the field name and new value.

**Updatable Fields:**
- Product Description / Quantity / Specification (e.g. 8mm, 78 MT)
- Rate
- Preferred Brand (TATA, JSW, AM/NS India, SAIL, NMDC, Apollo, Others)
- Payment Terms (Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC)
- Delivery Location
- Email ID
- Additional Notes

Quoted, Won, and Lost stay closed until the sales price is saved. Reply *Price this inquiry* after the base price is ready. If every line is unavailable, send the decline from the dashboard.

Example:
"INQ-2026-0042, payment terms to 45 days credit, delivery to Chakan"`,

  LOG_ORDER: `🛒 **Record New Order**

Please provide the **Inquiry ID** (e.g. INQ-F4D982) linked to this order:

- **Inquiry ID:** * (e.g. INQ-F4D982)
- **PO Number:** (e.g. PO-2026-0042, or auto-generated if not provided)
- **PO Date:** (e.g. 10-09-2026, or today's date if not provided)
- **Delivery Location:** (optional, defaults to Quoted Inquiry details)
- **Payment Terms:** (optional, defaults to Quoted Inquiry details)

- **Line Items:** (if not already specified in the Quoted Inquiry)
  - Product Name / Description
  - Spec / Dimensions
  - Quantity & Unit
  - Rate (₹ per unit)

💡 _Tip: If the Inquiry is already Quoted, in Negotiation, or On Hold, you can simply reply with the Inquiry ID to auto-load all products, rates, and customer details!_`,

  UPDATE_ORDER: `✏️ **Update Order**

To identify the order, please provide ONE of the following:
- **Inquiry ID:** (e.g. INQ-936C7B or INQ-3C86DE)
- **PO Number:** (e.g. PO-2026-0042)

Which field would you like to update? (Rate, Quantity, PO Number, PO Date, Delivery Location, Payment Terms, Stage, Attach PO)

**Examples:**
- "For Inquiry INQ-936C7B, attach PO number PO-2026-8899"
- "PO-2026-0042, update delivery location to Pune MIDC, change item 1 rate to 58000"`,

  LOG_VISIT: `**Log Customer Field Visit**

Reply with all of these together. I will ask again only for anything still missing.

${nextVisitPrompts({}).map((item) => `- **${item}**`).join('\n')}

After these details are complete, a code is sent to the customer.`,

  UPDATE_VISIT: `**Update Field Visit**

- **Customer / Company:** * (e.g. Vanguard Industrial Automation Systems)
- **Visit Date:** (optional e.g. 10-09-2026)

Which fields do you want to update? Mention the field name and new value.

**Updatable Fields:**
- Person Met, Contact Phone, City / Location, Visit Date
- Visit Outcome (Positive / Negative / Neutral), Follow-up Action, Meeting Remarks
- Add Photo / Document (Attach new site photos; existing photos are permanently preserved)
- Status (Completed / Follow-up Pending / Cancelled)
- Email, Designation, Customer Type, Visit Type, Customer Probability
- Product Details, Monthly Consumption, Current Requirement, Delivery Location, Preferred Make, Payment Terms

Example:
"Vanguard Industrial Automation Systems, update Person Met to Amit Sharma, Visit Outcome to Positive" (or upload a new site photo)`,

  LOG_NEW_CUSTOMER: `👤 **New Customer Acquisition**

Please provide the following details:

- **Company Name:** *
- **Contact Person:** *
- **Mobile Number:** *
- **Delivery Location:** *
- **Email:** (optional)
- **GST Number:** (optional)

You can reply in any format — just include the field names or values in order.

Example:
"Apex Steel Structures, Contact: Rajesh Sharma, Phone: 9820123456, Location: Chakan Pune, Email: rajesh@apexsteel.com, GST: 27AABCU9603R1ZM"`,

  LOG_COMPLAINT: `⚠️ **Log Customer Complaint**

Please provide the following details:

- **Customer / Company:** *
- **Complaint Date:** (optional — default: today's date)
- **Complaint Raised By:** * (Contact person name at customer's side)
- **Linked Order / Ref:** (optional, auto-linked if customer has active orders)
- **Product / Material:** (e.g. 12 MT MS angle)
- **Complaint Type:** (optional: Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
- **Invoice / Challan No.:** (optional)
- **Description:** * (e.g. 12 MT MS angle with bending damage and edge cuts)
- **Evidence / Attachments:** (optional — send up to 3 photos/PDFs)
- **Corrective Action:** (optional)
- **Customer Communication / Update:** (optional)
- **Resolution Notes:** (optional)
- **Resolution Date:** (optional)

Example:
"Apex Steel, Raised By: Rajesh Sharma, 12 MT MS angle with bending damage, Challan: CH-9081"`,

  UPDATE_COMPLAINT: `✏️ **Update Complaint**

To identify the complaint, provide ONE of the following:
- **Linked Order / Ref:** * (e.g. PO-2026-TI-101 or INQ-8971B1)
- **Customer / Company:** (e.g. Tech Industries)

What would you like to update?

**Updatable Fields:**
- Complaint Date (e.g. 27-09-2026)
- Complaint Raised By (Customer Contact Person)
- Product / Material
- Complaint Type (Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other)
- Invoice / Challan No.
- Description
- Corrective Action
- Customer Communication / Update
- Status (Pending / In Progress / Resolved / Closed)
- Resolution Date (e.g. 27-09-2026)
- Resolution Notes

Example:
"Update complaint for Tech Industries to Status: Resolved, Resolution Notes: Replaced 2 MT MS Angle"`
};

// ── ACTION NAME FORMATTER FOR PROMPTS ─────────────────────────────────────────

function getActionFriendlyName(action) {
  switch (action) {
    case 'LOG_INQUIRY': return 'new inquiry';
    case 'UPDATE_INQUIRY': return 'inquiry update';
    case 'LOG_ORDER': return 'order';
    case 'UPDATE_ORDER': return 'order update';
    case 'LOG_VISIT': return 'visit report';
    case 'UPDATE_VISIT': return 'visit update';
    case 'LOG_NEW_CUSTOMER': return 'customer acquisition';
    case 'LOG_COMPLAINT': return 'complaint';
    case 'UPDATE_COMPLAINT': return 'complaint update';
    default: return 'action';
  }
}

function getModuleFamily(action) {
  if (!action) return 'OTHER';
  const act = String(action).toUpperCase().trim();
  if (act === 'LOG_INQUIRY' || act === 'UPDATE_INQUIRY') return 'INQUIRY';
  if (act === 'LOG_ORDER' || act === 'UPDATE_ORDER') return 'ORDER';
  if (act === 'LOG_VISIT' || act === 'UPDATE_VISIT') return 'VISIT';
  if (act === 'LOG_COMPLAINT' || act === 'UPDATE_COMPLAINT') return 'COMPLAINT';
  if (act === 'LOG_NEW_CUSTOMER') return 'CUSTOMER';
  return 'OTHER';
}

function getModuleDisplayName(action) {
  const family = getModuleFamily(action);
  switch (family) {
    case 'INQUIRY': return 'Inquiry';
    case 'ORDER': return 'Order';
    case 'VISIT': return 'Field Visit';
    case 'COMPLAINT': return 'Complaint';
    case 'CUSTOMER': return 'Customer Acquisition';
    default: return getActionFriendlyName(action);
  }
}

function getTargetActionVerb(action) {
  switch (action) {
    case 'LOG_INQUIRY': return 'log an inquiry';
    case 'UPDATE_INQUIRY': return 'update an inquiry';
    case 'LOG_ORDER': return 'log an order';
    case 'UPDATE_ORDER': return 'update an order';
    case 'LOG_VISIT': return 'log a field visit';
    case 'UPDATE_VISIT': return 'update a field visit';
    case 'LOG_NEW_CUSTOMER': return 'onboard a customer';
    case 'LOG_COMPLAINT': return 'log a complaint';
    case 'UPDATE_COMPLAINT': return 'update a complaint';
    default: return `start ${getActionFriendlyName(action)}`;
  }
}

function getEditPromptForAction(action) {
  switch (action) {
    case 'LOG_INQUIRY':
      return `Which field would you like to change? (e.g. "Rate: 55000", "Delivery location: Pune", "Quantity: 25 MT", or "Additional notes: ...")`;
    case 'UPDATE_INQUIRY':
      return `Which field would you like to change? (e.g. "Rate: 55000", "Quantity / Spec: 78 MT 8mm", "Payment terms: 30 days", "Delivery location: Mumbai", or "Additional notes: ...")`;
    case 'LOG_ORDER':
      return `Which field would you like to change? (e.g. "Rate: 54000", "Delivery location: Pune", or "PO Number: PO-2026-001")`;
    case 'UPDATE_ORDER':
      return `Which field would you like to update? (Rate, Quantity, PO Number, PO Date, Delivery Location, Payment Terms, Stage, Attach PO)`;
    case 'LOG_VISIT':
      return `Which field would you like to change? (e.g. "Person met: Jenny Shah", "Contact phone: 9820123456", "Visit date: 20-09-2026", "Remarks: Discussed HR coil", or upload another photo)`;
    case 'UPDATE_VISIT':
      return `Which field would you like to change? (e.g. "Person met: Jenny Shah", "Outcome: Positive", "Remarks: Updated remarks", or upload a new site photo)`;
    case 'LOG_COMPLAINT':
      return `Which field would you like to change? (e.g. "Description: Delivered product had severe rust", "Product: HR Sheet 3mm", or "Type: Quality Defect")`;
    case 'UPDATE_COMPLAINT':
      return `Which field would you like to change? (e.g. "Status: In Progress", "Type: Physical Damage", or "Description: Updated notes")`;
    case 'LOG_NEW_CUSTOMER':
      return `Which field would you like to change? (e.g. "Contact person: Rajesh Sharma", "Mobile: 9820123456", or "Delivery location: Satara")`;
    default:
      return `Which field would you like to change? (e.g. "Rate: 55000" or "Delivery location: Pune")`;
  }
}

function buildOutOfScopeActivityResponse(currentAction, detectedAction, isAuthorizedForVisits = true) {
  const currentModuleName = getModuleDisplayName(currentAction);
  const targetVerb = getTargetActionVerb(detectedAction);
  const menuText = getCatalogMenu(isAuthorizedForVisits);
  const menuSections = getCatalogMenuSections(isAuthorizedForVisits);

  const replyText = `You are currently in the *${currentModuleName}* flow. To ${targetVerb}, please complete the current ongoing activity or select the relevant option from the menu.\n\nHere is the menu to start a new activity:\n\n${menuText}`;

  return {
    handled: true,
    reply: replyText,
    interactiveType: 'list',
    interactiveList: {
      bodyText: `You are currently in the *${currentModuleName}* flow. To ${targetVerb}, please complete the current ongoing activity or select the relevant option from the menu.\n\nHere is the menu to start a new activity:`,
      buttonText: 'Choose Action',
      sections: menuSections,
    },
  };
}

async function isGreetingWithLLM(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (clean.length === 0 || clean.length > 80) return false;

  // Immediate guard: If message contains obvious CRM transaction terms, numbers with units, IDs, or field assignments, it's NOT a greeting
  if (/\b(?:inq-|po-|vis-|cmp-|deal-|[0-9a-f]{8}-[0-9a-f]{4}|₹|\d+\s*(?:mt|tons?|kg|pcs|sheet|coil|plate|beam)|rate\s*[:=]|qty\s*[:=]|payment\s*terms|delivery\s*location|credit\s*period|complaint|acquisition|onboard)\b/i.test(clean)) {
    return false;
  }

  const prompt = `You are a strict greeting and menu classifier for a B2B sales WhatsApp bot (Enlight Metals SalesOS).
Determine if the following message is a greeting, salutation, polite conversational opener, or menu/start request (in English, Hindi, Hinglish, Marathi, Gujarati, or any language/slang):
"${clean}"

Examples of greetings / menu requests:
- "hi", "hello", "hieeee", "heyyyyy", "hola", "yo", "namaste", "namaskar", "kem cho", "vanakkam", "pranam", "ram ram", "radhe radhe", "kya haal hai", "good morning", "good evening", "hey bot", "start bot", "show menu", "options", "help", "let's begin"

Examples of non-greetings (operational or data queries):
- "send 10 MT HR Coil", "what is the rate for SS Industries?", "update PO 1234", "visited Horizon yesterday", "cancel", "45 days credit", "Pune delivery"

Respond strictly with ONLY "YES" if it is a greeting/salutation/opener/menu request, or "NO" otherwise. No markdown, no punctuation.`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)]);
    const raw = (typeof res.content === 'string' ? res.content : '').trim().toUpperCase();
    return raw.startsWith('YES');
  } catch (err) {
    console.warn('[CatalogFlow] AI greeting detection fallback notice:', err.message);
    return false;
  }
}

async function isGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().replace(/[!.,?*~_]/g, '').trim();
  if (!clean) return false;

  // 0. Catalog Item IDs (menu_1 .. menu_10) or Action Commands are NOT greetings!
  if (/^menu_?(?:[1-9]|10)$/i.test(clean) || /^start_(?:log|update)_/i.test(clean) || /^btn_repeat_/i.test(clean)) {
    return false;
  }

  // 1. Exact high-frequency greeting match
  const exactGreetings = new Set([
    'hi', 'hello', 'hey', 'start', 'menu', 'main menu', 'options',
    'namaste', 'namaskar', 'pranam', 'good morning', 'good afternoon', 'good evening', 'good day', 'good night',
    'hii', 'hiii', 'hiiii', 'heyy', 'heyyy', 'catalog', 'help', 'btn_post_menu', 'hie', 'hiee', 'hieee', 'hieeee',
    'yo', 'hola', 'sup', 'wassup', 'whatsup', 'wazzup', 'kya haal hai', 'kaise ho', 'kaisa hai',
    'ram ram', 'jai shree ram', 'radhe radhe', 'adab', 'salam', 'assalam alaikum', 'vanakkam', 'kem cho'
  ]);
  if (exactGreetings.has(clean)) return true;

  // 2. Regex for elongated variations (e.g. hieeee, hiiiiii, heyyyy, helloooo)
  if (
    /^(?:h+i+|h+e+y+|h+e+l+l*o+|h+i+e+|y+o+|h+o+l+a+|s+u+p+|w+a+s+s+u+p+|w+h+a+t+s+u+p+|w+z+u+p+|n+a+m+a+s+t+e+|n+a+m+a+s+k+a+r+|p+r+a+n+a+m+|a+d+a+a?b+|s+a+l+a+a?m+|r+a+m\s*r+a+m+|j+a+i\s*s+h+r+e+e\s*r+a+m+|k+y+a\s*h+a+a?l\s*h+a+i?|k+a+i+s+e\s*h+o+|k+a+i+s+a\s*h+a+i?|v+a+n+a+k+k+a+m+|k+e+m\s*c+h+o+|s+t+a+r+t|m+e+n+u|m+a+i+n\s*m+e+n+u|o+p+t+i+o+n+s?|c+a+t+a+l+o+g|h+e+l+p|b+t+n_p+o+s+t_m+e+n+u)$/i.test(clean)
  ) {
    return true;
  }

  // 3. Multi-word standard greeting openers
  if (
    /^(?:good\s*(?:morning|afternoon|evening|day|night)|hey\s*there|hi\s*there|hello\s*there|hi\s*bot|hello\s*bot|hey\s*bot|hi\s*assistant|hello\s*assistant|hey\s*all|greetings|let'?s\s*start|start\s*here)\b/i.test(clean) &&
    clean.length <= 35
  ) {
    return true;
  }

  // 4. Guard before LLM: If it contains obvious CRM transactions/data, don't call LLM
  if (/\b(?:inq-|po-|vis-|cmp-|deal-|₹|\d+\s*(?:mt|tons?|kg|pcs|sheet|coil|plate|beam)|rate|price|quote|order|visit|complaint|acquisition|delivery|payment|invoice|credit|bhosari|pune|mumbai)\b/i.test(clean)) {
    return false;
  }

  // Control replies are already handled by the active catalog step.
  if (/^(?:yes|no|cancel|y|n)$/i.test(clean)) return false;

  // 5. Intelligent Gemini Model Classifier for non-fixed / novel / multilingual greetings
  if (clean.length <= 60) {
    return await isGreetingWithLLM(clean);
  }

  return false;
}

function matchActionFromInput(text, hasActiveSession = false, isAuthorizedForVisits = true) {
  if (!text || typeof text !== 'string') return null;

  // Extract first line in case of multi-line interactive list replies (e.g. "3. Log New Order\nRecord new confirmed PO")
  const firstLine = text.split(/[\r\n]+/)[0].trim();
  const clean = firstLine.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();
  const fullClean = text.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();

  // If text is a full sentence with arguments/details, let natural action detection & LLM extraction handle it
  if (clean.length > 45 || /\b(?:rate|qty|status|inq-|po-|vis-|cmp-|midc|midc\s+pune|midc\s+bhosari|mt|tons|plate|sheet|coil)\b/i.test(clean)) {
    if (!/^(?:1|2|3|4|5|6|7|8|9|10|11)\.?$/i.test(clean) && !/^(?:\d+[\.\)\s\-]+|menu_\d+|start_log_|start_update_)?(?:log|update|record|start_log_|start_update_)?\s*(?:new\s*)?(?:inquiry|order|visit|complaint|customer|customer acquisition|field visit|customer visit|customer complaint|general query|other query)$/i.test(clean)) {
      return null;
    }
  }

  const isBareNumber = /^(?:[1-9]|10|11)\.?$/i.test(clean) || /^(?:option|choice)\s*(?:[1-9]|10|11)\.?$/i.test(clean);
  if (isBareNumber && hasActiveSession) {
    return null;
  }

  const stripped = clean.replace(/^(?:menu_|\d+[\.\)\s\-]+|\*+[0-9🔟]+[️⃣\s\.\)]+|switch\s+to\s+|change\s+to\s+|start\s+|open\s+)/i, '').trim();

  if (
    (!hasActiveSession && (clean === '1' || clean === '1.' || clean === 'option 1' || clean === 'choice 1')) ||
    clean === 'menu_1' ||
    stripped === 'log inquiry' || stripped === 'log new inquiry' || stripped === 'new inquiry' || stripped === 'create inquiry' || stripped === 'log inq' || stripped === 'new inq' || stripped === 'start_log_inquiry' ||
    clean === '1. log new inquiry' || clean === '1. log inquiry' || clean === '1 log new inquiry' ||
    fullClean.includes('capture customer requirements')
  ) {
    return 'LOG_INQUIRY';
  }
  if (
    (!hasActiveSession && (clean === '2' || clean === '2.' || clean === 'option 2' || clean === 'choice 2')) ||
    clean === 'menu_2' ||
    stripped === 'update inquiry' || stripped === 'update inq' || stripped === 'update an inquiry' || stripped === 'update the inquiry' || stripped === 'inquiry update' || stripped === 'inq update' || stripped === 'edit inquiry' || stripped === 'edit inq' || stripped === 'modify inquiry' || stripped === 'start_update_inquiry' ||
    clean === '2. update inquiry' || clean === '2 update inquiry' ||
    fullClean.includes('update specs or details') || fullClean.includes('update rates, specs or stage')
  ) {
    return 'UPDATE_INQUIRY';
  }
  if (
    (!hasActiveSession && (clean === '3' || clean === '3.' || clean === 'option 3' || clean === 'choice 3')) ||
    clean === 'menu_3' ||
    stripped === 'log order' || stripped === 'log new order' || stripped === 'record order' || stripped === 'record new order' || stripped === 'new order' || stripped === 'log won order' || stripped === 'record won order' || stripped === 'start_log_order' ||
    clean === '3. log new order' || clean === '3. log order' || clean === '3 log new order' ||
    fullClean.includes('record new confirmed po')
  ) {
    return 'LOG_ORDER';
  }
  if (
    (!hasActiveSession && (clean === '4' || clean === '4.' || clean === 'option 4' || clean === 'choice 4')) ||
    clean === 'menu_4' ||
    stripped === 'update order' || stripped === 'update won order' || stripped === 'order update' || stripped === 'edit order' || stripped === 'modify order' || stripped === 'start_update_order' ||
    clean === '4. update order' || clean === '4 update order' ||
    fullClean.includes('update po date, items or stage')
  ) {
    return 'UPDATE_ORDER';
  }
  if (
    (!hasActiveSession && (clean === '6' || clean === '6.' || clean === 'option 6' || clean === 'choice 6')) ||
    clean === 'menu_5' ||
    stripped === 'log visit' || stripped === 'log customer field visit' || stripped === 'log customer visit' || stripped === 'log field visit' || stripped === 'field visit' || stripped === 'new visit' || stripped === 'record visit' || stripped === 'start_log_visit' ||
    clean === '5. log customer field visit' || clean === '5. log field visit' || clean === '5 log customer field visit' ||
    fullClean.includes('log rep on-site client visit')
  ) {
    return 'LOG_VISIT';
  }

  // If user is a salesperson, option 7 in their menu is New Customer Acquisition
  if (!isAuthorizedForVisits) {
    if (
      (!hasActiveSession && (clean === '7' || clean === '7.' || clean === 'option 7' || clean === 'choice 7')) ||
      clean === 'menu_7' ||
      stripped === 'new acquisition' || stripped === 'new customer' || stripped === 'new customer acquisition' || stripped === 'customer acquisition' || stripped === 'add customer' || stripped === 'onboard customer' || stripped === 'log customer' || stripped === 'start_log_customer' ||
      clean === '6. new customer acquisition' || clean === '6. new acquisition' || clean === '6 new customer acquisition' ||
      clean === '7. new customer acquisition' || clean === '7. new acquisition' || clean === '7 new customer acquisition' ||
      fullClean.includes('onboard new client profile')
    ) {
      return 'LOG_NEW_CUSTOMER';
    }
    if (
      (!hasActiveSession && (clean === '8' || clean === '8.' || clean === 'option 8' || clean === 'choice 8')) ||
      clean === 'menu_8' ||
      stripped === 'log complaint' || stripped === 'log customer complaint' || stripped === 'new complaint' || stripped === 'record complaint' || stripped === 'raise complaint' || stripped === 'start_log_complaint' ||
      clean === '7. log customer complaint' || clean === '7. log complaint' || clean === '7 log customer complaint' ||
      clean === '8. log customer complaint' || clean === '8. log complaint' || clean === '8 log customer complaint' ||
      fullClean.includes('log quality/service issue')
    ) {
      return 'LOG_COMPLAINT';
    }
    if (
      (!hasActiveSession && (clean === '9' || clean === '9.' || clean === 'option 9' || clean === 'choice 9')) ||
      clean === 'menu_9' ||
      stripped === 'update complaint' || stripped === 'update customer complaint' || stripped === 'complaint update' || stripped === 'resolve complaint' || stripped === 'close complaint' || stripped === 'edit complaint' || stripped === 'start_update_complaint' ||
      clean === '8. update customer complaint' || clean === '8. update complaint' || clean === '8 update customer complaint' ||
      clean === '9. update customer complaint' || clean === '9. update complaint' || clean === '9 update customer complaint' ||
      fullClean.includes('update resolution or status')
    ) {
      return 'UPDATE_COMPLAINT';
    }
    if (
      (!hasActiveSession && (clean === '10' || clean === '10.' || clean === 'option 10' || clean === 'choice 10')) ||
      clean === 'menu_10' ||
      stripped === 'other' || stripped === 'general query' || stripped === 'other query' || stripped === 'general_query' || stripped === 'other / general query' || stripped === 'search query' ||
      clean === '9. other / general query' || clean === '9. other' || clean === '9. general query' || clean === '9 general query' ||
      clean === '10. other / general query' || clean === '10. other' || clean === '10. general query' || clean === '10 general query' ||
      fullClean.includes('general search or intelligence') || fullClean.includes('ask any data retrieval query')
    ) {
      return 'GENERAL_QUERY';
    }
  }

  // Explicit Update Visit keywords (always detected so unauthorized users hit the access denied gate)
  if (
    (isAuthorizedForVisits && !hasActiveSession && (clean === '7' || clean === '7.' || clean === 'option 7' || clean === 'choice 7')) ||
    clean === 'menu_6' ||
    stripped === 'update visit' || stripped === 'update field visit' || stripped === 'update customer visit' || stripped === 'visit update' || stripped === 'field visit update' || stripped === 'edit visit' || stripped === 'modify visit' || stripped === 'start_update_visit' ||
    clean === '6. update field visit' || clean === '6. update visit' || clean === '6 update field visit' ||
    fullClean.includes('update outcome or remarks')
  ) {
    return 'UPDATE_VISIT';
  }

  if (
    (!hasActiveSession && (clean === '8' || clean === '8.' || clean === 'option 8' || clean === 'choice 8')) ||
    clean === 'menu_7' ||
    stripped === 'new acquisition' || stripped === 'new customer' || stripped === 'new customer acquisition' || stripped === 'customer acquisition' || stripped === 'add customer' || stripped === 'onboard customer' || stripped === 'log customer' || stripped === 'start_log_customer' ||
    clean === '7. new customer acquisition' || clean === '7. new acquisition' || clean === '7 new customer acquisition' ||
    fullClean.includes('onboard new client profile')
  ) {
    return 'LOG_NEW_CUSTOMER';
  }
  if (
    (!hasActiveSession && (clean === '9' || clean === '9.' || clean === 'option 9' || clean === 'choice 9')) ||
    clean === 'menu_8' ||
    stripped === 'log complaint' || stripped === 'log customer complaint' || stripped === 'new complaint' || stripped === 'record complaint' || stripped === 'raise complaint' || stripped === 'start_log_complaint' ||
    clean === '8. log customer complaint' || clean === '8. log complaint' || clean === '8 log customer complaint' ||
    fullClean.includes('log quality/service issue')
  ) {
    return 'LOG_COMPLAINT';
  }
  if (
    (!hasActiveSession && (clean === '10' || clean === '10.' || clean === 'option 10' || clean === 'choice 10')) ||
    clean === 'menu_9' ||
    stripped === 'update complaint' || stripped === 'update customer complaint' || stripped === 'complaint update' || stripped === 'resolve complaint' || stripped === 'close complaint' || stripped === 'edit complaint' || stripped === 'start_update_complaint' ||
    clean === '9. update customer complaint' || clean === '9. update complaint' || clean === '9 update customer complaint' ||
    fullClean.includes('update resolution or status')
  ) {
    return 'UPDATE_COMPLAINT';
  }
  if (
    (!hasActiveSession && (clean === '11' || clean === '11.' || clean === 'option 11' || clean === 'choice 11')) ||
    clean === 'menu_10' ||
    stripped === 'other' || stripped === 'general query' || stripped === 'other query' || stripped === 'general_query' || stripped === 'other / general query' || stripped === 'search query' ||
    clean === '10. other / general query' || clean === '10. other' || clean === '10. general query' ||
    clean === '11. other / general query' || clean === '11. other' || clean === '11. general query' || clean === '11 general query' ||
    fullClean.includes('general search or intelligence')
  ) {
    return 'GENERAL_QUERY';
  }

  return null;
}

function isExplicitMenuSelection(text, hasActiveSession = false, isAuthorizedForVisits = true) {
  if (!text || typeof text !== 'string') return null;
  const firstLine = text.split(/[\r\n]+/)[0].trim();
  const clean = firstLine.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();
  const fullClean = text.toLowerCase().replace(/[🔟*️⃣\uFE0F\u20E3]/g, '').trim();

  // 1. WhatsApp List Item ID (e.g. menu_1 .. menu_10)
  if (/^menu_(?:[1-9]|10)$/i.test(clean)) {
    return matchActionFromInput(text, false, isAuthorizedForVisits);
  }

  // 2. Exact catalog list titles / descriptions
  if (
    /^(?:11|10|[1-9])[\.\)\s\-]+(?:log|update|record|new|onboard)?\s*(?:new\s*)?(?:inquiry|order|visit|field visit|customer visit|complaint|customer complaint|customer|acquisition|customer acquisition|general query|other query|other)\b/i.test(clean) ||
    fullClean.includes('capture customer requirements') ||
    fullClean.includes('update specs or details') || fullClean.includes('update rates, specs or stage') ||
    fullClean.includes('record new confirmed po') ||
    fullClean.includes('attach po, update items') ||
    fullClean.includes('record client meeting') ||
    fullClean.includes('update meeting outcome') ||
    fullClean.includes('add new customer profile') ||
    fullClean.includes('report quality or delay') ||
    fullClean.includes('update resolution status') ||
    fullClean.includes('ask any data retrieval query') ||
    fullClean.includes('general search or intelligence')
  ) {
    return matchActionFromInput(text, false, isAuthorizedForVisits);
  }

  // 3. Action command / start prefix (e.g. "start_log_order", "start_update_inquiry")
  if (/^start_(?:log|update)_(?:inquiry|order|visit|customer|complaint)$/i.test(clean)) {
    return matchActionFromInput(text, false, isAuthorizedForVisits);
  }

  // 3b. Repeat action button / command (e.g. "btn_repeat_log_complaint", "log another complaint")
  if (/^btn_repeat_/i.test(clean) || /\b(?:log|record|update|onboard|add)\s+another\b/i.test(clean)) {
    if (clean.includes('complaint')) return clean.includes('update') ? 'UPDATE_COMPLAINT' : 'LOG_COMPLAINT';
    if (clean.includes('visit')) return clean.includes('update') ? 'UPDATE_VISIT' : 'LOG_VISIT';
    if (clean.includes('order')) return clean.includes('update') ? 'UPDATE_ORDER' : 'LOG_ORDER';
    if (clean.includes('inquiry') || clean.includes('inq')) return clean.includes('update') ? 'UPDATE_INQUIRY' : 'LOG_INQUIRY';
    if (clean.includes('customer') || clean.includes('cust') || clean.includes('onboard')) return 'LOG_NEW_CUSTOMER';
  }

  // 4. Standalone action verbs / switch commands (e.g. "log order", "new inquiry", "update inquiry", "switch to inquiry")
  const matchedAction = matchActionFromInput(text, hasActiveSession, isAuthorizedForVisits);
  if (matchedAction) {
    return matchedAction;
  }

  // 5. If NOT in an active session (idle/general), single digits 1-11 are catalog selections
  if (!hasActiveSession && /^(?:11|10|[1-9])\.?$/i.test(clean)) {
    return matchActionFromInput(text, false, isAuthorizedForVisits);
  }

  return null;
}

const BARE_NUMBER_FIELD_INPUT_REPLY = `Please describe what you'd like to update in more detail. For example: 'update rate to 3000' or 'change quantity to 45 MT'.`;
const BARE_NUMBER_NO_SESSION_REPLY = `Please send 'Hi' or 'Menu' to get started.`;

function isBareCatalogNumber(text) {
  return typeof text === 'string' && /^\s*(?:option\s*|choice\s*)?(?:11|10|[1-9])\s*[.)]?\s*$/i.test(text);
}

// True when the latest bot message in the current session is a catalog menu / numbered start prompt.
async function isCatalogMenuAwaitingSelection(senderPhone) {
  try {
    const envelope = await getSessionEnvelope(senderPhone);
    const msgs = (envelope?.current_session?.messages && envelope.current_session.messages.length > 0)
      ? envelope.current_session.messages
      : (envelope?.rolling_messages || []);
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant') return false;
    const content = String(last.content || '');
    return last.agent === 'catalog_menu' ||
      last.action_type === 'CATALOG_MENU' ||
      last.metadata?.action_type === 'CATALOG_MENU' ||
      /Reply with a number \(1\s*[–-]/i.test(content) ||
      /\bChoose Action\b/i.test(content) ||
      /\bWhat would you like to do today\b/i.test(content) ||
      /\bActivity cancelled\b/i.test(content) ||
      /\bHere is the menu to start a new activity\b/i.test(content) ||
      /\breply with \*(?:[1-9]|10)\*/i.test(content);
  } catch (err) {
    console.warn('[CatalogFlow] Menu-awaiting check failed, allowing selection:', err.message);
    return true;
  }
}

// ── DATE NORMALIZATION ───────────────────────────────────────────────────────

function normalizeDateToDDMMYYYY(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const clean = dateStr.trim();

  // Handle relative words
  const now = new Date();
  if (/^(?:today|now|nonw|just now|aaj|current)$/i.test(clean)) {
    return formatDateDDMMYYYY(now);
  }
  if (/^yesterday$/i.test(clean)) {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    return formatDateDDMMYYYY(y);
  }
  if (/^(?:day before yesterday|parso)$/i.test(clean)) {
    const dby = new Date(now.getTime() - 48 * 3600 * 1000);
    return formatDateDDMMYYYY(dby);
  }

  // Handle DD-MM-YYYY or DD/MM/YYYY embedded in text
  const dmyMatch = clean.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${day}-${month}-${year}`;
  }

  // Handle YYYY-MM-DD embedded in text
  const ymdMatch = clean.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = String(ymdMatch[2]).padStart(2, '0');
    const day = String(ymdMatch[3]).padStart(2, '0');
    return `${day}-${month}-${year}`;
  }

  // Handle textual e.g. "10 Sep 2026", "10th September 2026"
  const parsed = new Date(clean);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    return formatDateDDMMYYYY(parsed);
  }

  return clean;
}

// Calendar dates are always IST (UTC+5:30), independent of the server timezone.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function toIstShifted(dObj) {
  return new Date(dObj.getTime() + IST_OFFSET_MS);
}

/** YYYY-MM-DD of the IST calendar day containing this instant. */
function formatIsoDateIST(d = new Date()) {
  const s = toIstShifted(d instanceof Date ? d : new Date(d));
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`;
}

/** "02:30 PM" in IST, or '' when the value is not a valid timestamp. */
function formatVisitTimeIST(value) {
  if (!value) return '';
  const dObj = value instanceof Date ? value : new Date(value);
  if (isNaN(dObj.getTime())) return '';
  const s = toIstShifted(dObj);
  const h24 = s.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function formatDateDDMMYYYY(d) {
  if (!d) return '';
  const dObj = d instanceof Date ? d : new Date(d);
  if (isNaN(dObj.getTime())) return typeof d === 'string' ? d : '';
  const s = toIstShifted(dObj);
  const day = String(s.getUTCDate()).padStart(2, '0');
  const month = String(s.getUTCMonth() + 1).padStart(2, '0');
  const year = s.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/** ISO date for a DD-MM-YYYY visit selector, or null (never defaults to today). */
function getStrictVisitDateIso(dStr) {
  if (typeof dStr !== 'string' || !/^\d{2}-\d{2}-\d{4}$/.test(dStr.trim())) return null;
  return parseDDMMYYYYtoISO(dStr.trim());
}

function parseDDMMYYYYtoISO(dStr) {
  const now = new Date();
  if (!dStr) return now.toISOString();

  const todayStr = formatDateDDMMYYYY(now);
  if (typeof dStr === 'string' && dStr.trim() === todayStr) {
    return now.toISOString();
  }

  const m = String(dStr).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    // IST midnight of that day + the current IST time of day
    const istTimeOfDayMs = (now.getTime() + IST_OFFSET_MS) % DAY_MS;
    const targetDate = new Date(Date.UTC(year, month, day) - IST_OFFSET_MS + istTimeOfDayMs);
    return targetDate.toISOString();
  }

  const parsed = new Date(dStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return now.toISOString();
}

/**
 * ISO timestamp for a user-supplied date, or null when it cannot be understood.
 * Unlike parseDDMMYYYYtoISO this never falls back to "now", so updates can keep the existing date.
 */
function parseUserDateToISOStrict(dStr) {
  if (dStr === null || dStr === undefined) return null;
  const raw = String(dStr).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const p = new Date(raw);
    return isNaN(p.getTime()) ? null : p.toISOString();
  }
  const isRelativeWord = /^(?:today|now|nonw|just now|aaj|current|yesterday|day before yesterday|parso)$/i.test(raw);
  if (!isRelativeWord && !/\b(?:19|20)\d{2}\b/.test(raw)) return null;
  const norm = normalizeDateToDDMMYYYY(raw);
  const m = String(norm || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return parseDDMMYYYYtoISO(norm);
}

function extractFollowUpDate(followupText, baseDate = new Date()) {
  if (!followupText || typeof followupText !== 'string') return null;
  const lower = followupText.toLowerCase();

  // 1. Explicit DD-MM-YYYY or YYYY-MM-DD
  const dmyMatch = lower.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  const ymdMatch = lower.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = String(ymdMatch[2]).padStart(2, '0');
    const day = String(ymdMatch[3]).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Parse baseDate properly if it's a string (DD-MM-YYYY or ISO) or Date
  let base = new Date();
  if (baseDate instanceof Date && !isNaN(baseDate.getTime())) {
    base = new Date(baseDate.getTime());
  } else if (typeof baseDate === 'string' && baseDate.trim()) {
    const iso = parseDDMMYYYYtoISO(baseDate.trim());
    const p = new Date(iso);
    if (!isNaN(p.getTime())) {
      base = p;
    }
  } else if (typeof baseDate === 'number' && !isNaN(baseDate)) {
    base = new Date(baseDate);
  }

  // 2. Relative "in X days" / "after X days" / "within X days" / "X days"
  const daysMatch = lower.match(/(?:in|after|within)?\s*(\d+)\s*(?:days?|din)/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const target = new Date(base.getTime() + days * 24 * 3600 * 1000);
    return formatIsoDateIST(target);
  }

  // 3. "tomorrow" / "kal"
  if (/\b(?:tomorrow|kal)\b/i.test(lower)) {
    const target = new Date(base.getTime() + 1 * 24 * 3600 * 1000);
    return formatIsoDateIST(target);
  }

  // 4. Relative "in X weeks" / "within X weeks" / "next week" / "agle hafte"
  const weeksMatch = lower.match(/(?:in|after|within)?\s*(\d+)\s*(?:weeks?|hafte)/i);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1], 10);
    const target = new Date(base.getTime() + weeks * 7 * 24 * 3600 * 1000);
    return formatIsoDateIST(target);
  }
  if (/\b(?:next\s+week|agle\s+hafte)\b/i.test(lower)) {
    const target = new Date(base.getTime() + 7 * 24 * 3600 * 1000);
    return formatIsoDateIST(target);
  }

  // 5. Relative "in X months" / "within X months"
  const monthsMatch = lower.match(/(?:in|after|within)?\s*(\d+)\s*(?:months?|mahine)/i);
  if (monthsMatch) {
    const months = parseInt(monthsMatch[1], 10);
    const target = new Date(base.getTime() + months * 30 * 24 * 3600 * 1000);
    return formatIsoDateIST(target);
  }

  // 6. Day of week (e.g. "on monday", "next tuesday")
  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < daysOfWeek.length; i++) {
    const dayName = daysOfWeek[i];
    if (new RegExp(`\\b(?:on\\s+|next\\s+)?${dayName}\\b`, 'i').test(lower)) {
      const currentDay = toIstShifted(base).getUTCDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7;
      const target = new Date(base.getTime() + diff * 24 * 3600 * 1000);
      return formatIsoDateIST(target);
    }
  }

  return null;
}

// ── VERBATIM NOTES EXTRACTION HELPER ────────────────────────────────────────

function extractVerbatimNotes(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const prefixPattern = /^(?:(?:change|edit|update|modify|set|alter|revise|amend|replace)\s+(?:the\s+)?)?(?:additional\s*notes?|notes?|remarks?|meeting\s*remarks?|discussion\s*notes?|resolution\s*notes?|comments?)\s*(?:to|as|is|:|=|\s+-)\s*/i;
  const match = trimmed.match(prefixPattern);
  if (!match) return null;

  let body = trimmed.slice(match[0].length).trim();
  // If there are subsequent field instructions (e.g. rate, quantity, delivery, payment, stage, status), stop before them
  const splitPattern = /(?:[\n\r]+|,\s*|\s+and\s+)(?=(?:(?:change|update|set)\s+)?(?:rate|price|qty|quantity|delivery|payment|stage|status)\s*(?:to|is|=|:|\b))/i;
  const splitMatch = body.search(splitPattern);
  if (splitMatch !== -1) {
    body = body.slice(0, splitMatch).trim();
  }
  return body.length > 0 ? body : null;
}

// ── LLM FIELD EXTRACTION ENGINE ──────────────────────────────────────────────

async function extractFieldsWithLLM(action, userInput, existingDraft = {}) {
  // Pure numeric or ordinal option selectors (e.g. "1", "2", "option 2", "#1") are menu choices, not field updates.
  if (isNumericOptionSelector(userInput)) {
    return existingDraft;
  }

  const now = new Date();
  const todayStr = formatDateDDMMYYYY(now);
  const yesterdayDate = new Date(now.getTime() - 24 * 3600 * 1000);
  const yesterdayStr = formatDateDDMMYYYY(yesterdayDate);
  const dayBeforeYesterdayDate = new Date(now.getTime() - 48 * 3600 * 1000);
  const dayBeforeYesterdayStr = formatDateDDMMYYYY(dayBeforeYesterdayDate);

  const cleanDraftForLLM = Object.fromEntries(Object.entries(existingDraft || {}).filter(([k]) => !k.startsWith('_')));

  const systemPrompt = `You are the Structured Data Extraction Agent for Enlight Metals CRM WhatsApp Bot.
The user is providing details for the action: "${action}".

REAL-TIME REFERENCE DATES (CRITICAL - ALWAYS USE THESE):
- Today: ${todayStr} (DD-MM-YYYY)
- Yesterday: ${yesterdayStr} (DD-MM-YYYY)
- Day Before Yesterday / Parso: ${dayBeforeYesterdayStr} (DD-MM-YYYY)
- Current Year: ${todayStr.slice(-4)}
- All relative dates like "today", "yesterday", "day before yesterday", "kal", "parso", "now" MUST be calculated relative to Today (${todayStr}) and Yesterday (${yesterdayStr}).
- NEVER output past years like 2024 or 2025 unless the user explicitly typed that specific year.

Extract the fields according to the following strict schema rules.
Return ONLY a valid JSON object (no markdown, no backticks, no explanation).

Schema by Action:

LOG_INQUIRY:
{
  "action": "LOG_INQUIRY",
  "company_name": "<Customer / Company Name, else null>",
  "email": "<Customer email address if mentioned, else null>",
  "contact_person": "<Customer Contact Person / Name if mentioned e.g. 'Sheetal Kumari', else null>",
  "contact_phone": "<10-digit mobile number if mentioned, else null>",
  "product_description": "<Summary of all products/quantities, else null>",
  "rate": <numeric target rate/price per unit if mentioned, else null>,
  "preferred_make": "<one of TATA, JSW, AM/NS India, SAIL, NMDC, Apollo, Others, else null>",
  "payment_terms": "<one of Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC, else null>",
  "delivery_location": "<e.g. Chakan Pune, Taloja, Aurangabad, else null>",
  "additional_notes": "<Exact literal text provided by user. NEVER summarize, rephrase, or alter user notes, else null>",
  "line_items": [
    {
      "sku_text": "<Literal product name mentioned by user e.g. 'Sheet', 'CR Sheet', 'HR Coil', 'MS Angle', 'Pipe', 'TMT Bar'>",
      "grade": "<Steel grade written by the user, e.g. E350, E250, E410, E450, SAILMA, Fe500, Fe550, Fe500D, Fe550D. If one grade is stated for the whole list, repeat it on every line. else null>",
      "description": "<Full product text e.g. 'MS Sheet 5MM THK (1250 x 2500)'>",
      "dimensions": "<Dimensions / specifications e.g. '1250 x 2500', '1000 x 2000 mm'>",
      "spec": "<Dimensions / specifications>",
      "hsn_sac": "<HSN code if known, else null>",
      "quantity": <numeric quantity e.g. 15>,
      "unit": "<MT | KG | PCS | Sheets | Nos, default MT>",
      "rate": <numeric rate per unit in INR without symbol e.g. 54000 or 20, else null>,
      "amount": <auto-calculated quantity * rate if rate mentioned, else null>
    }
  ],
  "entries": [
    {
      "company_name": "<Company Name>",
      "email": "<Email or null>",
      "contact_person": "<Contact Person or null>",
      "contact_phone": "<Phone or null>",
      "product_description": "<Product description>",
      "rate": <rate or null>,
      "preferred_make": "<make or null>",
      "payment_terms": "<payment terms or null>",
      "delivery_location": "<location or null>",
      "line_items": []
    }
  ]
}

UPDATE_INQUIRY:
{
  "action": "UPDATE_INQUIRY",
  "non_editable_field_requested": "<If the user asked to change a SYSTEM-GENERATED field (Inquiry ID, Inquiry Date, Logged By), its name e.g. 'Inquiry Date', else null>",
  "inquiry_id": "<Inquiry ID e.g. INQ-2026-0042, INQ-1BB6F1, INQ-B76516, INQ-0042, else null>",
  "company_name": "<Customer / Company Name e.g. 'SS Industries', else null>",
  "updates": {
    "product_description": "<if user requested general product text update, else null>",
    "rate": <numeric rate ONLY if a single overall rate was specified without mentioning product names, else null>,
    "preferred_make": "<one of TATA, JSW, AM/NS India, SAIL, NMDC, Apollo, Others if update requested, else null>",
    "payment_terms": "<one of Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC if update requested, else null>",
    "delivery_location": "<if user requested update, else null>",
    "email": "<Customer email if update requested, else null>",
    "additional_notes": "<Exact literal text provided by user if update requested. NEVER summarize, rephrase, or alter user notes, else null>",
    "stage": "<Open | Quoted | Negotiation | Won | Lost | On Hold if mentioned, else null>",
    "status": "<Open | Quoted | Negotiation | Won | Lost | On Hold if mentioned, else null>"
  },
  "line_item_updates": [
    {
      "sku_text": "<Product SKU or Name e.g. 'MS Sheet 5MM', 'MS Sheet 6MM', 'HR Coil', else null>",
      "description": "<Product description, else null>",
      "spec": "<Dimensions / specifications / thickness / size e.g. '8mm', '6mm', '1250 x 2500', else null>",
      "dimensions": "<Dimensions / specifications / thickness / size e.g. '8mm', '6mm', else null>",
      "rate": <numeric rate if specified for this product e.g. 20, 30, 54000, else null>,
      "quantity": <numeric quantity if specified for this product e.g. 15, 20, 78, else null>,
      "unit": "<MT | KG | PCS | Sheets, default MT>"
    }
  ]
}

IMPORTANT RULES FOR INQUIRIES:
- If a user provides line item updates with specifications, thickness, or dimensions (e.g. 'Line item: 78MT 8mm', 'HR Coil 8mm 78MT', 'change thickness to 8mm', 'change spec to 8mm'), extract the dimension/thickness into 'spec' and 'dimensions' ('8mm'), quantity into 'quantity' (78), and unit into 'unit' ('MT')! If product name is not explicitly mentioned (e.g. 'Line item: 78MT 8mm'), set sku_text and description to null or generic, while preserving spec/dimensions and quantity.
- If a user provides multiple products with individual rates (e.g. 'rate \n MS Sheet 5MM - 20 \n MS Sheet 6MM - 30'), put each product with its specific rate into 'line_item_updates' array! Do NOT put 20 as updates.rate, and do NOT put 'MS Sheet 5MM, MS Sheet 6MM' into updates.product_description.
- If a user provides multiple products with quantities (e.g. 'MS Sheet 5MM - 15 MT, MS Sheet 6MM - 20 MT'), parse each into line_items/line_item_updates with its respective quantity and unit.
- If a single rate is provided along with multiple products, apply that rate to all line items.

LOG_ORDER:
{
  "action": "LOG_ORDER",
  "inquiry_id": "<Inquiry ID e.g. INQ-F4D982, INQ-2026-0042, else null>",
  "company_name": "<Company Name, else null>",
  "po_number": "<Only an explicit edit to the generated system PO; otherwise null>",
  "reference_po_number": "<Customer/document PO or voucher number, else null>",
  "po_date": "<PO Date in DD-MM-YYYY format, else null>",
  "delivery_location": "<Delivery Location, else null>",
  "payment_terms": "<Payment Terms, else null>",
  "rate": <numeric rate per unit in INR without symbol e.g. 50000 or 58000 if mentioned at top level or single rate, else null>,
  "line_items": [
    {
      "sku_text": "<Core metal product name e.g. 'MS Plate 10mm', 'HR Coil'>",
      "description": "<Product name e.g. 'MS Plate 10mm', 'HR Coil'>",
      "spec": "<Dimensions / Spec e.g. '8X6000X1500', else null>",
      "dimensions": "<Dimensions / Spec, else null>",
      "hsn_sac": "<HSN code if mentioned, else null>",
      "quantity": <numeric quantity e.g. 10>,
      "unit": "<MT | KG | PCS | Sheets | Nos, default MT>",
      "rate": <numeric rate per unit in INR without symbol e.g. 58000>,
      "amount": <auto-calculated quantity * rate>
    }
  ],
  "entries": [
    {
      "inquiry_id": "<Inquiry ID>",
      "company_name": "<Company Name>",
      "po_number": "<PO Number>",
      "po_date": "<PO Date>",
      "delivery_location": "<Location>",
      "payment_terms": "<Payment Terms>",
      "rate": <rate or null>,
      "line_items": []
    }
  ]
}

UPDATE_ORDER:
{
  "action": "UPDATE_ORDER",
  "inquiry_id": "<Inquiry ID if mentioned e.g. INQ-936C7B, INQ-3C86DE, INQ-2026-0042, else null>",
  "po_number": "<Only a new/editable system PO when the user explicitly says system/internal/generated PO; otherwise null>",
  "reference_po_number": "<Customer/document PO to store as Reference PO, else null>",
  "company_name": "<Customer / Company Name if mentioned, else null>",
  "updates": {
    "po_number": "<new or attached PO number if updating/attaching to inquiry e.g. PO-2026-8899, else null>",
    "po_date": "<new PO date if updated, else null>",
    "delivery_date": "<new delivery date if updated e.g. 25-09-2026, else null>",
    "delivery_location": "<new delivery location if updated, else null>",
    "payment_terms": "<new payment terms if updated, else null>",
    "status": "<Pending | Processing | Dispatched | Delivered | Cancelled | Won if updated, else null>"
  },
  "line_item_updates": [
    {
      "operation": "<update | add | remove>",
      "item_reference": "<item number or product name>",
      "description": "<product name>",
      "spec": "<spec>",
      "hsn_sac": "<hsn>",
      "quantity": <numeric quantity or null>,
      "unit": "<unit or null>",
      "rate": <numeric rate or null>,
      "amount": <numeric amount or null>
    }
  ]
}

LOG_VISIT:
{
  "action": "LOG_VISIT",
  "company_name": "<Customer / Company Name visited, else null>",
  "person_met": "<Person met and/or designation, else null>",
  "contact_phone": "<10-digit phone number if provided, else null>",
  "city_location": "<City or location of visit, else null>",
  "visit_date": "<Visit date in DD-MM-YYYY format e.g. 10-09-2026, else null>",
  "visit_outcome": "<Positive | Negative | Neutral, else null>",
  "followup_action": "<specific follow up action if mentioned, else null>",
  "meeting_remarks": "<meeting remarks & requirements discussed, else null>",
  "email": "<email address if mentioned, else null>",
  "designation": "<job title / designation if mentioned, else null>",
  "customer_type": "<OEM | Fabricator | EPC | Manufacturer | Trader if mentioned, else null>",
  "visit_type": "<First Visit | Follow-up 1 | Follow-up 2 | Follow-up 3 | Regular Visit if mentioned, else null>",
  "customer_probability": "<Hot | Warm | Cold if mentioned, else null>",
  "product_details": "<detailed product specifications or grades discussed, else null>",
  "monthly_consumption": "<monthly consumption if mentioned, else null>",
  "current_requirement": "<current requirement collected if mentioned, else null>",
  "next_purchase_expected": "<expected next purchase date / timeframe, else null>",
  "delivery_location": "<delivery location if mentioned, else null>",
  "preferred_make": "<preferred brand / make if mentioned, else null>",
  "payment_terms": "<payment terms if mentioned, else null>",
  "entries": [
    {
      "company_name": "<Company Name visited>",
      "person_met": "<Person met, else null>",
      "contact_phone": "<Phone, else null>",
      "city_location": "<City / Location, else null>",
      "visit_date": "<Visit date in DD-MM-YYYY format, else null>",
      "visit_outcome": "<Positive | Negative | Neutral, else null>",
      "followup_action": "<Follow-up action, else null>",
      "meeting_remarks": "<Meeting remarks, else null>"
    }
  ]
}

UPDATE_VISIT:
{
  "action": "UPDATE_VISIT",
  "company_name": "<Customer / Company Name if mentioned (strip leading possessives like 'my' or 'our'), else null>",
  "visit_date": "<Existing Visit Date of the visit record to identify it, else null>",
  "updates": {
    "person_met": "<Person met if updated, else null>",
    "contact_phone": "<Contact phone if updated, else null>",
    "city_location": "<City / Location if updated, else null>",
    "visit_outcome": "<Positive | Negative | Neutral if updated, else null>",
    "visit_date": "<New visit date ONLY IF the user explicitly asked to change/update the visit date, else null>",
    "followup_action": "<Follow-up action if updated, else null>",
    "meeting_remarks": "<Meeting remarks if updated, else null>",
    "status": "<Completed | Follow-up Pending | Cancelled if updated, else null>",
    "email": "<Email if updated, else null>",
    "designation": "<Designation if updated, else null>",
    "customer_type": "<OEM | Fabricator | EPC | Manufacturer | Trader if updated, else null>",
    "visit_type": "<First Visit | Follow-up 1-3 | Regular Visit if updated, else null>",
    "customer_probability": "<Hot | Warm | Cold if updated, else null>",
    "product_details": "<Product Details if updated, else null>",
    "monthly_consumption": "<Monthly Consumption if updated, else null>",
    "current_requirement": "<Current Requirement if updated, else null>",
    "next_purchase_expected": "<Next Purchase Expected if updated, else null>",
    "delivery_location": "<Delivery Location if updated, else null>",
    "preferred_make": "<Preferred Make if updated, else null>",
    "payment_terms": "<Payment Terms if updated, else null>"
  }
}

LOG_NEW_CUSTOMER:
{
  "action": "LOG_NEW_CUSTOMER",
  "company_name": "<Customer / Company Name, else null>",
  "contact_person": "<Owner / Contact Person Name, else null>",
  "mobile_number": "<10-digit mobile number, digits only, else null>",
  "delivery_location": "<City / Delivery Address / Location, else null>",
  "email": "<Email address if mentioned, else null>",
  "gst_number": "<GST number if mentioned, else null>",
  "entries": [
    {
      "company_name": "<Company Name>",
      "contact_person": "<Contact Person>",
      "mobile_number": "<Mobile Number>",
      "delivery_location": "<Location>",
      "email": "<Email>",
      "gst_number": "<GST>"
    }
  ]
}

LOG_COMPLAINT:
{
  "action": "LOG_COMPLAINT",
  "company_name": "<Company / Customer Name, else null>",
  "complaint_date": "<Complaint Date in DD-MM-YYYY format e.g. 27-09-2026 if mentioned, else null>",
  "raised_by": "<Contact person name at customer's side who raised the complaint e.g. 'Rajesh Sharma', else null>",
  "affected_product": "<Product name from the official 22 catalog products list (e.g. 'HR Coil', 'HR Sheet', 'CR Sheet', 'MS Angle', etc.) if explicitly named, or null if only generic words like '2 coils', 'material', 'defective goods' are mentioned>",
  "linked_inquiry_or_po": "<Linked Inquiry ID e.g. INQ-8971B1 or PO Number e.g. PO-Apex-4567, 6712 if mentioned, else null>",
  "complaint_type": "<Quality Defect | Physical Damage | Quantity Shortage | Delivery Delay | Billing Mismatch | Specification Mismatch | Other, if mentioned or inferred from issue, else null>",
  "challan_no": "<Invoice or Delivery Challan number e.g. 'CH-9081', 'INV-1029', else null>",
  "complaint_description": "<Detailed complaint description including issue details and any quantities mentioned, else null>",
  "corrective_action": "<Corrective action taken or proposed if mentioned, else null>",
  "customer_communication": "<Communication or update shared with customer if mentioned, else null>",
  "resolution_notes": "<Resolution notes if mentioned, else null>",
  "resolution_date": "<Resolution date in DD-MM-YYYY format if mentioned, else null>",
  "entries": [
    {
      "company_name": "<Company Name>",
      "complaint_date": "<DD-MM-YYYY>",
      "raised_by": "<Raised By>",
      "affected_product": "<Product from official catalog, else null>",
      "linked_inquiry_or_po": "<Linked ID, else null>",
      "complaint_type": "<Type>",
      "challan_no": "<Challan/Invoice No>",
      "complaint_description": "<Description>",
      "corrective_action": "<Action>",
      "customer_communication": "<Communication>",
      "resolution_notes": "<Resolution Notes>",
      "resolution_date": "<Resolution Date>"
    }
  ]
}

UPDATE_COMPLAINT:
{
  "action": "UPDATE_COMPLAINT",
  "company_name": "<Customer / Company Name if mentioned, else null>",
  "linked_inquiry_or_po": "<Linked PO Number or Inquiry ID e.g. INQ-8971B1, PO-2026-TI-101 if mentioned, else null>",
  "updates": {
    "raised_by": "<Contact person name at customer if updated, else null>",
    "complaint_type": "<Quality Defect | Physical Damage | Quantity Shortage | Delivery Delay | Billing Mismatch | Specification Mismatch | Other if updated, else null>",
    "complaint_description": "<if updated, else null>",
    "status": "<Pending | In Progress | Resolved | Closed if updated, else null>",
    "resolution_notes": "<if updated, else null>"
  }
}

CRITICAL RULES:
1. Extract from natural language, free-form text, or lists.
2. For numeric amounts/rates, strip ₹ and currency symbols.
3. Normalize all dates to DD-MM-YYYY format (e.g. "today" -> current date, "yesterday" -> yesterday date, "10/9/26" -> "10-09-2026").
4. If a field was NOT mentioned by the user, leave it as null or empty string. NEVER fabricate or guess.
5. In LOG_INQUIRY and LOG_ORDER: if multiple products are listed, extract EACH individual item into the line_items array with its own product name, dimensions/spec, quantity, and unit.
6. If an existing draft is provided, you are completing or updating fields for THAT ACTIVE DRAFT (${cleanDraftForLLM.company_name || 'the current draft'}). PRESERVE existing draft fields unless explicitly changed by the user message.
6b. In LOG_ORDER, the platform always supplies a generated system PO. Put a customer/document/voucher PO in 'reference_po_number', never replace the generated 'po_number' unless the user explicitly asks to edit the system/internal PO.
6a. VISIT OUTCOME AUTHORITY (CRITICAL): In LOG_VISIT and UPDATE_VISIT, \`visit_outcome\` is an explicit field, not sentiment analysis. If the active draft already has an outcome, return null for \`visit_outcome\` unless the user explicitly supplies or changes the outcome (for example, "Visit Outcome: Negative" or "change outcome to Neutral"). Never infer or change it from meeting remarks, requirements, or general discussion text.
7. MULTIPLE ENTITIES / COMPANIES (CRITICAL): If and only if the user message itself introduces multiple distinct companies/records (e.g. 'Visited two customers today: ABC Steel in Mumbai (positive) and Sharma Construction in Pune (neutral)' or 'Inquiry from ABC for 10 MT and XYZ for 20 MT'):
Output an 'entries' array containing a separate object for EACH individual customer/visit/inquiry/complaint!
If only a single company is mentioned or if filling missing fields for an existing draft, return the top-level fields (e.g. company_name, person_met, contact_phone, etc.) and do NOT output an entries array.
8. In LOG_ORDER: If the user provides an Inquiry ID (e.g. INQ-F4D982 or 'regarding inquiry INQ-F4D982'), extract the inquiry ID into 'inquiry_id'.
9. In UPDATE_ORDER: If the user explicitly asks to change the system/internal/generated PO, extract it into 'po_number' and 'updates.po_number'. If the user mentions a customer/document/voucher PO, extract it into 'reference_po_number' and never replace the canonical system PO.
10. PRODUCT EXTRACTION & CATALOG INTEGRITY RULES (CRITICAL):
- Extract the EXACT, LITERAL product term mentioned by the user (e.g. 'Sheet', 'Coil', 'Plate', 'Pipe', 'Tube', 'MS Sheet', 'HR Sheet', 'CR Coil', 'MS Angle', 'TMT Bar').
- ZERO FABRICATION / ZERO AUTO-CONVERSION: NEVER guess, assume, or auto-convert generic or ambiguous words (e.g. 'sheet', 'coil', 'plate', 'pipe', 'tube', 'bar', 'rod') to a specific catalog variant.
  - If the user says "sheet", extract sku_text as "Sheet" (NEVER auto-convert "sheet" to "HR Sheet" or "CR Sheet").
  - If the user says "coil", extract sku_text as "Coil" (NEVER auto-convert "coil" to "HR Coil").
  - If the user says "plate", extract sku_text as "Plate" (NEVER auto-convert "plate" to "HR Plate").
  - If the user says "pipe", extract sku_text as "Pipe" (NEVER auto-convert "pipe" to "MS Round Pipe").
  The backend validation engine will automatically detect generic/ambiguous terms and ask the user to clarify the exact catalog variant.
- In LOG_COMPLAINT: if no official catalog product name is mentioned, leave 'affected_product' as null so the system automatically resolves it from the linked Order / PO!
- "dimensions" / "spec": Extract thickness, gauge, width, and size (e.g. '8mm', '1250 x 2500', '50x50x6').
- "grade": When the user writes a steel grade such as E350, E250, E410, E450, SAILMA, Fe500, Fe550, Fe500D, or Fe550D, return it on each line item. If that grade is written once before a size list (e.g. "HR E350" then several sizes), repeat the same grade on every line. Do not put make names such as SAIL or NMDC in grade.
11. TOTAL ORDER VALUE / DIRECT MONEY MODIFICATION (CRITICAL):
- In UPDATE_ORDER: Total order value (or total money / total amount / grand total) is a computed calculation derived strictly from line item rates, quantities, and taxes.
- Users CANNOT directly modify or override the total order value at the header level.
- If the user asks to change the total value or money directly (e.g. 'Change the total Value from 2,36,000 to 2,50,000' or 'update total amount to 2,50,000'), do NOT put 'total_amount' or 'total_value' into updates, and do NOT create a line item update with only amount.
- When the user edits company name, PO number, PO date, delivery location, payment terms, or other fields, do NOT output 'updates.total_amount' or dummy 'line_item_updates'.
- You MUST extract ONLY the specific valid updates requested in the user message.
12. UPDATE_COMPLAINT RESOLUTION NOTES (CRITICAL):
- In UPDATE_COMPLAINT, 'updates.resolution_notes' MUST strictly contain ONLY actual details describing how the issue was resolved (e.g. 'replacement 10 MT plates dispatched and accepted', 'credit note CN-102 issued for ₹20,000', 'commercial discount of ₹500/MT approved').
- NEVER put the user's action command, request text, or phrase (e.g. 'update this po PO: PO-20260923-9085 compliant and mark it resolved', 'mark as resolved', 'resolve my last complaint', 'close the complaint') into 'updates.resolution_notes'.
- If the user only commands to resolve/mark resolved/close the complaint without providing specific resolution notes, set 'updates.status' to 'Resolved', but leave 'updates.resolution_notes' as null!
13. SYSTEM-GENERATED AND NON-EDITABLE FIELDS (CRITICAL):
- Inquiry ID (e.g. INQ-XXXXXX), Order ID, Complaint Ticket ID, Visit Log ID, and Customer ID are system-generated record identifiers. They CANNOT be edited, renamed, or modified.
- Customer / Company Name in update workflows (UPDATE_INQUIRY, UPDATE_ORDER, UPDATE_VISIT, UPDATE_COMPLAINT) is tied to the existing database record and cannot be changed.
- If the user's message is ONLY asking to change/edit a system-generated or non-editable field (e.g. 'change inquiry id to IN879', 'change ticket id to 101', 'change customer to ABC'), return null for all updates. NEVER hallucinate, guess, or populate unmentioned fields (like payment_terms, rate, etc.)!
- Other system-generated fields that CANNOT be edited: Deal ID, Enquiry Number, Logged By / Created By, Creation Date, Salesperson.
- UPDATE_INQUIRY FIELD OWNERSHIP (use this to decide every request):
  * SYSTEM-GENERATED (never editable): Inquiry ID, Inquiry Date / date of the inquiry / created date (the inquiry has NO editable date field), Logged By / Salesperson, Total Value.
  * USER-ENTERED (editable): Stage / Status, Quantity, Rate, Delivery Location, Payment Terms, Preferred Make, Additional Notes, product line items.
  * For a request like 'update the date of the inquiry to tomorrow', 'change inquiry date to 25-09-2026', 'date badlo', 'backdate this inquiry', set "non_editable_field_requested" to 'Inquiry Date' and leave ALL updates null. NEVER convert the requested date into additional_notes, payment_terms, or any other field.
  * For 'change inquiry id to IN897' set "non_editable_field_requested" to 'Inquiry ID'; for 'change logged by to Ramesh' set it to 'Logged By'.
  * If the message ALSO contains a valid user-entered change, extract that change normally AND still set "non_editable_field_requested".
- Recognise these requests in any phrasing, word order, or Hinglish, e.g. 'edit inquiry id for Rajeshwari Shah Industries to In897', 'inquiry number badlo to 897', 'INQ-F2785B ko IN897 kar do', 'rename deal id', 'set enquiry no as 12', 'change created date to 01-09-2026', 'change logged by to Ramesh'.
- The NEW value the user wants for a system-generated field (e.g. 'In897', 'IN879', '897') is NOT data: NEVER put it into 'inquiry_id', 'company_name', 'updates', 'line_item_updates', or any other field. 'inquiry_id' may ONLY hold an EXISTING inquiry ID the user references to pick a record (e.g. 'update INQ-F2785B rate to 50000' -> inquiry_id 'INQ-F2785B').
- If the same message ALSO requests a valid editable change (e.g. 'change inquiry id to IN897 and rate to 50000'), extract ONLY the valid editable change (rate) and ignore the system-generated part.
14. STRICT UPDATE EXTRACTION IN UPDATE FLOWS (CRITICAL):
- In UPDATE_VISIT, UPDATE_ORDER, UPDATE_INQUIRY, UPDATE_COMPLAINT: 'updates' MUST contain ONLY the fields that the user EXPLICITLY requested to change/update in their message.
- If the user says 'update contact person phone to 5612788945', populate ONLY 'updates.contact_phone'. Do NOT put 'visit_date', 'person_met', 'city_location', etc. into 'updates' unless the user explicitly requested to update those specific fields.
- NEVER put existing unedited fields from the draft into 'updates'.
15. ZERO SUMMARIZATION OF NOTES / ADDITIONAL NOTES / REMARKS (CRITICAL):
- When extracting 'additional_notes', 'meeting_remarks', 'remarks', 'discussion_notes', 'notes', or comments, NEVER summarize, rewrite, rephrase, or generalize the user's words (e.g. if the user says 'we will be having follow up', extract 'we will be having follow up' EXACTLY as typed. NEVER convert or summarize it to 'Follow-up planned').
- PRESERVE the exact verbatim text entered by the user.
16. NUMERIC OPTION SELECTORS (CRITICAL):
- If the user message is purely an option number or choice (e.g. '1', '2', '3', 'option 2', 'choice 1', 'second'), it is an option selection from a menu or clarification list.
- NEVER extract or interpret an option selector number as a rate, price, quantity, or dimension!
- Leave 'rate' and 'line_items[].rate' as null unless the user explicitly mentioned words like 'rate', 'price', '@', '₹', '/MT', 'per ton', etc.
17. UPDATE_COMPLAINT FIELD RESTRICTION (CRITICAL):
- After a complaint is logged, ONLY these fields may be updated: Complaint Raised By, Complaint Type, Complaint Description, Status, and Resolution Notes.
- Complaint Date, customer/company, linked Inquiry/PO, product/material, challan number, attachments/evidence, corrective action, customer communication, and resolution date are locked. Do not return them in \`updates\`.
`;

  const userPrompt = `Existing Active Draft:
${JSON.stringify(cleanDraftForLLM, null, 2)}

User Message:
"${userInput}"`;

  const verbatimNotes = extractVerbatimNotes(userInput);

  try {
    const response = await invokeWithFallback([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    let raw = typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
    if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
    else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

    let parsed = safeParseJSON(raw, null);
    if (parsed && isNumericOptionSelector(userInput)) {
      delete parsed.rate;
      if (parsed.updates) delete parsed.updates.rate;
      if (Array.isArray(parsed.line_items)) {
        parsed.line_items.forEach(it => {
          delete it.rate;
          delete it.amount;
        });
      }
      if (Array.isArray(parsed.line_item_updates)) {
        parsed.line_item_updates.forEach(it => {
          delete it.rate;
          delete it.amount;
        });
      }
    }
    if (verbatimNotes) {
      if (!parsed) parsed = {};
      if (action === 'LOG_INQUIRY') {
        parsed.additional_notes = verbatimNotes;
      } else if (action === 'UPDATE_INQUIRY') {
        parsed.updates = parsed.updates || {};
        parsed.updates.additional_notes = verbatimNotes;
        parsed.additional_notes = verbatimNotes;
      } else if (action === 'LOG_VISIT') {
        parsed.meeting_remarks = verbatimNotes;
      } else if (action === 'UPDATE_VISIT') {
        parsed.updates = parsed.updates || {};
        parsed.updates.meeting_remarks = verbatimNotes;
        parsed.meeting_remarks = verbatimNotes;
      }
    }

    if (parsed) {
      const nonEditableRequested = action === 'UPDATE_INQUIRY' ? normalizeInquirySystemFieldLabel(parsed.non_editable_field_requested) : null;
      delete parsed.non_editable_field_requested;
      const merged = mergeDraft(action, existingDraft, parsed, userInput);
      if (merged && typeof merged === 'object') {
        delete merged._non_editable_request;
        if (nonEditableRequested) merged._non_editable_request = nonEditableRequested;
      }
      return merged;
    }
  } catch (err) {
    console.error('[CatalogFlow] LLM extraction error:', err.message);
  }

  if (verbatimNotes) {
    const fallbackParsed = {};
    if (action === 'LOG_INQUIRY') {
      fallbackParsed.additional_notes = verbatimNotes;
    } else if (action === 'UPDATE_INQUIRY') {
      fallbackParsed.updates = { additional_notes: verbatimNotes };
      fallbackParsed.additional_notes = verbatimNotes;
    } else if (action === 'LOG_VISIT') {
      fallbackParsed.meeting_remarks = verbatimNotes;
    } else if (action === 'UPDATE_VISIT') {
      fallbackParsed.updates = { meeting_remarks: verbatimNotes };
      fallbackParsed.meeting_remarks = verbatimNotes;
    }
    return mergeDraft(action, existingDraft, fallbackParsed, userInput);
  }

  return existingDraft;
}

const TOTAL_VALUE_PERMISSION_NOTICE = '⚠️ *Permission Notice:* You do not have permission to directly change the Total Order Value. Total value is calculated automatically from individual line item quantities and rates. To adjust the total value, please update individual line item rates or quantities.';
const COMPLAINT_EDITABLE_UPDATE_FIELDS = new Set([
  'raised_by',
  'complaint_type',
  'complaint_description',
  'description',
  'status',
  'resolution_notes',
]);

const COMPLAINT_UPDATE_FIELD_LABELS = {
  complaint_date: 'Complaint Date',
  customer_name: 'Customer / Company Name',
  linked_inquiry_or_po: 'Linked Inquiry / PO',
  deal_id: 'Linked Inquiry / PO',
  po_number: 'Linked Inquiry / PO',
  affected_product: 'Product / Material',
  product_name: 'Product / Material',
  product: 'Product / Material',
  challan_no: 'Invoice / Challan No.',
  attachments: 'Evidence / Attachments',
  corrective_action: 'Corrective Action',
  customer_communication: 'Customer Communication',
  resolution_date: 'Resolution Date',
};

function restrictComplaintUpdateFields(updates = {}) {
  const allowed = {};
  const locked = [];
  for (const [field, value] of Object.entries(updates || {})) {
    if (COMPLAINT_EDITABLE_UPDATE_FIELDS.has(field)) {
      allowed[field] = value;
    } else if (value !== null && value !== undefined && value !== '') {
      locked.push(COMPLAINT_UPDATE_FIELD_LABELS[field] || field.replace(/_/g, ' '));
    }
  }
  return { allowed, locked: [...new Set(locked)] };
}

function detectLockedComplaintUpdateFields(userInput = '') {
  const text = String(userInput || '');
  const editVerb = '(?:change|edit|update|modify|set|replace|correct|revise|amend|alter)';
  const locked = [];
  const hasEdit = new RegExp(`\\b${editVerb}\\b`, 'i').test(text);
  if (!hasEdit) return locked;

  const addIf = (pattern, label) => {
    if (pattern.test(text)) locked.push(label);
  };

  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\b(?:customer|company|client|party)\\s*name\\b`, 'i'), 'Customer / Company Name');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\b(?:linked\\s*)?(?:po|purchase\\s*order|inquiry|deal)\\s*(?:number|no\\.?|id)?\\b`, 'i'), 'Linked Inquiry / PO');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\bcomplaint\\s*date\\b`, 'i'), 'Complaint Date');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\b(?:product|material|affected\\s*product)\\b`, 'i'), 'Product / Material');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\b(?:invoice|challan)\\b`, 'i'), 'Invoice / Challan No.');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\b(?:attachment|evidence|photo|document)\\b`, 'i'), 'Evidence / Attachments');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\bcorrective\\s*action\\b`, 'i'), 'Corrective Action');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\bcustomer\\s*communication\\b`, 'i'), 'Customer Communication');
  addIf(new RegExp(`\\b${editVerb}\\b[\\s\\S]{0,50}\\bresolution\\s*date\\b`, 'i'), 'Resolution Date');

  return [...new Set(locked)];
}

function detectTotalValueUpdateAttempt(text, extractedData) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (!clean) return false;

  // Check if user input explicitly refers to modifying the total value / money / total amount
  const hasTotalKeywords = /\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|total\s*money)\b/i.test(clean);
  if (!hasTotalKeywords) {
    return false;
  }

  // Verify modification action/intent targeting total value (prevent false positives on company name, PO, quantity/tonnage)
  if (
    /\b(?:change|update|set|modify|make|edit|increase|decrease|reduce|fix)\b.*?\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|total\s*money)\b/i.test(clean) ||
    /\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|total\s*money)\b.*?\b(?:change|update|set|modify|from|to|is|=|karo|badlo)\b/i.test(clean) ||
    /\btotal\s+(?:order\s+)?(?:value|amount)\s+(?:from\s+[\d,.]+\s+)?to\s+[\d,.]+/i.test(clean) ||
    /\b(?:change|update|set|modify)\s+(?:the\s+)?total\s+(?:order\s+)?(?:value|amount)\b/i.test(clean) ||
    /\b(?:total\s*(?:order\s*)?(?:value|amount))\s*[:=]\s*₹?\s*[\d,.]+/i.test(clean)
  ) {
    return true;
  }

  return false;
}

function getAllowedFieldsListForAction(action) {
  switch (action) {
    case 'LOG_INQUIRY':
      return `- *Rate / Target Price*\n- *Quantity & Unit (e.g. 25 MT)*\n- *Product Specifications / Dimensions*\n- *Payment Terms:* ${INQUIRY_PAYMENT_TERMS.join(', ')}\n- *Delivery Location*\n- *Email ID*\n- *Preferred Brand:* ${INQUIRY_PREFERRED_MAKES.join(', ')}\n- *Additional Notes*`;
    case 'UPDATE_INQUIRY':
      return `- *Rate / Target Price*\n- *Quantity & Product Specifications / Dimensions (e.g. 8mm, 78 MT)*\n- *Payment Terms:* ${INQUIRY_PAYMENT_TERMS.join(', ')}\n- *Delivery Location*\n- *Email ID*\n- *Preferred Brand:* ${INQUIRY_PREFERRED_MAKES.join(', ')}\n- *Additional Notes*`;
    case 'LOG_ORDER':
      return `- *PO Number (e.g. PO-2026-001)*\n- *PO Date*\n- *Delivery Location*\n- *Payment Terms*\n- *Product Rates & Quantities*`;
    case 'UPDATE_ORDER':
      return `• *PO Number*\n• *PO Date / Delivery Date*\n• *Delivery Location*\n• *Payment Terms*\n• *Status (Pending, Processing, Dispatched, Delivered, Cancelled)*\n• *Line Item Rates & Quantities*`;
    case 'LOG_VISIT':
      return `- *Person Met*\n- *Contact Phone*\n- *City / Location*\n- *Visit Date*\n- *Visit Outcome (Positive / Neutral / Negative)*\n- *Meeting Remarks & Discussion Notes*`;
    case 'UPDATE_VISIT':
      return `- *Person Met*\n- *Contact Phone*\n- *Designation & Email*\n- *City / Location*\n- *Customer Type & Visit Type*\n- *Visit Outcome & Probability*\n- *Product Details & Monthly Consumption*\n- *Current Requirement & Next Purchase Expected*\n- *Delivery Location & Preferred Make & Payment Terms*\n- *Follow-up Action & Date*\n- *Meeting Remarks*\n- *Add Photo / Document (Attach additional site photos)*\n- *Status*`;
    case 'LOG_COMPLAINT':
      return `- *Complaint Date*\n- *Complaint Raised By*\n- *Linked Inquiry ID / PO Number*\n- *Affected Product*\n- *Complaint Type*\n- *Invoice / Challan No.*\n- *Complaint Description*\n- *Evidence Attachments (Max 3)*\n- *Corrective Action*\n- *Customer Communication*\n- *Resolution Notes*\n- *Resolution Date*`;
    case 'UPDATE_COMPLAINT':
      return `- *Complaint Raised By*\n- *Complaint Type*\n- *Complaint Description*\n- *Status (Pending, In Progress, Resolved, Closed)*\n- *Resolution Notes*`;
    case 'LOG_NEW_CUSTOMER':
      return `- *Company Name*\n- *Contact Person*\n- *Mobile Number*\n- *Delivery Location / City*\n- *Email Address*\n- *GST Number*`;
    default:
      return `- *Rate*\n- *Quantity*\n- *Payment Terms*\n- *Delivery Location*`;
  }
}

function detectNonEditableFieldAttempt(action, text, draft = {}) {
  if (!text || typeof text !== 'string') return { isNonEditable: false };
  const clean = text.trim();
  if (!clean) return { isNonEditable: false };

  // Fast bypass: If user is explicitly targeting an editable field (notes, remarks, rate, qty, payment terms, delivery location, etc.)
  const isExplicitEditableField = /^(?:(?:change|edit|update|modify|set|alter|revise|amend|replace)\s+(?:the\s+)?)?(?:additional\s*notes?|notes?|remarks?|meeting\s*remarks?|discussion\s*notes?|resolution\s*notes?|comments?|description|rate|price|target\s*price|bhav|quantity|qty|payment\s*terms?|delivery\s*location|location|city|person\s*met|contact\s*person|contact\s*phone|phone|mobile|email(?:\s*id)?|visit\s*date|po\s*number|po\s*no|po\s*date|status|stage|preferred\s*make|make)\s*(?:to|as|is|:|=|\s+-)\s*/i.test(clean);
  if (isExplicitEditableField) {
    return { isNonEditable: false };
  }

  // 1. Inquiry ID attempt
  const isInqIdChange =
    /\b(?:change|edit|update|modify|set|alter|fix|revise|amend|make|replace)\b.*?\b(?:inquiry\s*id|inq\s*id|deal\s*id|enquiry\s*id|inquiry\s*no|inq\s*no|deal\s*no)\b/i.test(clean) ||
    /\b(?:inquiry\s*id|inq\s*id|deal\s*id|enquiry\s*id|inquiry\s*no|inq\s*no|deal\s*no)\b.*?\b(?:change|edit|update|modify|set|to|is|=|karo|badlo)\b/i.test(clean) ||
    /^(?:change|edit|update|modify|set)\s+(?:the\s+)?(?:inquiry|inq|deal|enquiry)\s+(?:id|number|no|code)\b/i.test(clean) ||
    /^(?:inquiry|inq|deal|enquiry)\s+(?:id|number|no|code)\s*(?:to|as|=|is|:)\s*[A-Za-z0-9_-]+/i.test(clean);

  if (isInqIdChange) {
    const currentInq = draft._inquiry_display_id || draft.inquiry_id || (action === 'LOG_INQUIRY' ? 'auto-generated' : 'current inquiry');
    return {
      isNonEditable: true,
      fieldName: 'Inquiry ID',
      message: `*Inquiry ID is system-generated and cannot be edited.*\n\n- Inquiry IDs (e.g. *${currentInq}*) are generated automatically by the CRM and cannot be modified or renamed.\n- If you meant to update a *different* inquiry, please reply *Cancel* and start an update for that Inquiry ID or Customer Name.`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
      compactReply: action === 'UPDATE_INQUIRY' ? buildInquirySystemFieldReply('Inquiry ID', draft._inquiry_display_id || null) : null,
    };
  }

  // 2. Total Order Value / Total Amount attempt
  const isTotalValueChange =
    /\b(?:change|edit|update|modify|set|alter|fix|make|increase|decrease|reduce)\b.*?\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|money)\b/i.test(clean) ||
    /\b(?:total\s*(?:order\s*)?(?:value|amount|price)|order\s*(?:value|amount)|grand\s*total|money)\b.*?\b(?:change|edit|update|set|modify|from|to|is|=|karo|badlo)\b/i.test(clean) ||
    /\btotal\s+(?:value|amount)\s+(?:from\s+[\d,.]+\s+)?to\s+[\d,.]+/i.test(clean) ||
    /^(?:change|edit|update|modify|set)\s+(?:the\s+)?total\s+(?:value|amount)\b/i.test(clean);

  if (isTotalValueChange) {
    return {
      isNonEditable: true,
      fieldName: 'Total Order Value',
      message: `*Total Order Value is system-calculated and cannot be edited directly.*\n\n- Total value is calculated automatically from individual item rates and quantities (Rate x Quantity + Taxes).\n- To adjust the total value, please update individual product rates or quantities.`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
    };
  }

  // 3. Customer / Company Name in Record Update flows (UPDATE_INQUIRY, UPDATE_ORDER, UPDATE_VISIT, UPDATE_COMPLAINT)
  if (['UPDATE_INQUIRY', 'UPDATE_ORDER', 'UPDATE_VISIT', 'UPDATE_COMPLAINT'].includes(action)) {
    const isCustomerSubField = /\b(?:customer\s+(?:communication|update|type|probability|requirement|feedback|notes)|contact\s+(?:person|phone|mobile|number))\b/i.test(clean);

    const isCustomerChange = !isCustomerSubField && (
      /^(?:change|edit|update|modify|set|alter|switch|replace)\s+(?:the\s+)?(?:customer(?:\s*name)?|company(?:\s*name)?|party(?:\s*name)?|client(?:\s*name)?)\s*(?:to|as|=|is|:|\s)\s*[A-Za-z0-9]/i.test(clean) ||
      /^(?:customer(?:\s*name)?|company(?:\s*name)?|party(?:\s*name)?|client(?:\s*name)?)\s*(?:to|as|=|is|:)\s*[A-Za-z0-9]/i.test(clean) ||
      /^(?:change|switch|replace)\s+(?:the\s+)?(?:customer|company|party|client)\b/i.test(clean)
    );

    if (isCustomerChange) {
      let currentCust = draft.company_name;
      if (!currentCust) {
        const match = clean.match(/(?:for|of|regarding|on)\s+([A-Za-z0-9\s&.,'-]+?)(?:,|\s+change|\s+edit|\s+update|\s+set|\s+modify|\s+to|$)/i);
        if (match && match[1] && !/^(?:the|a|an|customer|visit|order|inquiry|complaint)$/i.test(match[1].trim())) {
          currentCust = match[1].trim();
        }
      }
      currentCust = currentCust || 'the current customer';
      const recordType = getActionFriendlyName(action);
      return {
        isNonEditable: true,
        fieldName: 'Customer Name',
        message: `*Customer Name cannot be edited for an existing record.*\n\n- This ${recordType} is permanently linked to *${currentCust}* in the CRM.\n- If this belongs to a different customer, please reply *Cancel* and start a new update with the correct customer name.`,
        allowedFieldsList: getAllowedFieldsListForAction(action),
      };
    }
  }

  // 4. Order ID / Database Internal ID
  const isOrderIdChange =
    /\b(?:change|edit|update|modify|set|alter)\b.*?\b(?:order\s*id|internal\s*id|deal\s*id)\b/i.test(clean) ||
    /\b(?:order\s*id|internal\s*id|deal\s*id)\b.*?\b(?:change|edit|update|set|modify|to|is|=|karo|badlo)\b/i.test(clean);

  if (isOrderIdChange && !/\b(?:po\s*number|po\s*no|po#)\b/i.test(clean)) {
    return {
      isNonEditable: true,
      fieldName: 'Order ID',
      message: `*Order ID is system-generated and cannot be edited.*\n\n- Internal Order IDs are generated automatically by the CRM.\n- Note: If you want to update the Customer PO Number, please specify "PO Number: PO-XXXX".`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
    };
  }

  // 5. Visit ID / Log ID
  const isVisitIdChange =
    /\b(?:change|edit|update|modify|set)\b.*?\b(?:visit\s*id|log\s*id|visit\s*no)\b/i.test(clean);

  if (isVisitIdChange) {
    return {
      isNonEditable: true,
      fieldName: 'Visit ID',
      message: `*Visit ID is system-generated and cannot be edited.*\n\n- Visit log IDs are generated automatically by the CRM.`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
    };
  }

  // 6. Complaint Ticket ID
  const isComplaintIdChange =
    /\b(?:change|edit|update|modify|set)\b.*?\b(?:complaint\s*id|ticket\s*id|ticket\s*no|ticket\s*number|complaint\s*no)\b/i.test(clean);

  if (isComplaintIdChange) {
    return {
      isNonEditable: true,
      fieldName: 'Complaint Ticket ID',
      message: `*Complaint Ticket ID is system-generated and cannot be edited.*\n\n- Complaint ticket numbers are assigned automatically by the CRM.`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
    };
  }

  // 7. Linked Deal / PO in Complaint Updates
  if (action === 'UPDATE_COMPLAINT') {
    const isLinkedDealChange =
      /\b(?:change|edit|update|modify|set|switch|replace)\b.*?\b(?:linked\s*(?:inquiry|po|order|deal)|po\s*number|inquiry\s*id)\b/i.test(clean);

    if (isLinkedDealChange) {
      return {
        isNonEditable: true,
        fieldName: 'Linked Inquiry/PO',
        message: `*Linked Inquiry/PO cannot be changed for an existing complaint.*\n\n- This complaint is permanently tied to its original order reference.\n- To file a complaint for a different order, please reply *Cancel* and log a new complaint.`,
        allowedFieldsList: getAllowedFieldsListForAction(action),
      };
    }
  }

  // 8. Customer ID in LOG_NEW_CUSTOMER
  if (action === 'LOG_NEW_CUSTOMER') {
    const isCustIdChange =
      /\b(?:change|edit|update|modify|set)\b.*?\b(?:customer\s*id|client\s*id|account\s*id)\b/i.test(clean);

    if (isCustIdChange) {
      return {
        isNonEditable: true,
        fieldName: 'Customer ID',
        message: `*Customer ID is system-generated and cannot be edited.*\n\n- Customer Master IDs are generated automatically upon onboarding.`,
        allowedFieldsList: getAllowedFieldsListForAction(action),
      };
    }
  }

  // 9. System Audit Fields (Logged By, Creation Date, Salesperson Phone)
  const isAuditFieldChange =
    /\b(?:change|edit|update|modify|set)\b.*?\b(?:logged\s*by|created\s*by|created\s*date|creation\s*date|salesperson(?:\s*phone|\s*id)?)\b/i.test(clean);

  if (isAuditFieldChange) {
    return {
      isNonEditable: true,
      fieldName: 'Audit Metadata',
      message: `*Audit metadata (Logged By / Creation Date) is system-generated and cannot be edited.*`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
      compactReply: action === 'UPDATE_INQUIRY' ? buildInquirySystemFieldReply('Logged By / Creation Date', draft._inquiry_display_id || null) : null,
    };
  }

  // 10. Tax / GST Calculation
  const isTaxChange =
    /\b(?:change|edit|update|modify|set)\b.*?\b(?:gst\s*(?:rate|amount|percentage|%)?|tax\s*(?:rate|amount|percentage|%)?|cgst|sgst|igst)\b/i.test(clean);

  if (isTaxChange) {
    return {
      isNonEditable: true,
      fieldName: 'GST / Taxes',
      message: `*GST and Tax calculations are computed automatically based on product HSN codes and cannot be edited directly.*`,
      allowedFieldsList: getAllowedFieldsListForAction(action),
    };
  }

  // 11. Photo Replacement / Deletion Attempt on Visits (Audit Trail Protection)
  if (['LOG_VISIT', 'UPDATE_VISIT'].includes(action)) {
    const isPhotoReplaceAttempt =
      /\b(?:replace|delete|remove|overwrite|swap)\b.*?\b(?:photo|pic|picture|image|attachment)s?\b/i.test(clean) ||
      /\b(?:photo|pic|picture|image|attachment)s?\b.*?\b(?:replace|delete|remove|overwrite|swap|badlo|hatao)\b/i.test(clean);

    if (isPhotoReplaceAttempt) {
      return {
        isNonEditable: true,
        fieldName: 'Photo Attachment',
        message: `*Previously uploaded photos cannot be replaced or removed.*\n\n- Existing photos are permanent records preserved for verified visit audit compliance.\n- You can always attach additional photos to this visit report.`,
        allowedFieldsList: getAllowedFieldsListForAction(action),
      };
    }
  }

  // 12. Photo / Attachment edit attempt on Complaints (Attachments locked to initial log)
  if (action === 'UPDATE_COMPLAINT') {
    const isPhotoChangeAttempt =
      /\b(?:replace|delete|remove|overwrite|swap|change|add|upload)\b.*?\b(?:photo|pic|picture|image|attachment|evidence)s?\b/i.test(clean) ||
      /\b(?:photo|pic|picture|image|attachment|evidence)s?\b.*?\b(?:replace|delete|remove|overwrite|swap|badlo|hatao|change|add|upload)\b/i.test(clean);

    if (isPhotoChangeAttempt) {
      return {
        isNonEditable: true,
        fieldName: 'Evidence / Attachments',
        message: `*Attachments cannot be edited or added during a complaint update.*\n\n- Evidence photos and documents are permanent records preserved from the initial complaint log.\n- To view attached photos/documents, please open the complaint on the dashboard.`,
        allowedFieldsList: getAllowedFieldsListForAction(action),
      };
    }
  }

  return { isNonEditable: false };
}

const INQUIRY_EDITABLE_FIELDS_INLINE = 'Stage, Quantity / Specifications, Rate, Delivery Location, Payment Terms, Preferred Make, Additional Notes';

// Strict detector for "rename / change the inquiry ID (or its audit fields)" requests.
// Selections such as "update inquiry no 3", "inquiry id INQ-F2785B" or "update INQ-F2785B rate to 500"
// must NOT match, so the normal selection / update flow keeps working for them.
function detectInquirySystemFieldEdit(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 300) return null;

  const editableFieldMention = /\b(?:rate|price|bhav|qty|quantity|tonnage|mt|tons?|kg|payment|terms?|credit|delivery|location|city|stage|status|make|brand|notes?|remarks?|won|lost|quoted|quote|negotiation|hold|review)\b/i;
  if (editableFieldMention.test(clean)) return null;

  const VERB = '(?:change|edit|update|modify|rename|set|alter|replace|correct|fix|amend|revise|badlo|badal)';
  const ID_TERM = '(?:inquiry|enquiry|inq|deal)\\s*(?:id|number|no\\.?|code|ref(?:erence)?\\s*(?:id|no\\.?|number)?)';
  const isSelectorOnly = (s) => /^\s*[:#-]?\s*\d{1,4}\s*[.!?]?\s*$/.test(s);

  const auditMatch = new RegExp(`\\b${VERB}\\b.*?\\b(created\\s*(?:by|date|on|at)|creation\\s*date|logged\\s*(?:by|on|date)|salesperson(?:\\s*(?:name|phone|id))?)\\b`, 'i').exec(clean);
  if (auditMatch) {
    const term = auditMatch[1].toLowerCase();
    const label = /by|salesperson/.test(term) ? 'Logged By' : 'Creation Date';
    return { field: 'audit', label };
  }

  const verbBefore = new RegExp(`\\b${VERB}\\b.*?\\b(?:the\\s+)?${ID_TERM}\\b(.*)$`, 'i').exec(clean);
  if (verbBefore) {
    const rest = verbBefore[1] || '';
    if (!isSelectorOnly(rest)) {
      if (/(?:^|\s)(?:to|as|into|=|->|se)\s*\S/i.test(rest)) return { field: 'inquiry_id', label: 'Inquiry ID' };
      if (!rest.trim() || /^\s*[.!?]*\s*$/.test(rest) || /^\s*(?:for|of)\s+\S/i.test(rest)) return { field: 'inquiry_id', label: 'Inquiry ID' };
    }
  }

  if (new RegExp(`\\b${ID_TERM}\\s+(?:ko\\s+|ka\\s+)?(?:change|badlo|badal|rename|modify|edit)\\b`, 'i').test(clean)) {
    return { field: 'inquiry_id', label: 'Inquiry ID' };
  }

  if (new RegExp(`^${ID_TERM}\\s*(?:to|as|=|->)\\s*\\S`, 'i').test(clean) ||
      new RegExp(`^${ID_TERM}\\s*[:#]?\\s*#?(?:INQ|DEAL)?-?[A-Z0-9]+\\s+(?:to|->)\\s+\\S`, 'i').test(clean)) {
    return { field: 'inquiry_id', label: 'Inquiry ID' };
  }

  const codeRename = new RegExp(`\\b${VERB}\\b\\s+#?(?:INQ|DEAL)-[A-Z0-9]+\\s+(?:to|->|into)\\s+([A-Za-z0-9_-]+)\\s*[.!]?$`, 'i').exec(clean);
  if (codeRename && /^[A-Za-z]{2,}[-_]?\d+[A-Za-z0-9]*$/.test(codeRename[1])) {
    return { field: 'inquiry_id', label: 'Inquiry ID' };
  }

  if (/\b(?:INQ|DEAL)-[A-Z0-9]+\s+(?:ko|se)\s+[A-Za-z]{2,}[-_]?\d+[A-Za-z0-9]*\s+(?:kar|karo|kardo|badlo|badal|change)\b/i.test(clean)) {
    return { field: 'inquiry_id', label: 'Inquiry ID' };
  }

  // Inquiry date (UPDATE_INQUIRY has no editable date field). Dates of other things (follow-up, PO, visit...) are left alone.
  if (!/\b(?:follow[\s-]*up|po|visit|payment|resolution|complaint|dispatch|due|expected|closing|next|purchase|order|invoice|challan|reminder)\s+date\b/i.test(clean)) {
    const DATE_TARGET = '(?:(?:inquiry|enquiry|inq)\\s+date|date\\s+of\\s+(?:the\\s+|this\\s+|my\\s+|that\\s+)?(?:inquiry|enquiry|inq)|date|dated)';
    if (new RegExp(`\\b(?:${VERB.slice(3, -1)}|shift|move|backdate|prepone|postpone)\\b.*?\\b${DATE_TARGET}\\b`, 'i').test(clean) ||
        /^(?:(?:the\s+)?(?:inquiry|enquiry|inq)\s+)?date\s*(?:to|as|=|:|->)\s*\S/i.test(clean) ||
        /\b(?:inquiry\s+|enquiry\s+|inq\s+)?date\s+(?:ko\s+)?(?:change|badlo|badal|update|edit|modify)\b/i.test(clean)) {
      return { field: 'inquiry_date', label: 'Inquiry Date' };
    }
  }

  return null;
}

// Maps the free-text field name Gemini reports in `non_editable_field_requested` onto a known inquiry system field.
function normalizeInquirySystemFieldLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const v = raw.toLowerCase().trim();
  if (!v || v === 'null' || v === 'none') return null;
  if (/logged|created\s*by|salesperson|owner/.test(v)) return 'Logged By';
  if (/date|dated|created\s*(?:on|at)|creation/.test(v)) return 'Inquiry Date';
  if (/\bid\b|number|\bno\b|code|reference/.test(v)) return 'Inquiry ID';
  return null;
}

function buildInquirySystemFieldReply(label, displayId = null) {
  if (displayId && label !== 'Inquiry ID') {
    return `*${label} (${displayId}) is system-generated and can't be edited.*\n` +
      `Please select an editable option from below:\n\n` +
      `• *At least one field to update (e.g. Rate, Quantity, Delivery Location, Payment Terms, or Additional Notes)*`;
  }
  if (displayId) {
    const subject = label === 'Inquiry ID' ? `Inquiry ID (${displayId})` : `${label} of ${displayId}`;
    return `*${subject} is system-generated and can't be edited.*\n` +
      `Which field would you like to update? (${INQUIRY_EDITABLE_FIELDS_INLINE})`;
  }
  return `*${label} is system-generated and can't be edited.*\n` +
    `You can update: ${INQUIRY_EDITABLE_FIELDS_INLINE}.\n` +
    `Reply with the inquiry serial number or customer name to continue.`;
}

function extractThicknessTransition(text) {
  if (!text || typeof text !== 'string') return null;

  // Pattern 1: X -> Y (e.g. 2.5mm -> 3.5mm, 2.5 -> 3.5mm, 2.5mm to 3.5mm)
  const arrowMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:->|-->|=>|→)\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (arrowMatch) {
    return {
      sourceThickness: Number(arrowMatch[1]),
      targetThickness: Number(arrowMatch[2]),
      sourceSpec: `${arrowMatch[1]}mm`,
      targetSpec: `${arrowMatch[2]}mm`,
    };
  }

  // Pattern 2: from X to Y / change X to Y / thickness of X to Y / X to Y
  const toMatch = text.match(/(?:(?:from|change|thickness(?:\s*of)?|thk(?:\s*of)?)\s+)?(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:to|into|se)\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (toMatch) {
    return {
      sourceThickness: Number(toMatch[1]),
      targetThickness: Number(toMatch[2]),
      sourceSpec: `${toMatch[1]}mm`,
      targetSpec: `${toMatch[2]}mm`,
    };
  }

  // Pattern 3: X thickness Y (e.g. "HR Coil 2.5mm thickness 3.5mm")
  const thkWordMatch = text.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:thickness|spec|thk)\s+(?:to\s+|is\s+|as\s+)?(\d+(?:\.\d+)?)\s*mm/i);
  if (thkWordMatch) {
    return {
      sourceThickness: Number(thkWordMatch[1]),
      targetThickness: Number(thkWordMatch[2]),
      sourceSpec: `${thkWordMatch[1]}mm`,
      targetSpec: `${thkWordMatch[2]}mm`,
    };
  }

  return null;
}

function scoreLineItemAgainstUpdate(item, upd) {
  if (!item || !upd) return 0;
  const itemSku = (item.sku_text || item.description || '').trim().toLowerCase();
  const itemDim = (item.dimensions || item.spec || '').trim().toLowerCase();
  const itemGrade = (item.grade || '').trim().toLowerCase();
  const cleanItemFull = [itemSku, itemDim, itemGrade].join(' ').replace(/[^a-z0-9]/g, '');

  const updSku = (upd.sku_text || upd.description || upd.item_reference || '').trim().toLowerCase();
  const updSpec = (upd.spec || upd.dimensions || '').trim().toLowerCase();
  const cleanUpdFull = [updSku, updSpec].join(' ').replace(/[^a-z0-9]/g, '');
  if (!cleanUpdFull) return 0;

  let score = 0;
  if (cleanItemFull && cleanUpdFull) {
    if (cleanItemFull === cleanUpdFull) {
      score += 150;
    } else if (cleanItemFull.includes(cleanUpdFull)) {
      score += 60 + cleanUpdFull.length;
    } else if (cleanUpdFull.includes(cleanItemFull)) {
      score += 60 + cleanItemFull.length;
    }
  }

  // Extract source thickness if this update specifies a transition (e.g. 2.5mm -> 3.5mm)
  // or specifies an item reference / source with a different thickness from target spec
  let sourceThk = null;
  if (upd.source_spec || upd.source_dimensions) {
    sourceThk = extractThickness(upd.source_spec || upd.source_dimensions);
  }
  if (sourceThk === null) {
    const trRef = extractThicknessTransition(upd.item_reference) ||
                  extractThicknessTransition(upd.replace_source) ||
                  extractThicknessTransition(upd.sku_text) ||
                  extractThicknessTransition(upd.description);
    if (trRef) sourceThk = trRef.sourceThickness;
  }
  if (sourceThk === null) {
    const thkSku = extractThickness(upd.sku_text);
    const thkSpec = extractThickness(updSpec);
    if (thkSku !== null && thkSpec !== null && Math.abs(thkSku - thkSpec) >= 0.05) {
      sourceThk = thkSku;
    }
  }

  const tItem = extractThickness(itemDim) || extractThickness(itemSku);
  const tUpd = extractThickness(updSpec) || extractThickness(updSku);

  // 1. Catalog & HSN Master Alignment
  const normItem = normalizeProductToCatalog(itemSku, itemDim);
  const normUpd = normalizeProductToCatalog(updSku, updSpec);

  if (normItem.isValid && normUpd.isValid) {
    if (normItem.catalogName === normUpd.catalogName) {
      score += 120;
      // Do not award HSN bonus if this update is changing the thickness to a different value,
      // because target thickness HSN would falsely bias towards existing items in the destination tariff band.
      const isChangingThickness = (sourceThk !== null) || (tItem !== null && tUpd !== null && Math.abs(tItem - tUpd) >= 0.05 && (upd.spec || upd.dimensions));
      if (!isChangingThickness && normItem.hsnCode && normUpd.hsnCode && normItem.hsnCode === normUpd.hsnCode) {
        score += 40;
      }
    } else if (normItem.category && normUpd.category && normItem.category !== normUpd.category) {
      score -= 80;
    } else {
      score -= 50;
    }
  }

  // 2. Thickness / Dimension Alignment
  if (sourceThk !== null && tItem !== null) {
    if (Math.abs(tItem - sourceThk) < 0.05) {
      score += 250; // Decisive match: matches the source thickness specified by user!
    } else {
      score -= 150; // Penalize other thicknesses
    }
  } else if (tItem !== null && tUpd !== null) {
    if (Math.abs(tItem - tUpd) < 0.05) {
      score += 60;
    } else {
      score -= 60;
    }
  }

  // 3. Token-based matching
  const stopWords = new Set(['the', 'for', 'and', 'with', 'item', 'update', 'change', 'rate', 'price', 'quantity', 'qty', 'of', 'to', 'in', 'at']);
  const curTokens = [itemSku, itemDim, itemGrade].join(' ').split(/[\s,()/-]+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && !stopWords.has(t));
  const updTokens = [updSku, updSpec].join(' ').split(/[\s,()/-]+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && !stopWords.has(t));

  let matchedTokens = 0;
  for (const ut of updTokens) {
    if (curTokens.some(ct => ct === ut || ct.includes(ut) || ut.includes(ct))) {
      matchedTokens++;
    }
  }
  if (matchedTokens > 0) {
    score += matchedTokens * 20;
  }

  // 4. Broad steel keywords covering all 4 master categories
  const steelKeywords = [
    'channel', 'plate', 'sheet', 'coil', 'angle', 'pipe', 'tube', 'beam', 'bar',
    'chequered', 'gp', 'cr', 'hr', 'hrpo', 'galvalume', 'ms', 'gi', 'tmt',
    'slotted', 'solar', 'purlin', 'tray', 'earthing', 'strip', 'flat', 'round', 'square'
  ];
  for (const kw of steelKeywords) {
    const inCur = curTokens.some(t => t.includes(kw));
    const inUpd = updTokens.some(t => t.includes(kw));
    if (inCur && inUpd) {
      score += 30;
    } else if (inCur !== inUpd && inUpd) {
      score -= 40;
    }
  }

  return score;
}

function isLineUpdatePinned(upd) {
  return Boolean(upd) && (
    (Array.isArray(upd._target_item_ids) && upd._target_item_ids.length > 0) ||
    (Array.isArray(upd._target_indexes) && upd._target_indexes.length > 0)
  );
}

function matchLineItemUpdate(item, index, totalItems, lineUpdates) {
  if (!Array.isArray(lineUpdates) || lineUpdates.length === 0 || !item) return null;

  // 0. Updates already resolved to specific line items only apply to those items
  for (const upd of lineUpdates) {
    if (!isLineUpdatePinned(upd)) continue;
    const ids = Array.isArray(upd._target_item_ids) ? upd._target_item_ids.filter(Boolean).map(String) : [];
    if (ids.length > 0 && item.id) {
      if (ids.includes(String(item.id))) return upd;
    } else if (Array.isArray(upd._target_indexes) && upd._target_indexes.includes(index)) {
      return upd;
    }
  }
  lineUpdates = lineUpdates.filter(upd => !isLineUpdatePinned(upd) && !/^(?:add|insert|new)$/i.test(String(upd?.operation || '')));
  if (lineUpdates.length === 0) return null;

  // 1. Explicit item number match: '1', 'item 1', 'first item', etc.
  for (const upd of lineUpdates) {
    if (!upd) continue;
    const rawRef = String(upd.item_reference || upd.description || upd.sku_text || '').trim();
    const numMatch = rawRef.match(/^(?:item\s*#?|line\s*#?|#)?(\d+)(?:st|nd|rd|th)?(?:\s*item)?$/i);
    if (numMatch) {
      const targetIdx = parseInt(numMatch[1], 10) - 1;
      if (targetIdx === index) return upd;
    }
    if (/^first(?:\s*item)?$/i.test(rawRef) && index === 0) return upd;
    if (/^second(?:\s*item)?$/i.test(rawRef) && index === 1) return upd;
    if (/^third(?:\s*item)?$/i.test(rawRef) && index === 2) return upd;
    if (/^fourth(?:\s*item)?$/i.test(rawRef) && index === 3) return upd;
    if (/^fifth(?:\s*item)?$/i.test(rawRef) && index === 4) return upd;
  }

  // 2. Specific product name / spec / description matching
  let bestMatch = null;
  let highestScore = 0;

  for (const upd of lineUpdates) {
    if (!upd) continue;
    const score = scoreLineItemAgainstUpdate(item, upd);
    if (score > highestScore && score >= 20) {
      highestScore = score;
      bestMatch = upd;
    }
  }

  if (bestMatch) return bestMatch;

  // 3. Fallback ONLY if there is exactly 1 item in total
  if (totalItems === 1 && lineUpdates.length > 0) {
    return lineUpdates[0];
  }

  return null;
}

// ── DUPLICATE PRODUCT LINE ITEM DISAMBIGUATION ───────────────────────────────

function normalizeLineItemName(item) {
  return String(item?.sku_text || item?.description || item?.product_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isExplicitLineItemNumberRef(upd) {
  const rawRef = String(upd?.item_reference || '').trim();
  return /^(?:item\s*#?|line\s*#?|#)?\d+(?:st|nd|rd|th)?(?:\s*item)?$/i.test(rawRef) ||
    /^(?:first|second|third|fourth|fifth)(?:\s*item)?$/i.test(rawRef);
}

function getLineUpdateProductRef(upd) {
  return [upd?.sku_text, upd?.description, upd?.item_reference, upd?.spec, upd?.dimensions]
    .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    .map(v => String(v).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericLineUpdateRef(ref) {
  const clean = String(ref || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return !clean || /^(?:line item|line items|item|items|product|products|material|line|the item|this item|quantity|qty|rate|price)$/.test(clean);
}

// ── LINE ITEM ADD vs REPLACE (UPDATE_INQUIRY and UPDATE_ORDER only) ─────────
// An unnamed product mention must ask add-or-replace. An explicit
// "change A to B" / "replace A with B" replaces that line, after the existing
// catalog confirmation when the new product is not in the list.

function isLineItemFieldPhrase(source) {
  return /^(?:the\s+)?(?:rate|price|bhav|qty|quantity|stage|status|payment(?:\s*terms?)?|delivery(?:\s*(?:location|address|date))?|location|date|notes?|additional\s*notes|preferred\s*make|make|po(?:\s*(?:number|date|no\.?))?|spec|specification|thickness|total(?:\s*(?:value|amount|order\s*value))?|amount|value)\b/i.test(String(source || '').trim());
}

function looksLikeLineProduct(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || isLineItemFieldPhrase(n) || isGenericLineUpdateRef(n)) return false;
  if (normalizeProductToCatalog(n).isValid) return true;
  return /\b(?:plate|sheet|coil|angle|pipe|tube|bar|channel|beam|chequered|hrpo|galvalume|tmt)\b/i.test(n);
}

function parseProductTail(raw) {
  let s = String(raw || '').trim().replace(/[?.!]+$/g, '');
  let quantity = null;
  let unit = null;
  let spec = null;
  const qtyM = s.match(/(\d+(?:\.\d+)?)\s*(mt|tons?|tonnes?|kg|pcs|nos|sheets?|plates?|coils?)\b/i);
  if (qtyM) {
    quantity = Number(qtyM[1]);
    unit = qtyM[2].toUpperCase();
    if (unit.startsWith('TON')) unit = 'MT';
    else if (unit.startsWith('SHEET')) unit = 'Sheets';
    else if (unit.startsWith('PLATE')) unit = 'Plates';
    else if (unit.startsWith('COIL')) unit = 'Coils';
    else if (unit === 'NOS') unit = 'Nos';
    else if (unit === 'PCS') unit = 'Pcs';
    s = s.replace(qtyM[0], ' ');
  }
  const specM = s.match(/(\d+(?:\.\d+)?)\s*mm\b/i) || s.match(/\b(\d+\s*[xX]\s*\d+(?:\s*[xX]\s*\d+)?)\b/);
  if (specM) {
    spec = /mm/i.test(specM[0]) ? `${specM[1]}mm` : specM[0].replace(/\s+/g, '');
    s = s.replace(specM[0], ' ');
  }
  const productName = s
    .replace(/\b(?:for|with|of|the|a|an|same|configuration|please|item|line)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { productName, quantity, unit, spec };
}

function classifyLineItemMutation(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const explicit = raw.match(/^(?:please\s+)?(?:change|replace|swap|convert)\s+(?:the\s+)?line\s*item\s+(?:from\s+)?(.+?)\s+(?:to|with|into|as)\s+(.+)$/i)
    || raw.match(/^(?:please\s+)?(?:replace|swap)\s+(?:the\s+)?(?:line\s*item\s+)?(?:from\s+)?(.+?)\s+(?:with|to|into)\s+(.+)$/i);
  if (explicit) {
    const sourceName = explicit[1].replace(/^(?:from|of)\s+/i, '').trim();
    const parsed = parseProductTail(explicit[2]);
    if (isGenericLineUpdateRef(sourceName) || /^line\s*items?$/i.test(sourceName)) {
      return looksLikeLineProduct(parsed.productName) ? { kind: 'ambiguous', sourceName: null, ...parsed } : null;
    }
    if (looksLikeLineProduct(sourceName) && looksLikeLineProduct(parsed.productName)) {
      return { kind: 'replace', sourceName, ...parsed };
    }
    return null;
  }

  const change = raw.match(/^(?:please\s+)?change\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(.+)$/i);
  if (change) {
    const sourceName = change[1].trim();
    const parsed = parseProductTail(change[2]);
    if (/^line\s*items?$/i.test(sourceName)) {
      return looksLikeLineProduct(parsed.productName) ? { kind: 'ambiguous', sourceName: null, ...parsed } : null;
    }
    if (!isLineItemFieldPhrase(sourceName) && looksLikeLineProduct(sourceName) && looksLikeLineProduct(parsed.productName)) {
      return { kind: 'replace', sourceName, ...parsed };
    }
  }

  const add = raw.match(/^(?:please\s+)?(?:add|insert|include|append)\s+(?:a\s+)?(?:new\s+)?(?:line\s*item\s+)?(.+)$/i);
  if (add) {
    const parsed = parseProductTail(add[1]);
    if (looksLikeLineProduct(parsed.productName)) return { kind: 'add', sourceName: null, ...parsed };
  }

  const ambiguous = raw.match(/^(?:please\s+)?(?:update\s+|set\s+|log\s+|put\s+)?(?:the\s+)?line\s*items?\s*(?:to|as|:|-)?\s*(.+)$/i);
  if (ambiguous) {
    const parsed = parseProductTail(ambiguous[1]);
    if (looksLikeLineProduct(parsed.productName)) return { kind: 'ambiguous', sourceName: null, ...parsed };
  }

  return null;
}

function formatMutationPhrase(name, intent) {
  const bits = [name];
  if (intent && intent.quantity !== null && intent.quantity !== undefined && intent.quantity !== '') {
    const unit = intent.unit || '';
    bits.push(unit === 'MT' ? `${intent.quantity}MT` : (unit ? `${intent.quantity} ${unit}` : String(intent.quantity)));
  }
  if (intent && intent.spec) bits.push(intent.spec);
  return bits.filter(Boolean).join(' ');
}

function buildAddOrReplacePrompt(name, intent) {
  const phrase = formatMutationPhrase(name, intent);
  return `Got it — ${phrase}. Do you want to:\n` +
    `1. Add this as a new line item\n` +
    `2. Replace an existing line item (tell me which one)`;
}

function lineItemNotFoundReply(sourceName) {
  return `${sourceName} was not found in the current line items. Please check the item name and try again.`;
}

function findExistingLineIndexes(items, sourceName) {
  const itemsArr = Array.isArray(items) ? items : [];
  const raw = String(sourceName || '').trim();
  if (!raw) return [];
  const num = raw.match(/^(?:item\s*#?|line\s*#?|#|option\s*)?(\d+)(?:st|nd|rd|th)?(?:\s*item)?$/i);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    return idx >= 0 && idx < itemsArr.length ? [idx] : [];
  }
  const needle = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!needle || isGenericLineUpdateRef(needle)) return [];
  return itemsArr.map((it, i) => {
    const label = `${it?.sku_text || ''} ${it?.description || ''}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label) return -1;
    if (label === needle || label.startsWith(`${needle} `) || label.includes(needle)) return i;
    const tokens = needle.split(' ').filter(t => t.length >= 2);
    if (tokens.length > 0 && tokens.every(t => label.includes(t))) return i;
    return -1;
  }).filter(i => i >= 0);
}

function buildWhichLinePrompt(items, indexes, phrase) {
  const lines = indexes.map(i => `${i + 1}. ${items[i]?.sku_text || items[i]?.description || 'Line item'}`).join('\n');
  return `Which existing line item should *${phrase}* replace?\n\n${lines}\n\nReply with the number or the item name.`;
}

function applyResolvedLineMutation(draft, kind, index, catalogName, intent) {
  delete draft._line_mutation;
  delete draft._skip_llm_extract;
  const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
  if (kind === 'add') {
    draft.line_item_updates = [{
      operation: 'add',
      sku_text: catalogName,
      description: catalogName,
      item_reference: catalogName,
      spec: intent.spec || null,
      dimensions: intent.spec || null,
      quantity: intent.quantity,
      unit: intent.unit || (intent.quantity ? 'MT' : null),
      rate: null,
    }];
    draft._skip_llm_extract = true;
    return draft;
  }
  const item = items[index] || {};
  const sourceLabel = item.sku_text || item.description || intent.sourceName;
  draft.line_item_updates = [{
    operation: 'replace',
    replace_source: sourceLabel,
    sku_text: catalogName,
    description: catalogName,
    item_reference: sourceLabel,
    spec: intent.spec || null,
    dimensions: intent.spec || null,
    quantity: intent.quantity,
    unit: intent.unit || item.unit || null,
    rate: null,
    _target_indexes: [index],
    _target_item_ids: item.id ? [item.id] : [],
  }];
  draft._skip_llm_extract = true;
  return draft;
}

async function insertAddedDealLineItems(dealId, lineUpdates) {
  const adds = (Array.isArray(lineUpdates) ? lineUpdates : []).filter(u => u && /^(?:add|insert|new)$/i.test(String(u.operation || '')));
  let addedAmount = 0;
  for (const upd of adds) {
    const itQty = parseNumericValue(upd.quantity) || 0;
    const itRate = parseIndianAmount(upd.rate) || 0;
    const itAmt = itQty > 0 && itRate > 0 ? itQty * itRate : 0;
    addedAmount += itAmt;
    const { error } = await supabase.from('deal_items').insert({
      deal_id: dealId,
      sku_text: upd.sku_text || upd.description || 'Steel Item',
      dimensions: upd.dimensions || upd.spec || null,
      quantity: itQty,
      unit: upd.unit || 'MT',
      rate: itRate,
      amount: itAmt,
    });
    if (error) return { error, addedAmount, inserted: false };
  }
  return { error: null, addedAmount, inserted: adds.length > 0 };
}

function resolveNamedLineOrAsk(draft, intent, catalogName) {
  const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
  const indexes = findExistingLineIndexes(items, intent.sourceName);
  if (indexes.length === 0) {
    delete draft._line_mutation;
    return { reply: lineItemNotFoundReply(intent.sourceName) };
  }
  if (indexes.length > 1) {
    draft._line_mutation = { ...intent, kind: 'replace', productName: catalogName, awaiting: 'replace_which' };
    return { reply: buildWhichLinePrompt(items, indexes, formatMutationPhrase(catalogName, intent)) };
  }
  applyResolvedLineMutation(draft, 'replace', indexes[0], catalogName, intent);
  return { applied: true };
}

function startLineItemMutation(draft, intent) {
  const norm = normalizeProductToCatalog(intent.productName);
  const isCustom = isCustomProductRecognized(intent.productName, draft);
  const catalogName = norm.isValid ? norm.catalogName : intent.productName;
  if (!norm.isValid && !isCustom) {
    draft._line_mutation = { ...intent, productName: intent.productName, awaiting: 'catalog' };
    delete draft.line_item_updates;
    return {
      reply: getUnknownProductClarificationMessage(intent.productName),
      interactiveType: 'buttons',
      interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
    };
  }
  if (intent.kind === 'ambiguous') {
    draft._line_mutation = { ...intent, productName: catalogName, awaiting: 'choice' };
    delete draft.line_item_updates;
    return { reply: buildAddOrReplacePrompt(catalogName, intent) };
  }
  if (intent.kind === 'add') {
    applyResolvedLineMutation(draft, 'add', null, catalogName, intent);
    return { applied: true };
  }
  return resolveNamedLineOrAsk(draft, intent, catalogName);
}

function parseAddOrReplaceChoice(text) {
  const t = String(text || '').trim();
  if (/^(?:1|1[.)]|option\s*1|choice\s*1|add(?:\s+this)?(?:\s+as\s+a\s+new\s+line\s+item)?|new\s+line(?:\s+item)?|add\s+new)\b/i.test(t) && !/\breplace\b/i.test(t)) {
    return { choice: 'add' };
  }
  const repl = t.match(/^(?:2|2[.)]|option\s*2|choice\s*2|replace(?:\s+(?:an\s+)?existing(?:\s+(?:line\s*)?item)?)?)\b\s*(.*)$/i);
  if (repl) {
    const rest = String(repl[1] || '').replace(/^(?:with|to|the|item|line\s*item)\s+/i, '').replace(/[?.!]+$/g, '').trim();
    return { choice: 'replace', sourceName: rest || null };
  }
  return null;
}

function resolveLineItemMutationTurn(text, draft, action) {
  if (action !== 'UPDATE_INQUIRY' && action !== 'UPDATE_ORDER') return null;
  if (!draft || isDiscardOrCancelIntent(text)) return null;
  const hasCandidateList = Boolean(
    (Array.isArray(draft._inquiry_candidates) && draft._inquiry_candidates.length) ||
    (Array.isArray(draft._order_candidates) && draft._order_candidates.length)
  );
  const pending = draft._line_mutation;
  if (!pending) {
    if (hasCandidateList) return null;
    const selected = (action === 'UPDATE_INQUIRY' && draft._inquiry_verified) || (action === 'UPDATE_ORDER' && draft._order_verified);
    if (!selected) return null;
    const intent = classifyLineItemMutation(text);
    if (!intent) return null;
    return startLineItemMutation(draft, intent);
  }
  if (hasCandidateList) return null;

  if (pending.awaiting === 'catalog') {
    const clean = String(text || '').toLowerCase().replace(/[!.,?*]/g, '').trim();
    if (clean === 'btn_add_product' || clean === 'add product' || clean === 'add new product') {
      return null;
    }
    const resolved = resolveClarifiedProduct(text, pending.productName);
    if (!resolved) {
      const again = classifyLineItemMutation(text);
      if (again) return startLineItemMutation(draft, again);
      return {
        reply: getUnknownProductClarificationMessage(pending.productName),
        interactiveType: 'buttons',
        interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
      };
    }
    const next = { ...pending, productName: resolved };
    if (next.kind === 'ambiguous') {
      draft._line_mutation = { ...next, awaiting: 'choice' };
      delete draft.line_item_updates;
      return { reply: buildAddOrReplacePrompt(resolved, next) };
    }
    if (next.kind === 'add') {
      applyResolvedLineMutation(draft, 'add', null, resolved, next);
      return { applied: true };
    }
    return resolveNamedLineOrAsk(draft, next, resolved);
  }

  if (pending.awaiting === 'choice') {
    const choice = parseAddOrReplaceChoice(text);
    if (!choice) {
      const again = classifyLineItemMutation(text);
      if (again) return startLineItemMutation(draft, again);
      return { reply: buildAddOrReplacePrompt(pending.productName, pending) };
    }
    if (choice.choice === 'add') {
      applyResolvedLineMutation(draft, 'add', null, pending.productName, pending);
      return { applied: true };
    }
    const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
    if (!choice.sourceName) {
      if (items.length === 1) {
        applyResolvedLineMutation(draft, 'replace', 0, pending.productName, { ...pending, sourceName: items[0]?.sku_text || 'Item 1' });
        return { applied: true };
      }
      draft._line_mutation = { ...pending, kind: 'replace', awaiting: 'replace_which' };
      const indexes = items.map((_, i) => i);
      return { reply: buildWhichLinePrompt(items, indexes, formatMutationPhrase(pending.productName, pending)) };
    }
    return resolveNamedLineOrAsk(draft, { ...pending, kind: 'replace', sourceName: choice.sourceName }, pending.productName);
  }

  if (pending.awaiting === 'replace_which') {
    const again = classifyLineItemMutation(text);
    if (again && again.kind !== 'ambiguous') return startLineItemMutation(draft, again);
    const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
    const indexes = findExistingLineIndexes(items, text);
    if (indexes.length === 1) {
      applyResolvedLineMutation(draft, 'replace', indexes[0], pending.productName, pending);
      return { applied: true };
    }
    if (indexes.length > 1) {
      return { reply: buildWhichLinePrompt(items, indexes, formatMutationPhrase(pending.productName, pending)) };
    }
    return { reply: lineItemNotFoundReply(String(text || '').trim()) };
  }

  return null;
}

function pinLineUpdateToItems(upd, items, indexes) {
  upd._target_indexes = indexes;
  upd._target_item_ids = indexes.map(i => items[i]?.id).filter(Boolean);
}

/**
 * Resolves every rate/quantity update against the record's current line items.
 * A unique best match is pinned to that item. When the best match shares its product
 * name with other items and the update does not tell them apart (e.g. same product,
 * different thickness), returns those candidates so the user can choose.
 */
function resolveLineItemUpdateTargets(draft) {
  const items = Array.isArray(draft?.existing_items) ? draft.existing_items : [];
  if (items.length === 0) return null;

  // A bare "change quantity to 40 MT" arrives as a header quantity, which is never applied
  // to line items; turn it into a line item update so it gets a target.
  const hasVal = v => v !== null && v !== undefined && v !== '';
  const headerQty = hasVal(draft.updates?.quantity) ? draft.updates.quantity : (hasVal(draft.quantity) ? draft.quantity : null);
  if (headerQty !== null) {
    const existingUpdates = Array.isArray(draft.line_item_updates) ? draft.line_item_updates : [];
    if (!existingUpdates.some(u => u && hasVal(u.quantity))) {
      const headerUnit = draft.updates?.unit || draft.unit || null;
      draft.line_item_updates = [...existingUpdates, {
        operation: 'update',
        item_reference: 'Line Item',
        quantity: parseNumericValue(headerQty) ?? headerQty,
        ...(headerUnit ? { unit: headerUnit } : {}),
      }];
    }
    if (draft.updates) delete draft.updates.quantity;
    delete draft.quantity;
  }

  const headerRate = hasVal(draft.updates?.rate) ? draft.updates.rate : (hasVal(draft.rate) ? draft.rate : null);
  if (headerRate !== null && !draft._apply_rate_to_all) {
    const parsedRate = parseIndianAmount(headerRate) ?? (parseNumericValue(headerRate) ?? headerRate);
    if (items.length === 1) {
      // Single product in record -> directly assign rate to that product without prompting
      const existingUpdates = Array.isArray(draft.line_item_updates) ? draft.line_item_updates : [];
      if (existingUpdates.length > 0) {
        existingUpdates[0].rate = parsedRate;
        pinLineUpdateToItems(existingUpdates[0], items, [0]);
      } else {
        const singleItem = items[0] || {};
        draft.line_item_updates = [{
          operation: 'update',
          item_reference: singleItem.sku_text || singleItem.description || 'Item 1',
          rate: parsedRate,
          _target_indexes: [0],
          _target_item_ids: singleItem.id ? [String(singleItem.id)] : [],
        }];
      }
    } else if (items.length > 1) {
      // More than 1 product:
      const existingUpdates = Array.isArray(draft.line_item_updates) ? draft.line_item_updates : [];
      const alreadyAssignedToSpecific = existingUpdates.some(u => {
        return u && Number(u.rate) === Number(parsedRate) && !isGenericLineUpdateRef(getLineUpdateProductRef(u));
      });

      if (!alreadyAssignedToSpecific) {
        const genericIdx = existingUpdates.findIndex(u => u && isGenericLineUpdateRef(getLineUpdateProductRef(u)));
        if (genericIdx >= 0) {
          existingUpdates[genericIdx].rate = parsedRate;
          delete existingUpdates[genericIdx]._target_indexes;
          delete existingUpdates[genericIdx]._target_item_ids;
        } else {
          draft.line_item_updates = [...existingUpdates, {
            operation: 'update',
            item_reference: 'Line Item',
            rate: parsedRate,
          }];
        }
      }
    }
    if (draft.updates) delete draft.updates.rate;
    delete draft.rate;
  }

  const updates = Array.isArray(draft?.line_item_updates) ? draft.line_item_updates : [];
  if (updates.length === 0) return null;

  for (let u = 0; u < updates.length; u++) {
    const upd = updates[u];
    if (!upd || isLineUpdatePinned(upd) || isExplicitLineItemNumberRef(upd)) continue;
    if (upd.operation && /^(?:add|new|insert|create)$/i.test(String(upd.operation))) continue;

    const productRef = getLineUpdateProductRef(upd);
    if (/^(?:all|all items|all products|every item|each item|sab|sabhi|sab items)$/i.test(productRef)) {
      pinLineUpdateToItems(upd, items, items.map((_, i) => i));
      continue;
    }
    if (isGenericLineUpdateRef(productRef)) {
      if (items.length === 1) {
        pinLineUpdateToItems(upd, items, [0]);
        continue;
      }
      return { updateIndex: u, candidateIndexes: items.map((_, i) => i), reason: 'unnamed' };
    }

    const scores = items.map(it => scoreLineItemAgainstUpdate(it, upd));
    const topScore = Math.max(...scores);
    if (topScore < 20) continue;

    const bestIdx = scores.indexOf(topScore);
    const bestName = normalizeLineItemName(items[bestIdx]);
    const sameNameIdx = bestName
      ? items.map((it, i) => (normalizeLineItemName(it) === bestName ? i : -1)).filter(i => i >= 0)
      : [bestIdx];
    const tiedIdx = sameNameIdx.filter(i => scores[i] === topScore);

    if (tiedIdx.length <= 1) {
      pinLineUpdateToItems(upd, items, [bestIdx]);
      continue;
    }

    return { updateIndex: u, candidateIndexes: tiedIdx };
  }

  // A rate that was only meant for a line item must not also be applied to every other item
  if (isGeneralRateDuplicateOfLineRate(draft.updates && draft.updates.rate, updates)) {
    delete draft.updates.rate;
  }
  if (isGeneralRateDuplicateOfLineRate(draft.rate, updates)) {
    delete draft.rate;
  }

  return null;
}

function buildLineItemChoicePrompt(draft, pending) {
  const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
  const upd = (draft.line_item_updates || [])[pending.updateIndex] || {};
  const candidates = pending.candidateIndexes.map(i => items[i]).filter(Boolean);
  const productName = candidates[0]?.sku_text || candidates[0]?.description || upd.sku_text || upd.description || 'this product';

  const changeParts = [];
  if (upd.rate !== undefined && upd.rate !== null && upd.rate !== '') {
    changeParts.push(`rate to ₹${(parseIndianAmount(upd.rate) ?? 0).toLocaleString('en-IN')}`);
  }
  if (upd.quantity !== undefined && upd.quantity !== null && upd.quantity !== '') {
    changeParts.push(`quantity to ${upd.quantity}${upd.unit ? ` ${upd.unit}` : ''}`);
  }
  const changeText = changeParts.length > 0 ? ` (${changeParts.join(' and ')})` : '';

  const list = formatDetailedInquiryItemsList(candidates);
  if (pending.reason === 'unnamed') {
    if (upd.rate !== undefined && upd.rate !== null && upd.rate !== '') {
      const rateVal = parseIndianAmount(upd.rate) ?? 0;
      const rateFormatted = `₹${rateVal.toLocaleString('en-IN')}${upd.unit ? ` / ${upd.unit}` : ' / MT'}`;
      return `📌 *Extracted Rate:* ${rateFormatted}\n\n` +
        `*For which product is this rate for?*\n\n` +
        `${list}\n\n` +
        `👉 Reply with the *product name*, the *number* (1–${candidates.length}), *All* to update all products, or *Skip* to leave rates unchanged.`;
    }
    return `This record has *${candidates.length} line items*. Which one do you want to update${changeText}?\n\n` +
      `${list}\n\n` +
      `👉 Reply with the *number* (1–${candidates.length}), the *product name*, or *All* to update all of them.`;
  }
  return `There are *${candidates.length} line items* named *${productName}* in this record. Which one do you want to update${changeText}?\n\n` +
    `${list}\n\n` +
    `👉 Reply with the *number* (1–${candidates.length}), the *thickness / size*, *All* to update all, or *Skip* to leave unchanged.`;
}

async function askLineItemChoiceIfNeeded(action, draft, senderPhone) {
  if (action !== 'UPDATE_INQUIRY' && action !== 'UPDATE_ORDER') return null;
  const pending = resolveLineItemUpdateTargets(draft);
  if (!pending) {
    delete draft._pending_line_choice;
    return null;
  }

  draft._pending_line_choice = pending;
  const prompt = buildLineItemChoicePrompt(draft, pending);
  await recordSessionMessage(senderPhone, 'assistant', prompt, {
    action_type: action,
    customer_name: draft.company_name,
  });
  await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
  return { handled: true, reply: prompt };
}

function pickLineItemChoice(text, items, candidateIndexes) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  if (/^(?:all|both|all of them|both of them|sab|sabhi|dono|all items|both items)\.?$/i.test(clean)) {
    return candidateIndexes;
  }

  const pickedNum = extractCandidateIndex(clean, candidateIndexes.length);
  if (pickedNum && pickedNum >= 1 && pickedNum <= candidateIndexes.length) {
    return [candidateIndexes[pickedNum - 1]];
  }

  const normalizeSpec = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const replyNorm = normalizeSpec(clean);
  const sizeTokens = (clean.toLowerCase().match(/\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g)\b/g) || []).map(normalizeSpec);

  const matches = candidateIndexes.filter(i => {
    const it = items[i] || {};
    const spec = normalizeSpec(`${it.dimensions || ''} ${it.spec || ''} ${it.grade || ''}`);
    if (!spec) return false;
    if (sizeTokens.length > 0) {
      return sizeTokens.every(tok => {
        const num = tok.match(/\d+(?:\.\d+)?/)?.[0];
        return num ? new RegExp(`(?:^|[^\\d.])${num.replace('.', '\\.')}(?:\\.0+)?mm`).test(spec) : spec.includes(tok);
      });
    }
    return replyNorm.length >= 3 && spec.includes(replyNorm);
  });

  if (matches.length === 1) return matches;
  if (matches.length > 1) return null;

  // Reply naming the product ("HR Coil") when the candidates are different products
  const replyName = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (replyName.length < 3) return null;
  const nameMatches = candidateIndexes.filter(i => {
    const name = normalizeLineItemName(items[i]);
    return name && (name.includes(replyName) || replyName.includes(name));
  });
  if (nameMatches.length === 1) return nameMatches;
  if (nameMatches.length > 1) return null;

  let bestIdx = -1;
  let bestScore = 0;
  let tie = false;
  candidateIndexes.forEach(i => {
    const score = scoreLineItemAgainstUpdate(items[i], { sku_text: clean });
    if (score > bestScore) { bestScore = score; bestIdx = i; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  });
  return bestIdx >= 0 && bestScore >= 20 && !tie ? [bestIdx] : null;
}

async function handleLineItemChoiceReply(text, senderPhone, action, draft) {
  const pending = draft._pending_line_choice;
  const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
  const updates = Array.isArray(draft.line_item_updates) ? draft.line_item_updates : [];
  const upd = updates[pending?.updateIndex];

  if (!pending || !upd || !Array.isArray(pending.candidateIndexes) || pending.candidateIndexes.length === 0) {
    delete draft._pending_line_choice;
    return null;
  }

  const clean = String(text || '').trim();

  // 1. User wants to skip assigning this rate / update
  if (/^(?:skip|skip\s*this|skip\s*rate|ignore|leave|leave\s*it|none|rehne\s*do|skip\s*kar\s*do|no\s*rate|keep\s*existing|rehne\s*de)\.?$/i.test(clean)) {
    if (pending.updateIndex >= 0 && pending.updateIndex < updates.length) {
      updates.splice(pending.updateIndex, 1);
      draft.line_item_updates = updates;
    }
    delete draft._pending_line_choice;

    const nextChoice = await askLineItemChoiceIfNeeded(action, draft, senderPhone);
    if (nextChoice) return nextChoice;

    const missing = validateMandatoryFields(action, draft);
    if (missing.length > 0) {
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const askMissing = `Please provide the remaining details to update:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, { action_type: action, customer_name: draft.company_name });
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
      return { handled: true, reply: askMissing };
    }

    const summary = buildConfirmationSummary(action, draft);
    await recordSessionMessage(senderPhone, 'assistant', summary, { action_type: action, customer_name: draft.company_name });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: summary,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  if (isDiscardOrCancelIntent(text)) {
    delete draft._pending_line_choice;
    return null;
  }

  // 2. User picked an item or All
  const picked = pickLineItemChoice(text, items, pending.candidateIndexes);
  if (!picked) {
    const looksLikeNewUpdate = /\b(?:rate|price|qty|quantity|payment|delivery|stage|status)\b|₹/i.test(text);
    if (looksLikeNewUpdate) {
      delete draft._pending_line_choice;
      return null;
    }
    const retry = `⚠️ I could not tell which item you meant.\n\n${buildLineItemChoicePrompt(draft, pending)}`;
    await recordSessionMessage(senderPhone, 'assistant', retry, { action_type: action, customer_name: draft.company_name });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
    return { handled: true, reply: retry };
  }

  // Merge this rate into any existing updates targeting the chosen items
  const targetIndexes = Array.isArray(picked) ? picked : [picked];
  const otherUpdates = updates.filter((_, idx) => idx !== pending.updateIndex);
  for (const pIdx of targetIndexes) {
    const existingTargetUpd = otherUpdates.find(u => {
      if (Array.isArray(u._target_indexes) && u._target_indexes.includes(pIdx)) return true;
      if (items[pIdx]?.id && Array.isArray(u._target_item_ids) && u._target_item_ids.includes(String(items[pIdx].id))) return true;
      return false;
    });
    if (existingTargetUpd) {
      if (upd.rate !== null && upd.rate !== undefined && upd.rate !== '') existingTargetUpd.rate = upd.rate;
      if (upd.quantity !== null && upd.quantity !== undefined && upd.quantity !== '') existingTargetUpd.quantity = upd.quantity;
    }
  }

  const allMerged = targetIndexes.every(pIdx => otherUpdates.some(u => {
    return (Array.isArray(u._target_indexes) && u._target_indexes.includes(pIdx)) ||
           (items[pIdx]?.id && Array.isArray(u._target_item_ids) && u._target_item_ids.includes(String(items[pIdx].id)));
  }));

  if (allMerged) {
    updates.splice(pending.updateIndex, 1);
    draft.line_item_updates = updates;
  } else {
    pinLineUpdateToItems(upd, items, picked);
  }
  delete draft._pending_line_choice;

  const nextChoice = await askLineItemChoiceIfNeeded(action, draft, senderPhone);
  if (nextChoice) return nextChoice;

  const missing = validateMandatoryFields(action, draft);
  if (missing.length > 0) {
    const missingList = missing.map((m) => `- **${m}**`).join('\n');
    const askMissing = `Please provide the remaining details to update:\n\n${missingList}`;
    await recordSessionMessage(senderPhone, 'assistant', askMissing, { action_type: action, customer_name: draft.company_name });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
    return { handled: true, reply: askMissing };
  }

  const summary = buildConfirmationSummary(action, draft);
  await recordSessionMessage(senderPhone, 'assistant', summary, { action_type: action, customer_name: draft.company_name });
  await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
  return {
    handled: true,
    reply: summary,
    interactiveType: 'buttons',
    interactiveButtons: CONFIRMATION_BUTTONS,
  };
}

// ── MERGE DRAFT HELPER ───────────────────────────────────────────────────────

function hasExplicitVisitOutcomeInput(userInput = '') {
  const input = String(userInput).trim();
  if (!input) return false;

  // A controlled value by itself is a valid response to the outcome prompt.
  if (/^(?:positive|negative|neutral|follow[-\s]*up(?:\s+required)?)\.?$/i.test(input)) {
    return true;
  }

  // Otherwise require that the outcome field is explicitly named or updated.
  return /\b(?:visit\s+)?outcome\b\s*(?:(?:is|to|as|=|:)\s*)?(?:positive|negative|neutral|follow[-\s]*up(?:\s+required)?)\b/i.test(input) ||
    /\b(?:change|update|set|mark)\b[\s\S]{0,40}\b(?:visit\s+)?outcome\b[\s\S]{0,40}\b(?:positive|negative|neutral|follow[-\s]*up(?:\s+required)?)\b/i.test(input);
}

const STEEL_GRADE_PATTERN = /\b(SAILMA|Fe\s*550\s*D|Fe\s*500\s*D|Fe\s*600|Fe\s*550|Fe\s*500|E\s*550|E\s*450|E\s*410|E\s*350|E\s*250)\b/gi;

function compactSteelGrade(token) {
  return String(token || '').replace(/\s+/g, '').toUpperCase();
}

function extractSteelGradeTokens(text) {
  const found = [];
  if (!text) return found;
  const re = new RegExp(STEEL_GRADE_PATTERN.source, 'gi');
  const source = String(text);
  let match;
  while ((match = re.exec(source))) {
    found.push({ token: compactSteelGrade(match[1]), index: match.index });
  }
  return found;
}

function gradeMatchesCatalog(beforeText, canonicalSku) {
  const before = String(beforeText || '').toLowerCase();
  const sku = String(canonicalSku || '').toLowerCase().trim();
  if (!sku) return false;
  if (before.includes(sku)) return true;
  const family = sku.split(/\s+/)[0];
  return Boolean(family && family.length >= 2 && new RegExp(`\\b${family}\\b`, 'i').test(before));
}

function resolveCapturedSteelGrade({ rawSku, description, itemGrade, prevGrade, userInput, canonicalSku }) {
  const own = extractSteelGradeTokens(`${rawSku || ''} ${description || ''} ${itemGrade || ''} ${prevGrade || ''}`);
  if (own.length) return own[0].token;

  const messageGrades = extractSteelGradeTokens(userInput);
  if (!messageGrades.length) return null;

  const attached = messageGrades.filter((grade) => {
    const start = Math.max(0, grade.index - 24);
    return gradeMatchesCatalog(String(userInput).slice(start, grade.index), canonicalSku);
  });
  const uniqueAttached = [...new Set(attached.map((grade) => grade.token))];
  if (uniqueAttached.length === 1) return uniqueAttached[0];

  const uniqueMessage = [...new Set(messageGrades.map((grade) => grade.token))];
  if (uniqueMessage.length === 1) return uniqueMessage[0];
  return null;
}

function mergeSingleDraft(action, baseDraft, newExtracted, userInput = '') {
  const merged = { ...baseDraft, action };
  const sourceCandidate = String(userInput || '').trim();
  const isControlInput =
    !sourceCandidate ||
    /^\d{1,2}$/.test(sourceCandidate) ||
    /^(?:yes|y|no|n|ok|okay|save|confirm|cancel|discard|edit|change|modify|btn_|menu_)/i.test(
      sourceCandidate,
    );
  if (
    (action === 'LOG_INQUIRY' || action === 'LOG_ORDER') &&
    !merged._source_original_text &&
    sourceCandidate.length >= 3 &&
    !isControlInput
  ) {
    merged._source_original_text = sourceCandidate;
  }
  const explicitSystemPoEdit =
    Boolean(baseDraft._editing_system_po) ||
    /\b(?:system|internal|generated|enlight|our)\s+po\b/i.test(userInput) ||
    /\b(?:change|edit|set|update)\b.*\b(?:system|internal|generated|enlight|our)\s+po\b/i.test(userInput);
  const extractedPo = newExtracted?.po_number;
  if (
    action === 'LOG_ORDER' &&
    extractedPo &&
    baseDraft.generated_po_number &&
    !explicitSystemPoEdit
  ) {
    newExtracted = {
      ...newExtracted,
      reference_po_number:
        newExtracted.reference_po_number || extractedPo,
      po_number: baseDraft.po_number,
    };
  }
  if (baseDraft.updates && typeof baseDraft.updates === 'object' && !Array.isArray(baseDraft.updates)) {
    merged.updates = { ...baseDraft.updates };
  }
  delete merged._permissionNotice; // Always clear stale notice from prior turns
  delete merged._locked_complaint_update_fields;
  if (baseDraft._queue) merged._queue = baseDraft._queue;
  if (baseDraft._totalCount) merged._totalCount = baseDraft._totalCount;
  if (baseDraft._currentIndex) merged._currentIndex = baseDraft._currentIndex;

  for (const [key, val] of Object.entries(newExtracted)) {
    if (key === 'action' || key === 'entries' || key.startsWith('_')) continue;

    if (val !== null && val !== undefined && val !== '') {
      if (key === 'updates' && typeof val === 'object' && !Array.isArray(val)) {
        merged.updates = merged.updates || {};
        for (const [uKey, uVal] of Object.entries(val)) {
          if (uVal !== null && uVal !== undefined && uVal !== '') {
            if (action === 'UPDATE_VISIT' && uKey === 'visit_outcome' && !hasExplicitVisitOutcomeInput(userInput)) {
              continue;
            }
            if (action === 'UPDATE_ORDER' && (uKey === 'total_amount' || uKey === 'total_value' || uKey === 'grand_total' || uKey === 'amount')) {
              continue;
            }
            if (action === 'UPDATE_ORDER' && uKey === 'company_name') {
              merged.company_name = String(uVal).replace(/^my\s*/i, '').replace(/^our\s+/i, '').replace(/^for\s+/i, '').trim();
              continue;
            }
            if (uKey === 'rate') {
              const parsedRate = parseIndianAmount(uVal);
              merged.updates[uKey] = parsedRate !== null ? parsedRate : uVal;
              continue;
            }
            if (uKey === 'quantity') {
              const parsedQty = parseNumericValue(uVal);
              merged.updates[uKey] = parsedQty !== null ? parsedQty : uVal;
              continue;
            }
            merged.updates[uKey] = uVal;
          }
        }
      } else if (key === 'line_items' && Array.isArray(val)) {
        if (val.length > 0) {
          const existingList = Array.isArray(baseDraft.line_items) ? baseDraft.line_items : [];
          merged.line_items = val.map((item, idx) => {
            const prevItem = existingList[idx] || (existingList.length === 1 ? existingList[0] : null);
            const qty = parseNumericValue(item.quantity) || (prevItem ? parseNumericValue(prevItem.quantity) || 0 : 0);
            const rawUnit = item.unit || prevItem?.unit || 'MT';
            const rate = !isNumericOptionSelector(userInput)
              ? (parseIndianAmount(item.rate) || (prevItem ? parseIndianAmount(prevItem.rate) || 0 : 0))
              : (prevItem ? parseIndianAmount(prevItem.rate) || 0 : 0);
            const parsedAmt = parseIndianAmount(item.amount);
            const amt = parsedAmt ? parsedAmt : (qty && rate ? qty * rate : (prevItem?.amount ? parseIndianAmount(prevItem.amount) || 0 : 0));
            const rawSku = item.sku_text || item.description || prevItem?.sku_text || prevItem?.description || '';
            const rawDim = item.dimensions || item.spec || prevItem?.dimensions || prevItem?.spec || '';
            const norm = normalizeProductToCatalog(rawSku, rawDim);
            const itemDim = rawDim || norm.customDimensions || '';
            const canonicalSku = norm.isValid ? norm.catalogName : rawSku;
            const hsn = item.hsn_code || item.hsn_sac || (norm.isValid ? norm.hsnCode : (detectHsnCode(rawSku, itemDim) || detectHsnCode(item.description || '') || prevItem?.hsn_code || null));
            const grade = resolveCapturedSteelGrade({
              rawSku,
              description: item.description || prevItem?.description || '',
              itemGrade: item.grade,
              prevGrade: prevItem?.grade,
              userInput,
              canonicalSku,
            });
            return {
              sku_text: canonicalSku,
              description: item.description || prevItem?.description || canonicalSku,
              dimensions: itemDim,
              spec: itemDim,
              grade: grade || null,
              hsn_sac: hsn,
              hsn_code: hsn,
              is_valid_catalog: norm.isValid,
              quantity: qty || '',
              unit: rawUnit,
              rate: rate || '',
              amount: amt || '',
            };
          });

          if (!merged.product_description || merged.product_description.length < 5) {
            merged.product_description = merged.line_items.map(it => `${it.sku_text || it.description}${it.quantity ? ` - ${it.quantity} ${it.unit || 'MT'}` : ''}`).join(', ');
          }
        }
      } else if (key === 'line_item_updates' && Array.isArray(val)) {
        let validUpdates = val;
        if (action === 'UPDATE_ORDER' || action === 'UPDATE_INQUIRY') {
          validUpdates = val.filter(item => {
            if (!item) return false;
            // Reject items where only amount is given without any item reference, product, rate, quantity, or spec
            if (item.amount && !item.rate && !item.quantity && !item.item_reference && !item.description && !item.sku_text && !item.spec && !item.dimensions) {
              return false;
            }
            return Boolean(item.item_reference || item.description || item.sku_text || item.rate || item.quantity || item.spec || item.dimensions);
          });
        }
        if (validUpdates.length > 0) {
          merged.line_item_updates = validUpdates.map(upd => {
            if (!upd || typeof upd !== 'object') return upd;
            const normalized = { ...upd };
            if (normalized.rate !== null && normalized.rate !== undefined && normalized.rate !== '') {
              const parsedRate = parseIndianAmount(normalized.rate);
              if (parsedRate !== null) normalized.rate = parsedRate;
            }
            if (normalized.quantity !== null && normalized.quantity !== undefined && normalized.quantity !== '') {
              const parsedQty = parseNumericValue(normalized.quantity);
              if (parsedQty !== null) normalized.quantity = parsedQty;
            }
            if (normalized.dimensions && !normalized.spec) {
              normalized.spec = normalized.dimensions;
            } else if (normalized.spec && !normalized.dimensions) {
              normalized.dimensions = normalized.spec;
            }
            return normalized;
          });
          if (merged.updates) {
            delete merged.updates.rate;
            delete merged.updates.product_description;
          }
        }
      } else if (key === 'product_description' && typeof val === 'string' && val.trim()) {
        const norm = normalizeProductToCatalog(val.trim());
        if (norm.isValid && Array.isArray(merged.line_items) && merged.line_items.length > 0) {
          merged.line_items = merged.line_items.map(it => {
            const dim = it.dimensions || '';
            const itemNorm = normalizeProductToCatalog(it.sku_text, dim);
            if (!itemNorm.isValid) {
              return {
                ...it,
                sku_text: norm.catalogName,
                description: norm.catalogName,
                hsn_code: norm.hsnCode,
                hsn_sac: norm.hsnCode,
                is_valid_catalog: true,
              };
            }
            return it;
          });
        }
        merged.product_description = val;
      } else {
        if (key === 'company_name' && typeof val === 'string') {
          if (['UPDATE_INQUIRY', 'UPDATE_ORDER', 'UPDATE_VISIT', 'UPDATE_COMPLAINT'].includes(action) && baseDraft.company_name) {
            // Keep existing customer on update workflows
          } else {
            merged.company_name = val.replace(/^my\s*/i, '').replace(/^our\s+/i, '').replace(/^for\s+/i, '').trim();
          }
        } else if (key === 'inquiry_id' && typeof val === 'string') {
          if (['UPDATE_INQUIRY', 'UPDATE_ORDER'].includes(action) && baseDraft.inquiry_id) {
            // Keep existing inquiry_id on update workflows
          } else {
            merged.inquiry_id = val;
          }
        } else if (key.includes('date') && typeof val === 'string') {
          if (/\b(?:day before yesterday|parso)\b/i.test(userInput)) {
            const dby = new Date(Date.now() - 48 * 3600 * 1000);
            merged[key] = formatDateDDMMYYYY(dby);
          } else if (/\b(?:yesterday|kal)\b/i.test(userInput)) {
            const y = new Date(Date.now() - 24 * 3600 * 1000);
            merged[key] = formatDateDDMMYYYY(y);
          } else if (/\b(?:today|now|just now|aaj)\b/i.test(userInput)) {
            merged[key] = formatDateDDMMYYYY(new Date());
          } else {
            merged[key] = normalizeDateToDDMMYYYY(val);
          }
        } else if (key === 'rate' && (typeof val === 'string' || typeof val === 'number')) {
          if (!isNumericOptionSelector(userInput)) {
            const parsedRate = parseIndianAmount(val);
            merged.rate = parsedRate !== null ? parsedRate : val;
          }
        } else if (key === 'attachments' && Array.isArray(val)) {
          const prevAtts = Array.isArray(baseDraft.attachments) ? baseDraft.attachments : [];
          const existingUrls = new Set(prevAtts.map(a => a && (a.url || a.file_url)).filter(Boolean));
          const newlyAdded = val.filter(a => a && (a.url || a.file_url) && !existingUrls.has(a.url || a.file_url));
          merged.attachments = [...prevAtts, ...newlyAdded].slice(0, 3);
        } else if (key === 'gps_photo_url' && typeof val === 'string') {
          // Keep baseDraft photo if already set (never replace previously added photo)
          merged.gps_photo_url = baseDraft.gps_photo_url || val;
        } else if (
          key === 'visit_outcome' &&
          (
            (action === 'LOG_VISIT' && baseDraft.visit_outcome && !hasExplicitVisitOutcomeInput(userInput)) ||
            (action === 'UPDATE_VISIT' && !hasExplicitVisitOutcomeInput(userInput))
          )
        ) {
          // A prior explicit outcome is authoritative. Remarks and general discussion
          // must not silently mutate it through LLM sentiment extraction.
        } else {
          merged[key] = val;
        }
      }
    }
  }

  // Fallback date injection if date field is empty and user mentioned relative date
  if (!merged.visit_date && !merged.po_date && !merged.complaint_date) {
    let targetDateKey = 'visit_date';
    if (action.includes('ORDER')) targetDateKey = 'po_date';
    else if (action.includes('COMPLAINT')) targetDateKey = 'complaint_date';
    if (/\b(?:day before yesterday|parso)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date(Date.now() - 48 * 3600 * 1000));
    } else if (/\b(?:yesterday|kal)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date(Date.now() - 24 * 3600 * 1000));
    } else if (/\b(?:today|now|just now|aaj)\b/i.test(userInput)) {
      merged[targetDateKey] = formatDateDDMMYYYY(new Date());
    }
  }

  // Default complaint_date to today if not provided for LOG_COMPLAINT
  if (action === 'LOG_COMPLAINT' && !merged.complaint_date) {
    merged.complaint_date = formatDateDDMMYYYY(new Date());
  }

  // Ensure raised_by is mapped from contact_person/person_met if present
  if (action === 'LOG_COMPLAINT' && !merged.raised_by && (merged.contact_person || merged.person_met)) {
    merged.raised_by = merged.contact_person || merged.person_met;
  }

  // Fallback inquiry_id injection if missing and user mentioned INQ- or DEAL- ID
  if (!merged.inquiry_id && ['LOG_ORDER', 'UPDATE_ORDER', 'UPDATE_INQUIRY'].includes(action)) {
    const inqMatch = userInput.match(/\b(?:INQ|DEAL)-[A-Z0-9]+\b|#INQ-[A-Z0-9]+/i);
    if (inqMatch) {
      merged.inquiry_id = inqMatch[0].replace(/^#/, '').trim().toUpperCase();
    }
  }

  // Fallback rate extraction for LOG_ORDER / LOG_INQUIRY / UPDATE_INQUIRY
  if (!merged.rate && ['LOG_ORDER', 'LOG_INQUIRY', 'UPDATE_INQUIRY'].includes(action) && !isNumericOptionSelector(userInput)) {
    const rateMatch = userInput.match(/(?:rate|price|@|bhav)[\s:=-]*(?:to\s+|as\s+|is\s+|be\s+|ko\s+)?(?:₹|rs\.?)?\s*(\d+(?:,\d+)*(?:\.\d+)?(?:\s*(?:lakhs?|lacs?|crores?|k)(?![a-z]))?)/i) ||
      userInput.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:\/|\s*per\s*)(?:mt|ton|tonne|kg|pcs|sheet)/i) ||
      userInput.match(/(?:₹|rs\.?)\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:rate|bhav)?/i) ||
      userInput.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:₹|rs\.?)\s*(?:rate|bhav)?/i);
    if (rateMatch) {
      const parsedRate = parseIndianAmount(rateMatch[1]);
      if (parsedRate !== null) merged.rate = parsedRate;
    }
  }

  // Fallback PO extraction. Customer-provided values are Reference PO for a
  // new order unless the user is explicitly editing the system PO.
  if (!merged.po_number && ['LOG_ORDER', 'UPDATE_ORDER', 'LOG_COMPLAINT', 'UPDATE_COMPLAINT'].includes(action)) {
    const poMatch = userInput.match(/\b(?:PO[-_:#\s]*([A-Za-z0-9_-]+)|(?:po\s*number|po\s*no\.?|po#)[\s:=-]*([A-Za-z0-9_-]+))\b/i);
    if (poMatch) {
      const candidate = (poMatch[1] || poMatch[2] || '').trim();
      if (candidate && !/^(?:date|for|to|is|with|number|no|details?)$/i.test(candidate)) {
        const normalizedCandidate = candidate.toUpperCase().startsWith('PO')
          ? candidate.toUpperCase()
          : `PO-${candidate.toUpperCase()}`;
        const isSystemEdit =
          action !== 'LOG_ORDER' ||
          explicitSystemPoEdit ||
          Boolean(merged._editing_system_po);
        if (isSystemEdit) {
          merged.po_number = normalizedCandidate;
        } else {
          merged.reference_po_number = normalizedCandidate;
        }
        if (['LOG_COMPLAINT', 'UPDATE_COMPLAINT'].includes(action) && !merged.linked_inquiry_or_po) {
          merged.linked_inquiry_or_po = merged.po_number;
        }
      }
    }
  }

  // The allocator, not the LLM or a random fallback, owns generated POs.
  if (action === 'LOG_ORDER' && merged.po_number && /^(?:auto|generate|autogenerate|auto\s*generate)$/i.test(String(merged.po_number).trim())) {
    merged.po_number = baseDraft.po_number || null;
  }

  // Fallback payment_terms extraction for LOG_INQUIRY / LOG_ORDER / UPDATE_INQUIRY / UPDATE_ORDER
  if (!merged.payment_terms && ['LOG_ORDER', 'UPDATE_ORDER'].includes(action)) {
    const payMatch = userInput.match(/\b(\d+\s*days?(?:\s*(?:credit|terms?|net|advance))?|100%\s*advance|advance|immediate|pdc|lc|cad|credit|online|rtgs|neft|against\s+delivery|cash\s+on\s+delivery|cod)\b/i);
    if (payMatch) {
      merged.payment_terms = payMatch[0].trim();
    }
  }

  if (action === 'LOG_INQUIRY' && !merged.email) {
    const emailMatch = String(userInput || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) merged.email = emailMatch[0].toLowerCase();
  }
  if (action === 'UPDATE_INQUIRY' && !merged.updates?.email && /\bemail\b/i.test(String(userInput || ''))) {
    const emailMatch = String(userInput || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) {
      merged.updates = merged.updates || {};
      merged.updates.email = emailMatch[0].toLowerCase();
    }
  }
  if (action === 'UPDATE_INQUIRY' && merged.email && !merged.updates?.email) {
    merged.updates = merged.updates || {};
    merged.updates.email = String(merged.email).trim().toLowerCase();
  }

  // Fallback contact_person and mobile_number for LOG_NEW_CUSTOMER / LOG_VISIT / UPDATE_VISIT / LOG_INQUIRY / LOG_ORDER
  if (['LOG_NEW_CUSTOMER', 'LOG_VISIT', 'UPDATE_VISIT', 'LOG_INQUIRY', 'LOG_ORDER'].includes(action)) {
    if (!merged.mobile_number && !merged.contact_phone) {
      const phoneMatch = userInput.match(/\b(?:\+?91[\s-]?)?([6-9]\d{9})\b/) || userInput.match(/\b(\d{10})\b/);
      if (phoneMatch) {
        const extractedPhone = phoneMatch[1] || phoneMatch[0].replace(/\D/g, '').slice(-10);
        merged.mobile_number = extractedPhone;
        if (action.includes('VISIT') || action === 'LOG_INQUIRY') merged.contact_phone = extractedPhone;
      }
    }
    if (!merged.contact_person && !merged.person_met) {
      const namePhoneMatch = userInput.match(/^([a-zA-Z\s]{2,40})[,\s]+([6-9]\d{9})/);
      if (namePhoneMatch) {
        merged.contact_person = namePhoneMatch[1].trim();
        if (action.includes('VISIT')) merged.person_met = namePhoneMatch[1].trim();
      } else {
        const nameMatch = userInput.match(/(?:my\s+name\s+is|i\s+am|contact\s+person\s*(?:is|:)?|person\s+name\s*(?:is|:)?)\s+([A-Za-z][A-Za-z\s]{1,35}[A-Za-z])(?=[,.\n]|\s+(?:and|once|from|with|mobile|phone|delivery|location)|$)/i);
        if (nameMatch) {
          const extractedName = nameMatch[1].trim();
          if (extractedName && !/^(?:a|an|the|inquiring|inquiry|visiting|interested|planning)$/i.test(extractedName)) {
            merged.contact_person = extractedName;
            if (action.includes('VISIT')) merged.person_met = extractedName;
          }
        }
      }
    }
  }

  // Update normalization for edit workflows
  if (action === 'UPDATE_ORDER') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.delivery_date && !merged.updates.delivery_date) merged.updates.delivery_date = normalizeDateToDDMMYYYY(newExtracted.delivery_date);
    if (newExtracted.delivery_location && !merged.updates.delivery_location) merged.updates.delivery_location = newExtracted.delivery_location;
    if (newExtracted.po_date && !merged.updates.po_date) merged.updates.po_date = normalizeDateToDDMMYYYY(newExtracted.po_date);
    if (newExtracted.payment_terms && !merged.updates.payment_terms) merged.updates.payment_terms = newExtracted.payment_terms;
    if (newExtracted.status && !merged.updates.status) merged.updates.status = newExtracted.status;
    if (newExtracted.po_number && !merged.updates.po_number && merged.inquiry_id) merged.updates.po_number = newExtracted.po_number;

    let extractedRate = newExtracted.rate !== undefined && newExtracted.rate !== null ? newExtracted.rate : (newExtracted.updates && newExtracted.updates.rate);
    let extractedQty = newExtracted.quantity !== undefined && newExtracted.quantity !== null ? newExtracted.quantity : (newExtracted.updates && newExtracted.updates.quantity);

    if (extractedRate === undefined || extractedRate === null) {
      const rateMatch = userInput.match(/(?:rate|price|@|bhav)[\s:=-]*(?:to\s+|as\s+|is\s+|be\s+|ko\s+)?(?:₹|rs\.?)?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i) ||
        userInput.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:\/|\s*per\s*)(?:mt|ton|tonne|kg|pcs|sheet)/i) ||
        userInput.match(/(?:₹|rs\.?)\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:rate|bhav)?/i) ||
        userInput.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:₹|rs\.?)\s*(?:rate|bhav)?/i);
      if (rateMatch) extractedRate = Number(rateMatch[1].replace(/,/g, ''));
    }

    if (extractedQty === undefined || extractedQty === null) {
      const qtyMatch = userInput.match(/(\d+(?:\.\d+)?)\s*(?:mt|ton|tonne|kg|pcs|nos|sheets?|plates?|coils?)\b/i) ||
        userInput.match(/(?:qty|quantity)[\s:=-]*(\d+(?:\.\d+)?)/i);
      if (qtyMatch) extractedQty = Number(qtyMatch[1]);
    }

    const transition = extractThicknessTransition(userInput);
    const thkMatch = transition
      ? null
      : (userInput.match(/(?:line\s*item[\s:=-]*)?.*?(\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g))\b/i) ||
         userInput.match(/\b(\d+X\d+X\d+|\d+\s*x\s*\d+(?:\s*x\s*\d+)?)\b/i));
    const extractedSpec = transition ? transition.targetSpec : (thkMatch ? thkMatch[1].trim() : null);
    const sourceSpec = transition ? transition.sourceSpec : null;

    let lineUpdates = Array.isArray(newExtracted.line_item_updates) ? newExtracted.line_item_updates : [];
    if (lineUpdates.length === 0 && Array.isArray(merged.line_item_updates)) {
      lineUpdates = merged.line_item_updates;
    }
    if (transition && lineUpdates.length > 0) {
      lineUpdates.forEach(upd => {
        if (!upd.source_spec && transition.sourceSpec) {
          upd.source_spec = transition.sourceSpec;
          upd.source_dimensions = transition.sourceSpec;
        }
        if (transition.targetSpec) {
          upd.spec = transition.targetSpec;
          upd.dimensions = transition.targetSpec;
        }
      });
    }

    if (lineUpdates.length > 0) {
      if (Array.isArray(baseDraft.line_item_updates) && baseDraft.line_item_updates.length > 0) {
        const mergedList = [...baseDraft.line_item_updates];
        for (const newUpd of lineUpdates) {
          const matchedPrevIdx = mergedList.findIndex((prev, pIdx) => {
            const match = matchLineItemUpdate(prev, pIdx, mergedList.length, [newUpd]);
            return match !== null;
          });
          if (matchedPrevIdx >= 0) {
            const prevUpd = mergedList[matchedPrevIdx];
            const mergedUpd = { ...prevUpd };
            for (const [k, v] of Object.entries(newUpd)) {
              if (v !== null && v !== undefined && v !== '') {
                mergedUpd[k] = v;
              }
            }
            if (newUpd.sku_text && !isGenericLineUpdateRef(newUpd.sku_text)) {
              mergedUpd.sku_text = newUpd.sku_text;
              mergedUpd.description = newUpd.sku_text;
            }
            if (sourceSpec) {
              mergedUpd.source_spec = sourceSpec;
              mergedUpd.source_dimensions = sourceSpec;
            }
            const updatedDim = (newUpd.spec && String(newUpd.spec).trim()) ||
                               (newUpd.dimensions && String(newUpd.dimensions).trim()) ||
                               extractedSpec ||
                               prevUpd.dimensions ||
                               prevUpd.spec;
            if (updatedDim || sourceSpec) {
              mergedUpd.spec = updatedDim;
              mergedUpd.dimensions = updatedDim;
              delete mergedUpd._target_indexes;
              delete mergedUpd._target_item_ids;
            }
            mergedList[matchedPrevIdx] = mergedUpd;
          } else {
            if (sourceSpec) {
              newUpd.source_spec = sourceSpec;
              newUpd.source_dimensions = sourceSpec;
            }
            if (extractedSpec && !newUpd.dimensions && !newUpd.spec) {
              newUpd.dimensions = extractedSpec;
              newUpd.spec = extractedSpec;
            }
            mergedList.push(newUpd);
          }
        }
        merged.line_item_updates = mergedList;
      } else {
        if (extractedSpec) {
          lineUpdates.forEach(u => {
            if (!u.dimensions && !u.spec) {
              u.dimensions = extractedSpec;
              u.spec = extractedSpec;
            }
            if (sourceSpec && !u.source_spec) {
              u.source_spec = sourceSpec;
              u.source_dimensions = sourceSpec;
            }
          });
        }
        merged.line_item_updates = lineUpdates;
      }
    } else if ((extractedRate !== undefined && extractedRate !== null) || (extractedQty !== undefined && extractedQty !== null) || extractedSpec) {
      const existingItems = Array.isArray(merged.existing_items) ? merged.existing_items : [];
      const extractedUnit = userInput.match(/\b(mt|ton|tonne|kg|pcs|nos|sheets?|plates?|coils?)\b/i)?.[1]?.toUpperCase() || 'MT';
      if (existingItems.length === 1) {
        const firstItem = existingItems[0];
        merged.line_item_updates = [{
          operation: 'update',
          item_reference: firstItem.sku_text || 'Item 1',
          description: firstItem.sku_text,
          quantity: extractedQty !== undefined && extractedQty !== null ? extractedQty : firstItem.quantity,
          unit: firstItem.unit || extractedUnit || 'MT',
          rate: extractedRate !== undefined && extractedRate !== null ? extractedRate : firstItem.rate,
          ...(extractedSpec ? { dimensions: extractedSpec, spec: extractedSpec } : {}),
        }];
      } else if (existingItems.length > 1) {
        let targetItem = null;
        for (let i = 0; i < existingItems.length; i++) {
          const it = existingItems[i];
          const itSku = (it.sku_text || it.description || '').toLowerCase();
          const itTokens = itSku.split(/[\s,()/-]+/).filter(t => t.length >= 3);
          if (itTokens.some(t => userInput.toLowerCase().includes(t))) {
            targetItem = it;
            break;
          }
        }
        if (targetItem) {
          merged.line_item_updates = [{
            operation: 'update',
            item_reference: targetItem.sku_text || 'Item',
            description: targetItem.sku_text,
            quantity: extractedQty !== undefined && extractedQty !== null ? extractedQty : targetItem.quantity,
            unit: targetItem.unit || extractedUnit || 'MT',
            rate: extractedRate !== undefined && extractedRate !== null ? extractedRate : targetItem.rate,
            ...(extractedSpec ? { dimensions: extractedSpec, spec: extractedSpec } : {}),
          }];
        } else {
          merged.line_item_updates = [{
            operation: 'update',
            item_reference: 'Line Item',
            quantity: extractedQty,
            rate: extractedRate,
            ...(extractedSpec ? { dimensions: extractedSpec, spec: extractedSpec } : {}),
          }];
        }
      } else {
        merged.line_item_updates = [{
          operation: 'update',
          item_reference: 'Line Item',
          quantity: extractedQty,
          rate: extractedRate,
          ...(extractedSpec ? { dimensions: extractedSpec, spec: extractedSpec } : {}),
        }];
      }
    }
  } else if (action === 'UPDATE_INQUIRY') {
    if (!merged.updates) merged.updates = {};
    const hasVal = v => v !== null && v !== undefined && v !== '';
    if (hasVal(newExtracted.updates?.rate)) {
      merged.updates.rate = newExtracted.updates.rate;
    } else if (hasVal(newExtracted.rate)) {
      merged.updates.rate = newExtracted.rate;
    } else if (hasVal(merged.rate) && !hasVal(merged.updates.rate)) {
      merged.updates.rate = merged.rate;
    }

    // Direct regex extraction for explicit rate in user message e.g. "rate 54000/MT", "rate: 54000", "54000/MT"
    const explicitRateMatch = userInput.match(/\b(?:rate|price|pricing|bhav)\s*[:=-]?\s*(?:rs\.?|inr|₹)?\s*(\d+(?:,\d+)*(?:\.\d+)?(?:\s*(?:lakhs?|lacs?|crores?|k))?)/i) ||
      userInput.match(/(?:(?:rs\.?|inr|₹)\s*|\b)(\d+(?:,\d+)*(?:\.\d+)?(?:\s*(?:lakhs?|lacs?|crores?|k))?)\s*\/\s*(?:mt|ton|tonne|kg)\b/i);
    if (explicitRateMatch) {
      const pExpRate = parseIndianAmount(explicitRateMatch[1]);
      if (pExpRate && pExpRate > 0) {
        merged.updates.rate = pExpRate;
      }
    }

    if (newExtracted.delivery_location && !merged.updates.delivery_location) merged.updates.delivery_location = newExtracted.delivery_location;
    if (newExtracted.payment_terms && !merged.updates.payment_terms) merged.updates.payment_terms = newExtracted.payment_terms;
    if (newExtracted.preferred_make && !merged.updates.preferred_make) merged.updates.preferred_make = newExtracted.preferred_make;
    if (newExtracted.additional_notes && !merged.updates.additional_notes) merged.updates.additional_notes = newExtracted.additional_notes;
    if (newExtracted.updates?.additional_notes) merged.updates.additional_notes = newExtracted.updates.additional_notes;

    const rawStageInput = merged.updates.stage || merged.updates.status || newExtracted.stage || newExtracted.status || newExtracted.new_stage || newExtracted.updates?.stage || newExtracted.updates?.status;
    let extractedNormStage = null;
    if (rawStageInput) {
      extractedNormStage = normalizeDealStageKey(rawStageInput);
    }
    if (!extractedNormStage) {
      const stageMatch = userInput.match(/\b(?:mark|move|put|change|update|set|stage|status)?\s*(?:the\s+|an?\s+)?(?:stage|status)?\s*(?:to|as|:|=)?\s*(won|lost|negotiation|quoted|on\s+hold|hold|review|new\s+inquiry)\b/i);
      if (stageMatch) {
        extractedNormStage = normalizeDealStageKey(stageMatch[1]);
      }
    }
    if (extractedNormStage) {
      const stageDisplayNames = {
        'new_inquiry': 'New Inquiry',
        'review': 'Review',
        'quoted': 'Quoted',
        'negotiation': 'Negotiation',
        'won': 'Won',
        'lost': 'Lost',
        'on_hold': 'On Hold',
      };
      merged.updates.stage = stageDisplayNames[extractedNormStage] || extractedNormStage;
      delete merged.updates.status;
    }

    if (merged.updates.rate !== undefined && merged.updates.rate !== null && merged.updates.rate !== '') {
      const pRate = parseIndianAmount(merged.updates.rate);
      if (pRate !== null) merged.updates.rate = pRate;
    }

    const transition = extractThicknessTransition(userInput);
    let lineUpdates = Array.isArray(newExtracted.line_item_updates) ? newExtracted.line_item_updates : [];
    if (lineUpdates.length === 0 && Array.isArray(merged.line_item_updates)) {
      lineUpdates = merged.line_item_updates;
    }
    if (transition && lineUpdates.length > 0) {
      lineUpdates.forEach(upd => {
        if (!upd.source_spec && transition.sourceSpec) {
          upd.source_spec = transition.sourceSpec;
          upd.source_dimensions = transition.sourceSpec;
        }
        if (transition.targetSpec) {
          upd.spec = transition.targetSpec;
          upd.dimensions = transition.targetSpec;
        }
      });
    }
    if (lineUpdates.length > 0) {
      if (Array.isArray(baseDraft.line_item_updates) && baseDraft.line_item_updates.length > 0) {
        const mergedList = [...baseDraft.line_item_updates];
        for (const newUpd of lineUpdates) {
          const matchedPrevIdx = mergedList.findIndex((prev, pIdx) => {
            const match = matchLineItemUpdate(prev, pIdx, mergedList.length, [newUpd]);
            return match !== null;
          });
          if (matchedPrevIdx >= 0) {
            const mergedUpd = { ...mergedList[matchedPrevIdx], ...newUpd };
            if (transition && transition.sourceSpec) {
              mergedUpd.source_spec = transition.sourceSpec;
              mergedUpd.source_dimensions = transition.sourceSpec;
            }
            if (newUpd.spec || newUpd.dimensions || newUpd.source_spec) {
              delete mergedUpd._target_indexes;
              delete mergedUpd._target_item_ids;
            }
            mergedList[matchedPrevIdx] = mergedUpd;
          } else {
            mergedList.push(newUpd);
          }
        }
        merged.line_item_updates = mergedList;
      } else {
        merged.line_item_updates = lineUpdates;
      }
    } else {
      const thkMatch = transition
        ? null
        : (userInput.match(/(?:line\s*item[\s:=-]*)?.*?(\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g))\b/i) || userInput.match(/\b(\d+X\d+X\d+|\d+\s*x\s*\d+(?:\s*x\s*\d+)?)\b/i));
      const qtyMatch = userInput.match(/(\d+(?:\.\d+)?)\s*(?:mt|ton|tonne|kg|pcs|nos|sheets?|plates?|coils?)\b/i) || userInput.match(/(?:qty|quantity)[\s:=-]*(\d+(?:\.\d+)?)/i);
      if (transition || thkMatch || qtyMatch) {
        const extractedSpec = transition ? transition.targetSpec : (thkMatch ? thkMatch[1].trim() : null);
        const sourceSpec = transition ? transition.sourceSpec : null;
        const extractedQty = qtyMatch ? Number(qtyMatch[1]) : null;
        const extractedUnit = userInput.match(/\b(mt|ton|tonne|kg|pcs|nos|sheets?|plates?|coils?)\b/i)?.[1]?.toUpperCase() || 'MT';
        if (extractedSpec || extractedQty) {
          merged.line_item_updates = [{
            operation: 'update',
            item_reference: 'Line Item',
            ...(sourceSpec ? { source_spec: sourceSpec, source_dimensions: sourceSpec } : {}),
            ...(extractedQty !== null ? { quantity: extractedQty, unit: extractedUnit } : {}),
            ...(extractedSpec ? { spec: extractedSpec, dimensions: extractedSpec } : {}),
          }];
        }
      }
    }
  } else if (action === 'UPDATE_VISIT') {
    if (!merged.updates) merged.updates = {};
    if (newExtracted.person_met && !merged.updates.person_met && (newExtracted.person_met !== baseDraft.person_met || /\b(?:person|met|name|contact)\b/i.test(userInput))) {
      merged.updates.person_met = newExtracted.person_met;
    }
    if (newExtracted.contact_phone && !merged.updates.contact_phone && (newExtracted.contact_phone !== baseDraft.contact_phone || /\b(?:phone|mobile|number|contact)\b/i.test(userInput))) {
      merged.updates.contact_phone = newExtracted.contact_phone;
    }
    if (newExtracted.city_location && !merged.updates.city_location && (newExtracted.city_location !== baseDraft.city_location || /\b(?:location|city|address|site)\b/i.test(userInput))) {
      merged.updates.city_location = newExtracted.city_location;
    }
    if (newExtracted.visit_outcome && !merged.updates.visit_outcome && (newExtracted.visit_outcome !== baseDraft.visit_outcome || /\b(?:outcome|positive|negative|neutral|follow-up|followup)\b/i.test(userInput))) {
      merged.updates.visit_outcome = newExtracted.visit_outcome;
    }

    const userMentionedDate = /\b(?:date|yesterday|today|kal|parso|now|day before yesterday|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/i.test(userInput);
    if (newExtracted.updates?.visit_date && userMentionedDate) {
      merged.updates.visit_date = normalizeDateToDDMMYYYY(newExtracted.updates.visit_date);
    } else if (newExtracted.visit_date && userMentionedDate && newExtracted.visit_date !== baseDraft.visit_date) {
      merged.updates.visit_date = normalizeDateToDDMMYYYY(newExtracted.visit_date);
    } else if (merged.updates.visit_date && (!userMentionedDate || merged.updates.visit_date === baseDraft.visit_date)) {
      delete merged.updates.visit_date;
    }

    if (newExtracted.meeting_remarks && !merged.updates.meeting_remarks && (newExtracted.meeting_remarks !== baseDraft.meeting_remarks || /\b(?:remarks?|notes?|meeting|discussed)\b/i.test(userInput))) {
      merged.updates.meeting_remarks = newExtracted.meeting_remarks;
    }
    if (newExtracted.followup_action && !merged.updates.followup_action && (newExtracted.followup_action !== baseDraft.followup_action || /\b(?:followup|follow-up|action|task)\b/i.test(userInput))) {
      merged.updates.followup_action = newExtracted.followup_action;
    }
    if (newExtracted.email && !merged.updates.email) merged.updates.email = newExtracted.email;
    if (newExtracted.designation && !merged.updates.designation) merged.updates.designation = newExtracted.designation;
    if (newExtracted.customer_type && !merged.updates.customer_type) merged.updates.customer_type = newExtracted.customer_type;
    if (newExtracted.visit_type && !merged.updates.visit_type) merged.updates.visit_type = newExtracted.visit_type;
    if (newExtracted.customer_probability && !merged.updates.customer_probability) merged.updates.customer_probability = newExtracted.customer_probability;
    if (newExtracted.product_details && !merged.updates.product_details) merged.updates.product_details = newExtracted.product_details;
    if (newExtracted.monthly_consumption && !merged.updates.monthly_consumption) merged.updates.monthly_consumption = newExtracted.monthly_consumption;
    if (newExtracted.current_requirement && !merged.updates.current_requirement) merged.updates.current_requirement = newExtracted.current_requirement;
    if (newExtracted.next_purchase_expected && !merged.updates.next_purchase_expected) merged.updates.next_purchase_expected = newExtracted.next_purchase_expected;
    if (newExtracted.delivery_location && !merged.updates.delivery_location) merged.updates.delivery_location = newExtracted.delivery_location;
    if (newExtracted.preferred_make && !merged.updates.preferred_make) merged.updates.preferred_make = newExtracted.preferred_make;
    if (newExtracted.payment_terms && !merged.updates.payment_terms) merged.updates.payment_terms = newExtracted.payment_terms;
  } else if (action === 'UPDATE_COMPLAINT') {
    const { isInvalidOrGenericResolutionNotes } = require('../kra8');
    if (!merged.updates) merged.updates = {};
    if (newExtracted.updates) {
      Object.assign(merged.updates, newExtracted.updates);
    }
    if (newExtracted.complaint_date && !merged.updates.complaint_date) merged.updates.complaint_date = normalizeDateToDDMMYYYY(newExtracted.complaint_date);
    if (newExtracted.raised_by && !merged.updates.raised_by) merged.updates.raised_by = newExtracted.raised_by;
    if (newExtracted.contact_person && !merged.updates.raised_by) merged.updates.raised_by = newExtracted.contact_person;
    if (newExtracted.affected_product && !merged.updates.affected_product) merged.updates.affected_product = newExtracted.affected_product;
    if (newExtracted.product_name && !merged.updates.affected_product) merged.updates.affected_product = newExtracted.product_name;
    if (newExtracted.complaint_type && !merged.updates.complaint_type) merged.updates.complaint_type = newExtracted.complaint_type;
    if (newExtracted.challan_no && !merged.updates.challan_no) merged.updates.challan_no = newExtracted.challan_no;
    if (newExtracted.complaint_description && !merged.updates.complaint_description) merged.updates.complaint_description = newExtracted.complaint_description;
    if (newExtracted.corrective_action && !merged.updates.corrective_action) merged.updates.corrective_action = newExtracted.corrective_action;
    if (newExtracted.customer_communication && !merged.updates.customer_communication) merged.updates.customer_communication = newExtracted.customer_communication;
    if (newExtracted.status && !merged.updates.status) merged.updates.status = newExtracted.status;
    if (newExtracted.resolution_date && !merged.updates.resolution_date) merged.updates.resolution_date = normalizeDateToDDMMYYYY(newExtracted.resolution_date);
    if (newExtracted.resolution_notes && !merged.updates.resolution_notes) merged.updates.resolution_notes = newExtracted.resolution_notes;

    // Direct resolution note fallback if user supplied notes as free text
    if (!merged.updates.resolution_notes && merged.updates.status && ['resolved', 'closed'].includes(String(merged.updates.status).toLowerCase())) {
      if (!isInvalidOrGenericResolutionNotes(userInput, merged.company_name)) {
        merged.updates.resolution_notes = userInput.trim();
      }
    }

    if (merged.updates.resolution_notes && isInvalidOrGenericResolutionNotes(merged.updates.resolution_notes, merged.company_name)) {
      delete merged.updates.resolution_notes;
    }

    const restricted = restrictComplaintUpdateFields(merged.updates);
    merged.updates = restricted.allowed;
    const requestedLockedFields = detectLockedComplaintUpdateFields(userInput);
    const lockedFields = [...new Set([...restricted.locked, ...requestedLockedFields])];
    if (lockedFields.length > 0) {
      merged._locked_complaint_update_fields = [
        ...new Set([
          ...(baseDraft._locked_complaint_update_fields || []),
          ...lockedFields,
        ]),
      ];
    }
  }

  // Preserve attachments and GPS metadata from baseDraft
  if (baseDraft.attachments && (!merged.attachments || merged.attachments.length === 0)) {
    merged.attachments = baseDraft.attachments;
  }
  if (baseDraft.gps_photo_url && !merged.gps_photo_url) {
    merged.gps_photo_url = baseDraft.gps_photo_url;
  }
  if (baseDraft.gps_latitude !== undefined && merged.gps_latitude === undefined) {
    merged.gps_latitude = baseDraft.gps_latitude;
    merged.gps_longitude = baseDraft.gps_longitude;
    merged.gps_accuracy = baseDraft.gps_accuracy;
  }
  if (action === 'UPDATE_VISIT') {
    if (newExtracted.new_attachments || newExtracted.updates?.new_attachments) {
      const incoming = newExtracted.new_attachments || newExtracted.updates?.new_attachments || [];
      const prevNew = Array.isArray(merged.updates.new_attachments) ? merged.updates.new_attachments : (Array.isArray(baseDraft.updates?.new_attachments) ? baseDraft.updates.new_attachments : []);
      const existingUrls = new Set(prevNew.map(a => a && a.url).filter(Boolean));
      const distinct = incoming.filter(a => a && a.url && !existingUrls.has(a.url));
      merged.updates.new_attachments = [...prevNew, ...distinct];
    } else if (baseDraft.updates?.new_attachments) {
      merged.updates.new_attachments = baseDraft.updates.new_attachments;
    }
  }

  // Verbatim note enforcement directly from user input (zero summarization/distortion)
  const verbatimNotes = extractVerbatimNotes(userInput);
  if (verbatimNotes) {
    if (action === 'LOG_INQUIRY') {
      merged.additional_notes = verbatimNotes;
    } else if (action === 'UPDATE_INQUIRY') {
      merged.updates = merged.updates || {};
      merged.updates.additional_notes = verbatimNotes;
      merged.additional_notes = verbatimNotes;
    } else if (action === 'LOG_VISIT') {
      merged.meeting_remarks = verbatimNotes;
    } else if (action === 'UPDATE_VISIT') {
      merged.updates = merged.updates || {};
      merged.updates.meeting_remarks = verbatimNotes;
      merged.meeting_remarks = verbatimNotes;
    }
  }

  applyInquiryChoices(action, merged, userInput);

  return merged;
}

function mergeDraft(action, baseDraft, newExtracted, userInput = '') {
  // If LLM returned multiple entries (e.g. 2 visits / 2 companies in one message)
  if (Array.isArray(newExtracted?.entries) && newExtracted.entries.length > 0) {
    const firstEntry = newExtracted.entries[0];
    const remainingEntries = newExtracted.entries.slice(1).map(entry => {
      return mergeSingleDraft(action, {}, entry, userInput);
    });

    const merged = mergeSingleDraft(action, baseDraft, firstEntry, userInput);
    if (remainingEntries.length > 0) {
      merged._queue = (baseDraft._queue || []).concat(remainingEntries);
      merged._totalCount = baseDraft._totalCount || (merged._queue.length + 1);
      merged._currentIndex = baseDraft._currentIndex || 1;
    }
    if (action === 'UPDATE_ORDER' && detectTotalValueUpdateAttempt(userInput, newExtracted)) {
      merged._permissionNotice = TOTAL_VALUE_PERMISSION_NOTICE;
    }
    return merged;
  }

  const merged = mergeSingleDraft(action, baseDraft, newExtracted, userInput);
  if (action === 'UPDATE_ORDER' && detectTotalValueUpdateAttempt(userInput, newExtracted)) {
    merged._permissionNotice = TOTAL_VALUE_PERMISSION_NOTICE;
  }
  return merged;
}

// ── FORWARD CUSTOMER DETAILS TO PARENT DRAFT ──────────────────────────────

function forwardCustomerDetailsToParentDraft(originalAction, originalDraft, custDraft) {
  if (!originalDraft || typeof originalDraft !== 'object') return originalDraft;
  if (!custDraft || typeof custDraft !== 'object') return originalDraft;

  // 1. Company Name
  if (custDraft.company_name) {
    originalDraft.company_name = custDraft.company_name;
  }

  // 2. Phone / Mobile Number
  const phoneVal = custDraft.mobile_number || custDraft.phone || custDraft.contact_phone;
  if (phoneVal) {
    if (!originalDraft.contact_phone) originalDraft.contact_phone = phoneVal;
    if (!originalDraft.mobile_number) originalDraft.mobile_number = phoneVal;
    if (!originalDraft.phone) originalDraft.phone = phoneVal;
  }

  // 3. Location / City / Delivery Address
  // A visit city and a customer's delivery location are separate fields. Do not
  // turn one into the other while resuming a visit after customer onboarding.
  if (originalAction === 'LOG_VISIT') {
    const explicitDelivery = custDraft.delivery_location || null;
    if (explicitDelivery && !originalDraft.delivery_location) {
      originalDraft.delivery_location = explicitDelivery;
    }
  } else {
    const locVal = custDraft.delivery_location || custDraft.city_location || custDraft.location || custDraft.address;
    if (locVal) {
      if (!originalDraft.city_location) originalDraft.city_location = locVal;
      if (!originalDraft.delivery_location) originalDraft.delivery_location = locVal;
      if (!originalDraft.location) originalDraft.location = locVal;
      if (!originalDraft.address) originalDraft.address = locVal;
    }
  }

  // 4. Contact Person / Person Met
  const personVal = custDraft.contact_person || custDraft.person_met;
  if (personVal) {
    if (!originalDraft.person_met) originalDraft.person_met = personVal;
    if (!originalDraft.contact_person) originalDraft.contact_person = personVal;
  }

  // Mark customer as verified and created
  originalDraft._customer_verified = true;
  originalDraft._new_customer_created = true;

  return originalDraft;
}

// ── VALIDATE MANDATORY FIELDS ────────────────────────────────────────────────

function validateMandatoryFields(action, draft) {
  const missing = [];

  switch (action) {
    case 'LOG_INQUIRY':
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.product_description && (!Array.isArray(draft.line_items) || draft.line_items.length === 0)) {
        missing.push('Product Description / Quantity');
      } else {
        const prodCheck = validateDraftProducts('LOG_INQUIRY', draft);
        if (!prodCheck.isValid) {
          missing.push(`Valid Product Name (Unrecognized: "${prodCheck.invalidProducts.join(', ')}")`);
        }
      }
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!draft.delivery_location) missing.push('Delivery Location');
      break;

    case 'UPDATE_INQUIRY':
      if (!draft.inquiry_id && !draft.company_name) missing.push('Inquiry ID (e.g. INQ-2026-0042) or Company Name');
      const inqUpdates = draft.updates || {};
      const hasInqUpdate = Object.values(inqUpdates).some(v => v !== null && v !== undefined && v !== '') ||
                           Boolean(draft.rate || draft.quantity || draft.new_stage || draft.stage || draft.payment_terms || draft.delivery_location);
      const hasInqLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      if (!hasInqUpdate && !hasInqLineUpdates) missing.push('At least one field to update (e.g. Rate, Quantity, Delivery Location, Payment Terms, or Additional Notes)');
      const inqProdCheck = validateDraftProducts('UPDATE_INQUIRY', draft);
      if (!inqProdCheck.isValid) {
        missing.push(`Valid Product Name (Unrecognized: "${inqProdCheck.invalidProducts.join(', ')}")`);
      }
      break;

    case 'LOG_ORDER':
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.company_name) missing.push('Company Name');
      // System PO is allocated automatically at draft creation/finalization.
      if (!draft.po_date) missing.push('PO Date (e.g. 10-09-2026)');
      if (!draft.delivery_location) missing.push('Delivery Location');
      if (!draft.payment_terms) missing.push('Payment Terms');
      if (!Array.isArray(draft.line_items) || draft.line_items.length === 0) {
        missing.push('Line Items (Product Name, Quantity, Rate)');
      } else {
        const isMultiItem = draft.line_items.length > 1;
        draft.line_items.forEach((it, idx) => {
          const itemName = it.sku_text || it.description;
          const itemLabel = isMultiItem ? ` ${idx + 1}${itemName ? ` (${itemName})` : ''}` : '';
          if (!itemName) missing.push(`Product Name for line item${isMultiItem ? ` ${idx + 1}` : ''}`);
          if (!(parseNumericValue(it.quantity) > 0)) missing.push(`Quantity for line item${itemLabel}`);
          if (!(parseIndianAmount(it.rate) > 0)) missing.push(`Rate (₹ per unit) for line item${itemLabel}`);
        });
        const ordProdCheck = validateDraftProducts('LOG_ORDER', draft);
        if (!ordProdCheck.isValid) {
          missing.push(`Valid Product Name (Unrecognized: "${ordProdCheck.invalidProducts.join(', ')}")`);
        }
      }
      break;

    case 'UPDATE_ORDER': {
      const hasOrderIdentifier = Boolean(draft.po_number || draft.inquiry_id || draft.company_name);
      if (!hasOrderIdentifier) {
        missing.push('Inquiry ID OR PO Number (e.g. INQ-936C7B or PO-2026-0042)');
      }
      const ordUpdates = draft.updates || {};
      const hasOrdHeader = Object.values(ordUpdates).some(v => v !== null && v !== undefined && v !== '') ||
                           Boolean(draft.po_date || draft.delivery_date || draft.delivery_location || draft.payment_terms || draft.status);
      const hasLineUpdates = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
      const hasPoToAttach = Boolean(draft.inquiry_id && (draft.po_number || ordUpdates.po_number));
      if (!hasOrdHeader && !hasLineUpdates && !hasPoToAttach) {
        missing.push('At least one field to update (e.g. PO Number to attach, PO Date, Delivery Date, Delivery Location, Payment Terms, or Line Items)');
      }
      break;
    }

    case 'LOG_VISIT':
      if (!draft.meeting_remarks && (draft.notes || draft.additional_notes)) {
        draft.meeting_remarks = draft.notes || draft.additional_notes;
      }
      if (!draft.contact_phone && (draft.mobile_number || draft.phone)) {
        draft.contact_phone = draft.mobile_number || draft.phone;
      }
      if (!draft.person_met && draft.contact_person) {
        draft.person_met = draft.contact_person;
      }
      missing.push(...nextVisitPrompts(draft));
      break;

    case 'UPDATE_VISIT': {
      const hasVisitIdentifier = Boolean(draft.visit_id || draft.company_name);
      if (!hasVisitIdentifier) {
        missing.push('Customer / Company Name');
      }
      const visUpdates = draft.updates || {};
      const hasVisUpdate = Object.values(visUpdates).some(v => v !== null && v !== undefined && v !== '') ||
        (Array.isArray(visUpdates.new_attachments) && visUpdates.new_attachments.length > 0) ||
        (Array.isArray(draft.attachments) && draft.attachments.length > 0) ||
        Boolean(visUpdates.gps_photo_url || draft.gps_photo_url);
      if (!hasVisUpdate) missing.push('At least one field to update (e.g. Person Met, Contact Phone, City/Location, Outcome, Follow-up, Remarks, or Add Photo)');
      break;
    }

    case 'LOG_NEW_CUSTOMER':
      if (!draft.contact_person && draft.person_met) {
        draft.contact_person = draft.person_met;
      }
      if (!draft.mobile_number && (draft.contact_phone || draft.phone)) {
        draft.mobile_number = draft.contact_phone || draft.phone;
      }
      if (!draft.delivery_location && (draft.city_location || draft.location || draft.address)) {
        draft.delivery_location = draft.city_location || draft.location || draft.address;
      }
      if (!draft.company_name) missing.push('Company Name');
      if (!draft.contact_person) missing.push('Contact Person');
      if (!draft.mobile_number && !draft.phone && !draft.contact_phone) missing.push('Mobile Number');
      if (!draft.delivery_location && !draft.city_location && !draft.address) missing.push('Delivery Location');
      break;

    case 'LOG_COMPLAINT':
      if (!draft.complaint_date) {
        draft.complaint_date = formatDateDDMMYYYY(new Date());
      }
      if (!draft.status) {
        draft.status = 'Open';
      }
      if (!draft.raised_by && (draft.contact_person || draft.person_met)) {
        draft.raised_by = draft.contact_person || draft.person_met;
      }
      if (!draft.company_name) missing.push('Company / Customer Name');
      if (!draft.raised_by) {
        missing.push('Complaint Raised By (Contact person name at customer)');
      }
      if (!draft.complaint_description && !draft.description && !draft.affected_product) {
        missing.push('Complaint Description');
      }
      if (!draft.linked_inquiry_or_po && !draft.po_number && !draft.deal_id && !draft.inquiry_id) {
        missing.push('Linked Inquiry ID / PO Number');
      }
      if (!draft.affected_product && !draft.product_name) {
        missing.push('Product / Material');
      }
      if (!draft.complaint_type) {
        missing.push('Complaint Type');
      }
      if (!draft.status) {
        missing.push('Initial Status');
      }
      break;

    case 'UPDATE_COMPLAINT': {
      const { isInvalidOrGenericResolutionNotes } = require('../kra8');
      const hasCmpRef = Boolean(draft.linked_inquiry_or_po || draft.company_name || draft.complaint_id);
      if (!hasCmpRef) {
        missing.push('Customer Name OR Linked PO Number / Inquiry ID');
      }
      const cmpUpdates = draft.updates || {};
      const hasCmpUpdate = Object.values(cmpUpdates).some(v => v !== null && v !== undefined && v !== '');
      if (!hasCmpUpdate) {
        if (Array.isArray(draft._locked_complaint_update_fields) && draft._locked_complaint_update_fields.length > 0) {
          missing.push(`Locked fields cannot be updated after logging: ${draft._locked_complaint_update_fields.join(', ')}`);
        }
        missing.push('At least one field to update (e.g. Complaint Type, Status, Description, Resolution Notes)');
      }
      if (cmpUpdates.status && ['resolved', 'closed'].includes(String(cmpUpdates.status).toLowerCase())) {
        if (isInvalidOrGenericResolutionNotes(cmpUpdates.resolution_notes, draft.company_name)) {
          missing.push('Resolution Notes');
        }
      }
      break;
    }
  }

  return missing;
}

/**
 * Checks whether a company name is already registered company-wide in recurring_customers.
 * If registered, returns conflict details with the assigned representative's name, phone, etc.
 */
async function checkCompanyWideCustomerRegistration(companyName, senderPhone) {
  if (!companyName) return null;
  const cleanName = String(companyName).trim();
  if (!cleanName || cleanName.toLowerCase() === 'unknown' || cleanName.toLowerCase() === 'null') return null;

  try {
    const coreName = normalizeCoreCompanyName(cleanName);
    let query = supabase.from('recurring_customers').select('*');
    if (coreName && coreName.length >= 3) {
      query = query.or(`customer_name.ilike.%${cleanName}%,customer_name.ilike.%${coreName}%`);
    } else {
      query = query.ilike('customer_name', `%${cleanName}%`);
    }

    const { data: existingCusts, error } = await query.limit(20);
    if (error) {
      console.error('[CatalogFlow] checkCompanyWideCustomerRegistration query error:', error.message);
      return null;
    }

    const exactMatch = (existingCusts || []).find((c) => {
      const dbName = (c.customer_name || '').trim().toLowerCase();
      const targetName = cleanName.toLowerCase();
      if (dbName === targetName) return true;
      const dbCore = normalizeCoreCompanyName(c.customer_name);
      const targetCore = normalizeCoreCompanyName(cleanName);
      if (dbCore && targetCore && dbCore === targetCore) return true;
      return false;
    });

    if (exactMatch) {
      const normSender = String(senderPhone || '').replace(/\D/g, '').slice(-10);
      const normAssigned = String(exactMatch.assigned_salesperson_phone || '').replace(/\D/g, '').slice(-10);
      let repInfo = '';
      if (normAssigned && normAssigned !== normSender) {
        const { getEmployeeByPhone } = require('../supabase');
        const repEmp = await getEmployeeByPhone(normAssigned);
        const repName = repEmp?.name || 'Another Representative';
        repInfo = `• *Assigned Representative:* ${repName} (${normAssigned})\n`;
      } else if (normAssigned && normAssigned === normSender) {
        repInfo = `• *Assigned Representative:* You (already registered in your accounts)\n`;
      }

      const conflictMsg = `⚠️ *Customer Already Registered!*\n\n` +
        `• *Company Name:* ${exactMatch.customer_name}\n` +
        repInfo +
        (exactMatch.contact_person ? `• *Contact Person:* ${exactMatch.contact_person}\n` : '') +
        (exactMatch.customer_phone ? `• *Mobile Number:* ${exactMatch.customer_phone}\n` : '') +
        (exactMatch.customer_address ? `• *Location:* ${exactMatch.customer_address}\n` : '') +
        (exactMatch.customer_gst ? `• *GST:* ${exactMatch.customer_gst}\n` : '') +
        `\n_This customer is already registered in the system under another representative's portfolio. Duplicate account creation is not permitted. Please contact your Sales Manager or Administrator to reassign this account._`;

      return {
        isRegistered: true,
        match: exactMatch,
        isOtherRep: Boolean(normAssigned && normAssigned !== normSender),
        conflictMessage: conflictMsg,
      };
    }
  } catch (err) {
    console.error('[CatalogFlow] checkCompanyWideCustomerRegistration error:', err.message);
  }
  return null;
}

// ── VERIFY DRAFT CUSTOMER (ROLE & ACCOUNT SCOPED) ───────────────────────────

function calculateCustomerMatchPercentage(inputName, candidateName) {
  const rawInput = String(inputName || '').trim().toLowerCase();
  const rawCand = String(candidateName || '').trim().toLowerCase();
  if (!rawInput || !rawCand) return 0;
  if (rawInput === rawCand) return 100;

  const maxRawLen = Math.max(rawInput.length, rawCand.length);
  const rawScore = maxRawLen === 0 ? 100 : Math.round((1 - inquiryOptDistance(rawInput, rawCand) / maxRawLen) * 100);

  const cleanInput = cleanLegalSuffixes(rawInput);
  const cleanCand = cleanLegalSuffixes(rawCand);
  if (cleanInput && cleanCand) {
    if (cleanInput === cleanCand) return 100;
    const maxCleanLen = Math.max(cleanInput.length, cleanCand.length);
    const cleanScore = maxCleanLen === 0 ? 100 : Math.round((1 - inquiryOptDistance(cleanInput, cleanCand) / maxCleanLen) * 100);
    return Math.max(rawScore, cleanScore);
  }

  return rawScore;
}

async function getMatchingAssignedCustomers(inputName, senderPhone, officialName) {
  const assignedList = await getAssignedCustomersList(senderPhone);
  const assignedNames = (assignedList || []).map(c => c.customer_name).filter(Boolean);
  if (!assignedNames.length) {
    return officialName ? [officialName] : [];
  }

  const uniqueNames = Array.from(new Set(assignedNames));
  const rawInput = String(inputName || '').trim().toLowerCase();
  const cleanInput = cleanLegalSuffixes(rawInput);
  const inputTokens = cleanInput.split(' ').filter(t => t.length >= 2);

  const scored = [];
  for (const name of uniqueNames) {
    const rawCand = name.trim().toLowerCase();
    const cleanCand = cleanLegalSuffixes(rawCand);
    const candTokens = cleanCand.split(' ').filter(t => t.length >= 2);

    let score = calculateCustomerMatchPercentage(inputName, name);

    const startsWithInput = rawCand.startsWith(rawInput) || cleanCand.startsWith(cleanInput);
    const containsInput = rawCand.includes(rawInput) || cleanCand.includes(cleanInput);
    const tokenMatch = inputTokens.length > 0 && inputTokens.every(it => candTokens.some(ct => ct.startsWith(it) || it.startsWith(ct)));

    if (name.toLowerCase().trim() === (officialName || '').toLowerCase().trim()) {
      score = Math.max(score, 60);
    }
    if (startsWithInput) score += 30;
    else if (containsInput) score += 20;
    if (tokenMatch) score += 15;

    if (name.toLowerCase().trim() === (officialName || '').toLowerCase().trim() || startsWithInput || containsInput || tokenMatch || score >= 35) {
      scored.push({ name, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const results = [];
  if (officialName) {
    results.push(officialName);
  }
  for (const item of scored) {
    if (!results.some(r => r.toLowerCase().trim() === item.name.toLowerCase().trim())) {
      results.push(item.name);
    }
    if (results.length >= 3) break;
  }

  return results.slice(0, 3);
}

function buildCustomerMatchValidationMessage(rawInput, fetchedName, candidates) {
  let msg = `Do you want to continue with the fetched customer name: *${fetchedName}*?\n\n`;
  if (candidates && candidates.length > 0) {
    msg += `Matching accounts from your assigned list:\n`;
    candidates.forEach((cand, idx) => {
      msg += `  ${idx + 1}. *${cand}*\n`;
    });
    msg += `\n`;
  }
  msg += `👉 Tap *Yes* to continue with *${fetchedName}*`;
  if (candidates && candidates.length > 1) {
    msg += `, or reply with *1*, *2*${candidates.length > 2 ? ', or *3*' : ''} to choose a customer.`;
  } else if (candidates && candidates.length === 1) {
    msg += `, or reply with *1*.`;
  } else {
    msg += `.`;
  }
  return msg;
}

async function verifyDraftCustomer(action, draft, senderPhone) {
  if (!draft || !draft.company_name) return { isValid: true };
  if (draft._customer_verified === true || draft._new_customer_created === true) {
    return { isValid: true, officialName: draft.company_name };
  }
  if (
    action === 'LOG_NEW_CUSTOMER' ||
    action === 'UPDATE_INQUIRY' ||
    action === 'UPDATE_ORDER' ||
    action === 'UPDATE_VISIT' ||
    action === 'UPDATE_COMPLAINT' ||
    action === 'LOG_COMPLAINT' ||
    (action === 'LOG_ORDER' && (draft.deal_id || draft.inquiry_id || draft._inquiry_display_id))
  ) return { isValid: true };

  const rawName = String(draft.company_name).trim();
  if (!rawName || rawName.toLowerCase() === 'null' || rawName.toLowerCase() === 'unknown') {
    draft.company_name = null;
    return { isValid: true };
  }

  // Attempt verification against assigned accounts / scope
  const officialName = await verifyAndGetCustomerName(rawName, senderPhone);
  if (officialName) {
    const matchPct = calculateCustomerMatchPercentage(rawName, officialName);
    if (matchPct >= 70) {
      draft.company_name = officialName;
      draft._customer_verified = true;
      return { isValid: true, officialName };
    }

    const candidates = await getMatchingAssignedCustomers(rawName, senderPhone, officialName);
    const prompt = buildCustomerMatchValidationMessage(rawName, officialName, candidates);
    return {
      isValid: false,
      isLowMatchCustomer: true,
      fetchedName: officialName,
      rawName: rawName,
      matchPercentage: matchPct,
      candidates,
      prompt,
    };
  }

  // Unrecognized customer -> Prompt for implicit new customer confirmation
  const askNewCustomerPrompt = `⚠️ *"${rawName}"* is not in your customer list.\n\n` +
    `Is this a new customer?\n` +
    `👉 Reply *Yes* to onboard as a new customer, or *No* to re-enter the correct company name.`;

  return {
    isValid: false,
    isUnrecognizedCustomer: true,
    unverifiedName: rawName,
    prompt: askNewCustomerPrompt,
  };
}

// ── AUTO-INQUIRY MATCHING FOR PO DOCUMENT UPLOADS ───────────────────────────

/**
 * Searches the salesperson's scoped portfolio for open/quoted inquiries matching
 * the customer name and product details extracted from a PO document.
 */
async function findMatchingInquiriesForPo(customerName, lineItems = [], senderPhone) {
  if (!customerName) return { status: 'NO_MATCH', candidates: [] };

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  // Query deals for this salesperson
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, total_amount, delivery_location, payment_terms, salesperson_phone, created_at, deal_items(*)')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
  }

  const { data: allDeals } = await dealsQuery.limit(200);
  const deals = allDeals || [];

  // Filter deals matching customerName and open stages
  const custDeals = deals.filter(d => {
    const st = String(d.stage || '').toLowerCase().trim();
    if (st === 'won' || st === 'closed_won' || st === 'closed won' || st === 'lost' || st === 'closed_lost' || st === 'closed lost') {
      return false;
    }
    return isCustomerMatch(customerName, null, d.customer_name, null);
  });

  // Query inquiries for this salesperson as fallback
  let inqsQuery = supabase
    .from('inquiries')
    .select('id, sender_name, customer_name, salesperson_phone, status, stage, ai_extraction_json, created_at, inquiry_items(*), deals(*)')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
  }

  const { data: allInqs } = await inqsQuery.limit(200);
  const inqs = allInqs || [];

  const custInqs = inqs.filter(i => {
    const st = String(i.stage || i.status || '').toLowerCase().trim();
    if (st === 'won' || st === 'confirmed' || st === 'closed_won' || st === 'lost' || st === 'closed_lost') {
      return false;
    }
    const cName = i.customer_name || i.sender_name || i.ai_extraction_json?.customer_name || i.ai_extraction_json?.companyName || '';
    return isCustomerMatch(customerName, null, cName, null);
  });

  // Combine and deduplicate candidates by inquiry ID
  const candidateMap = new Map();

  for (const d of custDeals) {
    const dId = d.inquiry_id || d.id;
    const cleanDisplayInq = dId.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
    const displayId = `INQ-${cleanDisplayInq}`;
    const dDate = d.created_at ? formatDateDDMMYYYY(new Date(d.created_at)) : '';
    const items = Array.isArray(d.deal_items) ? d.deal_items : [];
    const prodSummary = items.map(it => `${it.sku_text || 'Steel'} (${it.quantity || ''} ${it.unit || 'MT'})`).join(', ') || 'Requirements on record';

    candidateMap.set(d.id, {
      deal_id: d.id,
      inquiry_id: d.inquiry_id || d.id,
      displayId,
      company_name: d.customer_name,
      stage: formatStageLabel ? formatStageLabel(d.stage) : d.stage,
      dateFormatted: dDate,
      productSummary: prodSummary,
      delivery_location: d.delivery_location,
      payment_terms: d.payment_terms,
      total_amount: d.total_amount,
      deal_items: items,
    });
  }

  for (const i of custInqs) {
    const linkedDeal = Array.isArray(i.deals) && i.deals.length > 0 ? i.deals[0] : null;
    const dealId = linkedDeal ? linkedDeal.id : null;
    if (dealId && candidateMap.has(dealId)) continue;

    const inqKey = i.id;
    if (candidateMap.has(inqKey)) continue;

    const cleanDisplayInq = i.id.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
    const displayId = `INQ-${cleanDisplayInq}`;
    const dDate = i.created_at ? formatDateDDMMYYYY(new Date(i.created_at)) : '';
    const items = Array.isArray(i.inquiry_items) ? i.inquiry_items : [];
    const prodSummary = items.map(it => `${it.sku_text || 'Steel'} (${it.quantity || ''} ${it.unit || 'MT'})`).join(', ') || 'Requirements on record';
    const cName = i.customer_name || i.sender_name || i.ai_extraction_json?.customer_name || i.ai_extraction_json?.companyName || customerName;

    candidateMap.set(inqKey, {
      deal_id: dealId,
      inquiry_id: i.id,
      displayId,
      company_name: cName,
      stage: formatStageLabel ? formatStageLabel(i.stage || i.status) : (i.stage || i.status),
      dateFormatted: dDate,
      productSummary: prodSummary,
      delivery_location: i.ai_extraction_json?.delivery_location || i.ai_extraction_json?.deliveryLocation || null,
      payment_terms: i.ai_extraction_json?.payment_terms || i.ai_extraction_json?.paymentTerms || null,
      total_amount: i.ai_extraction_json?.total_amount || 0,
      deal_items: items,
    });
  }

  const allCustCandidates = Array.from(candidateMap.values());
  if (allCustCandidates.length === 0) {
    return { status: 'NO_MATCH', candidates: [] };
  }

  // Check product match overlap with Master Catalog, HSN root, and category guards
  function getProductDetails(it) {
    const raw = (it.sku_text || it.description || it.product_name || '').trim();
    const dim = (it.dimensions || it.spec || '').trim();
    const norm = normalizeProductToCatalog(raw, dim);
    const hsn = norm.hsnCode || detectHsnCode(raw, dim);
    const hsnRoot = hsn ? hsn.slice(0, 4) : null;
    return {
      raw: raw.toLowerCase(),
      catalogName: norm.isValid ? norm.catalogName.toLowerCase() : null,
      category: norm.category || null,
      hsnRoot,
      dim: dim.toLowerCase()
    };
  }

  function itemsMatch(p, c) {
    if (p.catalogName && c.catalogName && p.catalogName === c.catalogName) return true;
    if (p.hsnRoot && c.hsnRoot && p.hsnRoot === c.hsnRoot) {
      if (p.category && c.category && p.category === c.category) return true;
    }
    if (p.category && c.category && p.category !== c.category) {
      return false;
    }
    if (p.raw && c.raw && (p.raw.includes(c.raw) || c.raw.includes(p.raw))) return true;
    return false;
  }

  const poProductDetails = (lineItems || []).map(getProductDetails).filter(p => p.raw || p.catalogName);

  let matchedCandidates = [];
  if (poProductDetails.length > 0) {
    matchedCandidates = allCustCandidates.filter(cand => {
      const items = Array.isArray(cand.deal_items) ? cand.deal_items : [];
      if (items.length === 0) return true;
      const cProductDetails = items.map(getProductDetails).filter(c => c.raw || c.catalogName);
      if (cProductDetails.length === 0) return true;

      return poProductDetails.some(poP => cProductDetails.some(cP => itemsMatch(poP, cP)));
    });
  }

  // If product filter didn't match anything specific, fall back to all customer candidates
  if (matchedCandidates.length === 0) {
    matchedCandidates = allCustCandidates;
  }

  const finalCandidates = matchedCandidates.map((c, idx) => ({
    ...c,
    index: idx + 1,
  }));

  if (finalCandidates.length === 1) {
    return {
      status: 'SINGLE_MATCH',
      inquiry: finalCandidates[0],
      candidates: finalCandidates,
    };
  }

  return {
    status: 'MULTIPLE_MATCHES',
    candidates: finalCandidates,
  };
}

function isPlaceholderDocumentCaption(caption) {
  return /^(?:document received|image received|attached image|attached pdf document|photo uploaded)$/i.test(
    String(caption || '').trim(),
  );
}

/**
 * Processes an incoming Inquiry document (photo or PDF) inside an active LOG_INQUIRY flow session.
 */
async function handleInquiryDocumentOcr(imageBuffer, mimeType, senderPhone, caption = '') {
  const { can } = require('../utils/permissions');
  if (!await can(senderPhone, 'inquiries.manage')) {
    return {
      handled: true,
      reply: 'You do not have permission to log inquiries. Please contact your admin.',
    };
  }
  const { extractFromImage } = require('../gemini');
  let extraction = null;
  try {
    extraction = await extractFromImage(imageBuffer, mimeType);
  } catch (err) {
    console.error('[CatalogFlow] extractFromImage error in handleInquiryDocumentOcr:', err);
  }

  if (!extraction || extraction.error || (!extraction.customer && (!extraction.line_items || extraction.line_items.length === 0))) {
    return {
      handled: true,
      reply: `⚠️ Could not clearly extract inquiry details from the document image. Please send a clearer picture or type the details (e.g. "Delta Structural Steel 50 MT HR Coil Delivery Mumbai").`,
    };
  }

  const rawCustName = extraction.customer && extraction.customer.name ? String(extraction.customer.name).trim() : '';
  const isGenericName = !rawCustName || rawCustName === 'null' || rawCustName === 'None' || rawCustName.length < 2;
  const custName = isGenericName ? null : rawCustName;
  const officialCustomerName = custName ? await verifyAndGetCustomerName(custName, senderPhone) : null;
  const finalCustomerName = officialCustomerName || custName || null;

  const photoDataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`;
  const attachmentObj = {
    name: `inquiry-doc-${Date.now()}.${(mimeType || '').includes('pdf') ? 'pdf' : 'jpg'}`,
    url: photoDataUrl,
    type: mimeType || 'image/jpeg',
    uploaded_at: new Date().toISOString(),
  };

  const lineItems = (extraction.line_items || []).map(it => {
    const calc = calculateLineItem(it);
    return {
      sku_text: it.sku_text || it.product_name || it.description || 'Steel',
      dimensions: it.dimensions || null,
      grade: it.grade || null,
      hsn_code: it.hsn_code || (typeof detectHsnCode === 'function' ? detectHsnCode(it.sku_text || it.description || '', it.dimensions) : '') || '',
      quantity: calc.quantity,
      unit: calc.unit || 'MT',
      rate: calc.rate ? Number(calc.rate) : null,
      amount: calc.amount ? Number(calc.amount) : null,
      cgst_rate: calc.cgst_rate,
      cgst_amount: calc.cgst_amount,
      sgst_rate: calc.sgst_rate,
      sgst_amount: calc.sgst_amount,
      total_gst: calc.total_gst,
      final_amount: calc.final_amount,
    };
  });

  const draft = {
    company_name: finalCustomerName,
    email: (extraction.customer && extraction.customer.email) || extraction.customer_email || null,
    delivery_location: extraction.delivery_location || null,
    payment_terms: matchInquiryOption(extraction.payment_terms, INQUIRY_PAYMENT_TERMS) || null,
    preferred_make: matchInquiryOption(extraction.preferred_make || extraction.make, INQUIRY_PREFERRED_MAKES) || null,
    line_items: lineItems,
    attachments: [attachmentObj],
    _customer_verified: Boolean(officialCustomerName),
  };
  try {
    const session = await getFullActiveSession(senderPhone);
    const intent = session?.last_intent || '';
    if (intent.includes('|LOG_INQUIRY|')) {
      const existing = safeParseJSON(intent.split('|').slice(2).join('|'), {});
      if (existing && existing.source_channel && !draft.source_channel) {
        draft.source_channel = existing.source_channel;
      }
    }
  } catch (e) {}

  if (caption && caption.length > 3 && !isPlaceholderDocumentCaption(caption)) {
    try {
      const captionExtracted = await extractFieldsWithLLM('LOG_INQUIRY', caption, draft);
      mergeDraft('LOG_INQUIRY', draft, captionExtracted, caption);
    } catch (e) {}
  }

  // 1. Verify customer
  if (draft.company_name && !draft._customer_verified) {
    const custVerification = await verifyDraftCustomer('LOG_INQUIRY', draft, senderPhone);
    if (!custVerification.isValid) {
      if (custVerification.isLowMatchCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custVerification.prompt, { action_type: 'LOG_INQUIRY' });
        await saveActiveSession(
          senderPhone,
          custVerification.fetchedName,
          `catalog_cust_match_confirm|LOG_INQUIRY|${custVerification.fetchedName}|${JSON.stringify(custVerification.candidates)}|${JSON.stringify(draft)}`
        );
        return {
          handled: true,
          reply: custVerification.prompt,
          interactiveType: 'buttons',
          interactiveButtons: CUST_MATCH_BUTTONS,
        };
      }
      if (custVerification.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custVerification.prompt, { action_type: 'LOG_INQUIRY' });
        await saveActiveSession(
          senderPhone,
          draft.company_name || 'Customer',
          `catalog_implicit_cust_ask|LOG_INQUIRY|${custVerification.unverifiedName}|${JSON.stringify(draft)}`
        );
        return {
          handled: true,
          reply: custVerification.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      }
    }
  }

  // 1b. Validate products against catalog / custom products
  const ocrProdCheck = validateDraftProducts('LOG_INQUIRY', draft);
  if (!ocrProdCheck.isValid) {
    await recordSessionMessage(senderPhone, 'assistant', ocrProdCheck.clarificationMessage, { action_type: 'LOG_INQUIRY' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: ocrProdCheck.clarificationMessage,
      interactiveType: 'buttons',
      interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
    };
  }

  // 2. Validate mandatory fields
  const missing = validateMandatoryFields('LOG_INQUIRY', draft);
  if (missing.length === 0) {
    const summary = buildConfirmationSummary('LOG_INQUIRY', draft);
    await recordSessionMessage(senderPhone, 'assistant', summary, { action_type: 'LOG_INQUIRY' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|LOG_INQUIRY|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: summary,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  } else {
    const missingList = missing.map(m => `• *${m}*`).join('\n');
    const askMissing = `📄 *Extracted Inquiry Details from Document*\n\nPlease provide the remaining mandatory details for this inquiry:\n\n${missingList}`;
    await recordSessionMessage(senderPhone, 'assistant', askMissing, { action_type: 'LOG_INQUIRY' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_INQUIRY|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askMissing,
    };
  }
}

async function finishUnlinkedOrderDraft(draft, senderPhone, notice) {
  const prodCheck = validateDraftProducts('LOG_ORDER', draft);
  if (!prodCheck.isValid) {
    const fullReply = `${notice || ''}${prodCheck.reply}`;
    await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_ORDER' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: fullReply,
      ...(prodCheck.canAddProduct
        ? { interactiveType: 'buttons', interactiveButtons: UNKNOWN_PRODUCT_BUTTONS }
        : {}),
    };
  }
  const missing = validateMandatoryFields('LOG_ORDER', draft);
  if (missing.length > 0) {
    const missingList = missing.map((m) => `• *${m}*`).join('\n');
    const askMissing = `${notice || ''}Please provide the remaining mandatory details for this order:\n\n${missingList}`;
    await recordSessionMessage(senderPhone, 'assistant', askMissing, { action_type: 'LOG_ORDER' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
    return { handled: true, reply: askMissing };
  }
  const summary = buildConfirmationSummary('LOG_ORDER', draft);
  const fullReply = `${notice || ''}${summary}`;
  await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_ORDER' });
  await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(draft)}`);
  return {
    handled: true,
    reply: fullReply,
    interactiveType: 'buttons',
    interactiveButtons: CONFIRMATION_BUTTONS,
  };
}

/**
 * Processes an incoming Purchase Order (PO) document inside an active LOG_ORDER flow session.
 * Auto-matches against open inquiries belonging to the salesperson.
 */
async function handleOrderDocumentOcr(imageBuffer, mimeType, senderPhone, caption = '') {
  const { can } = require('../utils/permissions');
  if (!await can(senderPhone, 'orders.create')) {
    return {
      handled: true,
      reply: 'You do not have permission to log orders. Please contact your admin.',
    };
  }
  const { extractFromImage } = require('../gemini');
  let extraction = null;
  try {
    extraction = await extractFromImage(imageBuffer, mimeType);
  } catch (err) {
    console.error('[CatalogFlow] extractFromImage error in handleOrderDocumentOcr:', err);
  }

  if (!extraction || extraction.error || (!extraction.customer && (!extraction.line_items || extraction.line_items.length === 0))) {
    return {
      handled: true,
      reply: `⚠️ Could not clearly extract PO details from the document. Please send a clearer PO document or type the order details.`,
    };
  }

  const rawCustName = extraction.customer && extraction.customer.name ? String(extraction.customer.name).trim() : '';
  const isGenericName = !rawCustName || rawCustName === 'null' || rawCustName === 'None' || rawCustName.length < 2;
  const custName = isGenericName ? null : rawCustName;
  const officialCustomerName = custName ? await verifyAndGetCustomerName(custName, senderPhone) : null;
  const finalCustomerName = officialCustomerName || custName || null;

  const photoDataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`;
  const attachmentObj = {
    name: `po-doc-${Date.now()}.${(mimeType || '').includes('pdf') ? 'pdf' : 'jpg'}`,
    url: photoDataUrl,
    type: mimeType || 'image/jpeg',
    uploaded_at: new Date().toISOString(),
  };

  const lineItems = (extraction.line_items || []).map(it => {
    const calc = calculateLineItem(it);
    return {
      sku_text: it.sku_text || it.product_name || it.description || 'Steel',
      dimensions: it.dimensions || null,
      grade: it.grade || null,
      hsn_code: it.hsn_code || (typeof detectHsnCode === 'function' ? detectHsnCode(it.sku_text || it.description || '', it.dimensions) : '') || '',
      quantity: calc.quantity,
      unit: calc.unit || 'MT',
      rate: calc.rate ? Number(calc.rate) : 0,
      amount: calc.amount ? Number(calc.amount) : 0,
      cgst_rate: calc.cgst_rate,
      cgst_amount: calc.cgst_amount,
      sgst_rate: calc.sgst_rate,
      sgst_amount: calc.sgst_amount,
      total_gst: calc.total_gst,
      final_amount: calc.final_amount,
    };
  });

  const poDate = extraction.po_date ? normalizeDateToDDMMYYYY(extraction.po_date) : formatDateDDMMYYYY(new Date());

  let existingDraft = {};
  try {
    const session = await getFullActiveSession(senderPhone);
    const intent = session?.last_intent || '';
    if (intent.startsWith('catalog_flow|LOG_ORDER|') || intent.startsWith('catalog_editing|LOG_ORDER|')) {
      existingDraft = safeParseJSON(intent.split('|').slice(2).join('|'), {}) || {};
    }
  } catch (e) {}

  const draft = { ...existingDraft };
  await ensureDraftSystemPo(
    draft,
    draft.po_reservation_token || `catalog-ocr:${senderPhone}:${Date.now()}`,
    draft.deal_id || null,
  );
  if (!draft.company_name && finalCustomerName) draft.company_name = finalCustomerName;
  if (extraction.po_number && String(extraction.po_number).trim().length > 2) {
    draft.reference_po_number = String(extraction.po_number).trim();
  }
  if (!draft.po_date && extraction.po_date) draft.po_date = normalizeDateToDDMMYYYY(extraction.po_date);
  if (!draft.po_date && !draft._direct_order) draft.po_date = poDate;
  if (!draft.delivery_location && extraction.delivery_location) draft.delivery_location = extraction.delivery_location;
  if (!draft.payment_terms && extraction.payment_terms) draft.payment_terms = extraction.payment_terms;
  if ((!Array.isArray(draft.line_items) || draft.line_items.length === 0) && lineItems.length > 0) {
    draft.line_items = lineItems;
  }
  draft.attachments = [...(Array.isArray(existingDraft.attachments) ? existingDraft.attachments : []), attachmentObj];
  if (officialCustomerName) draft._customer_verified = true;

  if (caption && caption.length > 3 && !isPlaceholderDocumentCaption(caption)) {
    try {
      const captionExtracted = await extractFieldsWithLLM('LOG_ORDER', caption, draft);
      mergeDraft('LOG_ORDER', draft, captionExtracted, caption);
    } catch (e) {}
  }

  if (draft._direct_order) {
    return await finishUnlinkedOrderDraft(draft, senderPhone, '');
  }

  // 1. Auto-match to existing inquiries by Customer + Product
  const matchResult = await findMatchingInquiriesForPo(draft.company_name, draft.line_items, senderPhone);

  if (matchResult.status === 'SINGLE_MATCH') {
    const matchedInq = matchResult.inquiry;
    draft.inquiry_id = matchedInq.displayId;
    draft._inquiry_display_id = matchedInq.displayId;
    draft.deal_id = matchedInq.deal_id;
    draft._matched_inquiry_id = matchedInq.inquiry_id;

    if (!draft.delivery_location && matchedInq.delivery_location) {
      draft.delivery_location = matchedInq.delivery_location;
    }
    if (!draft.payment_terms && matchedInq.payment_terms) {
      draft.payment_terms = matchedInq.payment_terms;
    }

    const summary = buildConfirmationSummary('LOG_ORDER', draft);
    const notice = `🔗 *Auto-linked to Quoted Inquiry ${matchedInq.displayId}*\n\n`;
    const fullReply = notice + summary;

    await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_ORDER' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: fullReply,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  if (matchResult.status === 'MULTIPLE_MATCHES') {
    draft._inquiry_candidates = matchResult.candidates;
    draft._all_inquiry_candidates = matchResult.candidates;

    const choicesText = matchResult.candidates
      .map(c => `${c.index}. *${c.displayId}* (${c.dateFormatted}) — _${c.stage}_\n   • *Product:* ${c.productSummary}\n   • *Delivery Location:* ${c.delivery_location || 'Not specified'}\n   • *Payment Terms:* ${c.payment_terms || 'Not specified'}`)
      .join('\n\n');

    const noneOptionNum = matchResult.candidates.length + 1;
    const prompt = `📋 *Found ${matchResult.candidates.length} open inquiries for ${draft.company_name || 'Customer'} with matching products:*\n\nWhich inquiry is this PO against?\n\n${choicesText}\n\n${noneOptionNum}. *None* — Record order without linking to an inquiry\n\n👉 Reply with the *Number* (1–${noneOptionNum}) or the *Inquiry ID*.`;

    await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: 'LOG_ORDER' });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: prompt,
    };
  }

  return await finishUnlinkedOrderDraft(
    draft,
    senderPhone,
    `ℹ️ *No matching inquiry found for this customer and product. Order will be recorded without an inquiry link.*\n\n`,
  );
}

// ── VALIDATE ORDER INQUIRY STAGE GATE ───────────────────────────────────────

/**
 * Validates that an Order is linked to an existing Inquiry that is in Quoted stage.
 * Per Rule B:
 * - Salesperson provides an Inquiry ID → bot queries Inquiries/deals table → checks current stage
 * - If stage is Quoted / Price Quote → proceed with order creation flow ✅
 * - If stage is New Inquiry, Negotiation, On Hold, or any pre-quote stage → block:
 *   "Order cannot be created. Inquiry INQ-XXXXX is currently in [stage] stage. A quotation must be sent and the inquiry must be in Quoted stage before an order can be recorded."
 * - If Inquiry ID does not exist → block:
 *   "Inquiry ID not found. Please verify and try again."
 */
async function validateOrderInquiryStage(draft, senderPhone) {
  if (!draft) return { isValid: false, reply: 'Inquiry ID not found. Please verify and try again.' };

  const rawInq = (draft.inquiry_id || '').trim();
  if (!rawInq) {
    return {
      isValid: false,
      isMissingId: true,
      reply: `🛒 *Record New Order*\n\nPlease provide the *Inquiry ID* (e.g. INQ-F4D982) linked to this order:`,
    };
  }

  const cleanInqCode = rawInq.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();

  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  // 1. Fetch candidate deals matching cleanInqCode
  let dQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, delivery_location, payment_terms, salesperson_phone, created_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    dQuery = dQuery.in('salesperson_phone', targetPhones);
  }

  const { data: deals, error: dErr } = await dQuery.limit(500);
  if (dErr) console.warn('[CatalogFlow] validateOrderInquiryStage deals fetch warning:', dErr.message);

  let matchedDeal = (deals || []).find(d => {
    const dId = (d.id || '').replace(/-/g, '').toUpperCase();
    const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
    return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || (d.id || '').toUpperCase().startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
  });

  let matchedInq = null;
  if (!matchedDeal) {
    let iQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, status, stage, po_number, reference_po_number, generated_po_number, salesperson_phone, created_at, ai_extraction_json')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      iQuery = iQuery.in('salesperson_phone', targetPhones);
    }

    const { data: inqs, error: iErr } = await iQuery.limit(500);
    if (iErr) console.warn('[CatalogFlow] validateOrderInquiryStage inqs fetch warning:', iErr.message);

    matchedInq = (inqs || []).find(i => {
      const iId = (i.id || '').replace(/-/g, '').toUpperCase();
      return iId.startsWith(cleanInqCode) || (i.id || '').toUpperCase().startsWith(cleanInqCode) || iId.includes(cleanInqCode);
    });
  }

  // 1b. Unscoped fallback by explicit cleanInqCode
  if (!matchedDeal && !matchedInq && cleanInqCode) {
    const { data: allDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, delivery_location, payment_terms, salesperson_phone, created_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false })
      .limit(500);

    const accessibleDeals = await filterRecordsToCallerScope(allDeals, scope, { customerField: 'customer_name' });
    matchedDeal = accessibleDeals.find(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || (d.id || '').toUpperCase().startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
    });

    if (!matchedDeal) {
      const { data: allInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, stage, po_number, reference_po_number, generated_po_number, salesperson_phone, created_at, ai_extraction_json')
        .order('created_at', { ascending: false })
        .limit(500);

      const accessibleInqs = await filterRecordsToCallerScope(allInqs, scope, { customerField: 'sender_name' });
      matchedInq = accessibleInqs.find(i => {
        const iId = (i.id || '').replace(/-/g, '').toUpperCase();
        return iId.startsWith(cleanInqCode) || (i.id || '').toUpperCase().startsWith(cleanInqCode) || iId.includes(cleanInqCode);
      });
    }
  }

  if (!matchedDeal && !matchedInq) {
    return {
      isValid: false,
      reply: `Inquiry ID not found. Please verify and try again.`,
    };
  }

  // Determine stage & display formatting
  const canonicalInqId = matchedInq ? matchedInq.id : (matchedDeal?.inquiry_id || matchedDeal?.id);
  const formattedCode = canonicalInqId ? `INQ-${canonicalInqId.replace(/-/g, '').slice(0, 6).toUpperCase()}` : 'Inquiry';

  const rawStage = (matchedInq ? (matchedInq.stage || matchedInq.status) : matchedDeal?.stage) || 'new_inquiry';
  const stageLower = String(rawStage).toLowerCase().trim();

  const isNewInquiryStage = [
    'new_inquiry',
    'new',
    'auto_created',
    'inquiry'
  ].includes(stageLower);

  if (isNewInquiryStage) {
    return {
      isValid: false,
      reply: `Order cannot be created. Inquiry ${formattedCode} is currently in New Inquiry stage. A quotation must be sent before an order can be recorded.`,
    };
  }

  if (stageLower === 'lost' || stageLower === 'closed lost' || stageLower === 'closed_lost') {
    return {
      isValid: false,
      reply: `Order cannot be created. Inquiry ${formattedCode} is marked as Lost. Please reopen or update the inquiry before recording an order.`,
    };
  }

  // If Quoted stage -> Auto populate customer name, delivery location, payment terms, line items, PO details
  draft.inquiry_id = formattedCode;
  draft._inquiry_display_id = formattedCode;

  const sessionRate = draft.rate ? (parseIndianAmount(draft.rate) ?? 0) : null;

  // 1. Customer Name
  if (!draft.company_name) {
    draft.company_name = matchedDeal?.customer_name || matchedInq?.sender_name || matchedInq?.ai_extraction_json?.customer_name || matchedInq?.ai_extraction_json?.companyName || null;
  }
  if (draft.company_name) {
    draft._customer_verified = true;
  }

  // 2. Delivery Location
  if (!draft.delivery_location) {
    draft.delivery_location = matchedDeal?.delivery_location || matchedInq?.ai_extraction_json?.delivery_location || matchedInq?.ai_extraction_json?.deliveryLocation || matchedInq?.ai_extraction_json?.delivery_address || null;
  }

  // 3. Payment Terms
  if (!draft.payment_terms) {
    draft.payment_terms = matchedDeal?.payment_terms || matchedInq?.ai_extraction_json?.payment_terms || matchedInq?.ai_extraction_json?.paymentTerms || null;
  }

  // 4. PO Date
  if (!draft.po_date) {
    draft.po_date = formatDateDDMMYYYY(new Date());
  }

  // 5. Preserve a customer PO from a quoted legacy record as Reference PO.
  // The draft's generated system PO remains the canonical editable value.
  if (!draft.reference_po_number) {
    draft.reference_po_number =
      matchedDeal?.reference_po_number ||
      matchedInq?.reference_po_number ||
      (
        matchedDeal?.po_number &&
        !/^EM\/PO\/\d+$/i.test(String(matchedDeal.po_number).trim())
          ? matchedDeal.po_number
          : null
      ) ||
      (
        matchedInq?.po_number &&
        !/^EM\/PO\/\d+$/i.test(String(matchedInq.po_number).trim())
          ? matchedInq.po_number
          : null
      );
  }

  // 6. Fetch DB line items
  let dbItems = [];
  if (matchedDeal && Array.isArray(matchedDeal.deal_items) && matchedDeal.deal_items.length > 0) {
    dbItems = matchedDeal.deal_items;
  } else if (matchedDeal?.id) {
    const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', matchedDeal.id);
    if (dItems && dItems.length > 0) dbItems = dItems;
  }

  if (dbItems.length === 0 && canonicalInqId) {
    const { data: inqItems } = await supabase.from('inquiry_items').select('*').eq('inquiry_id', canonicalInqId);
    if (inqItems && inqItems.length > 0) dbItems = inqItems;
  }

  if (dbItems.length === 0 && matchedInq?.ai_extraction_json?.line_items) {
    dbItems = matchedInq.ai_extraction_json.line_items;
  }

  if (dbItems.length > 0) {
    if (!Array.isArray(draft.line_items) || draft.line_items.length === 0) {
      draft.line_items = dbItems.map(it => {
        const qty = Number(it.quantity) || 0;
        const itemRate = Number(it.rate) || (Number(it.amount) && Number(it.quantity) ? Number(it.amount) / Number(it.quantity) : 0);
        const rate = itemRate > 0 ? itemRate : ((sessionRate && sessionRate > 0) ? sessionRate : (matchedInq?.ai_extraction_json?.rate ? Number(matchedInq.ai_extraction_json.rate) : 0));
        const amount = qty > 0 && rate > 0 ? qty * rate : (Number(it.amount) || 0);
        const sku = it.sku_text || it.description || 'Metal Product';
        const dim = it.dimensions || it.spec || null;
        const norm = normalizeProductToCatalog(sku, dim);
        const canonicalSku = norm.isValid ? norm.catalogName : sku;
        const hsn = it.hsn_code || it.hsn_sac || (norm.isValid ? norm.hsnCode : detectHsnCode(sku, dim));
        return {
          sku_text: canonicalSku,
          description: it.description || canonicalSku,
          dimensions: dim,
          spec: dim,
          quantity: qty,
          unit: it.unit || 'MT',
          rate: rate,
          amount: amount,
          hsn_sac: hsn,
          hsn_code: hsn,
          is_valid_catalog: norm.isValid,
        };
      });
    } else {
      draft.line_items = draft.line_items.map((it, idx) => {
        const fallbackDb = dbItems[idx] || dbItems[0] || {};
        const qty = Number(it.quantity) || Number(fallbackDb.quantity) || 0;
        const itemRate = Number(it.rate) || Number(fallbackDb.rate) || (Number(it.amount) && Number(it.quantity) ? Number(it.amount) / Number(it.quantity) : 0);
        const rate = itemRate > 0 ? itemRate : ((sessionRate && sessionRate > 0) ? sessionRate : 0);
        const amount = qty > 0 && rate > 0 ? qty * rate : (Number(it.amount) || 0);
        const sku = it.sku_text || it.description || fallbackDb.sku_text || fallbackDb.description || 'Metal Product';
        const dim = it.dimensions || it.spec || fallbackDb.dimensions || fallbackDb.spec || null;
        const norm = normalizeProductToCatalog(sku, dim);
        const canonicalSku = norm.isValid ? norm.catalogName : sku;
        const hsn = it.hsn_code || it.hsn_sac || fallbackDb.hsn_code || (norm.isValid ? norm.hsnCode : detectHsnCode(sku, dim));
        return {
          ...fallbackDb,
          ...it,
          sku_text: canonicalSku,
          description: it.description || fallbackDb.description || canonicalSku,
          dimensions: dim,
          spec: dim,
          quantity: qty,
          unit: it.unit || fallbackDb.unit || 'MT',
          rate: rate,
          amount: amount,
          hsn_sac: hsn,
          hsn_code: hsn,
          is_valid_catalog: norm.isValid,
        };
      });
    }
  }

  return {
    isValid: true,
    deal: matchedDeal,
    inquiry: matchedInq,
  };
}

// ── STRICT PRODUCT CATALOG VERIFICATION ──────────────────────────────────────

function resolveClarifiedProduct(userInput, invalidProduct) {
  const clean = (userInput || '').trim();
  if (!clean) return null;
  const cleanLower = clean.toLowerCase();
  const pLower = String(invalidProduct || '').toLowerCase();

  const sheetOptions = ['HR Sheet', 'CR Sheet', 'HRPO Sheet', 'GP Sheet', 'Galvalume Sheet', 'Chequered Sheet'];
  const coilOptions = ['HR Coil', 'CR Coil', 'HRPO Coil', 'GP Coil', 'Galvalume Coil', 'Chequered Coil'];
  const plateOptions = ['HR Plate', 'HR Sheet', 'Chequered Sheet'];
  const pipeOptions = ['MS Round Pipe', 'MS Square Pipe', 'MS Rectangular Tube'];
  const barOptions = ['MS Round Bar', 'MS Flat Bar', 'MS Square Bar', 'TMT Bar'];

  let targetList = [];
  if (pLower.includes('sheet')) targetList = sheetOptions;
  else if (pLower.includes('coil')) targetList = coilOptions;
  else if (pLower.includes('plate')) targetList = plateOptions;
  else if (pLower.includes('pipe') || pLower.includes('tube')) targetList = pipeOptions;
  else if (pLower.includes('bar') || pLower.includes('rod') || pLower.includes('sariya')) targetList = barOptions;

  // 1. Numeric option matches (e.g. "1", "option 1", "choice 1", "#1", "first option", "1st option")
  const numMatch = clean.match(/\b(?:option\s*|choice\s*|#\s*)?([1-6])\b/i) ||
    (clean.match(/\b(first|1st)\b/i) ? [null, '1'] :
    clean.match(/\b(second|2nd)\b/i) ? [null, '2'] :
    clean.match(/\b(third|3rd)\b/i) ? [null, '3'] :
    clean.match(/\b(fourth|4th)\b/i) ? [null, '4'] :
    clean.match(/\b(fifth|5th)\b/i) ? [null, '5'] :
    clean.match(/\b(sixth|6th)\b/i) ? [null, '6'] : null);

  if (numMatch && targetList.length > 0) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (targetList[idx]) return targetList[idx];
  }

  // 2. Direct mention of any option in targetList (e.g. "same configuration for HR plate", "use HR sheet")
  if (targetList.length > 0) {
    const sortedTargets = [...targetList].sort((a, b) => b.length - a.length);
    for (const opt of sortedTargets) {
      if (cleanLower.includes(opt.toLowerCase())) {
        return opt;
      }
    }
  }

  // 3. Check all known catalog products if mentioned in conversational text
  const allCatalogProducts = [
    'Chequered Sheet', 'Chequered Plate', 'Galvalume Sheet', 'Galvalume Coil',
    'HRPO Sheet', 'HRPO Coil', 'CR Sheet', 'CR Coil', 'HR Sheet', 'HR Plate', 'HR Coil',
    'GP Sheet', 'GP Coil', 'GI Sheet', 'GI Coil',
    'MS Round Pipe', 'MS Square Pipe', 'MS Rectangular Tube',
    'MS Round Bar', 'MS Flat Bar', 'MS Square Bar', 'TMT Bar'
  ];
  for (const catProd of allCatalogProducts) {
    if (cleanLower.includes(catProd.toLowerCase())) {
      const norm = normalizeProductToCatalog(catProd);
      if (norm.isValid) return norm.catalogName;
    }
  }

  // 4. Exact normalization
  const norm = normalizeProductToCatalog(clean);
  if (norm.isValid) return norm.catalogName;

  return null;
}

function findMatchingCustomProduct(rawProduct, draft) {
  const clean = String(rawProduct || '').trim().toLowerCase();
  if (!clean) return null;

  const verifiedList = Array.isArray(draft?._verified_custom_products)
    ? draft._verified_custom_products
    : [];
  if (verifiedList.some((v) => String(v || '').trim().toLowerCase() === clean)) {
    const cached = typeof getCachedCustomProducts === 'function' ? getCachedCustomProducts() : [];
    const dbMatch = (cached || []).find(
      (p) => String(p.product_name || '').trim().toLowerCase() === clean,
    );
    return dbMatch || { product_name: String(rawProduct).trim(), dimensions: '', hsn_code: '' };
  }

  const cached = typeof getCachedCustomProducts === 'function' ? getCachedCustomProducts() : [];
  if (!Array.isArray(cached) || cached.length === 0) return null;

  return (
    cached.find((p) => String(p.product_name || '').trim().toLowerCase() === clean) || null
  );
}

function isCustomProductRecognized(rawProduct, draft) {
  return Boolean(findMatchingCustomProduct(rawProduct, draft));
}

function resolveProductHsnOrEmpty(skuText, dimensions, fallbackHsn, draft) {
  if (fallbackHsn && String(fallbackHsn).trim()) {
    return String(fallbackHsn).trim();
  }
  const detected =
    typeof detectHsnCode === 'function' ? detectHsnCode(skuText || '', dimensions || '') : null;
  if (detected) return detected;
  const customMatch = findMatchingCustomProduct(skuText, draft);
  if (customMatch && customMatch.hsn_code && String(customMatch.hsn_code).trim()) {
    return String(customMatch.hsn_code).trim();
  }
  return '';
}

function extractPendingNewProductSeed(draft, invalidProductName) {
  const fallbackName = String(invalidProductName || '').trim();
  if (Array.isArray(draft?.line_items) && draft.line_items.length > 0) {
    for (const item of draft.line_items) {
      const pName = String(item.sku_text || item.description || '').trim();
      const dim = String(item.dimensions || item.spec || '').trim();
      if (pName) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid && !isCustomProductRecognized(pName, draft)) {
          return {
            original_name: pName,
            product_name: pName,
            dimensions: dim,
            hsn_code: String(item.hsn_code || item.hsn_sac || '').trim(),
          };
        }
      }
    }
  }
  if (Array.isArray(draft?.line_item_updates) && draft.line_item_updates.length > 0) {
    for (const item of draft.line_item_updates) {
      const pName = String(item.sku_text || item.description || item.item_reference || '').trim();
      const dim = String(item.dimensions || item.spec || '').trim();
      if (pName && !isGenericLineUpdateRef(pName) && !/^(?:item\s*\d+|\d+|line\s*#?\d+)$/i.test(pName)) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid && !isCustomProductRecognized(pName, draft)) {
          return {
            original_name: pName,
            product_name: pName,
            dimensions: dim,
            hsn_code: String(item.hsn_code || item.hsn_sac || '').trim(),
          };
        }
      }
    }
  }
  if (draft?._line_mutation?.awaiting === 'catalog' && draft._line_mutation.productName) {
    const mutName = String(draft._line_mutation.productName).trim();
    return {
      original_name: mutName,
      product_name: mutName,
      dimensions: String(draft._line_mutation.spec || '').trim(),
      hsn_code: '',
    };
  }
  const resolvedName = fallbackName || String(draft?.product_description || '').trim();
  return {
    original_name: resolvedName,
    product_name: resolvedName,
    dimensions: '',
    hsn_code: '',
  };
}

function mergePartialAddProductInput(pendingProd, rawText) {
  const next = {
    original_name: String(pendingProd?.original_name || pendingProd?.product_name || '').trim(),
    product_name: String(pendingProd?.product_name || '').trim(),
    dimensions: String(pendingProd?.dimensions || '').trim(),
    hsn_code: String(pendingProd?.hsn_code || '').trim(),
  };
  let remaining = String(rawText || '').trim();
  if (!remaining) return next;

  const hsnLabeled = remaining.match(
    /\b(?:hsn\s*\/?\s*sac(?:\s*code)?|hsn(?:\s*code)?|sac(?:\s*code)?)\s*[:=-]?\s*([0-9]{4,8})\b/i,
  );
  if (hsnLabeled) {
    next.hsn_code = hsnLabeled[1].trim();
    remaining = remaining.replace(hsnLabeled[0], ' ');
  }

  const specLabeled = remaining.match(
    /\b(?:specs?\s*\/?\s*dimensions?|specs?|dimensions?|size|thickness)\s*[:=-]\s*([^,\n|;]+)/i,
  );
  if (specLabeled) {
    next.dimensions = specLabeled[1].trim();
    remaining = remaining.replace(specLabeled[0], ' ');
  }

  const nameLabeled = remaining.match(
    /\b(?:product\s*name|name|product)\s*[:=-]\s*([^,\n|;]+)/i,
  );
  if (nameLabeled) {
    next.product_name = nameLabeled[1].trim();
    remaining = remaining.replace(nameLabeled[0], ' ');
  }

  if (!hsnLabeled) {
    const bareHsn = remaining.match(/(?:^|[\s,;|])([0-9]{4,8})(?=$|[\s,;|])/);
    if (bareHsn) {
      next.hsn_code = bareHsn[1].trim();
      remaining = remaining.replace(bareHsn[1], ' ');
    }
  }

  const segments = remaining
    .split(/[,;|\n]+/)
    .map((s) => s.replace(/^[\s:=-]+|[\s:=-]+$/g, '').trim())
    .filter(Boolean);

  const isDimensionLike = (str) =>
    /(?:\d+(?:\.\d+)?\s*[xX*×]\s*\d+|\b\d+(?:\.\d+)?\s*(?:mm|cm|m|inch|in|ft|thk|gauge|swg|nb|od|sch|schedule|id|wt)\b|\b(?:is\s*\d+|grade\s*[a-z0-9-]+|astm\s*[a-z0-9-]+|fe\s*\d+)\b|^\d)/i.test(
      str,
    );

  segments.forEach((seg, idx) => {
    const inlineNameAndSpec = seg.match(
      /^([A-Za-z][A-Za-z\s/-]{1,40}?)\s+(\d+(?:\.\d+)?\s*(?:[xX*×]\s*\d+(?:\.\d+)?(?:\s*[xX*×]\s*\d+(?:\.\d+)?)?|\s*(?:mm|cm|m|inch|in|ft|thk|gauge|swg|nb|od)\b).*)$/i,
    );
    if (inlineNameAndSpec && !specLabeled && !nameLabeled) {
      next.product_name = inlineNameAndSpec[1].trim();
      next.dimensions = inlineNameAndSpec[2].trim();
      return;
    }

    if (isDimensionLike(seg)) {
      if (!specLabeled) next.dimensions = seg;
      return;
    }

    if (segments.length >= 2 && idx === 0 && !nameLabeled) {
      next.product_name = seg;
      return;
    }
    if (segments.length >= 2 && idx >= 1 && !specLabeled) {
      next.dimensions = seg;
      return;
    }

    if (!next.product_name) {
      next.product_name = seg;
    } else if (
      /^(?:standard|custom|commercial|regular|normal|mill\s*edge|slit\s*edge|trimmed|untrimmed|any|na|n\/a)$/i.test(
        seg,
      )
    ) {
      next.dimensions = seg;
    } else {
      next.product_name = seg;
    }
  });

  if (!next.original_name && next.product_name) {
    next.original_name = next.product_name;
  }
  return next;
}

function buildAddProductPromptCard(pendingProd, prefixWarning = '') {
  const pName = String(pendingProd?.product_name || '').trim() || '_Empty_';
  const specs = String(pendingProd?.dimensions || '').trim() || '_Empty_';
  const hsn = String(pendingProd?.hsn_code || '').trim() || '_Empty_';
  const missing = [];
  if (!String(pendingProd?.product_name || '').trim()) missing.push('Product Name *');
  if (!String(pendingProd?.dimensions || '').trim()) missing.push('Specs / Dimensions *');
  if (!String(pendingProd?.hsn_code || '').trim()) missing.push('HSN/SAC Code *');

  const prefix = prefixWarning ? `${prefixWarning}\n\n` : '';
  const guidance =
    missing.length > 0
      ? `👉 Please reply with the missing mandatory fields (${missing.join(', ')}) — you can send them together or one by one _(e.g. "Specs: 10mm, HSN: 72083700")_, then tap *Save Product*.`
      : `👉 Tap *Save Product* to add this product and continue, or reply with *Product Name* / *Specs* / *HSN Code* to update before saving.`;

  return (
    `${prefix}📦 *Add New Product*\n\n` +
    `- **Product Name *:** ${pName}\n` +
    `- **Specs / Dimensions *:** ${specs}\n` +
    `- **HSN/SAC Code *:** ${hsn}\n\n` +
    guidance
  );
}

function validateDraftProducts(action, draft) {
  if (!draft || !['LOG_INQUIRY', 'UPDATE_INQUIRY', 'LOG_ORDER', 'UPDATE_ORDER'].includes(action)) {
    return { isValid: true };
  }

  const invalidProducts = [];

  // 1. Validate line items
  if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
    for (const item of draft.line_items) {
      const pName = item.sku_text || item.description || '';
      const dim = item.dimensions || item.spec || '';
      if (pName && pName.trim()) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid && !isCustomProductRecognized(pName, draft)) {
          invalidProducts.push(pName.trim());
        }
      }
    }
  }

  // 2. Validate line item updates for UPDATE flows
  if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
    for (const item of draft.line_item_updates) {
      const pName = item.sku_text || item.description || item.item_reference || '';
      const dim = item.dimensions || item.spec || '';
      if (pName && pName.trim() && !isGenericLineUpdateRef(pName) && !/^(?:item\s*\d+|\d+|line\s*#?\d+)$/i.test(pName.trim())) {
        const norm = normalizeProductToCatalog(pName, dim);
        if (!norm.isValid && !isCustomProductRecognized(pName, draft)) {
          invalidProducts.push(pName.trim());
        }
      }
    }
  }

  // 3. Validate product_description if line_items is empty
  if ((!draft.line_items || draft.line_items.length === 0) && draft.product_description && typeof draft.product_description === 'string') {
    const rawDesc = draft.product_description.trim();
    if (rawDesc.length > 0) {
      const norm = normalizeProductToCatalog(rawDesc);
      if (!norm.isValid && !isCustomProductRecognized(rawDesc, draft)) {
        invalidProducts.push(rawDesc);
      }
    }
  }

  // 4. Validate pending line mutation awaiting catalog clarification
  if (draft._line_mutation?.awaiting === 'catalog' && draft._line_mutation.productName) {
    const mutProd = String(draft._line_mutation.productName).trim();
    if (mutProd && !isCustomProductRecognized(mutProd, draft)) {
      invalidProducts.push(mutProd);
    }
  }

  if (invalidProducts.length > 0) {
    const seen = new Set();
    const uniqueInvalid = [];
    for (const p of invalidProducts) {
      const k = p.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        uniqueInvalid.push(p);
      }
    }
    const clarificationMessage = getUnknownProductClarificationMessage(uniqueInvalid);
    return {
      isValid: false,
      invalidProducts: uniqueInvalid,
      clarificationMessage,
      reply: clarificationMessage,
      canAddProduct: true,
      interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
    };
  }

  return { isValid: true };
}

// ── EXTRACT VISIT DETAILS & FORMATTING HELPERS ──────────────────────────────

function extractVisitDetails(v) {
  if (!v) return {};
  const vDate = v.visited_at ? new Date(v.visited_at) : new Date();
  const dateFormatted = formatDateDDMMYYYY(vDate);

  const rem = String(v.remarks || '');

  const outTagMatch = rem.match(/\[Outcome:\s*([^\]]+)\]/i);
  const rawOutcome = v.outcome || (outTagMatch ? outTagMatch[1].trim() : 'Positive');
  const outcome = rawOutcome ? (rawOutcome.charAt(0).toUpperCase() + rawOutcome.slice(1)) : 'Positive';

  const locTagMatch = rem.match(/\[Location:\s*([^\]]+)\]/i) || rem.match(/(?:^|\||\n)\s*Location:\s*([^|\]\n]+)/i);
  const location = v.customer_address || v.location || (locTagMatch ? locTagMatch[1].trim() : 'Not specified');

  const fuActionMatch = rem.match(/\[(?:Follow-?Up|Follow-?up\s*Action):\s*([^\]]+)\]/i) ||
                        rem.match(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*([^|\]\n]+)/i);
  let followUpAction = v.follow_up_action || (fuActionMatch ? fuActionMatch[1].trim() : null);
  if (followUpAction) {
    const lFu = followUpAction.toLowerCase();
    if (['none', 'nil', 'n/a', 'na', 'null', '-', 'not required', 'no follow-up', 'no follow up'].includes(lFu)) {
      followUpAction = null;
    }
  }

  const fuDateMatch = rem.match(/\[(?:Follow-?UpDate|Follow-?up\s*Date):\s*([^\]]+)\]/i) ||
                      rem.match(/(?:^|\||\n)\s*Follow-?up\s*Date:\s*([^|\]\n]+)/i);
  const rawFuDate = v.follow_up_date || (fuDateMatch ? fuDateMatch[1].trim() : null);
  let followUpDate = null;
  if (rawFuDate) {
    const parsed = new Date(rawFuDate);
    if (!isNaN(parsed.getTime())) {
      followUpDate = formatDateDDMMYYYY(parsed);
    } else {
      followUpDate = rawFuDate;
    }
  } else if (followUpAction) {
    const extractedDate = extractFollowUpDate(followUpAction, vDate);
    if (extractedDate) {
      followUpDate = formatDateDDMMYYYY(new Date(extractedDate));
    }
  }

  const fuStatusMatch = rem.match(/\[(?:Follow-?UpStatus|Follow-?up\s*Status):\s*([^\]]+)\]/i) ||
                        rem.match(/(?:^|\||\n)\s*Follow-?up\s*Status:\s*([^|\]\n]+)/i);
  const rawFuStatus = (followUpAction || fuStatusMatch) ? (fuStatusMatch ? fuStatusMatch[1].trim() : (v.follow_up_status || 'pending')) : null;
  let followUpStatus = null;
  if (rawFuStatus) {
    const sLower = rawFuStatus.toLowerCase();
    const isNegatedStatus = /\b(?:not|no|never|pending|yet|nahi|nahin|incomplete|un-?resolved)\b/.test(sLower);
    if (!isNegatedStatus && ['completed', 'done', 'resolved', 'closed'].some(st => sLower.includes(st))) {
      followUpStatus = 'Completed';
    } else {
      followUpStatus = 'Pending';
    }
  }

  const cleanRemarks = rem
    .replace(/\[(?:Outcome|Location|Follow-?Up|Follow-?up\s*Action|Follow-?UpDate|Follow-?up\s*Date|Follow-?UpStatus|Follow-?up\s*Status|Requirement|Requirements|Material\s*Requirement|Discussion|Interests?|Make|Payment\s*Terms|Terms):\s*[^\]]+\]/gi, '')
    .replace(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Follow-?up\s*Date:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Follow-?up\s*Status:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*(?:Material\s*)?Requirement:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Location:\s*[^|\n]+/gi, '')
    .replace(/^[\s|•-]+|[\s|•-]+$/g, '')
    .trim();

  const reqTagMatch = rem.match(/\[(?:Requirement|Requirements|Material\s*Requirement):\s*([^\]]+)\]/i);
  const makeTagMatch = rem.match(/\[(?:Make|Preferred\s*Make):\s*([^\]]+)\]/i);
  const termsTagMatch = rem.match(/\[(?:Payment\s*Terms|Terms):\s*([^\]]+)\]/i);

  const productDetails = v.product_details || (reqTagMatch ? reqTagMatch[1].trim() : null);
  const preferredMake = v.preferred_make || (makeTagMatch ? makeTagMatch[1].trim() : null);
  const paymentTerms = v.payment_terms || (termsTagMatch ? termsTagMatch[1].trim() : null);

  let nextPurchaseExpected = null;
  if (v.next_purchase_expected) {
    const parsedNpe = new Date(v.next_purchase_expected);
    if (!isNaN(parsedNpe.getTime())) {
      nextPurchaseExpected = formatDateDDMMYYYY(parsedNpe);
    } else {
      nextPurchaseExpected = v.next_purchase_expected;
    }
  }

  return {
    id: v.id,
    customer_name: v.customer_name || 'Customer',
    location: location || 'Not specified',
    outcome: outcome || 'Positive',
    date_formatted: dateFormatted,
    person_met: v.person_met || 'Not specified',
    contact_no: v.contact_no || v.contact_phone || null,
    contact_phone: v.contact_phone || v.contact_no || null,
    email: v.email || null,
    designation: v.designation || null,
    customer_type: v.customer_type || null,
    visit_type: v.visit_type || null,
    customer_probability: v.customer_probability || null,
    product_details: productDetails,
    monthly_consumption: v.monthly_consumption || null,
    current_requirement: v.current_requirement || null,
    next_purchase_expected: nextPurchaseExpected,
    delivery_location: v.delivery_location || null,
    preferred_make: preferredMake,
    payment_terms: paymentTerms,
    gps_photo_url: v.gps_photo_url || null,
    attachments: Array.isArray(v.attachments) ? v.attachments : [],
    gps_latitude: v.gps_latitude || null,
    gps_longitude: v.gps_longitude || null,
    gps_accuracy: v.gps_accuracy || null,
    follow_up_action: followUpAction,
    follow_up_date: followUpDate,
    follow_up_status: followUpStatus,
    remarks: cleanRemarks || 'Not specified',
    visited_at: v.visited_at,
    salesperson_phone: v.salesperson_phone || null,
  };
}

function formatSelectedVisitPrompt(record) {
  let prompt = `*Selected Field Visit for ${record.customer_name} (${record.date_formatted}):*\n\n` +
    `*Stakeholder & Classification:*\n` +
    `• *Person Met:* ${record.person_met || 'Not specified'}\n` +
    `• *Designation:* ${record.designation || 'Not specified'}\n` +
    `• *Contact Phone:* ${record.contact_phone || record.contact_no || 'Not specified'}\n` +
    `• *Email:* ${record.email || 'Not specified'}\n` +
    `• *City / Location:* ${record.location || 'Not specified'}\n` +
    `• *Customer Type:* ${record.customer_type || 'Not specified'}\n` +
    `• *Visit Type:* ${record.visit_type || 'Not specified'}\n` +
    `• *Outcome:* ${record.outcome || 'Positive'}\n` +
    `• *Customer Probability:* ${record.customer_probability || 'Not specified'}\n\n` +
    `*Commercials & Requirements:*\n` +
    `• *Product Details:* ${record.product_details || 'Not specified'}\n` +
    `• *Monthly Consumption:* ${record.monthly_consumption || 'Not specified'}\n` +
    `• *Current Requirement:* ${record.current_requirement || 'Not specified'}\n` +
    `• *Next Purchase Expected:* ${record.next_purchase_expected || 'Not specified'}\n` +
    `• *Preferred Make:* ${record.preferred_make || 'Not specified'}\n` +
    `• *Payment Terms:* ${record.payment_terms || 'Not specified'}\n` +
    `• *Delivery Location:* ${record.delivery_location || 'Not specified'}\n\n` +
    `*Follow-up & Meeting Notes:*\n` +
    `• *Follow-up Action:* ${record.follow_up_action || 'None'}\n` +
    `• *Follow-up Date:* ${record.follow_up_date || 'None'}\n` +
    `• *Follow-up Status:* ${record.follow_up_status || 'Pending'}\n` +
    `• *Remarks:* ${record.remarks || 'Not specified'}\n`;

  const attCount = (Array.isArray(record.attachments) ? record.attachments.length : 0) + (record.gps_photo_url ? 1 : 0);
  if (attCount > 0) {
    prompt += `• *Attachments:* ${attCount} photo(s) on file\n`;
  }

  prompt += `\n*Which fields would you like to update?*\n` +
    `_(Reply with the field name and new value, or upload a new site photo)_`;

  return prompt;
}

function formatSelectedComplaintPrompt(record) {
  const customer = record.customer_name || 'Customer';
  const date = record.complaint_date || record.date_formatted || 'Not specified';
  const resolutionNotes = record.resolution_notes || 'Not specified';
  const fields = [
    'Complaint Raised By',
    'Complaint Type',
    'Complaint Description',
    'Status',
    'Resolution Notes',
  ];

  return `*Selected Customer Complaint: ${customer}*\n` +
    `*Complaint Details:*\n` +
    `• *Complaint Date:* ${date}\n` +
    `• *Complaint Raised By:* ${record.raised_by || 'Not specified'}\n` +
    `• *Linked Order / Ref:* ${record.po_number ? `PO: ${record.po_number}` : (record.linked_inquiry_or_po || 'Not specified')}\n` +
    `• *Product / Material:* ${record.product_name || record.affected_product || 'Not specified'}\n` +
    `• *Complaint Type:* ${record.complaint_type || 'Quality Defect'}\n` +
    `• *Invoice / Challan No.:* ${record.challan_no || 'Not specified'}\n` +
    `• *Description:* ${record.description || 'Not specified'}\n` +
    `• *Status:* ${record.status || 'Open'}\n` +
    `• *Resolution Notes:* ${resolutionNotes}\n\n` +
    `*Fields to Update:*\n` +
    fields.map(field => `• *${field}*`).join('\n') +
    `\n\nPlease reply with the field name and new value.`;
}

function isFullRecordSelection(text = '') {
  const value = String(text).trim();
  if (!value.includes('|')) return false;
  if (/\b(?:update|change|edit|modify|set|resolve|close|reopen|mark)\b/i.test(value)) return false;
  return /\b(?:date|status|type|outcome|location|customer)\b/i.test(value);
}

function formatSelectedRecordPrompt(action, record) {
  if (action === 'UPDATE_COMPLAINT') return formatSelectedComplaintPrompt(record);
  if (action === 'UPDATE_VISIT') return formatSelectedVisitPrompt(record);
  return '';
}

function formatVisitSelectionLine(record, index) {
  return `${index}. *${record.customer_name}* | Date: ${record.date_formatted || 'Not specified'} | Person: ${record.person_met || 'Not specified'} | Location: ${record.location || 'Not specified'} | Outcome: ${record.outcome || 'Not specified'}`;
}

function formatComplaintSelectionLine(record, index) {
  return `${index}. *${record.customer_name}* | Date: ${record.complaint_date || record.date_formatted || 'Not specified'} | Type: ${record.complaint_type || 'Not specified'} | Status: ${record.status || 'Not specified'}`;
}

// ── MULTI-VISIT DATE DISAMBIGUATION CHECK ────────────────────────────────────

async function checkMultipleVisitsForUpdate(action, draft, senderPhone) {
  if (action !== 'UPDATE_VISIT') return { needsDisambiguation: false };
  if (draft.visit_id) return { needsDisambiguation: false };

  const hasCompanyName = Boolean(draft.company_name && draft.company_name.trim());
  const selectorDateIso = getStrictVisitDateIso(draft.visit_date);

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  let query = supabase
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false });

  if (hasCompanyName) {
    query = query.ilike('customer_name', `%${draft.company_name.trim()}%`);
  }

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      query = query.in('salesperson_phone', targetPhones);
    } else {
      return { needsDisambiguation: false };
    }
  }

  const { data: allVisits } = await query.limit(50);

  if (!allVisits || allVisits.length === 0) {
    if (hasCompanyName) return { needsDisambiguation: false };
    return {
      needsDisambiguation: false,
      handled: true,
      prompt: `ℹ️ *No Field Visits Found*\n\nThere are no existing field visit records in your portfolio.\n\nIf you would like to log a new field visit, reply with *5* or send the visit details (Customer Name, Person Met, Outcome, Remarks).`,
      reply: `ℹ️ *No Field Visits Found*\n\nThere are no existing field visit records in your portfolio.\n\nIf you would like to log a new field visit, reply with *5* or send the visit details (Customer Name, Person Met, Outcome, Remarks).`,
      draft,
    };
  }

  if (hasCompanyName && allVisits.length <= 1) return { needsDisambiguation: false };

  // 1. Accessibility filtering by salesperson phone
  let candidateVisits = allVisits.filter(v => {
    if (scope.isAdmin || scope.phones === null) return true;
    if (!v.salesperson_phone) return false;
    return isPhoneInScope(v.salesperson_phone, scope.phones);
  });

  // A partial name like "Steel" also pulls other companies' visits; prefer the matching customer
  if (hasCompanyName) {
    const sameCustomer = candidateVisits.filter(v => isCustomerMatch(draft.company_name, null, v.customer_name, null));
    if (sameCustomer.length > 0) candidateVisits = sameCustomer;
  }

  // 2. Filter out synthetic Bigin sync logs
  const realVisits = candidateVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
  let pool = realVisits.length > 0 ? realVisits : candidateVisits;

  // A visit date narrows the choice; several visits on that date still need a pick
  if (selectorDateIso) {
    const selectorDay = formatIsoDateIST(new Date(selectorDateIso));
    const sameDay = pool.filter(v => v.visited_at && formatIsoDateIST(new Date(v.visited_at)) === selectorDay);
    if (sameDay.length === 1) {
      draft.visit_id = sameDay[0].id;
      return { needsDisambiguation: false };
    }
    if (sameDay.length > 1) pool = sameDay;
  }

  if (hasCompanyName && pool.length === 1) {
    draft.visit_id = pool[0].id;
    return { needsDisambiguation: false };
  }
  if (hasCompanyName && pool.length === 0) return { needsDisambiguation: false };
  if (pool.length === 0) {
    if (hasCompanyName) return { needsDisambiguation: false };
    return {
      needsDisambiguation: false,
      handled: true,
      prompt: `ℹ️ *No Field Visits Found*\n\nThere are no existing field visit records in your portfolio.`,
      reply: `ℹ️ *No Field Visits Found*\n\nThere are no existing field visit records in your portfolio.`,
      draft,
    };
  }

  const pageSize = 10;
  const page = Number(draft._visit_candidates_page) || 1;
  const startIdx = (page - 1) * pageSize;
  const pageItems = pool.slice(startIdx, startIdx + pageSize);
  const totalPages = Math.ceil(pool.length / pageSize);

  const candidateSummaries = pageItems.map((v, idx) => {
    const details = extractVisitDetails(v);
    return {
      index: startIdx + idx + 1,
      ...details,
      company_name: details.customer_name || draft.company_name || 'Customer',
      date: details.date_formatted,
      time: formatVisitTimeIST(v.visited_at || v.created_at),
      remarks: details.remarks !== 'Not specified' ? (details.remarks.length > 80 ? details.remarks.slice(0, 77) + '...' : details.remarks) : null,
    };
  });

  const hasMixedCustomers = new Set(pool.map(v => String(v.customer_name || '').trim().toLowerCase())).size > 1;
  const dateCounts = candidateSummaries.reduce((acc, c) => acc.set(c.date, (acc.get(c.date) || 0) + 1), new Map());
  const choicesText = candidateSummaries
    .map(c => {
      const companyLabel = hasCompanyName && !hasMixedCustomers ? '' : ` (${c.company_name})`;
      // Several visits on the same date: show the time so they can be told apart
      const timeLabel = dateCounts.get(c.date) > 1 && c.time ? `, ${c.time}` : '';
      const lines = [
        `${c.index}. *Visit on ${c.date}${timeLabel}*${companyLabel}`,
        `   • *Person Met:* ${c.person_met}`,
        `   • *Location:* ${c.location}`,
        `   • *Outcome:* ${c.outcome}`,
      ];
      if (c.follow_up_action) {
        lines.push(`   • *Follow-up Action:* ${c.follow_up_action}`);
      }
      if (c.follow_up_date) {
        lines.push(`   • *Follow-up Date:* ${c.follow_up_date}`);
      }
      if (c.follow_up_status) {
        lines.push(`   • *Follow-up Status:* ${c.follow_up_status}`);
      }
      if (c.remarks) {
        lines.push(`   • *Remarks:* ${c.remarks}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  let headerText = hasCompanyName
    ? `📅 *Multiple Visits Found for ${draft.company_name} (${pool.length} Records):*`
    : `📅 *Recent Field Visits (${pool.length} Records):*`;

  if (pool.length > pageSize) {
    headerText = hasCompanyName
      ? `📅 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${pool.length} Visits Found for ${draft.company_name} (Page ${page} of ${totalPages}):*`
      : `📅 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${pool.length} Field Visits (Page ${page} of ${totalPages}):*`;
  }

  let footerText = `👉 Reply with the *Option Number* (1–${pool.length}), *Visit Date* (e.g. "${candidateSummaries[0].date}"), *Person Met*, or what you want to update.`;
  if (totalPages > 1) {
    footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
  }

  const prompt = `${headerText}\n\n` +
    `Please choose which visit you want to update:\n\n` +
    `${choicesText}\n\n` +
    `${footerText}`;

  draft._visit_candidates = candidateSummaries;
  draft._all_visit_candidates = pool;
  draft._visit_candidates_page = page;

  return {
    needsDisambiguation: true,
    handled: true,
    prompt,
    reply: prompt,
    draft,
  };
}

// ── MODULE STAGE FORMATTER ───────────────────────────────────────────────────

function formatStageLabel(st) {
  const s = String(st || '').toLowerCase();
  if (s.includes('won') || s.includes('order')) return 'Won';
  if (s.includes('lost')) return 'Lost';
  if (s.includes('quote') || s.includes('price') || s.includes('qualif') || s.includes('confirmed') || s.includes('proposal')) return 'Quoted';
  if (s.includes('negot')) return 'Negotiation';
  if (s.includes('hold')) return 'On Hold';
  return 'New Inquiry';
}

function activityStageName(st) {
  const s = String(st || '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'won' || s === 'closed won') return 'Closed Won';
  if (s === 'lost' || s === 'closed lost') return 'Closed Lost';
  if (['quoted', 'quotation_sent', 'qualified', 'saved', 'confirmed', 'processed', 'price quote'].includes(s)) return 'Price Quote';
  if (s.includes('negot')) return 'Negotiation';
  if (s === 'on_hold' || s === 'hold' || s === 'on hold') return 'On Hold';
  if (['new_inquiry', 'new', 'review', 'needs_review', 'pending', 'received', 'new inquiry'].includes(s)) return 'New Inquiry';
  return '';
}

function formatDetailedInquiryItemsList(items, { includeHsn = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((item, idx) => {
    const rawName = item.sku_text || item.product_requirement || item.product_name || item.description || item.pName || 'Steel Item';
    const grade = String(item.grade || '').trim();
    const name = grade && !rawName.toLowerCase().includes(grade.toLowerCase())
      ? `${rawName} ${grade}`
      : rawName;
    const dim = item.dimensions || item.spec || item.thickness || item.size;
    let spec = '';
    if (dim) {
      const thkMatch = String(dim).match(/(\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g))\b/i);
      const shortSpec = thkMatch ? thkMatch[0].trim() : String(dim).split(/[\s(,]/)[0].trim();
      if (shortSpec && !name.toLowerCase().includes(shortSpec.toLowerCase())) {
        spec = ` (${shortSpec})`;
      } else if (!name.toLowerCase().includes(String(dim).toLowerCase())) {
        spec = ` (${dim})`;
      }
    }

    let hsnBlock = '';
    if (includeHsn) {
      const detected = (typeof detectHsnCode === 'function') ? detectHsnCode(rawName, dim || '') : null;
      const hsn = item.hsn_code || item.hsn_sac || item.hsn || detected;
      if (hsn) {
        hsnBlock = ` [HSN: ${hsn}]`;
      }
    }

    const calc = calculateLineItem(item);
    const displayQty = (calc.quantity !== '' && calc.quantity !== null && calc.quantity !== undefined && Number(calc.quantity) > 0)
      ? `${Number(calc.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${calc.unit || 'MT'}`
      : '';
    const rate = Number(calc.rate || 0);
    const lineTotal = Number(calc.final_amount || 0) || (calc.amount ? Math.round(Number(calc.amount) * 1.18 * 100) / 100 : 0);

    const prefix = items.length > 1 ? `${idx + 1}. ` : '';

    if (rate > 0) {
      const formattedLineTotal = formatMoneyValue(lineTotal);
      const formattedRate = formatMoneyValue(rate);
      const lineTotalStr = lineTotal > 0 ? ` | Line Total: ₹${formattedLineTotal}` : '';
      return `${prefix}${name}${spec}${hsnBlock}${displayQty ? ` | ${displayQty}` : ''} | ₹${formattedRate} /${calc.unit || 'MT'}${lineTotalStr}`;
    }

    return `${prefix}${name}${spec}${hsnBlock}${displayQty ? ` | ${displayQty}` : ''}`;
  }).join('\n');
}

/**
 * Helper to format Indian currency values with or without decimals cleanly.
 */
function formatMoneyValue(num) {
  if (num === null || num === undefined || isNaN(Number(num))) return '0';
  const n = Number(num);
  const hasDec = (n % 1 !== 0);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: hasDec ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Normalizes attribute values for display in inquiry/order update prompts.
 * If empty, null, undefined, 'Not specified', 'none', or 'null', returns '-'.
 */
function formatAttributeValue(val) {
  if (val === null || val === undefined) return '-';
  const str = String(val).trim();
  if (!str || str.toLowerCase() === 'not specified' || str.toLowerCase() === 'none' || str.toLowerCase() === 'null') {
    return '-';
  }
  return str;
}

/**
 * Extracts all core attributes (Preferred Make, Additional Notes, Payment Terms, Delivery Location)
 * from an inquiry row, AI extraction JSON, raw text, and linked deal.
 */
function extractInquiryAttributes(inq, linkedDeal = null) {
  if (!inq && !linkedDeal) {
    return { preferred_make: null, additional_notes: null, payment_terms: null, delivery_location: null };
  }

  const ai = inq?.ai_extraction_json
    ? (typeof inq.ai_extraction_json === 'string' ? safeParseJSON(inq.ai_extraction_json, {}) : inq.ai_extraction_json)
    : {};

  // 1. Preferred Make
  let preferredMake = linkedDeal?.preferred_make || ai.preferred_make || ai.preferredMake || ai.make || null;
  if (!preferredMake && Array.isArray(linkedDeal?.deal_items)) {
    const firstWithMake = linkedDeal.deal_items.find(it => it.preferred_make || it.make);
    if (firstWithMake) preferredMake = firstWithMake.preferred_make || firstWithMake.make;
  }
  if (!preferredMake && Array.isArray(ai.line_items || ai.lineItems)) {
    const firstWithMake = (ai.line_items || ai.lineItems).find(it => it.preferred_make || it.make || it.preferredMake);
    if (firstWithMake) preferredMake = firstWithMake.preferred_make || firstWithMake.make || firstWithMake.preferredMake;
  }
  if (!preferredMake && inq?.raw_text) {
    const match = inq.raw_text.match(/(?:Preferred Make|Make):\s*([^\r\n]+)/i);
    if (match) preferredMake = match[1].trim();
  }

  // 2. Additional Notes
  let additionalNotes = linkedDeal?.additional_notes || linkedDeal?.notes || linkedDeal?.remarks || ai.additional_notes || ai.additionalNotes || ai.notes || ai.remarks || null;
  if (!additionalNotes && inq?.raw_text) {
    const match = inq.raw_text.match(/(?:Additional Notes|Notes|Remarks?):\s*([^\r\n]+)/i);
    if (match) additionalNotes = match[1].trim();
  }

  // 3. Payment Terms
  let paymentTerms = linkedDeal?.payment_terms || inq?.payment_terms || ai.paymentTerms || ai.payment_terms || null;
  if (!paymentTerms && inq?.raw_text) {
    const match = inq.raw_text.match(/Payment Terms:\s*([^\r\n]+)/i);
    if (match) paymentTerms = match[1].trim();
  }

  // 4. Delivery Location
  let deliveryLocation = linkedDeal?.delivery_location || inq?.delivery_location || ai.deliveryLocation || ai.delivery_location || ai.delivery_address || null;
  if (!deliveryLocation && inq?.raw_text) {
    const match = inq.raw_text.match(/Delivery Location:\s*([^\r\n]+)/i);
    if (match) deliveryLocation = match[1].trim();
  }

  return {
    preferred_make: preferredMake,
    additional_notes: additionalNotes,
    payment_terms: paymentTerms,
    delivery_location: deliveryLocation,
  };
}

/**
 * Formats the selected inquiry card when chosen for update.
 * Guarantees that Date, Stage, Preferred Make, Payment Terms, Delivery Location,
 * and Additional Notes are always displayed in compulsory order, using '-' for any missing value.
 * Displays line item rates, line totals, and overall Quotation Total whenever pricing exists.
 */
function formatSelectedInquiryPrompt(matchedRecord, itemsListText) {
  const displayId = matchedRecord.displayId || `INQ-${(matchedRecord.inquiry_id || matchedRecord.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()}`;
  const custName = matchedRecord.customer_name || matchedRecord.company_name || 'Customer';
  const dateStr = matchedRecord.date_formatted || matchedRecord.dateFormatted || matchedRecord.date || (matchedRecord.created_at ? formatDateDDMMYYYY(matchedRecord.created_at) : '-');
  const stageStr = matchedRecord.stage || 'New Inquiry';

  // Calculate quotation total / total amount
  let totalAmt = Number(matchedRecord.total_amount || matchedRecord.totalAmount || 0);
  const items = Array.isArray(matchedRecord.deal_items)
    ? matchedRecord.deal_items
    : (Array.isArray(matchedRecord.existing_items) ? matchedRecord.existing_items : []);
  if (!totalAmt && items.length > 0) {
    totalAmt = items.reduce((s, it) => {
      const q = Number(it.quantity || 0);
      const r = Number(it.rate || 0);
      const a = Number(it.amount || 0);
      return s + (a || (q * r));
    }, 0);
  }

  const quoteTotalBlock = totalAmt > 0 ? `\n\nQuotation Total: ₹${formatMoneyValue(totalAmt)}` : '';

  return `✏️ *Selected Inquiry ${displayId} (${custName}):*\n\n` +
    `• *Date:* ${formatAttributeValue(dateStr)}\n` +
    `• *Stage:* ${formatAttributeValue(stageStr)}\n` +
    `• *Preferred Make:* ${formatAttributeValue(matchedRecord.preferred_make)}\n` +
    `• *Payment Terms:* ${formatAttributeValue(matchedRecord.payment_terms)}\n` +
    `• *Delivery Location:* ${formatAttributeValue(matchedRecord.delivery_location)}\n` +
    `• *Additional Notes:* ${formatAttributeValue(matchedRecord.additional_notes)}\n\n` +
    `*Current Line Items:*\n\n${itemsListText}` +
    quoteTotalBlock + `\n\n` +
    `You can update quantity, specs, payment terms, or delivery. Reply *Price this inquiry* after the base price is ready. Quoted, Won, and Lost stay closed until that sales price is saved.`;
}

/**
 * Formats the selected order card when chosen for update.
 * Guarantees that Linked Inquiry, PO Number, PO Date, Stage, Delivery Location,
 * and Payment Terms are displayed in compulsory order, using '-' for any missing value.
 * Displays Current Line Items with HSN code, Total Tonnage, Sub Total, GST (18%),
 * Total Order Value, and the multi-field update prompt.
 */
function formatSelectedOrderPrompt(matchedRecord, itemsListText) {
  const displayId = matchedRecord.displayId || matchedRecord.po_number || `INQ-${(matchedRecord.inquiry_id || matchedRecord.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()}`;
  const custName = matchedRecord.customer_name || matchedRecord.company_name || 'Customer';

  // Clean Linked Inquiry display
  const rawInqId = matchedRecord.inquiry_id || matchedRecord.id || '';
  const cleanInqCode = rawInqId.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
  const linkedInquiry = cleanInqCode ? `INQ-${cleanInqCode}` : (matchedRecord.deal_code || '-');

  const poNumberStr = matchedRecord.po_number || '-';
  const poDateStr = matchedRecord.po_date
    ? formatDateDDMMYYYY(matchedRecord.po_date)
    : (matchedRecord.date_formatted || matchedRecord.dateFormatted || (matchedRecord.won_at ? formatDateDDMMYYYY(matchedRecord.won_at) : (matchedRecord.created_at ? formatDateDDMMYYYY(matchedRecord.created_at) : '-')));
  const stageStr = formatStageLabel(matchedRecord.stage || 'Won');
  const delLocStr = matchedRecord.delivery_location || '-';
  const payTermsStr = matchedRecord.payment_terms || '-';

  // Line items & financial calculations
  const items = (Array.isArray(matchedRecord.deal_items) && matchedRecord.deal_items.length > 0)
    ? matchedRecord.deal_items
    : (Array.isArray(matchedRecord.existing_items) && matchedRecord.existing_items.length > 0)
      ? matchedRecord.existing_items
      : (Array.isArray(matchedRecord.items) && matchedRecord.items.length > 0)
        ? matchedRecord.items
        : [];

  let subtotal = 0;
  let totalTonnage = 0;
  let primaryUnit = 'MT';

  if (items.length > 0) {
    items.forEach(it => {
      const rawQty = (it.quantity !== undefined && it.quantity !== null && it.quantity !== '')
        ? it.quantity
        : ((it.quantity_mt !== undefined && it.quantity_mt !== null && it.quantity_mt !== '') ? it.quantity_mt : (it.qty || 0));
      const qty = Number(rawQty) || 0;
      const rate = Number(it.rate || it.rate_per_mt || it.target_price || it.unit_price || 0);
      const amount = Number(it.amount || it.line_total || it.total || 0) || (rate > 0 && qty > 0 ? (rate * qty) : 0);
      subtotal += amount;
      totalTonnage += qty;
      if (it.unit) primaryUnit = it.unit;
    });
  }

  if (subtotal === 0 && Number(matchedRecord.total_amount) > 0) {
    subtotal = Number(matchedRecord.total_amount);
  }

  const gstRate = 0.18;
  const gstAmount = Math.round(subtotal * gstRate * 100) / 100;
  const grandTotal = Math.round((subtotal + gstAmount) * 100) / 100;

  const tonnageStr = totalTonnage > 0
    ? (formatLineItemsTonnage(items) || `${formatMoneyValue(totalTonnage)} ${primaryUnit}`)
    : '';

  let lineItemsSection = '';
  if (itemsListText && itemsListText.trim()) {
    lineItemsSection = `*Current Line Items:*\n\n${itemsListText}\n`;
  }

  let totalsSection = '';
  if (totalTonnage > 0) {
    totalsSection += `• *Total Tonnage:* ${tonnageStr}\n`;
  }
  totalsSection += `• *Sub Total:* ₹${formatMoneyValue(subtotal)}\n`;
  totalsSection += `• *GST (18%):* ₹${formatMoneyValue(gstAmount)}\n`;
  totalsSection += `• *Total Order Value:* ₹${formatMoneyValue(grandTotal)}`;

  return `✏️ *Selected Order ${displayId} (${custName}):*\n\n` +
    `• *Linked Inquiry:* ${formatAttributeValue(linkedInquiry)}\n` +
    `• *PO Number:* ${formatAttributeValue(poNumberStr)}\n` +
    (matchedRecord.reference_po_number ? `• *Reference PO:* ${formatAttributeValue(matchedRecord.reference_po_number)}\n` : '') +
    `• *PO Date:* ${formatAttributeValue(poDateStr)}\n` +
    `• *Stage:* ${formatAttributeValue(stageStr)}\n` +
    `• *Delivery Location:* ${formatAttributeValue(delLocStr)}\n` +
    `• *Payment Terms:* ${formatAttributeValue(payTermsStr)}\n\n` +
    lineItemsSection +
    totalsSection + `\n\n` +
    `Which field would you like to update? (Rate, Quantity, PO Number, PO Date, Delivery Location, Payment Terms, Stage, Attach PO)`;
}

function formatSelectedInquiryForOrderPrompt(matchedRecord) {
  const inqDisplay = matchedRecord.displayId || `INQ-${matchedRecord.clean_code || matchedRecord.id}`;
  const cust = matchedRecord.customer_name || 'Customer';
  const prodSummary = matchedRecord.product_summary || 'Steel Material';
  const loc = matchedRecord.delivery_location && matchedRecord.delivery_location !== 'Not specified' ? matchedRecord.delivery_location : null;
  const pay = matchedRecord.payment_terms && matchedRecord.payment_terms !== 'Not specified' ? matchedRecord.payment_terms : null;
  const rateText = matchedRecord.total_amount > 0 ? `₹${Number(matchedRecord.total_amount).toLocaleString('en-IN')}` : 'Rate not set';

  let itemsText = '';
  const items = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : [];
  if (items.length > 0) {
    itemsText = items.map(it => {
      const name = it.sku_text || it.product_name || 'Steel Material';
      const spec = [it.grade, it.dimensions].filter(Boolean).join(' ');
      const specStr = spec ? ` (${spec})` : '';
      const qtyStr = it.quantity ? `${it.quantity} ${it.unit || 'MT'}` : '';
      const rateStr = it.rate ? `₹${Number(it.rate).toLocaleString('en-IN')} /${it.unit || 'MT'}` : '';
      const totStr = it.amount ? `Total: ₹${Number(it.amount).toLocaleString('en-IN')}` : (it.quantity && it.rate ? `Total: ₹${Number(it.quantity * it.rate).toLocaleString('en-IN')}` : '');
      const parts = [qtyStr, rateStr, totStr].filter(Boolean).join(' | ');
      return `• *Product:* ${name}${specStr} | ${parts}`;
    }).join('\n');
  } else {
    itemsText = `• *Product:* ${prodSummary} | ${rateText}`;
  }

  let prompt = `🛒 *Creating order for ${inqDisplay} (${cust})*\n\n` +
    `${itemsText}\n` +
    (loc ? `• *Delivery Location:* ${loc}\n` : '') +
    (pay ? `• *Payment Terms:* ${pay}\n` : '') +
    `\nA system PO number has been generated and can be edited before confirmation.\n` +
    `• *System PO Number* (editable)\n` +
    `• *Reference PO* (optional customer/document PO)\n` +
    `• *PO Date* (or "Today")\n\n` +
    `_(e.g. "change system PO to EM/PO/42" or "Reference PO: PO-9988")_`;

  return prompt;
}

function formatProductSummaryCompact(item) {
  if (!item) return 'Steel Material';

  // Check deal_items or line items
  const items = (Array.isArray(item.deal_items) && item.deal_items.length > 0)
    ? item.deal_items
    : (item.ai_extraction_json && Array.isArray(item.ai_extraction_json.line_items) && item.ai_extraction_json.line_items.length > 0)
      ? item.ai_extraction_json.line_items
      : (item.ai_extraction_json && Array.isArray(item.ai_extraction_json.lineItems) && item.ai_extraction_json.lineItems.length > 0)
        ? item.ai_extraction_json.lineItems
        : (Array.isArray(item.line_items) && item.line_items.length > 0)
          ? item.line_items
          : [];

  if (items.length > 0) {
    const formatItemLabel = (it) => {
      const name = it.sku_text || it.description || it.product_name || 'Item';
      const dim = it.dimensions || it.spec;
      if (dim) {
        const thkMatch = dim.match(/(\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g))\b/i);
        const shortSpec = thkMatch ? thkMatch[0].trim().toUpperCase() : dim.split(/[\s(,]/)[0].trim();
        if (shortSpec && !name.toLowerCase().includes(shortSpec.toLowerCase())) {
          return `${name} (${shortSpec})`;
        }
      }
      return name;
    };

    if (items.length === 1) {
      const it = items[0];
      const name = formatItemLabel(it);
      const qtyStr = it.quantity ? `${it.quantity} ${it.unit || 'MT'}` : '';
      return qtyStr ? `${qtyStr} ${name}` : name;
    }
    const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const names = items.slice(0, 3).map(formatItemLabel).join(', ');
    const more = items.length > 3 ? ` +${items.length - 3} more` : '';
    return `${items.length} Items${totalQty > 0 ? ` (${formatLineItemsTonnage(items) || `${totalQty} MT`})` : ''} — ${names}${more}`;
  }

  if (item.product_summary) return item.product_summary;
  if (item.product_description) return item.product_description;
  if (item.product_name) return item.product_name;
  if (item.affected_product) return item.affected_product;
  if (item.ai_extraction_json?.product_requirement) return item.ai_extraction_json.product_requirement;
  if (item.ai_extraction_json?.productType) return item.ai_extraction_json.productType;

  if (item.raw_text) {
    const firstLine = item.raw_text.split(/[\r\n]+/)[0].trim();
    if (firstLine && firstLine.length < 50 && !firstLine.toLowerCase().startsWith('customer:')) {
      return firstLine;
    }
  }

  return 'Steel Material';
}

function getAssignedPhoneFromCustomerMap(customerName, customerOwnerMap) {
  if (!customerName || !customerOwnerMap || customerOwnerMap.size === 0) return null;
  const clean = customerName.toLowerCase().trim();
  if (customerOwnerMap.has(clean)) return customerOwnerMap.get(clean);

  const stripped = clean
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return null;

  for (const [name, phone] of customerOwnerMap.entries()) {
    if (name === clean) return phone;
    const mapStripped = name
      .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
      .replace(/[^a-z0-9]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (mapStripped && (stripped === mapStripped || stripped.startsWith(mapStripped) || mapStripped.startsWith(stripped))) {
      return phone;
    }
  }
  return null;
}

/**
 * Restricts fallback lookup results to records the caller may access.
 * Admins (scope.phones === null) keep every record. Others keep a record when its
 * owner phone is in scope, or (when customerField is given) when the customer is
 * assigned to someone in scope.
 */
/**
 * Inserts a deal that shares its id with the linked inquiry (INQ-XXXXXX == DEAL-XXXXXX).
 * If a deal already owns that id: 'reuse' returns it untouched, 'update' applies the payload to it.
 * Falls back to a generated id only when the same-id insert fails for another reason.
 * Returns { data: row | null, error }.
 */
async function insertDealMirroringInquiry(payload, { onExisting = 'reuse' } = {}) {
  const inquiryId = payload && payload.inquiry_id;
  if (!inquiryId) {
    const { data, error } = await supabase.from('deals').insert(payload).select();
    return { data: (data && data[0]) || null, error };
  }

  const { data: sameIdRows, error: sameIdErr } = await supabase
    .from('deals')
    .insert({ id: inquiryId, ...payload })
    .select();
  if (!sameIdErr && sameIdRows && sameIdRows.length > 0) return { data: sameIdRows[0], error: null };

  const { data: existingRows } = await supabase
    .from('deals')
    .select('*')
    .eq('id', inquiryId)
    .limit(1);
  if (existingRows && existingRows.length > 0) {
    if (onExisting === 'update') {
      // Keep the existing owner / record status of the deal
      const { created_at, salesperson_phone, status, ...updatePayload } = payload;
      const { data: updRows, error: updErr } = await supabase
        .from('deals')
        .update(updatePayload)
        .eq('id', inquiryId)
        .select();
      return { data: (updRows && updRows[0]) || null, error: updErr || null };
    }
    return { data: existingRows[0], error: null };
  }

  console.warn('[CatalogFlow] Deal insert with inquiry id failed, falling back to generated id:', sameIdErr?.message);
  const { data: fbRows, error: fbErr } = await supabase.from('deals').insert(payload).select();
  return { data: (fbRows && fbRows[0]) || null, error: fbErr || null };
}

async function filterRecordsToCallerScope(records, scope, { phoneField = 'salesperson_phone', customerField = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return [];
  if (!scope || scope.isAdmin || scope.phones === null || scope.phones === undefined) return list;

  const scopePhones = expandPhoneVariants(scope.phones || []);
  if (scopePhones.length === 0) return [];

  const ownsDirectly = (r) => Boolean(r && r[phoneField]) && isPhoneInScope(r[phoneField], scopePhones);

  let customerOwnerMap = null;
  if (customerField && list.some(r => !ownsDirectly(r) && r && r[customerField])) {
    try {
      const { data: customers } = await supabase
        .from('recurring_customers')
        .select('customer_name, assigned_salesperson_phone')
        .eq('is_active', true);
      customerOwnerMap = new Map();
      (customers || []).forEach(c => {
        if (c.customer_name && c.assigned_salesperson_phone) {
          customerOwnerMap.set(c.customer_name.trim().toLowerCase(), c.assigned_salesperson_phone);
        }
      });
    } catch (e) {
      console.warn('[CatalogFlow] filterRecordsToCallerScope customer owner lookup failed:', e.message);
    }
  }

  return list.filter(r => {
    if (ownsDirectly(r)) return true;
    if (customerOwnerMap && r && r[customerField]) {
      const owner = getAssignedPhoneFromCustomerMap(r[customerField], customerOwnerMap);
      if (owner && isPhoneInScope(owner, scopePhones)) return true;
    }
    return false;
  });
}

// ── RECORD FETCHING FOR UPDATE SELECTION FLOWS ───────────────────────────────

async function fetchEditableRecordsForModule(action, senderPhone, { customerFilter = null } = {}) {
  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  const cleanCustFilter = customerFilter ? customerFilter.trim() : null;

  if (action === 'UPDATE_INQUIRY' || action === 'LOG_ORDER') {
    let dealsQuery = supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, customer_phone, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false });

    let inqsQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, stage, po_number, reference_po_number, generated_po_number, inquiry_type, created_at, salesperson_phone, inquiry_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
      .neq('inquiry_type', 'purchase_order')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin) {
      if (targetPhones.length > 0) {
        dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
        inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
      } else {
        dealsQuery = null;
        inqsQuery = null;
      }
    }

    const [{ data: allDeals }, { data: allInqs }] = await Promise.all([
      dealsQuery ? dealsQuery.limit(500) : Promise.resolve({ data: [] }),
      inqsQuery ? inqsQuery.limit(500) : Promise.resolve({ data: [] }),
    ]);

    const filterByScope = (items) => {
      if (scope.isAdmin || scope.phones === null) return items || [];
      return (items || []).filter(item => {
        if (!item.salesperson_phone) return false;
        return isPhoneInScope(item.salesperson_phone, targetPhones);
      });
    };

    const scopedDeals = filterByScope(allDeals);
    const scopedInqs = filterByScope(allInqs);

    const dealByInqId = new Map();
    const wonOrClosedInqIds = new Set();
    const terminalStages = new Set(['won', 'lost', 'closed', 'completed', 'cancelled']);
    const ELIGIBLE_ORDER_STAGES = new Set([
      'quoted',
      'price_quote',
      'price quote',
      'qualified',
      'confirmed',
      'proposal',
      'saved',
      'quotation_sent',
      'negotiation',
      'on_hold',
      'hold'
    ]);

    const isEligibleOrderStage = (st) => {
      if (!st) return false;
      const s = String(st).toLowerCase().trim();
      if (terminalStages.has(s) || s.includes('won') || s.includes('lost') || s.includes('closed') || s.includes('cancel')) return false;
      if (ELIGIBLE_ORDER_STAGES.has(s)) return true;
      if (s.includes('quote') || s.includes('price') || s.includes('qualif') || s.includes('proposal') || s.includes('negot') || s.includes('hold')) return true;
      return false;
    };

    scopedDeals.forEach(d => {
      const stage = (d.stage || '').toLowerCase().trim();
      const isTerminal = terminalStages.has(stage) || Boolean(d.po_number);
      if (d.inquiry_id) {
        if (isTerminal) {
          wonOrClosedInqIds.add(d.inquiry_id);
        } else if (!dealByInqId.has(d.inquiry_id)) {
          dealByInqId.set(d.inquiry_id, d);
        }
      }
      if (d.id) {
        if (isTerminal) {
          wonOrClosedInqIds.add(d.id);
        } else if (!dealByInqId.has(d.id)) {
          dealByInqId.set(d.id, d);
        }
      }
    });

    const matched = [];
    const seenInqIds = new Set();

    // 1. Process Genuine Inquiries from inquiries table
    scopedInqs.forEach(inq => {
      if (wonOrClosedInqIds.has(inq.id)) return;
      if (terminalStages.has((inq.status || '').toLowerCase().trim())) return;
      const rawLower = (inq.raw_text || '').toLowerCase().trim();
      if (rawLower.startsWith('[po document attached:') || rawLower.includes('po number:')) return;

      const linkedDeal = dealByInqId.get(inq.id);
      const stage = (linkedDeal?.stage || inq.stage || inq.status || 'new_inquiry').toLowerCase().trim();
      if (terminalStages.has(stage)) return;

      // STRICT STAGE FILTER FOR LOG_ORDER: Price Quote, Negotiation, On Hold only. Exclude new_inquiry & review.
      if (action === 'LOG_ORDER' && !isEligibleOrderStage(stage)) return;

      const cleanCode = (inq.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      const displayId = `INQ-${cleanCode}`;
      const ai = inq.ai_extraction_json || {};
      const prodSummary = linkedDeal ? formatProductSummaryCompact(linkedDeal) : formatProductSummaryCompact(inq);
      const stageLabel = formatStageLabel(stage);
      const dateFormatted = formatDateDDMMYYYY(inq.created_at);
      const inqAttrs = extractInquiryAttributes(inq, linkedDeal);

      const inqDealItems = (linkedDeal?.deal_items && linkedDeal.deal_items.length > 0)
        ? linkedDeal.deal_items
        : (inq.inquiry_items && inq.inquiry_items.length > 0)
          ? inq.inquiry_items
          : (ai.line_items && ai.line_items.length > 0)
            ? ai.line_items
            : (ai.lineItems && ai.lineItems.length > 0)
              ? ai.lineItems
              : [];

      let calculatedTotalAmt = Number(linkedDeal?.total_amount) || Number(ai.totalAmount) || Number(ai.total_amount) || 0;
      if (!calculatedTotalAmt && inqDealItems.length > 0) {
        calculatedTotalAmt = inqDealItems.reduce((s, it) => {
          const q = Number(it.quantity || 0);
          const r = Number(it.rate || 0);
          const a = Number(it.amount || 0);
          return s + (a || (q * r));
        }, 0);
      }

      matched.push({
        id: inq.id,
        deal_id: linkedDeal?.id || null,
        inquiry_id: inq.id,
        displayId,
        clean_code: cleanCode,
        customer_name: linkedDeal?.customer_name || inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
        product_summary: prodSummary,
        stage: stageLabel,
        raw_stage: stage,
        date_formatted: dateFormatted,
        payment_terms: inqAttrs.payment_terms || 'Not specified',
        delivery_location: inqAttrs.delivery_location || 'Not specified',
        preferred_make: inqAttrs.preferred_make || null,
        additional_notes: inqAttrs.additional_notes || null,
        total_amount: calculatedTotalAmt,
        po_number: linkedDeal?.po_number || inq.po_number || null,
        reference_po_number: linkedDeal?.reference_po_number || inq.reference_po_number || null,
        generated_po_number: linkedDeal?.generated_po_number || inq.generated_po_number || null,
        deal_items: inqDealItems,
        created_at: inq.created_at,
      });
      seenInqIds.add(inq.id);
    });

    // 2. Process standalone deals that have NO inquiry_id (created directly in CRM without an inquiry record)
    scopedDeals.forEach(d => {
      if (d.inquiry_id && seenInqIds.has(d.inquiry_id)) return;
      if (d.inquiry_id) return; // If it has an inquiry_id but wasn't in inqs, it was filtered out (e.g. PO)
      const stage = (d.stage || 'new_inquiry').toLowerCase().trim();
      if (terminalStages.has(stage) || Boolean(d.po_number)) return;

      // STRICT STAGE FILTER FOR LOG_ORDER: Price Quote, Negotiation, On Hold only. Exclude new_inquiry & review.
      if (action === 'LOG_ORDER' && !isEligibleOrderStage(stage)) return;

      const cleanCode = (d.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      const displayId = `INQ-${cleanCode}`;
      const prodSummary = formatProductSummaryCompact(d);
      const stageLabel = formatStageLabel(stage);
      const dateFormatted = formatDateDDMMYYYY(d.created_at);
      const dealAttrs = extractInquiryAttributes(null, d);

      const dDealItems = Array.isArray(d.deal_items) ? d.deal_items : [];
      let calculatedDealTotalAmt = Number(d.total_amount) || 0;
      if (!calculatedDealTotalAmt && dDealItems.length > 0) {
        calculatedDealTotalAmt = dDealItems.reduce((s, it) => {
          const q = Number(it.quantity || 0);
          const r = Number(it.rate || 0);
          const a = Number(it.amount || 0);
          return s + (a || (q * r));
        }, 0);
      }

      matched.push({
        id: d.id,
        deal_id: d.id,
        inquiry_id: d.id,
        displayId,
        clean_code: cleanCode,
        customer_name: d.customer_name || 'Customer',
        product_summary: prodSummary,
        stage: stageLabel,
        raw_stage: stage,
        date_formatted: dateFormatted,
        payment_terms: dealAttrs.payment_terms || d.payment_terms || 'Not specified',
        delivery_location: dealAttrs.delivery_location || d.delivery_location || 'Not specified',
        preferred_make: dealAttrs.preferred_make || null,
        additional_notes: dealAttrs.additional_notes || null,
        total_amount: calculatedDealTotalAmt,
        po_number: d.po_number || null,
        reference_po_number: d.reference_po_number || null,
        generated_po_number: d.generated_po_number || null,
        deal_items: dDealItems,
        created_at: d.created_at,
      });
    });

    // Sort newest first by created_at strictly matching CRM Inquiries table sequence
    matched.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    let editable = matched;

    if (cleanCustFilter) {
      editable = editable.filter(m => isCustomerMatch(cleanCustFilter, null, m.customer_name, null));
    }

    return editable;
  }

  if (action === 'UPDATE_ORDER') {
    const [dealsRes, customersRes] = await Promise.all([
      supabase
        .from('deals')
        .select('id, inquiry_id, customer_name, customer_phone, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
        .eq('stage', 'won')
        .order('won_at', { ascending: false, nullsFirst: false })
        .limit(500),
      supabase
        .from('recurring_customers')
        .select('customer_name, assigned_salesperson_phone')
        .eq('is_active', true)
    ]);

    const customerOwnerMap = new Map();
    customersRes.data?.forEach(c => {
      if (c.customer_name && c.assigned_salesperson_phone) {
        customerOwnerMap.set(c.customer_name.trim().toLowerCase(), c.assigned_salesperson_phone);
      }
    });

    const allDeals = dealsRes.data || [];

    const filterByScope = (items) => {
      if (scope.isAdmin || scope.phones === null) return items || [];
      return (items || []).filter(item => {
        const assignedOwnerPhone = getAssignedPhoneFromCustomerMap(item.customer_name, customerOwnerMap);
        const effectivePhone = assignedOwnerPhone || item.salesperson_phone;
        if (!effectivePhone) return false;
        return isPhoneInScope(effectivePhone, targetPhones);
      });
    };

    let scopedDeals = filterByScope(allDeals);

    if (cleanCustFilter) {
      scopedDeals = scopedDeals.filter(d => isCustomerMatch(cleanCustFilter, null, d.customer_name, d.customer_phone));
    }

    return scopedDeals.map(d => {
      const cleanCode = (d.id || '').replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
      const displayInq = `INQ-${cleanCode}`;
      const displayId = d.po_number ? d.po_number : displayInq;
      const dateFormatted = d.po_date ? formatDateDDMMYYYY(d.po_date) : (d.won_at ? formatDateDDMMYYYY(d.won_at) : (d.created_at ? formatDateDDMMYYYY(d.created_at) : formatDateDDMMYYYY(new Date())));

      return {
        id: d.id,
        deal_id: d.id,
        inquiry_id: d.inquiry_id || d.id,
        displayId,
        po_number: d.po_number || null,
        reference_po_number: d.reference_po_number || null,
        generated_po_number: d.generated_po_number || null,
        po_date: d.po_date || null,
        deal_code: displayInq,
        clean_code: cleanCode,
        customer_name: d.customer_name || 'Customer',
        product_summary: formatProductSummaryCompact(d),
        stage: formatStageLabel(d.stage || 'Won'),
        date_formatted: dateFormatted,
        delivery_location: d.delivery_location || 'Not specified',
        payment_terms: d.payment_terms || 'Not specified',
        total_amount: Number(d.total_amount) || 0,
        deal_items: d.deal_items || [],
        created_at: d.created_at,
        won_at: d.won_at,
      };
    });
  }

  if (action === 'UPDATE_COMPLAINT') {
    let complaintsQuery = supabase
      .from('complaints')
      .select('*')
      .order('reported_at', { ascending: false, nullsFirst: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      complaintsQuery = complaintsQuery.in('reported_by', targetPhones);
    }

    const { data: allComplaints } = await complaintsQuery.limit(500);

    const filterByScope = (items) => {
      if (scope.isAdmin || scope.phones === null) return items || [];
      return (items || []).filter(item => {
        if (!item.reported_by) return false;
        return isPhoneInScope(item.reported_by, targetPhones);
      });
    };

    let scopedComplaints = filterByScope(allComplaints);

    // Filter: Pending & Open only; excludes Resolved & Closed
    scopedComplaints = scopedComplaints.filter(c => {
      const st = String(c.status || '').toLowerCase().trim();
      return !['resolved', 'closed', 'cancelled'].includes(st);
    });

    // Sort newest first strictly matching CRM Complaints module sequence
    scopedComplaints.sort((a, b) => {
      const timeA = new Date(a.reported_at || a.created_at || 0).getTime();
      const timeB = new Date(b.reported_at || b.created_at || 0).getTime();
      return timeB - timeA;
    });

    if (cleanCustFilter) {
      scopedComplaints = scopedComplaints.filter(c => isCustomerMatch(cleanCustFilter, null, c.customer_name, null));
    }

    return scopedComplaints.map(c => {
      const cleanId = (c.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      const displayId = `COMP-${cleanId}`;
      const dateFormatted = formatDateDDMMYYYY(c.reported_at || c.created_at || new Date());
      const typeLabel = c.complaint_type
        ? c.complaint_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        : 'Quality Defect';
      const statusLabel = c.status
        ? c.status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        : 'Open';

      return {
        id: c.id,
        displayId,
        clean_code: cleanId,
        customer_name: c.customer_name || 'Customer',
        complaint_type: typeLabel,
        status: statusLabel,
        date_formatted: dateFormatted,
        complaint_date: c.complaint_date ? formatDateDDMMYYYY(new Date(c.complaint_date)) : dateFormatted,
        raised_by: c.raised_by || c.contact_person || null,
        product_name: c.product_name || c.affected_product || null,
        challan_no: c.challan_no || null,
        corrective_action: c.corrective_action || null,
        customer_communication: c.customer_communication || null,
        resolution_notes: c.resolution_notes || null,
        resolution_date: c.resolution_date ? formatDateDDMMYYYY(new Date(c.resolution_date)) : null,
        description: c.description || null,
        po_number: c.po_number || null,
        deal_id: c.deal_id || null,
        created_at: c.created_at,
        reported_at: c.reported_at,
      };
    });
  }

  if (action === 'UPDATE_VISIT') {
    let visitQuery = supabase
      .from('customer_visits')
      .select('*')
      .order('visited_at', { ascending: false, nullsFirst: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      visitQuery = visitQuery.in('salesperson_phone', targetPhones);
    }

    const { data: allVisits } = await visitQuery.limit(500);

    const filterByScope = (items) => {
      if (scope.isAdmin || scope.phones === null) return items || [];
      return (items || []).filter(item => {
        if (!item.salesperson_phone) return false;
        return isPhoneInScope(item.salesperson_phone, targetPhones);
      });
    };

    let scopedVisits = filterByScope(allVisits);

    // Exclude synthetic Bigin sync logs
    scopedVisits = scopedVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));

    // Sort newest first strictly matching CRM Visits module sequence
    scopedVisits.sort((a, b) => {
      const timeA = new Date(a.visited_at || 0).getTime();
      const timeB = new Date(b.visited_at || 0).getTime();
      return timeB - timeA;
    });

    if (cleanCustFilter) {
      scopedVisits = scopedVisits.filter(v => isCustomerMatch(cleanCustFilter, null, v.customer_name, null));
    }

    return scopedVisits.map(v => extractVisitDetails(v));
  }

  return [];
}

// ── FORMAT SINGLE RECORD LINE FOR MODULE SELECTION ──────────────────────────

function formatRecordLineForModule(action, record, index) {
  switch (action) {
    case 'LOG_ORDER': {
      const priceStr = record.total_amount > 0 ? `₹${Number(record.total_amount).toLocaleString('en-IN')}` : 'Rate not set';
      const stageStr = record.raw_stage === 'quoted' ? 'Price Quote' : (record.stage || 'Price Quote');
      return `${index}. ${record.displayId} | ${record.customer_name} | ${record.product_summary} | ${priceStr} | ${stageStr} | ${record.date_formatted}`;
    }
    case 'UPDATE_INQUIRY':
      return `${index}. ${record.displayId} | ${record.customer_name} | ${record.product_summary} | ${record.stage} | ${record.date_formatted}`;
    case 'UPDATE_ORDER':
      return `${index}. ${record.displayId} | ${record.customer_name} | ${record.product_summary} | ${record.date_formatted}`;
    case 'UPDATE_COMPLAINT':
      return formatComplaintSelectionLine(record, index);
    case 'UPDATE_VISIT': {
      return formatVisitSelectionLine(record, index);
    }
    default:
      return `${index}. ${record.customer_name} | ${record.date_formatted}`;
  }
}

// ── FETCH AND RENDER UPDATE SELECTION MESSAGE ────────────────────────────────

async function fetchAndRenderUpdateSelection(action, senderPhone, { page = 1, pageSize = 7, customerFilter = null } = {}) {
  const allRecords = await fetchEditableRecordsForModule(action, senderPhone, { customerFilter });

  if (allRecords.length === 0) {
    let emptyReply = '';
    if (customerFilter) {
      emptyReply = `ℹ️ *No records found for "${customerFilter}".*\n\nType another customer name to search specifically, or reply "All" to view all recent records.`;
    } else {
      switch (action) {
        case 'LOG_ORDER':
          emptyReply = `ℹ️ *No Eligible Inquiries Found for Order Creation*\n\nThere are no inquiries currently in Price Quote, Negotiation, or On Hold stage.\n\n*No Inquiry available - Create Order Directly*`;
          break;
        case 'UPDATE_INQUIRY':
          emptyReply = `ℹ️ *No Editable Inquiries Found*\n\nThere are no active or editable inquiries recorded in your portfolio.\n\nIf you would like to log a new inquiry, reply with *1* or send the inquiry details.`;
          break;
        case 'UPDATE_ORDER':
          emptyReply = `ℹ️ *No Orders Found*\n\nThere are no existing orders in your records.\n\nIf you would like to log a new order, reply with *3* or send the order details.`;
          break;
        case 'UPDATE_COMPLAINT':
          emptyReply = `ℹ️ *No Active Complaints Found*\n\nThere are no active customer complaints recorded in your portfolio.\n\nIf you would like to log a new complaint, reply with *8* or send the complaint details.`;
          break;
        case 'UPDATE_VISIT':
          emptyReply = `ℹ️ *No Field Visits Found*\n\nThere are no customer visits recorded in your portfolio.\n\nIf you would like to log a field visit, reply with *5* or send the visit details.`;
          break;
        default:
          emptyReply = `ℹ️ *No editable records found.*`;
      }
    }

    return {
      hasRecords: false,
      reply: emptyReply,
      interactiveButtons: action === 'LOG_ORDER' ? DIRECT_ORDER_BUTTONS : null,
      state: {
        action,
        page: 1,
        totalCount: 0,
        customerFilter,
        cachedRecords: [],
      },
    };
  }

  const totalCount = allRecords.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  const curPage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (curPage - 1) * pageSize;
  const pageItems = allRecords.slice(startIdx, startIdx + pageSize);

  const cachedRecords = pageItems.map((r, i) => ({
    ...r,
    index: startIdx + i + 1,
  }));

  const lines = cachedRecords.map(r => formatRecordLineForModule(action, r, r.index));
  const listText = lines.join('\n');

  let headerText = '';
  if (customerFilter) {
    switch (action) {
      case 'LOG_ORDER':
        headerText = `📋 *Inquiries ready for an order for ${customerFilter} (${totalCount} Records):*`;
        break;
      case 'UPDATE_INQUIRY':
        headerText = `📋 *Editable Inquiries for ${customerFilter} (${totalCount} Records):*`;
        break;
      case 'UPDATE_ORDER':
        headerText = `🛒 *Orders for ${customerFilter} (${totalCount} Records):*`;
        break;
      case 'UPDATE_COMPLAINT':
        headerText = `⚠️ *Active Complaints for ${customerFilter} (${totalCount} Records):*`;
        break;
      case 'UPDATE_VISIT':
        headerText = `📍 *Field Visits for ${customerFilter} (${totalCount} Records):*`;
        break;
    }
  } else {
    const countDisplay = totalCount <= pageSize ? totalCount : `${startIdx + 1}–${startIdx + cachedRecords.length} of ${totalCount}`;
    switch (action) {
      case 'LOG_ORDER':
        headerText = `📋 *Log New Order*\n\nHere are your ${totalCount <= pageSize ? `${totalCount} ` : ''}inquiries ready for an order${totalCount > pageSize ? ` (${countDisplay})` : ''}:`;
        break;
      case 'UPDATE_INQUIRY':
        headerText = `📋 *Update Inquiry*\n\nHere are your ${totalCount <= pageSize ? `${totalCount} ` : ''}recent editable inquiries${totalCount > pageSize ? ` (${countDisplay})` : ''}:`;
        break;
      case 'UPDATE_ORDER':
        headerText = `🛒 *Update Order*\n\nHere are your ${totalCount <= pageSize ? `${totalCount} ` : ''}recent orders${totalCount > pageSize ? ` (${countDisplay})` : ''}:`;
        break;
      case 'UPDATE_COMPLAINT':
        headerText = `⚠️ *Update Complaint*\n\nHere are your ${totalCount <= pageSize ? `${totalCount} ` : ''}active complaints${totalCount > pageSize ? ` (${countDisplay})` : ''}:`;
        break;
      case 'UPDATE_VISIT':
        headerText = `📍 *Update Field Visit*\n\nHere are your ${totalCount <= pageSize ? `${totalCount} ` : ''}recent field visits${totalCount > pageSize ? ` (${countDisplay})` : ''}:`;
        break;
    }
  }

  let footerText = '';
  if (action === 'LOG_ORDER') {
    footerText = `Reply with the serial number or Inquiry ID to create an order. Type "Next" for more, or send a customer name to search.\n\n*No Inquiry available - Create Order Directly*`;
  } else {
    let footerIdLabel = 'Inquiry ID';
    if (action === 'UPDATE_ORDER') footerIdLabel = 'Order / PO Number';
    else if (action === 'UPDATE_COMPLAINT') footerIdLabel = 'Customer Name';
    else if (action === 'UPDATE_VISIT') footerIdLabel = 'Customer Name';
    footerText = `Reply with the serial number or ${footerIdLabel} to update that record. Type "Next" for the next 7 records, or tell me the customer name to search their records.`;
  }

  const fullReply = `${headerText}\n\n${listText}\n\n${footerText}`;

  return {
    hasRecords: true,
    reply: fullReply,
    interactiveButtons: action === 'LOG_ORDER' ? DIRECT_ORDER_BUTTONS : null,
    state: {
      action,
      page: curPage,
      totalCount,
      customerFilter,
      cachedRecords,
    },
  };
}

// ── HANDLE UPDATE SELECTION STATE ───────────────────────────────────────────

async function handleUpdateSelectionState(text, senderPhone, action, selectionState) {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  // 0. Permission check for UPDATE_VISIT
  if (action === 'UPDATE_VISIT') {
    const canUpdate = await canUserUpdateVisits(senderPhone);
    if (!canUpdate) {
      await recordSessionMessage(senderPhone, 'user', text);
      const deniedReply = `Access Denied: Field visits can only be updated by Sales Managers and Administrators. Please contact your manager to update a logged visit.`;
      await recordSessionMessage(senderPhone, 'assistant', deniedReply, { action_type: 'ACCESS_DENIED' });
      await finalizeCurrentSession(senderPhone, 'Unauthorized visit update attempt');
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: deniedReply };
    }
  }

  // Direct order, with no inquiry linked
  if (action === 'LOG_ORDER' && isDirectOrderRequest(clean)) {
    return await beginDirectOrder(senderPhone, null);
  }

  // 1. Cancel / Discard / Menu
  if (isDiscardOrCancelIntent(clean) || (await isGreeting(clean)) || lower === 'menu' || lower === 'exit' || lower === 'quit') {
    await recordSessionMessage(senderPhone, 'user', text);
    const canUpdate = await canUserUpdateVisits(senderPhone);
    const userMenu = getCatalogMenu(canUpdate);
    const userSections = getCatalogMenuSections(canUpdate);
    const cancelReply = `Activity cancelled.\n\n` + userMenu;
    await recordSessionMessage(senderPhone, 'assistant', cancelReply, { action_type: 'CATALOG_MENU' });
    recordInactiveDraft(senderPhone, action, null, 'discarded');
    await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} selection`);
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return {
      handled: true,
      reply: cancelReply,
      interactiveType: 'list',
      interactiveList: {
        bodyText: 'Here is the menu to start a new activity:',
        buttonText: 'Choose Action',
        sections: userSections,
      },
    };
  }

  // 1b. Direct cross-module action / menu selection preemption
  const explicitAction = isExplicitMenuSelection(clean, true);
  if (explicitAction) {
    if (explicitAction !== action) {
      recordInactiveDraft(senderPhone, action, null, 'discarded');
      await finalizeCurrentSession(senderPhone, `Switched from ${getActionFriendlyName(action)} to ${getActionFriendlyName(explicitAction)}`);
      return await handleCatalogFlow(text, senderPhone);
    } else {
      await recordSessionMessage(senderPhone, 'user', text);
      const selectionRes = await fetchAndRenderUpdateSelection(action, senderPhone, { page: 1, customerFilter: null });
      await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: action });
      await saveActiveSession(senderPhone, 'Customer', `catalog_update_select|${action}|${JSON.stringify(selectionRes.state)}`);
      return catalogSelectionResult(selectionRes);
    }
  }

  // 1c. Mid-flow retrieval query interception
  const isMidFlowRead = await isMidFlowReadQuery(clean);
  if (isMidFlowRead && !isFullRecordSelection(clean)) {
    return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_update_select', action, selectionState);
  }

  // 2. View All / Reset Filter
  if (['all', 'show all', 'view all', 'all records', 'reset', 'clear'].includes(lower)) {
    await recordSessionMessage(senderPhone, 'user', text);
    const selectionRes = await fetchAndRenderUpdateSelection(action, senderPhone, { page: 1, customerFilter: null });
    await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: action });
    await saveActiveSession(senderPhone, 'Customer', `catalog_update_select|${action}|${JSON.stringify(selectionRes.state)}`);
    return catalogSelectionResult(selectionRes);
  }

  // 3. Pagination ("Next", "more", "view more", "page 2", etc.)
  if (isPaginationRequest(clean)) {
    await recordSessionMessage(senderPhone, 'user', text);
    const totalPages = Math.ceil((selectionState.totalCount || 0) / 7);
    const nextPage = (Number(selectionState.page) || 1) + 1;
    if (nextPage > totalPages) {
      const noMoreMsg = `ℹ️ No more records. Type a customer name to search specifically, or reply "All" to start from the beginning.`;
      await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
      return { handled: true, reply: noMoreMsg };
    }
    const selectionRes = await fetchAndRenderUpdateSelection(action, senderPhone, {
      page: nextPage,
      customerFilter: selectionState.customerFilter || null,
    });
    await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: action });
    await saveActiveSession(senderPhone, selectionState.customerFilter || 'Customer', `catalog_update_select|${action}|${JSON.stringify(selectionRes.state)}`);
    return catalogSelectionResult(selectionRes);
  }

  // 4. Candidate Match Resolution (by Serial Number, Record ID, Date, or Name)
  const cached = Array.isArray(selectionState.cachedRecords) ? selectionState.cachedRecords : [];
  let matchedRecord = null;

  // 4a. Numeric candidate index match
  const numIdx = extractCandidateIndex(clean, selectionState.totalCount || cached.length);
  if (numIdx !== null) {
    matchedRecord = cached.find(r => r.index === numIdx);
    if (!matchedRecord && numIdx >= 1 && numIdx <= cached.length) {
      matchedRecord = cached[numIdx - 1];
    }
    if (!matchedRecord && numIdx >= 1) {
      // Lookup in full pool
      const fullPool = await fetchEditableRecordsForModule(action, senderPhone, { customerFilter: selectionState.customerFilter || null });
      if (numIdx <= fullPool.length) {
        matchedRecord = fullPool[numIdx - 1];
      }
    }
  }

  // 4b. Record ID matching
  if (!matchedRecord) {
    const embeddedInq = clean.match(/(?:inquiry|inq|deal)\s*(?:id|no\.?|#)?\s*(?:to|is|:)?\s*#?([A-Za-z0-9_-]+)|\b(?:INQ|DEAL)-([A-Z0-9]+)\b|#INQ-([A-Z0-9]+)/i);
    const embeddedPo = clean.match(/(?:po|order)\s*(?:id|no\.?|#)?\s*(?:to|is|:)?\s*#?([A-Za-z0-9_-]+)|\b(?:PO[-_:#\s]*([A-Za-z0-9_-]+)|(?:po\s*number|po\s*no\.?|po#)[\s:=-]*([A-Za-z0-9_-]+))\b/i);
    const embeddedCmp = clean.match(/(?:complaint|cmp)\s*(?:id|no\.?|#)?\s*(?:to|is|:)?\s*#?([A-Za-z0-9_-]+)|\b(?:COMP|CMP)-([A-Z0-9]+)\b|#COMP-([A-Z0-9]+)/i);

    const candidateIds = [];
    if (embeddedInq) {
      for (let i = 1; i < embeddedInq.length; i++) {
        if (embeddedInq[i]) candidateIds.push(embeddedInq[i].replace(/[^0-9A-Z]/gi, '').toUpperCase());
      }
    }
    if (embeddedPo) {
      for (let i = 1; i < embeddedPo.length; i++) {
        if (embeddedPo[i]) candidateIds.push(embeddedPo[i].replace(/[^0-9A-Z]/gi, '').toUpperCase());
      }
    }
    if (embeddedCmp) {
      for (let i = 1; i < embeddedCmp.length; i++) {
        if (embeddedCmp[i]) candidateIds.push(embeddedCmp[i].replace(/[^0-9A-Z]/gi, '').toUpperCase());
      }
    }

    const directCleanId = clean.replace(/^#?(?:INQ|DEAL|PO|COMP|CMP)-?/i, '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
    if (directCleanId.length >= 2 && directCleanId.length <= 15) {
      candidateIds.push(directCleanId);
    }

    const CANDIDATE_ID_STOPWORDS = new Set(['FOR', 'TO', 'IS', 'OF', 'IN', 'ON', 'AT', 'NEW', 'LOG', 'NOW', 'TODAY', 'DATED', 'WITH', 'FROM', 'THE', 'AND', 'AN', 'A', 'ORDER', 'INQUIRY', 'DEAL', 'PO', 'UPDATE']);

    for (const cleanId of candidateIds) {
      if (!cleanId || cleanId.length < 2 || CANDIDATE_ID_STOPWORDS.has(cleanId)) continue;
      matchedRecord = cached.find(r => {
        const dId = (r.displayId || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
        const rId = (r.id || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
        const po = (r.po_number || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
        return dId.includes(cleanId) || rId.startsWith(cleanId) || (po && po.includes(cleanId));
      });

      if (!matchedRecord) {
        const fullPool = await fetchEditableRecordsForModule(action, senderPhone, { customerFilter: null });
        matchedRecord = fullPool.find(r => {
          const dId = (r.displayId || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
          const rId = (r.id || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
          const po = (r.po_number || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
          return dId.includes(cleanId) || rId.startsWith(cleanId) || (po && po.includes(cleanId));
        });
      }

      if (!matchedRecord && (action === 'LOG_ORDER' || action === 'UPDATE_INQUIRY' || action === 'UPDATE_ORDER')) {
        try {
          const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../supabase');
          const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
          const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

          const { data: dbInqs } = await supabase
            .from('inquiries')
            .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, stage, inquiry_type, created_at, salesperson_phone, inquiry_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
            .order('created_at', { ascending: false })
            .limit(500);

          const accessibleInqs = (dbInqs || []).filter(i => {
            if (scope.isAdmin || scope.phones === null) return true;
            return i.salesperson_phone && isPhoneInScope(i.salesperson_phone, targetPhones);
          });

          const foundInq = accessibleInqs.find(i => {
            const rawId = (i.id || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
            return rawId.startsWith(cleanId) || rawId.includes(cleanId);
          });

          if (foundInq) {
            let { data: linkedDeals } = await supabase
              .from('deals')
              .select('id, inquiry_id, customer_name, customer_phone, po_number, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
              .eq('inquiry_id', foundInq.id);

            const linkedDeal = (linkedDeals && linkedDeals.length > 0) ? linkedDeals[0] : null;
            const rawStage = (linkedDeal?.stage || foundInq.stage || foundInq.status || 'new_inquiry').toLowerCase().trim();
            const cleanCode = (foundInq.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
            const displayId = `INQ-${cleanCode}`;

            if (action === 'LOG_ORDER') {
              const isTerminal = ['won', 'lost', 'closed', 'completed', 'cancelled'].includes(rawStage) || Boolean(linkedDeal?.po_number);
              if (isTerminal) {
                const terminalReply = `⚠️ Inquiry *${displayId}* (${foundInq.sender_name || 'Customer'}) has already been converted to an order or closed (Stage: ${formatStageLabel(rawStage)}).\n\nType another Inquiry ID or Customer Name, or reply "All" to view eligible inquiries.`;
                await recordSessionMessage(senderPhone, 'assistant', terminalReply, { action_type: action });
                return { handled: true, reply: terminalReply };
              }

              const isEligible = typeof isEligibleOrderStage === 'function' ? isEligibleOrderStage(rawStage) : ['quoted', 'price_quote', 'qualified', 'confirmed', 'proposal', 'negotiation', 'on_hold', 'hold'].includes(rawStage);
              if (!isEligible) {
                const ineligibleReply = `⚠️ Inquiry *${displayId}* (${foundInq.sender_name || 'Customer'}) is currently in *${formatStageLabel(rawStage)}* stage.\n\nOrders can only be logged for inquiries in *Price Quote*, *Negotiation*, or *On Hold* stages.\n\nType another Inquiry ID or Customer Name, or reply "Cancel" to exit.`;
                await recordSessionMessage(senderPhone, 'assistant', ineligibleReply, { action_type: action });
                return { handled: true, reply: ineligibleReply };
              }
            }

            const ai = foundInq.ai_extraction_json || {};
            const prodSummary = linkedDeal ? formatProductSummaryCompact(linkedDeal) : formatProductSummaryCompact(foundInq);
            const inqAttrs = extractInquiryAttributes(foundInq, linkedDeal);
            const inqDealItems = (linkedDeal?.deal_items && linkedDeal.deal_items.length > 0)
              ? linkedDeal.deal_items
              : (foundInq.inquiry_items && foundInq.inquiry_items.length > 0)
                ? foundInq.inquiry_items
                : (ai.line_items && ai.line_items.length > 0)
                  ? ai.line_items
                  : [];

            let calcTotal = Number(linkedDeal?.total_amount) || Number(ai.totalAmount) || Number(ai.total_amount) || 0;
            if (!calcTotal && inqDealItems.length > 0) {
              calcTotal = inqDealItems.reduce((s, it) => s + (Number(it.amount || 0) || (Number(it.quantity || 0) * Number(it.rate || 0))), 0);
            }

            matchedRecord = {
              id: foundInq.id,
              deal_id: linkedDeal?.id || null,
              inquiry_id: foundInq.id,
              displayId,
              clean_code: cleanCode,
              customer_name: linkedDeal?.customer_name || foundInq.sender_name || ai.companyName || 'Customer',
              product_summary: prodSummary,
              stage: formatStageLabel(rawStage),
              raw_stage: rawStage,
              date_formatted: formatDateDDMMYYYY(foundInq.created_at),
              payment_terms: inqAttrs.payment_terms || 'Not specified',
              delivery_location: inqAttrs.delivery_location || 'Not specified',
              preferred_make: inqAttrs.preferred_make || null,
              additional_notes: inqAttrs.additional_notes || null,
              total_amount: calcTotal,
              deal_items: inqDealItems,
              created_at: foundInq.created_at,
            };
            break;
          }
        } catch (fallbackErr) {
          console.warn('[CatalogFlow] candidate ID DB fallback error:', fallbackErr.message);
        }
      }

      if (matchedRecord) break;
    }
  }


  // 4c. Visit matching by Date / Person Met for UPDATE_VISIT
  if (!matchedRecord && action === 'UPDATE_VISIT') {
    const normInputDate = normalizeDateToDDMMYYYY(clean);
    matchedRecord = cached.find(c =>
      (normInputDate && c.date_formatted === normInputDate) ||
      (c.date_formatted && clean.includes(c.date_formatted)) ||
      (c.person_met && c.person_met !== 'Not recorded' && lower.includes(c.person_met.toLowerCase())) ||
      (c.location && c.location !== 'Not specified' && c.location.length >= 4 && lower.includes(c.location.toLowerCase()))
    );
  }

  // 4d. Candidate matching by customer name / single record context if update provided
  if (!matchedRecord) {
    const hasFieldUpdateIntent = /^(?:update|change|set|modify|make|revise|rate|price|qty|quantity|payment|terms|notes|location|delivery|stage)\b/i.test(clean) ||
      /\b(?:rate|price|qty|quantity|payment\s*terms?|delivery\s*location)\b/i.test(clean);

    if (cached.length === 1 && hasFieldUpdateIntent) {
      matchedRecord = cached[0];
    } else if (cached.length > 1) {
      const custMatch = cached.find(r => r.customer_name && lower.includes(r.customer_name.toLowerCase()));
      if (custMatch) {
        matchedRecord = custMatch;
      }
    }
  }

  // 5. If a record was matched:
  if (matchedRecord) {
    await recordSessionMessage(senderPhone, 'user', text);

    let draft = {};
    if (action === 'LOG_ORDER') {
      const inqItems = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : [];
      draft = {
        action: 'LOG_ORDER',
        inquiry_id: matchedRecord.inquiry_id || matchedRecord.id,
        deal_id: matchedRecord.deal_id || null,
        company_name: matchedRecord.customer_name,
        line_items: inqItems.map(it => ({
          sku_text: it.sku_text || it.product_name || 'Steel Material',
          description: it.description || it.sku_text || it.product_name || 'Steel Material',
          spec: it.dimensions || it.specifications || it.grade || '',
          dimensions: it.dimensions || '',
          grade: it.grade || '',
          quantity: Number(it.quantity || 0),
          unit: it.unit || 'MT',
          rate: Number(it.rate || 0),
          amount: Number(it.amount || 0) || (Number(it.quantity || 0) * Number(it.rate || 0)),
        })),
        product_description: matchedRecord.product_summary || null,
        _inquiry_display_id: matchedRecord.displayId,
        _inquiry_verified: true,
        reference_po_number:
          matchedRecord.reference_po_number ||
          (
            matchedRecord.po_number &&
            !/^EM\/PO\/\d+$/i.test(String(matchedRecord.po_number).trim())
              ? matchedRecord.po_number
              : null
          ),
        delivery_location: matchedRecord.delivery_location && matchedRecord.delivery_location !== 'Not specified' ? matchedRecord.delivery_location : null,
        payment_terms: matchedRecord.payment_terms && matchedRecord.payment_terms !== 'Not specified' ? matchedRecord.payment_terms : null,
        total_amount: Number(matchedRecord.total_amount || 0),
      };
      await ensureDraftSystemPo(
        draft,
        `catalog-selection:${senderPhone}:${matchedRecord.id || Date.now()}`,
        matchedRecord.deal_id || null,
      );
    } else if (action === 'UPDATE_INQUIRY') {
      const inqItems = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : [];
      draft = {
        inquiry_id: matchedRecord.inquiry_id || matchedRecord.id,
        deal_id: matchedRecord.deal_id || null,
        company_name: matchedRecord.customer_name,
        existing_items: inqItems,
        _inquiry_display_id: matchedRecord.displayId,
        _inquiry_verified: true,
        date_formatted: matchedRecord.date_formatted || null,
        stage: matchedRecord.stage || null,
        delivery_location: matchedRecord.delivery_location || null,
        payment_terms: matchedRecord.payment_terms || null,
        preferred_make: matchedRecord.preferred_make || null,
        additional_notes: matchedRecord.additional_notes || null,
        total_amount: Number(matchedRecord.total_amount || 0),
      };
    } else if (action === 'UPDATE_ORDER') {
      const orderItems = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : [];
      draft = {
        inquiry_id: matchedRecord.inquiry_id || matchedRecord.id,
        deal_id: matchedRecord.deal_id || matchedRecord.id,
        po_number: matchedRecord.po_number || null,
        reference_po_number: matchedRecord.reference_po_number || null,
        generated_po_number: matchedRecord.generated_po_number || null,
        po_date: matchedRecord.po_date || null,
        stage: matchedRecord.stage || 'Won',
        delivery_location: matchedRecord.delivery_location || null,
        payment_terms: matchedRecord.payment_terms || null,
        linked_inquiry_or_po: matchedRecord.po_number ? `PO: ${matchedRecord.po_number} (${matchedRecord.deal_code})` : matchedRecord.deal_code,
        company_name: matchedRecord.customer_name,
        existing_items: orderItems,
        total_amount: Number(matchedRecord.total_amount || 0),
        _order_verified: true,
      };
    } else if (action === 'UPDATE_COMPLAINT') {
      draft = {
        complaint_id: matchedRecord.id,
        company_name: matchedRecord.customer_name,
        linked_inquiry_or_po: matchedRecord.po_number || null,
        _complaint_verified: true,
      };
    } else if (action === 'UPDATE_VISIT') {
      draft = {
        visit_id: matchedRecord.id,
        company_name: matchedRecord.customer_name,
        visit_date: matchedRecord.date_formatted,
        visited_at: matchedRecord.visited_at,
        _visit_verified: true,
      };
    }

    const isPureSelect = isPureOptionSelectorOnly(clean) || isFullRecordSelection(clean);

    if (isPureSelect) {
      let prompt = '';
      if (action === 'LOG_ORDER') {
        prompt =
          `${formatSelectedInquiryForOrderPrompt(matchedRecord)}\n\n` +
          `🔢 *System PO Number:* ${draft.po_number}\n` +
          `_Generated automatically; you can edit it before confirmation._`;
      } else if (action === 'UPDATE_INQUIRY') {
        let itemsListText = '';
        const items = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : [];
        if (items.length > 0) {
          itemsListText = formatDetailedInquiryItemsList(items);
        } else {
          itemsListText = `1. *${matchedRecord.product_summary || 'Steel Material'}*`;
        }

        prompt = formatSelectedInquiryPrompt(matchedRecord, itemsListText);
      } else if (action === 'UPDATE_ORDER') {
        let itemsListText = '';
        const items = Array.isArray(matchedRecord.deal_items) ? matchedRecord.deal_items : (Array.isArray(matchedRecord.existing_items) ? matchedRecord.existing_items : []);
        if (items.length > 0) {
          itemsListText = formatDetailedInquiryItemsList(items, { includeHsn: true });
        } else {
          itemsListText = `*${matchedRecord.product_summary || 'Steel Material'}*`;
        }

        prompt = formatSelectedOrderPrompt(matchedRecord, itemsListText);
      } else if (action === 'UPDATE_COMPLAINT') {
        prompt = formatSelectedRecordPrompt(action, matchedRecord);
      } else if (action === 'UPDATE_VISIT') {
        prompt = formatSelectedRecordPrompt(action, matchedRecord);
      }

      await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
      await saveActiveSession(senderPhone, matchedRecord.customer_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
      return { handled: true, reply: prompt };
    }

    // Direct update provided alongside selector:
    const updatedDraft = await extractFieldsWithLLM(action, text, draft);
    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      const lineChoice = await askLineItemChoiceIfNeeded(action, updatedDraft, senderPhone);
      if (lineChoice) return lineChoice;

      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const askMissing = `Please provide the remaining details to update:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return { handled: true, reply: askMissing };
    }
  }

  // 6. Customer Name Search
  // If user typed a customer name (e.g. "Maurya Industries" or "Menon")
  const custSearchResults = await fetchEditableRecordsForModule(action, senderPhone, { customerFilter: clean });
  if (custSearchResults.length > 0) {
    await recordSessionMessage(senderPhone, 'user', text);
    const selectionRes = await fetchAndRenderUpdateSelection(action, senderPhone, { page: 1, customerFilter: clean });
    await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: action });
    await saveActiveSession(senderPhone, clean, `catalog_update_select|${action}|${JSON.stringify(selectionRes.state)}`);
    return catalogSelectionResult(selectionRes);
  }

  // 7. Check if user typed an out-of-bounds number
  if (/^\s*[1-9]\d*\s*$/.test(clean)) {
    const enteredNum = parseInt(clean, 10);
    const reply = `⚠️ Invalid selection (${enteredNum}). Please choose a valid number from the list above, type "Next" for more records, or tell me the customer name to search specifically.`;
    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', reply, { action_type: action });
    return { handled: true, reply };
  }

  // 8. No customer match and not an index -> inform user
  const moduleDisplayName = getModuleDisplayName(action);
  const notFoundReply = `ℹ️ *No editable ${moduleDisplayName} records found for "${clean}".*\n\nType another customer name to search specifically, type "All" to view all recent records, or reply "Cancel" to exit.`;
  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', notFoundReply, { action_type: action });
  await saveActiveSession(senderPhone, selectionState.customerFilter || 'Customer', `catalog_update_select|${action}|${JSON.stringify(selectionState)}`);
  return { handled: true, reply: notFoundReply };
}

// ── COMPLAINT ORDER VALIDATION & MULTI-ORDER DISAMBIGUATION CHECK ───────────

async function checkOrdersForComplaint(action, draft, senderPhone, originalText = '') {
  if (action !== 'LOG_COMPLAINT') return { handled: false, needsDisambiguation: false };
  if (!draft) return { handled: false, needsDisambiguation: false };

  const companyName = String(draft.company_name || '').trim();
  let rawRef = (draft.linked_inquiry_or_po || draft.po_number || draft.deal_id || draft.inquiry_id || '').trim();

  // If no reference in draft, inspect originalText for PO or Inquiry ID pattern
  if (!rawRef && originalText) {
    const poM = originalText.match(/\b(?:PO[-_:#\s]*([A-Za-z0-9_-]+)|(?:po\s*number|po\s*no\.?|po#)[\s:=-]*([A-Za-z0-9_-]+))\b/i);
    if (poM) {
      const cand = (poM[1] || poM[2] || '').trim();
      if (cand && !/^(?:date|for|to|is|with|number|no|details?)$/i.test(cand)) {
        rawRef = cand.toUpperCase().startsWith('PO') ? cand.toUpperCase() : `PO-${cand.toUpperCase()}`;
      }
    }
    if (!rawRef) {
      const inqM = originalText.match(/\b(?:INQ|DEAL)-[A-Z0-9]+\b|#INQ-[A-Z0-9]+/i);
      if (inqM) rawRef = inqM[0].replace(/^#/, '').trim().toUpperCase();
    }
  }

  // If neither company name nor PO/Inquiry reference is present, mandatory fields check will handle it
  if (!companyName && !rawRef) return { handled: false, needsDisambiguation: false };

  // Already confirmed there is no order to link for this customer
  if (draft._unlinked_complaint && draft._unlinked_complaint_customer === companyName.toLowerCase() &&
      (!rawRef || rawRef === draft._unverified_order_ref)) {
    return { handled: false, needsDisambiguation: false, status: 'UNLINKED', draft };
  }

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  // Query confirmed won orders from Orders module (deals table with stage = 'won') strictly scoped by role
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, po_number, stage, total_amount, delivery_location, payment_terms, created_at, salesperson_phone')
    .eq('stage', 'won')
    .order('created_at', { ascending: false });

  if (companyName) {
    dealsQuery = dealsQuery.ilike('customer_name', `%${companyName}%`);
  }

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
    } else {
      dealsQuery = null;
    }
  }

  const { data: deals } = dealsQuery ? await dealsQuery.limit(500) : { data: [] };
  const wonDeals = deals || [];

  if (wonDeals.length === 0) {
    if (companyName) {
      // Customer has no confirmed order to link: keep the draft and log a general (unlinked) complaint.
      // A PO / Inquiry reference the user typed cannot be verified, so it is noted but not linked.
      draft._unlinked_complaint = true;
      draft._unlinked_complaint_customer = companyName.toLowerCase();
      if (rawRef) {
        draft._unverified_order_ref = rawRef;
        delete draft.linked_inquiry_or_po;
        delete draft.po_number;
        delete draft.deal_id;
        delete draft.inquiry_id;
      }
      return { handled: false, needsDisambiguation: false, status: 'UNLINKED', draft };
    } else {
      const reply = `❌ *Order / PO Not Found in Orders Module*\n\n` +
        `Order / PO *"${rawRef}"* was not found among confirmed orders in the Orders module.\n\n` +
        `👉 Please verify the PO Number or Inquiry ID, or provide the Customer Name.`;
      return {
        handled: true,
        status: 'ORDER_NOT_FOUND',
        reply,
        draft,
      };
    }
  }

  // Fetch line items for these won deals
  const dealIds = wonDeals.map(d => d.id);
  const { data: items } = await supabase
    .from('deal_items')
    .select('deal_id, sku_text, dimensions, quantity, unit')
    .in('deal_id', dealIds);

  const itemMap = new Map();
  (items || []).forEach(it => {
    const list = itemMap.get(it.deal_id) || [];
    list.push(it);
    itemMap.set(it.deal_id, list);
  });

  const enrichedDeals = wonDeals.map(d => {
    const rawInq = d.id;
    const cleanCode = rawInq.replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
    const dealCode = `INQ-${cleanCode}`;
    const itms = itemMap.get(d.id) || [];
    const prodSummary = itms.length > 0
      ? itms.map(it => `${it.sku_text || 'Steel'} ${it.dimensions || ''} ${it.quantity ? `(${it.quantity} ${it.unit || 'MT'})` : ''}`.trim()).join(', ')
      : 'Steel Material';
    const dateFormatted = d.created_at ? new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '';
    const loc = d.delivery_location ? `${d.delivery_location}` : 'Not specified';
    const payment = d.payment_terms ? `${d.payment_terms}` : 'Not specified';

    return {
      ...d,
      deal_code: dealCode,
      clean_code: cleanCode,
      effective_deal_id: d.id,
      items: itms,
      product_summary: prodSummary,
      date_formatted: dateFormatted,
      location: loc,
      payment_terms: payment,
      total_amount: Number(d.total_amount) || 0,
    };
  });

  const formatOrderCandidate = (d, idx) => {
    const poRef = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;
    const lines = [
      `${idx + 1}. ${poRef} — _${d.stage ? (d.stage.charAt(0).toUpperCase() + d.stage.slice(1)) : 'Won'}_`,
      `   • *Product:* ${d.product_summary}`,
      `   • *Delivery Location:* ${d.location}`,
      `   • *Payment Terms:* ${d.payment_terms}`,
    ];
    if (d.total_amount > 0) {
      lines.push(`   • *Total Value:* ₹${d.total_amount.toLocaleString('en-IN')}`);
    }
    if (d.date_formatted) {
      lines.push(`   • *Date:* ${d.date_formatted}`);
    }
    return lines.join('\n');
  };

  // Check if candidate PO or Inquiry ID was specified in user text or draft
  if (rawRef) {
    const cleanInput = rawRef.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*/i, '').replace(/^#+/, '').trim().toUpperCase();

    const matched = enrichedDeals.find(d => {
      const dPo = (d.po_number || '').trim().toUpperCase();
      const dPoClean = dPo.replace(/^(?:PO|Purchase\s*Order)[\s#:-]*/i, '').replace(/^#+/, '');
      const dIdClean = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqIdClean = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();

      return (
        (dPo && (dPo === cleanInput || dPoClean === cleanInput || dPo.includes(cleanInput) || cleanInput.includes(dPoClean))) ||
        d.clean_code === cleanInput ||
        d.deal_code.toUpperCase() === cleanInput ||
        dIdClean.startsWith(cleanInput) ||
        inqIdClean.startsWith(cleanInput)
      );
    });

    if (matched) {
      draft.company_name = matched.customer_name;
      draft.deal_id = matched.id;
      draft.po_number = matched.po_number || null;
      draft.linked_inquiry_or_po = matched.po_number ? `PO: ${matched.po_number} (${matched.deal_code})` : matched.deal_code;
      const dealProd = matched.product_summary || (matched.items && matched.items.length > 0 ? matched.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
      const isCatalogProd = draft.affected_product && isValidCatalogProduct(draft.affected_product);
      if ((!draft.affected_product || !isCatalogProd) && dealProd) {
        draft.affected_product = dealProd;
      } else if (isCatalogProd) {
        const norm = normalizeProductToCatalog(draft.affected_product);
        if (norm.catalogName) draft.affected_product = norm.catalogName;
      }
      return { handled: false, needsDisambiguation: false, draft };
    } else {
      // Specified PO or Inquiry not found among won orders
      if (companyName) {
        const availableList = enrichedDeals.map(formatOrderCandidate).join('\n\n');
        const reply = `❌ *Order / PO Not Found in Orders Module*\n\n` +
          `Customer: *${companyName}*\n` +
          `Order / PO *"${rawRef}"* was not found among confirmed orders for ${companyName}.\n\n` +
          `*Available Confirmed Orders for ${companyName}:*\n\n` +
          `${availableList}\n\n` +
          `👉 Please reply with a valid *PO Number* or *Inquiry ID* from the list above.`;

        draft._order_candidates = enrichedDeals;
        return {
          handled: true,
          status: 'ORDER_NOT_FOUND',
          reply,
          draft,
        };
      } else {
        const reply = `❌ *Order / PO Not Found in Orders Module*\n\n` +
          `Order / PO *"${rawRef}"* was not found among confirmed orders in the Orders module.\n\n` +
          `👉 Please verify the PO Number or Inquiry ID, or provide the Customer Name.`;
        return {
          handled: true,
          status: 'ORDER_NOT_FOUND',
          reply,
          draft,
        };
      }
    }
  }

  // If no reference was specified by user:
  if (enrichedDeals.length === 1) {
    const singleDeal = enrichedDeals[0];
    draft.company_name = singleDeal.customer_name;
    draft.deal_id = singleDeal.effective_deal_id || singleDeal.inquiry_id || singleDeal.id;
    draft.po_number = singleDeal.po_number || null;
    draft.linked_inquiry_or_po = singleDeal.po_number ? `PO: ${singleDeal.po_number} (${singleDeal.deal_code})` : singleDeal.deal_code;
    const singleProd = singleDeal.product_summary || (singleDeal.items && singleDeal.items.length > 0 ? singleDeal.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
    const isCatalogProd = draft.affected_product && isValidCatalogProduct(draft.affected_product);
    if ((!draft.affected_product || !isCatalogProd) && singleProd) {
      draft.affected_product = singleProd;
    } else if (isCatalogProd) {
      const norm = normalizeProductToCatalog(draft.affected_product);
      if (norm.catalogName) draft.affected_product = norm.catalogName;
    }
    return { handled: false, needsDisambiguation: false, draft };
  }

  // Multiple won orders exist and no specific PO/INQ was provided -> Multi-Order Disambiguation
  const pageSize = 10;
  const page = Number(draft._order_candidates_page) || 1;
  const startIdx = (page - 1) * pageSize;
  const pageDeals = enrichedDeals.slice(startIdx, startIdx + pageSize);
  const totalPages = Math.ceil(enrichedDeals.length / pageSize);

  const orderList = pageDeals.map(formatOrderCandidate).join('\n\n');

  let headerText = `⚠️ *Multiple Confirmed Orders Found for ${companyName || 'this customer'} (${enrichedDeals.length} Records):*`;
  if (enrichedDeals.length > pageSize) {
    headerText = `⚠️ *Showing ${startIdx + 1}–${startIdx + pageDeals.length} of ${enrichedDeals.length} Confirmed Orders for ${companyName || 'this customer'} (Page ${page} of ${totalPages}):*`;
  }

  let footerText = `👉 Reply with the *Number* (1–${enrichedDeals.length}) or the *Inquiry ID* / *PO Number*.`;
  if (totalPages > 1) {
    footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
  }

  const prompt = `${headerText}\n\n` +
    `Please specify which order or PO this complaint is about:\n\n` +
    `${orderList}\n\n` +
    `${footerText}`;

  draft._order_candidates = pageDeals;
  draft._all_order_candidates = enrichedDeals;
  draft._order_candidates_page = page;

  return {
    handled: true,
    needsDisambiguation: true,
    status: 'MULTIPLE_ORDERS',
    reply: prompt,
    prompt,
    draft,
  };
}

// ── CUSTOMER MATCHING HELPERS ────────────────────────────────────────────────

function cleanLegalSuffixes(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCustomerMatch(custName, custPhone, targetName, targetPhone) {
  const cClean = cleanLegalSuffixes(custName);
  const tClean = cleanLegalSuffixes(targetName);
  if (!cClean || !tClean) return false;
  if (cClean === tClean) return true;
  const [shorter, longer] = cClean.length <= tClean.length ? [cClean, tClean] : [tClean, cClean];
  if (shorter.length >= 2 && longer.startsWith(shorter)) {
    // Short fragments ("SS") must be a whole leading word so they don't match "SST Engineering".
    const endsOnWordBoundary = longer.length === shorter.length || longer[shorter.length] === ' ';
    if (endsOnWordBoundary || shorter.length >= 4) return true;
  }
  const genericWords = new Set(['steel', 'metals', 'traders', 'industries', 'engineering', 'enterprises', 'enterprise', 'infra', 'works', 'projects', 'systems']);
  const cWords = cClean.split(' ').filter(w => w.length >= 2 && !genericWords.has(w));
  const tWords = tClean.split(' ').filter(w => w.length >= 2 && !genericWords.has(w));
  if (cWords.length > 0 && tWords.length > 0) {
    if (cWords.every(w => tWords.includes(w)) || tWords.every(w => cWords.includes(w))) return true;
  }
  return false;
}

// ── INQUIRY LOOKUP & EDITABILITY DISAMBIGUATION CHECK ─────────────────────────

async function checkInquiriesForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_INQUIRY') return { handled: false };

  const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  const rawInqId = (draft.inquiry_id || '').trim();
  const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
  const companyName = (draft.company_name || '').trim();
  const hasFilter = Boolean(cleanInqId || companyName);

  if (draft._inquiry_verified && !originalText.match(/\b(?:INQ|DEAL)-[A-Z0-9]+\b|#INQ-[A-Z0-9]+/i)) {
    return { handled: false, status: 'ALREADY_VERIFIED', draft };
  }

  const accessibleSet = new Set();
  if (Array.isArray(scope.phones)) scope.phones.forEach(p => getPhoneVariants(p).forEach(pv => accessibleSet.add(pv)));
  if (senderPhone) getPhoneVariants(senderPhone).forEach(pv => accessibleSet.add(pv));
  const accessibleList = Array.from(accessibleSet);

  // Fetch deals and inquiries to find matches
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  let inqsQuery = supabase
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, inquiry_type, created_at, salesperson_phone')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin) {
    if (accessibleList.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', accessibleList);
      inqsQuery = inqsQuery.in('salesperson_phone', accessibleList);
    } else {
      dealsQuery = null;
      inqsQuery = null;
    }
  }

  if (companyName) {
    const cleanWord = cleanLegalSuffixes(companyName).split(' ').filter(w => w.length >= 2)[0] || companyName;
    if (dealsQuery) dealsQuery = dealsQuery.ilike('customer_name', `%${cleanWord}%`);
  }

  if (dealsQuery) dealsQuery = dealsQuery.limit(500);
  if (inqsQuery) inqsQuery = inqsQuery.limit(500);

  const [{ data: allDeals }, { data: allInqs }] = await Promise.all([
    dealsQuery ? dealsQuery : Promise.resolve({ data: [] }),
    inqsQuery ? inqsQuery : Promise.resolve({ data: [] }),
  ]);

  // Apply RBAC phone filtering
  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      if (!item.salesperson_phone) return false;
      return isPhoneInScope(item.salesperson_phone, scope.phones);
    });
  };

  const scopedDeals = filterByScope(allDeals);
  const scopedInqs = filterByScope(allInqs);

  const dealMapByInqId = new Map();
  scopedDeals.forEach(d => {
    if (d.inquiry_id) dealMapByInqId.set(d.inquiry_id, d);
  });

  const matchedCandidates = [];
  const seenKeys = new Set();

  // 1. Direct ID match if inquiry_id was provided
  if (cleanInqId) {
    scopedDeals.forEach(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      if (dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && (dId.includes(cleanInqId) || inqId.includes(cleanInqId)))) {
        const stage = (d.stage || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(d.inquiry_id || d.id).slice(0, 6).toUpperCase()}`;
        const dealAttrs = extractInquiryAttributes(null, d);
        matchedCandidates.push({
          id: d.inquiry_id || d.id,
          deal_id: d.id,
          inquiry_id: d.inquiry_id || d.id,
          displayId,
          company_name: d.customer_name || 'Customer',
          stage,
          payment_terms: dealAttrs.payment_terms || d.payment_terms || 'Not specified',
          delivery_location: dealAttrs.delivery_location || d.delivery_location || 'Not specified',
          preferred_make: dealAttrs.preferred_make || null,
          additional_notes: dealAttrs.additional_notes || null,
          total_amount: Number(d.total_amount) || 0,
          deal_items: d.deal_items || [],
          created_at: d.created_at,
          dateFormatted: formatDateDDMMYYYY(d.created_at),
          raw_text: '',
        });
        seenKeys.add(d.id);
        if (d.inquiry_id) seenKeys.add(d.inquiry_id);
      }
    });

    scopedInqs.forEach(inq => {
      if (seenKeys.has(inq.id)) return;
      const inqId = (inq.id || '').replace(/-/g, '').toUpperCase();
      if (inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && inqId.includes(cleanInqId))) {
        const ai = inq.ai_extraction_json || {};
        const stage = (inq.status || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${inq.id.slice(0, 6).toUpperCase()}`;
        const inqAttrs = extractInquiryAttributes(inq, dealMapByInqId.get(inq.id));
        matchedCandidates.push({
          id: inq.id,
          deal_id: dealMapByInqId.get(inq.id)?.id || null,
          inquiry_id: inq.id,
          displayId,
          company_name: inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
          stage,
          payment_terms: inqAttrs.payment_terms || 'Not specified',
          delivery_location: inqAttrs.delivery_location || 'Not specified',
          preferred_make: inqAttrs.preferred_make || null,
          additional_notes: inqAttrs.additional_notes || null,
          total_amount: Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
          deal_items: ai.lineItems || ai.line_items || [],
          created_at: inq.created_at,
          dateFormatted: formatDateDDMMYYYY(inq.created_at),
          raw_text: inq.raw_text,
        });
        seenKeys.add(inq.id);
      }
    });

    // 1b. Unscoped fallback by explicit cleanInqId if not found in scoped list
    if (matchedCandidates.length === 0) {
      const { data: fallbackDeals } = await supabase
        .from('deals')
        .select('id, inquiry_id, customer_name, customer_phone, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount, preferred_make, make)')
        .order('created_at', { ascending: false })
        .limit(500);

      (await filterRecordsToCallerScope(fallbackDeals, scope, { customerField: 'customer_name' })).forEach(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        if (dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && (dId.includes(cleanInqId) || inqId.includes(cleanInqId)))) {
          const stage = (d.stage || 'new_inquiry').toLowerCase();
          const displayId = `INQ-${(d.inquiry_id || d.id).slice(0, 6).toUpperCase()}`;
          const dealAttrs = extractInquiryAttributes(null, d);
          matchedCandidates.push({
            id: d.inquiry_id || d.id,
            deal_id: d.id,
            inquiry_id: d.inquiry_id || d.id,
            displayId,
            company_name: d.customer_name || 'Customer',
            stage,
            payment_terms: dealAttrs.payment_terms || d.payment_terms || 'Not specified',
            delivery_location: dealAttrs.delivery_location || d.delivery_location || 'Not specified',
            preferred_make: dealAttrs.preferred_make || null,
            additional_notes: dealAttrs.additional_notes || null,
            total_amount: Number(d.total_amount) || 0,
            deal_items: d.deal_items || [],
            created_at: d.created_at,
            dateFormatted: formatDateDDMMYYYY(d.created_at),
            raw_text: '',
          });
          seenKeys.add(d.id);
          if (d.inquiry_id) seenKeys.add(d.inquiry_id);
        }
      });

      if (matchedCandidates.length === 0) {
        const { data: fallbackInqs } = await supabase
          .from('inquiries')
          .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, inquiry_type, created_at, salesperson_phone')
          .order('created_at', { ascending: false })
          .limit(500);

        (await filterRecordsToCallerScope(fallbackInqs, scope, { customerField: 'sender_name' })).forEach(inq => {
          if (seenKeys.has(inq.id)) return;
          const inqId = (inq.id || '').replace(/-/g, '').toUpperCase();
          if (inqId.startsWith(cleanInqId) || (cleanInqId.length >= 4 && inqId.includes(cleanInqId))) {
            const ai = inq.ai_extraction_json || {};
            const stage = (inq.status || 'new_inquiry').toLowerCase();
            const displayId = `INQ-${inq.id.slice(0, 6).toUpperCase()}`;
            const inqAttrs = extractInquiryAttributes(inq, null);
            matchedCandidates.push({
              id: inq.id,
              deal_id: null,
              inquiry_id: inq.id,
              displayId,
              company_name: inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
              stage,
              payment_terms: inqAttrs.payment_terms || 'Not specified',
              delivery_location: inqAttrs.delivery_location || 'Not specified',
              preferred_make: inqAttrs.preferred_make || null,
              additional_notes: inqAttrs.additional_notes || null,
              total_amount: Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
              deal_items: ai.lineItems || ai.line_items || [],
              created_at: inq.created_at,
              dateFormatted: formatDateDDMMYYYY(inq.created_at),
              raw_text: inq.raw_text,
            });
            seenKeys.add(inq.id);
          }
        });
      }
    }
  }

  // 2. Company Name Match if no direct ID match or if company_name provided
  if (matchedCandidates.length === 0 && companyName) {
    scopedInqs.forEach(inq => {
      const ai = inq.ai_extraction_json || {};
      const candidateName = inq.sender_name || ai.companyName || ai.customer_name || ai.customer?.name || '';
      if (isCustomerMatch(companyName, null, candidateName, inq.sender_phone)) {
        const linkedDeal = dealMapByInqId.get(inq.id);
        const stage = (linkedDeal?.stage || inq.status || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(inq.id || linkedDeal?.id).slice(0, 6).toUpperCase()}`;
        const inqAttrs = extractInquiryAttributes(inq, linkedDeal);
        matchedCandidates.push({
          id: inq.id,
          deal_id: linkedDeal?.id || null,
          inquiry_id: inq.id,
          displayId,
          company_name: linkedDeal?.customer_name || candidateName || companyName,
          stage,
          payment_terms: inqAttrs.payment_terms || 'Not specified',
          delivery_location: inqAttrs.delivery_location || 'Not specified',
          preferred_make: inqAttrs.preferred_make || null,
          additional_notes: inqAttrs.additional_notes || null,
          total_amount: Number(linkedDeal?.total_amount) || Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
          deal_items: linkedDeal?.deal_items || ai.lineItems || ai.line_items || [],
          created_at: inq.created_at,
          dateFormatted: formatDateDDMMYYYY(inq.created_at),
          raw_text: inq.raw_text,
        });
        seenKeys.add(inq.id);
        if (linkedDeal?.id) seenKeys.add(linkedDeal.id);
      }
    });

    scopedDeals.forEach(d => {
      if (seenKeys.has(d.id) || (d.inquiry_id && seenKeys.has(d.inquiry_id))) return;
      if (isCustomerMatch(companyName, null, d.customer_name, d.customer_phone)) {
        const stage = (d.stage || 'new_inquiry').toLowerCase();
        const displayId = `INQ-${(d.inquiry_id || d.id).slice(0, 6).toUpperCase()}`;
        const dealAttrs = extractInquiryAttributes(null, d);
        matchedCandidates.push({
          id: d.inquiry_id || d.id,
          deal_id: d.id,
          inquiry_id: d.inquiry_id || d.id,
          displayId,
          company_name: d.customer_name || companyName,
          stage,
          payment_terms: dealAttrs.payment_terms || d.payment_terms || 'Not specified',
          delivery_location: dealAttrs.delivery_location || d.delivery_location || 'Not specified',
          preferred_make: dealAttrs.preferred_make || null,
          additional_notes: dealAttrs.additional_notes || null,
          total_amount: Number(d.total_amount) || 0,
          deal_items: d.deal_items || [],
          created_at: d.created_at,
          dateFormatted: formatDateDDMMYYYY(d.created_at),
          raw_text: '',
        });
        seenKeys.add(d.id);
      }
    });
  }

  // 3. No Filter provided (Direct Browse mode) -> Populate from all scoped deals & inqs
  if (!hasFilter && matchedCandidates.length === 0) {
    scopedDeals.forEach(d => {
      const stage = (d.stage || 'new_inquiry').toLowerCase();
      const displayId = `INQ-${(d.inquiry_id || d.id).slice(0, 6).toUpperCase()}`;
      const dealAttrs = extractInquiryAttributes(null, d);
      matchedCandidates.push({
        id: d.inquiry_id || d.id,
        deal_id: d.id,
        inquiry_id: d.inquiry_id || d.id,
        displayId,
        company_name: d.customer_name || 'Customer',
        stage,
        payment_terms: dealAttrs.payment_terms || d.payment_terms || 'Not specified',
        delivery_location: dealAttrs.delivery_location || d.delivery_location || 'Not specified',
        preferred_make: dealAttrs.preferred_make || null,
        additional_notes: dealAttrs.additional_notes || null,
        total_amount: Number(d.total_amount) || 0,
        deal_items: d.deal_items || [],
        created_at: d.created_at,
        dateFormatted: formatDateDDMMYYYY(d.created_at),
        raw_text: '',
      });
      seenKeys.add(d.id);
      if (d.inquiry_id) seenKeys.add(d.inquiry_id);
    });

    scopedInqs.forEach(inq => {
      if (seenKeys.has(inq.id)) return;
      const ai = inq.ai_extraction_json || {};
      const stage = (inq.status || 'new_inquiry').toLowerCase();
      const displayId = `INQ-${inq.id.slice(0, 6).toUpperCase()}`;
      const inqAttrs = extractInquiryAttributes(inq, dealMapByInqId.get(inq.id));
      matchedCandidates.push({
        id: inq.id,
        deal_id: dealMapByInqId.get(inq.id)?.id || null,
        inquiry_id: inq.id,
        displayId,
        company_name: inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
        stage,
        payment_terms: inqAttrs.payment_terms || 'Not specified',
        delivery_location: inqAttrs.delivery_location || 'Not specified',
        preferred_make: inqAttrs.preferred_make || null,
        additional_notes: inqAttrs.additional_notes || null,
        total_amount: Number(ai.totalAmount) || Number(ai.grandTotal) || 0,
        deal_items: ai.lineItems || ai.line_items || [],
        created_at: inq.created_at,
        dateFormatted: formatDateDDMMYYYY(inq.created_at),
        raw_text: inq.raw_text,
      });
      seenKeys.add(inq.id);
    });
  }

  const formatStageLabel = (st) => {
    const s = String(st || '').toLowerCase();
    if (s.includes('won') || s.includes('order')) return 'Won';
    if (s.includes('lost')) return 'Lost';
    if (s.includes('quote') || s.includes('price') || s.includes('qualif') || s.includes('confirmed') || s.includes('proposal')) return 'Price Quote';
    if (s.includes('negot')) return 'Negotiation';
    if (s.includes('hold')) return 'On Hold';
    return 'New Inquiry';
  };

  const formatProductSummary = (item) => {
    const items = (Array.isArray(item.deal_items) && item.deal_items.length > 0)
      ? item.deal_items
      : (item.ai_extraction_json && Array.isArray(item.ai_extraction_json.line_items) && item.ai_extraction_json.line_items.length > 0)
        ? item.ai_extraction_json.line_items
        : (item.ai_extraction_json && Array.isArray(item.ai_extraction_json.lineItems) && item.ai_extraction_json.lineItems.length > 0)
          ? item.ai_extraction_json.lineItems
          : (Array.isArray(item.line_items) && item.line_items.length > 0)
            ? item.line_items
            : [];

    if (items.length > 0) {
      const formatItemLabel = (it) => {
        const name = it.sku_text || it.description || it.product_name || 'Item';
        const dim = it.dimensions || it.spec;
        if (dim) {
          const thkMatch = dim.match(/(\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g))\b/i);
          const shortSpec = thkMatch ? thkMatch[0].trim().toUpperCase() : dim.split(/[\s(,]/)[0].trim();
          if (shortSpec && !name.toLowerCase().includes(shortSpec.toLowerCase())) {
            return `${name} (${shortSpec})`;
          }
        }
        return name;
      };

      if (items.length === 1) {
        const it = items[0];
        const name = formatItemLabel(it);
        const qtyStr = it.quantity ? ` (${it.quantity} ${it.unit || 'MT'})` : '';
        const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
        return `${name}${qtyStr}${rateStr}`;
      }
      const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
      const names = items.slice(0, 3).map(formatItemLabel).join(', ');
      const more = items.length > 3 ? ` +${items.length - 3} more` : '';
      return `${items.length} Items${totalQty > 0 ? ` (${formatLineItemsTonnage(items) || `${totalQty} MT`} Total)` : ''} — ${names}${more}`;
    }
    if (item.raw_text) {
      const firstLine = item.raw_text.split('\n')[0].trim();
      return firstLine.slice(0, 60);
    }
    return 'Products on record';
  };

  const isTerminal = (st) => ['won', 'lost', 'closed', 'completed', 'cancelled'].includes(String(st || '').toLowerCase());
  const editable = matchedCandidates.filter(m => !isTerminal(m.stage));
  const nonEditable = matchedCandidates.filter(m => isTerminal(m.stage));

  const targetName = companyName || draft.company_name || 'Customer';

  // ── Case A: 0 Editable Inquiries Found ──
  if (editable.length === 0) {
    if (nonEditable.length > 0 && hasFilter) {
      const latestNonEditable = nonEditable[0];
      const stageLabel = formatStageLabel(latestNonEditable.stage);
      const reply = `ℹ️ *No Editable Inquiries Found for ${latestNonEditable.company_name}*\n\n` +
        `The inquiry found for *${latestNonEditable.company_name}* (*${latestNonEditable.displayId}*) is already marked as *${stageLabel}*. Completed / won inquiries cannot be edited.\n\n` +
        `If you would like to log a new inquiry for *${latestNonEditable.company_name}*, please send the inquiry details (Product, Quantity, Payment Terms, Delivery Location).`;
      return {
        handled: true,
        reply,
        status: 'ONLY_TERMINAL',
      };
    }

    if (rawInqId) {
      delete draft.inquiry_id;
      const reply = `❌ *Inquiry Not Found*\n\n` +
        `Could not find Inquiry ID *${rawInqId}* in your active records.\n\n` +
        `Please check the Inquiry ID or reply with the Customer / Company Name.`;
      return {
        handled: true,
        reply,
        status: 'ID_NOT_FOUND',
        draft,
      };
    }

    const reply = hasFilter
      ? `ℹ️ *No Inquiries Found for ${targetName}*\n\n` +
        `There are no existing inquiries recorded for *${targetName}*.\n\n` +
        `If you would like to log a new inquiry, please share the inquiry details (Product, Quantity, Payment Terms, Delivery Location).`
      : `ℹ️ *No Editable Inquiries Found*\n\n` +
        `There are no active or editable inquiries recorded in your portfolio.\n\n` +
        `If you would like to log a new inquiry, reply with *1* or send the inquiry details.`;
    return {
      handled: true,
      reply,
      status: 'NO_INQUIRIES',
      draft,
    };
  }

  // ── Case B: Exactly 1 Editable Inquiry Found ──
  if (editable.length === 1 && hasFilter) {
    const single = editable[0];
    const singleItems = Array.isArray(single.deal_items) ? single.deal_items : [];
    draft.inquiry_id = single.inquiry_id || single.id;
    draft.deal_id = single.deal_id || null;
    draft.company_name = single.company_name;
    draft.existing_items = singleItems;
    draft._inquiry_display_id = single.displayId;
    draft.delivery_location = single.delivery_location || null;
    draft.payment_terms = single.payment_terms || null;
    draft.preferred_make = single.preferred_make || null;
    draft.additional_notes = single.additional_notes || null;

    const hasUpdates = (draft.updates && Object.values(draft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
      (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) ||
      Boolean(draft.rate || draft.quantity || draft.new_stage || draft.stage || draft.payment_terms || draft.delivery_location);

    // If user has not specified what to update yet, show current inquiry details & ask
    if (!hasUpdates) {
      let itemsListText = '';
      if (singleItems.length > 0) {
        itemsListText = formatDetailedInquiryItemsList(singleItems);
      } else {
        itemsListText = `1. *${formatProductSummary(single)}*`;
      }
      const stageLabel = formatStageLabel(single.stage);
      let totalAmt = Number(single.total_amount || single.totalAmount || 0);
      if (!totalAmt && singleItems.length > 0) {
        totalAmt = singleItems.reduce((s, it) => {
          const q = Number(it.quantity || 0);
          const r = Number(it.rate || 0);
          const a = Number(it.amount || 0);
          return s + (a || (q * r));
        }, 0);
      }
      const quoteTotalBlock = totalAmt > 0 ? `\n\nQuotation Total: ₹${totalAmt.toLocaleString('en-IN')}` : '';

      const prompt = `✏️ *Editable Inquiry Found for ${single.company_name}:*\n\n` +
        `• *Inquiry ID:* ${single.displayId}\n` +
        `• *Date:* ${formatAttributeValue(single.dateFormatted || single.date_formatted)}\n` +
        `• *Stage:* ${formatAttributeValue(stageLabel)}\n` +
        `• *Preferred Make:* ${formatAttributeValue(single.preferred_make)}\n` +
        `• *Payment Terms:* ${formatAttributeValue(single.payment_terms)}\n` +
        `• *Delivery Location:* ${formatAttributeValue(single.delivery_location)}\n` +
        `• *Additional Notes:* ${formatAttributeValue(single.additional_notes)}\n\n` +
        `*Current Line Items:*\n\n${itemsListText}` +
        quoteTotalBlock + `\n\n` +
        `You can update quantity, specs, payment terms, or delivery. Reply *Price this inquiry* after the base price is ready. Quoted, Won, and Lost stay closed until that sales price is saved.`;

      return {
        handled: true,
        reply: prompt,
        status: 'SINGLE_EDITABLE_ASK_DETAILS',
        draft,
      };
    }

    // User already provided update values -> continue to confirmation
    return {
      handled: false,
      status: 'SINGLE_EDITABLE_READY',
      draft,
    };
  }

  // ── Case C: Multiple Editable Inquiries Found (or Direct Browse with 1+ records) ──
  const pageSize = 10;
  const page = Number(draft._inquiry_candidates_page) || 1;
  const startIdx = (page - 1) * pageSize;
  const pageItems = editable.slice(startIdx, startIdx + pageSize);
  const totalPages = Math.ceil(editable.length / pageSize);

  const candidateSummaries = pageItems.map((inq, idx) => {
    let rateStr = null;
    let makeStr = inq.preferred_make || null;
    if (Array.isArray(inq.deal_items) && inq.deal_items.length > 0) {
      const firstItem = inq.deal_items[0];
      if (firstItem.rate) {
        rateStr = `₹${Number(firstItem.rate).toLocaleString('en-IN')}${firstItem.unit ? `/${firstItem.unit}` : '/MT'}`;
      }
      if (!makeStr && (firstItem.preferred_make || firstItem.make)) {
        makeStr = firstItem.preferred_make || firstItem.make;
      }
    }
    return {
      index: startIdx + idx + 1,
      id: inq.inquiry_id || inq.id,
      displayId: inq.displayId,
      company_name: inq.company_name,
      date: inq.dateFormatted || inq.date_formatted,
      stage: formatStageLabel(inq.stage),
      productSummary: formatProductSummary(inq),
      deal_items: inq.deal_items || [],
      payment_terms: inq.payment_terms || 'Not specified',
      delivery_location: inq.delivery_location || 'Not specified',
      preferred_make: makeStr,
      additional_notes: inq.additional_notes || null,
      rate: rateStr,
      make: makeStr,
    };
  });

  const choicesText = candidateSummaries
    .map(c => {
      const lines = [
        `${c.index}. *${c.displayId}* (${c.company_name}) — ${c.date} — _${c.stage}_`,
        `   • *Product:* ${c.productSummary}`,
        `   • *Delivery Location:* ${c.delivery_location}`,
        `   • *Payment Terms:* ${c.payment_terms}`,
      ];
      if (c.rate && !c.productSummary.includes('@ ₹')) {
        lines.push(`   • *Rate:* ${c.rate}`);
      }
      if (c.make) {
        lines.push(`   • *Make:* ${c.make}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  let headerText = hasFilter
    ? `📋 *Multiple Editable Inquiries Found for ${targetName} (${editable.length} Records):*`
    : `📋 *Recent Editable Inquiries (${editable.length} Records):*`;

  if (editable.length > pageSize) {
    headerText = hasFilter
      ? `📋 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${editable.length} Editable Inquiries for ${targetName} (Page ${page} of ${totalPages}):*`
      : `📋 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${editable.length} Recent Editable Inquiries (Page ${page} of ${totalPages}):*`;
  }

  let footerText = `👉 Reply with the *Option Number* (1–${editable.length}), *Inquiry ID* (e.g. "${candidateSummaries[0].displayId}"), *Product*, or what you want to update.`;
  if (totalPages > 1) {
    footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
  }

  const prompt = `${headerText}\n\n` +
    `Please choose which inquiry you want to edit:\n\n` +
    `${choicesText}\n\n` +
    `${footerText}`;

  draft._inquiry_candidates = candidateSummaries;
  draft._all_inquiry_candidates = editable;
  draft._inquiry_candidates_page = page;

  return {
    handled: true,
    reply: prompt,
    status: 'MULTIPLE_EDITABLE',
    draft,
  };
}

// ── ORDER LOOKUP & VALIDATION HELPER ─────────────────────────────────────────

async function checkOrdersForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_ORDER') return { handled: false };

  const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };

  const rawInqId = (draft.inquiry_id || '').trim();
  const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
  const rawPo = (draft.updates?.po_number || draft.po_number || '').trim();
  const rawReferencePo = (draft.updates?.reference_po_number || draft.reference_po_number || '').trim();
  const cleanPo = rawPo.replace(/^(?:PO[-_:#\s]*)/i, '').trim();
  const rawCompany = (draft.company_name || '').trim();
  const hasFilter = Boolean(cleanInqId || rawPo || rawReferencePo || rawCompany);

  if (draft._order_verified && !originalText.match(/\b(?:PO[-_:#\s]*[A-Za-z0-9_-]+|INQ-[A-Z0-9]+)\b/i)) {
    return { handled: false, status: 'ALREADY_VERIFIED', draft };
  }

  // 1. Fetch recent deals strictly scoped by role
  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
    } else {
      dealsQuery = null;
    }
  }

  const { data: deals } = dealsQuery ? await dealsQuery.limit(500) : { data: [] };

  // If no filter is provided and multiple deals exist -> Multiple Orders candidate view
  if (!hasFilter) {
    if (!deals || deals.length === 0) {
      const reply = `ℹ️ *No Orders Found*\n\nThere are no existing orders in your records.\n\nIf you would like to log a new order, reply with *3* or send the order details.`;
      return {
        handled: true,
        status: 'NOT_FOUND',
        reply,
        draft,
      };
    }

    return renderOrderCandidates(deals, 'Recent Orders');
  }

  // Order picker shared by "no filter" and "customer has several orders"
  function renderOrderCandidates(candidateDeals, listLabel) {
    const pageSize = 10;
    const page = Number(draft._order_candidates_page) || 1;
    const startIdx = (page - 1) * pageSize;
    const pageDeals = candidateDeals.slice(startIdx, startIdx + pageSize);
    const totalPages = Math.ceil(candidateDeals.length / pageSize);

    const formatDeal = (d, idx) => {
      const cleanCode = (d.id || '').replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
      const dealCode = `INQ-${cleanCode}`;
      const poRef = d.po_number ? `*${d.po_number}* (${dealCode})` : `*${dealCode}*`;
      const dateFormatted = d.po_date || (d.created_at ? formatDateDDMMYYYY(d.created_at) : '');
      const lines = [
        `${startIdx + idx + 1}. ${poRef} — *${d.customer_name || 'Customer'}* — _${d.stage || 'Won'}_`,
      ];
      if (Number(d.total_amount) > 0) {
        lines.push(`   • *Total Value:* ₹${Number(d.total_amount).toLocaleString('en-IN')}`);
      }
      if (d.delivery_location) {
        lines.push(`   • *Delivery Location:* ${d.delivery_location}`);
      }
      if (d.reference_po_number) {
        lines.push(`   • *Reference PO:* ${d.reference_po_number}`);
      }
      if (dateFormatted) {
        lines.push(`   • *Date:* ${dateFormatted}`);
      }
      return lines.join('\n');
    };

    const choicesText = pageDeals.map(formatDeal).join('\n\n');

    let headerText = `🛒 *${listLabel} (${candidateDeals.length} Records):*`;
    if (candidateDeals.length > pageSize) {
      headerText = `🛒 *Showing ${startIdx + 1}–${startIdx + pageDeals.length} of ${candidateDeals.length} ${listLabel} (Page ${page} of ${totalPages}):*`;
    }

    let footerText = `👉 Reply with the *Option Number* (1–${candidateDeals.length}), *Inquiry ID*, *PO Number*, or what you want to update.`;
    if (totalPages > 1) {
      footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
    }

    const prompt = `${headerText}\n\n` +
      `Please choose which order you want to update:\n\n` +
      `${choicesText}\n\n` +
      `${footerText}`;

    draft._order_candidates = pageDeals.map((d, i) => {
      const cleanCode = (d.id || '').replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
      return {
        ...d,
        index: startIdx + i + 1,
        deal_code: `INQ-${cleanCode}`,
        clean_code: cleanCode,
      };
    });
    draft._all_order_candidates = candidateDeals.map((d, i) => {
      const cleanCode = (d.id || '').replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
      return {
        ...d,
        index: i + 1,
        deal_code: `INQ-${cleanCode}`,
        clean_code: cleanCode,
      };
    });
    draft._order_candidates_page = page;

    return {
      handled: true,
      status: 'MULTIPLE_ORDERS',
      reply: prompt,
      draft,
    };
  }

  let deal = null;
  if (deals && deals.length > 0) {
    if (cleanInqId) {
      deal = deals.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
      }) || null;
    }
    if (!deal && rawPo) {
      deal = deals.find(d => {
        if (!d.po_number) return false;
        const dPo = String(d.po_number).trim();
        return dPo.toLowerCase() === rawPo.toLowerCase() || (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
      }) || null;
    }
    if (!deal && rawReferencePo) {
      deal = deals.find(d => String(d.reference_po_number || '').toLowerCase() === rawReferencePo.toLowerCase()) || null;
    }
    if (!deal && rawCompany) {
      const companyDeals = deals.filter(d => isCustomerMatch(rawCompany, null, d.customer_name, null));
      if (!cleanInqId && !rawPo) {
        const companyOrders = companyDeals.filter(d => String(d.stage || '').toLowerCase() === 'won' || Boolean(d.po_number));
        if (companyOrders.length > 1) {
          return renderOrderCandidates(companyOrders, `Orders for ${rawCompany}`);
        }
        if (companyOrders.length === 1) deal = companyOrders[0];
      }
      if (!deal) deal = companyDeals[0] || null;
    }
  }

  // 2. Check inquiries table if cleanInqId was given and not yet found in deals
  if (!deal && cleanInqId) {
    let inqsQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, salesperson_phone, status, po_number, reference_po_number, generated_po_number, ai_extraction_json, deals(*)')
      .order('created_at', { ascending: false });

    if (scope.phones !== null) {
      const targetPhones = expandPhoneVariants(scope.phones);
      if (targetPhones.length > 0) {
        inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
      } else {
        inqsQuery = null;
      }
    }

    const { data: inqRows } = inqsQuery ? await inqsQuery.limit(500) : { data: [] };
    if (inqRows) {
      for (const inq of inqRows) {
        const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
        if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
          if (inq.deals && inq.deals.length > 0) {
            deal = inq.deals[0];
          } else {
            const inqJson = inq.ai_extraction_json || {};
            deal = {
              id: inq.id,
              inquiry_id: inq.id,
              customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
              total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
              delivery_location: inqJson.delivery_location || inqJson.location || null,
              payment_terms: inqJson.payment_terms || null,
              po_number: rawPo || null,
              reference_po_number: inq.reference_po_number || null,
              generated_po_number: inq.generated_po_number || null,
              stage: inq.status || 'new_inquiry',
            };
          }
          break;
        }
      }
    }
  }

  // 2b. Unscoped fallback by explicit cleanInqId or rawPo if not found yet
  if (!deal && (cleanInqId || rawPo)) {
    const { data: rawAllDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false })
      .limit(500);
    const allDeals = await filterRecordsToCallerScope(rawAllDeals, scope, { customerField: 'customer_name' });

    if (allDeals && allDeals.length > 0) {
      if (cleanInqId) {
        deal = allDeals.find(d => {
          const dId = (d.id || '').replace(/-/g, '').toUpperCase();
          const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
          return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
        }) || null;
      }
      if (!deal && rawPo) {
        deal = allDeals.find(d => {
          if (!d.po_number) return false;
          const dPo = String(d.po_number).trim();
          return dPo.toLowerCase() === rawPo.toLowerCase() || (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
        }) || null;
      }
      if (!deal && rawReferencePo) {
        deal = allDeals.find(d => String(d.reference_po_number || '').toLowerCase() === rawReferencePo.toLowerCase()) || null;
      }
    }

    if (!deal && cleanInqId) {
      const { data: rawAllInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, salesperson_phone, status, po_number, reference_po_number, generated_po_number, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(500);
      const allInqs = await filterRecordsToCallerScope(rawAllInqs, scope, { customerField: 'sender_name' });

      if (allInqs) {
        for (const inq of allInqs) {
          const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
          if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
            if (inq.deals && inq.deals.length > 0) {
              deal = inq.deals[0];
            } else {
              const inqJson = inq.ai_extraction_json || {};
              deal = {
                id: inq.id,
                inquiry_id: inq.id,
                customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                delivery_location: inqJson.delivery_location || inqJson.location || null,
                payment_terms: inqJson.payment_terms || null,
                po_number: rawPo || null,
                reference_po_number: inq.reference_po_number || null,
                generated_po_number: inq.generated_po_number || null,
                stage: inq.status || 'new_inquiry',
              };
            }
            break;
          }
        }
      }
    }
  }

  if (!deal) {
    if (rawInqId || rawPo) {
      delete draft.inquiry_id;
      delete draft.po_number;
      const ref = rawInqId ? `Inquiry ID "${rawInqId}"` : `PO Number "${rawPo}"`;
      const reply = `❌ *Order / Inquiry Not Found*\n\n` +
        `Could not find an order or inquiry matching ${ref} in your records.\n\n` +
        `Please verify the Inquiry ID or PO Number and try again.`;
      return {
        handled: true,
        reply,
        status: 'ID_NOT_FOUND',
        draft,
      };
    }
    const reply = `ℹ️ *No Orders or Inquiries Found for ${rawCompany || 'Customer'}*\n\n` +
      `Could not find any active orders or inquiries for *${rawCompany || 'Customer'}*.\n\n` +
      `Please check the customer name or provide the Inquiry ID / PO Number.`;
    return {
      handled: true,
      reply,
      status: 'NOT_FOUND',
      draft,
    };
  }

  // Bind matched deal
  draft.inquiry_id = deal.inquiry_id || deal.id;
  draft.company_name = deal.customer_name || draft.company_name;
  if (deal.po_number && !draft.po_number && !draft.updates?.po_number) {
    draft.po_number = deal.po_number;
  }

  const ordUpdates = draft.updates || {};
  const hasUpdates = Object.values(ordUpdates).some(v => v !== null && v !== undefined && v !== '') ||
                     Boolean(draft.po_date || draft.delivery_date || draft.delivery_location || draft.payment_terms || draft.status) ||
                     (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0);

  if (!hasUpdates) {
    let itemsListText = '';
    const items = Array.isArray(deal.deal_items) ? deal.deal_items : [];
    if (items.length > 0) {
      itemsListText = formatDetailedInquiryItemsList(items, { includeHsn: true });
    } else {
      itemsListText = `*${deal.product_summary || 'Steel Material'}*`;
    }
    let prompt = '';
    if (draft._permissionNotice) {
      prompt += `${draft._permissionNotice}\n\n`;
    }
    prompt += formatSelectedOrderPrompt(deal, itemsListText);

    return {
      handled: true,
      reply: prompt,
      status: 'ASK_DETAILS',
      draft,
    };
  }

  return {
    handled: false,
    status: 'READY',
    draft,
  };
}

// ── COMPLAINT LOOKUP & VALIDATION HELPER ──────────────────────────────────────

async function checkComplaintsForUpdate(action, draft, senderPhone, originalText = '') {
  if (action !== 'UPDATE_COMPLAINT') return { handled: false };

  const targetRef = (draft.linked_inquiry_or_po || draft.target_ref || draft.complaint_id || '').trim();
  const companyName = (draft.company_name || '').trim();
  const hasFilter = Boolean(targetRef || companyName);

  if (draft._complaint_verified && !originalText.match(/\b(?:CMP-[A-Z0-9]+|PO[-_:#\s]*[A-Za-z0-9_-]+)\b/i)) {
    return { handled: false, status: 'ALREADY_VERIFIED', draft };
  }

  if (!hasFilter) {
    const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
    const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
    const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

    let complaintsQuery = supabase
      .from('complaints')
      .select('*')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      complaintsQuery = complaintsQuery.in('reported_by', targetPhones);
    }

    const { data: allComplaints } = await complaintsQuery.limit(200);
    // Active only: same rule as the update-selection list (excludes Resolved / Closed / Cancelled)
    const complaints = (allComplaints || [])
      .filter(c => !['resolved', 'closed', 'cancelled'].includes(String(c.status || '').toLowerCase().trim()))
      .slice(0, 50);

    if (complaints.length === 0) {
      const reply = `ℹ️ *No Active Complaints Found*\n\nThere are no active customer complaints recorded in your portfolio.\n\nIf you would like to log a new complaint, reply with *8* or send the complaint details.`;
      return {
        handled: true,
        reply,
        status: 'NOT_FOUND',
        draft,
      };
    }

    if (complaints.length === 1) {
      const matchedCmp = complaints[0];
      draft.company_name = matchedCmp.customer_name;
      draft.complaint_id = matchedCmp.id;
      if (matchedCmp.po_number && !draft.linked_inquiry_or_po) {
        draft.linked_inquiry_or_po = matchedCmp.po_number;
      }
      const prompt = formatSelectedComplaintPrompt({
        ...matchedCmp,
        date_formatted: matchedCmp.complaint_date || formatDateDDMMYYYY(new Date(matchedCmp.created_at || Date.now())),
      });
      return {
        handled: true,
        reply: prompt,
        status: 'ASK_DETAILS',
        draft,
      };
    }

    const pageSize = 10;
    const page = Number(draft._complaint_candidates_page) || 1;
    const startIdx = (page - 1) * pageSize;
    const pageCmps = complaints.slice(startIdx, startIdx + pageSize);
    const totalPages = Math.ceil(complaints.length / pageSize);

    const choicesText = pageCmps.map((c, idx) => {
      const poStr = c.po_number ? ` (PO: ${c.po_number})` : '';
      const lines = [
        `${startIdx + idx + 1}. *Complaint #${c.id.slice(0, 8)}* (${c.customer_name || 'Customer'}${poStr}) — _${c.status || 'Open'}_`,
        `   • *Type:* ${c.complaint_type || 'Quality Defect'}`,
      ];
      if (c.description) {
        const cleanDesc = c.description.length > 70 ? `${c.description.slice(0, 67)}...` : c.description;
        lines.push(`   • *Description:* ${cleanDesc}`);
      }
      return lines.join('\n');
    }).join('\n\n');

    let headerText = `⚠️ *Recent Active Complaints (${complaints.length} Records):*`;
    if (complaints.length > pageSize) {
      headerText = `⚠️ *Showing ${startIdx + 1}–${startIdx + pageCmps.length} of ${complaints.length} Active Complaints (Page ${page} of ${totalPages}):*`;
    }

    let footerText = `👉 Reply with the *Option Number* (1–${complaints.length}), *Customer Name*, *PO Number*, or what you want to update.`;
    if (totalPages > 1) {
      footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
    }

    const prompt = `${headerText}\n\n` +
      `Please choose which complaint you want to update:\n\n` +
      `${choicesText}\n\n` +
      `${footerText}`;

    draft._complaint_candidates = pageCmps;
    draft._all_complaint_candidates = complaints;
    draft._complaint_candidates_page = page;

    return {
      handled: true,
      status: 'MULTIPLE_COMPLAINTS',
      reply: prompt,
      draft,
    };
  }

  // Customer named without a specific complaint / PO: ask when the customer has several open complaints
  if (companyName && !draft.complaint_id && !draft.linked_inquiry_or_po && !draft.target_ref) {
    const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
    const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
    const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));
    let custCmpQuery = supabase
      .from('complaints')
      .select('*')
      .order('created_at', { ascending: false });
    if (!scope.isAdmin && targetPhones.length > 0) {
      custCmpQuery = custCmpQuery.in('reported_by', targetPhones);
    }
    const { data: scopedCmps } = await custCmpQuery.limit(100);
    const cleanCust = companyName.toLowerCase();
    const openCustCmps = (scopedCmps || []).filter(c => {
      const cName = String(c.customer_name || '').toLowerCase().trim();
      if (!cName || !(cName.includes(cleanCust) || cleanCust.includes(cName))) return false;
      return ['open', 'pending', 'reported', 'in progress', 'reopened'].includes(String(c.status || '').toLowerCase());
    });

    if (openCustCmps.length > 1) {
      const pageSize = 10;
      const pageCmps = openCustCmps.slice(0, pageSize);
      const totalPages = Math.ceil(openCustCmps.length / pageSize);
      const choicesText = pageCmps.map((c, idx) => {
        const poStr = c.po_number ? ` (PO: ${c.po_number})` : '';
        const when = c.complaint_date || c.reported_at || c.created_at;
        const dateStr = when ? ` — ${formatDateDDMMYYYY(new Date(when))}` : '';
        const lines = [
          `${idx + 1}. *Complaint #${c.id.slice(0, 8)}* (${c.customer_name || 'Customer'}${poStr}) — _${c.status || 'Open'}_${dateStr}`,
          `   • *Type:* ${c.complaint_type || 'Quality Defect'}`,
        ];
        if (c.description) {
          const cleanDesc = c.description.length > 70 ? `${c.description.slice(0, 67)}...` : c.description;
          lines.push(`   • *Description:* ${cleanDesc}`);
        }
        return lines.join('\n');
      }).join('\n\n');

      let footerText = `👉 Reply with the *Option Number* (1–${openCustCmps.length}) or *PO Number* of the complaint you want to update.`;
      if (totalPages > 1) {
        footerText += `\n💡 _Type "View More" or "Next" to see next records._`;
      }
      const prompt = `⚠️ *${openCustCmps.length} Open Complaints Found for ${companyName}:*\n\n` +
        `Please choose which complaint you want to update:\n\n` +
        `${choicesText}\n\n` +
        `${footerText}`;

      draft._complaint_candidates = pageCmps;
      draft._all_complaint_candidates = openCustCmps;
      draft._complaint_candidates_page = 1;

      return {
        handled: true,
        status: 'MULTIPLE_COMPLAINTS',
        reply: prompt,
        draft,
      };
    }
  }

  const matchedCmp = await findAndMatchComplaint(draft, senderPhone);

  if (!matchedCmp) {
    const refDisplay = targetRef ? `"${targetRef}"` : (companyName ? `"${companyName}"` : 'the specified reference');
    delete draft.linked_inquiry_or_po;
    delete draft.complaint_id;
    const reply = `⚠️ *No Active Complaint Found for ${refDisplay}*\n\n` +
      `Could not find an active complaint matching ${refDisplay} in your records.\n\n` +
      `Please check the Customer Name, PO Number, or Inquiry ID and try again.`;
    return {
      handled: true,
      reply,
      status: 'NOT_FOUND',
      draft,
    };
  }

  draft.company_name = matchedCmp.customer_name;
  draft.complaint_id = matchedCmp.id;
  if (matchedCmp.po_number && !draft.linked_inquiry_or_po) {
    draft.linked_inquiry_or_po = matchedCmp.po_number;
  }

  const cmpUpdates = draft.updates || {};
  const hasUpdates = Object.values(cmpUpdates).some(v => v !== null && v !== undefined && v !== '');

  if (!hasUpdates) {
    const prompt = `✏️ *Active Complaint Found for ${matchedCmp.customer_name}:*\n\n` +
      (matchedCmp.po_number ? `• *Linked Order / Ref:* PO: ${matchedCmp.po_number}\n` : '') +
      `• *Complaint Type:* ${matchedCmp.complaint_type || 'Quality Defect'}\n` +
      `• *Status:* ${matchedCmp.status || 'Open'}\n` +
      `• *Description:* ${matchedCmp.description || 'N/A'}\n\n` +
      `What details would you like to update?\n` +
      `_(e.g. "Mark as Resolved", "Update type to Specification Mismatch", "Add resolution notes: Replaced 2 MT coils")_`;

    return {
      handled: true,
      reply: prompt,
      status: 'ASK_DETAILS',
      draft,
    };
  }

  return {
    handled: false,
    status: 'READY',
    draft,
  };
}

// ── BUILD CONFIRMATION SUMMARY ───────────────────────────────────────────────

function buildConfirmationSummary(action, draft) {
  const indexTag = draft._totalCount && draft._totalCount > 1 ? ` (${draft._currentIndex || 1} of ${draft._totalCount}: ${draft.company_name || 'Item'})` : '';
  let summary = '';
  if (draft._permissionNotice) {
    summary += `${draft._permissionNotice}\n\n`;
  }
  summary += `✅ *Here's what I've captured${indexTag}:*\n\n`;

  switch (action) {
    case 'LOG_INQUIRY': {
      const displayItems = (draft.line_items || []).map((item) => ({ ...item, rate: null, amount: null }));
      const target = customerTargetNote({ ...draft, additional_notes: '' });
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *Email ID:* ${draft.email || '-'}\n`;
      if (displayItems.length > 0) {
        if (displayItems.length === 1) {
          summary += `• *Product:* ${formatDetailedInquiryItemsList(displayItems)}\n`;
        } else {
          summary += `• *Line Items:*\n${formatDetailedInquiryItemsList(displayItems).split('\n').map(l => `  ${l}`).join('\n')}\n`;
        }
      } else {
        summary += `• *Product:* ${draft.product_description || '-'}\n`;
      }
      summary += `• *Preferred Make:* ${draft.preferred_make || '-'}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms || '-'}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location || '-'}\n`;
      summary += `• *Additional Notes:* ${draft.additional_notes || '-'}\n`;
      if (target) summary += `• *${target}*\n`;
      summary += `• *Pricing:* Base price is still waiting with procurement.\n`;
      break;
    }

    case 'UPDATE_INQUIRY': {
      const displayId = draft._inquiry_display_id || (draft.inquiry_id ? (draft.inquiry_id.startsWith('INQ-') ? draft.inquiry_id : `INQ-${draft.inquiry_id.slice(0, 6).toUpperCase()}`) : 'Inquiry');
      summary += `• *Inquiry ID:* ${displayId}\n`;
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      const hasHeaderUpdates = draft.updates && Object.values(draft.updates).some(v => v !== null && v !== undefined && v !== '');
      if (hasHeaderUpdates) {
        summary += `• *Updating Fields:*\n`;
        for (const [k, v] of Object.entries(draft.updates || {})) {
          if (v) {
            const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const valStr = k.toLowerCase().includes('rate') ? `₹${Number(String(v).replace(/[^\d.]/g, '')).toLocaleString('en-IN')} / MT` : v;
            summary += `  • *${label}* → ${valStr}\n`;
          }
        }
      }
      if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
        summary += `• *Updating Products / Rates:*\n`;
        const existingInqItems = Array.isArray(draft.existing_items) ? draft.existing_items : [];
        draft.line_item_updates.forEach((it, i) => {
          if (it && String(it.operation || '').toLowerCase() === 'add') {
            const addName = it.sku_text || it.description || 'New item';
            const addSpec = it.spec || it.dimensions || '';
            const addQty = (it.quantity !== null && it.quantity !== undefined && it.quantity !== '') ? `Qty: ${it.quantity} ${it.unit || 'MT'}` : '';
            summary += `  • *Add* ${addName}${addSpec ? ` (${addSpec})` : ''}${addQty ? ` → ${addQty}` : ''}\n`;
            return;
          }
          if (it && String(it.operation || '').toLowerCase() === 'replace' && it.replace_source) {
            const newName = it.sku_text || it.description || 'New item';
            const newSpec = it.spec || it.dimensions || '';
            const newQty = (it.quantity !== null && it.quantity !== undefined && it.quantity !== '') ? ` | ${it.quantity} ${it.unit || 'MT'}` : '';
            summary += `  • *${it.replace_source}* → *${newName}*${newSpec ? ` (${newSpec})` : ''}${newQty}\n`;
            return;
          }
          const targets = Array.isArray(it._target_indexes)
            ? it._target_indexes.map(idx => existingInqItems[idx]).filter(Boolean)
            : (existingInqItems.length === 1 ? [existingInqItems[0]] : []);
          const hasValue = (v) => v !== null && v !== undefined && v !== '';
          const renderLine = (name, unit, oldSpec = null, newSpec = null) => {
            const parts = [];
            if (hasValue(it.quantity)) parts.push(`Qty: ${it.quantity} ${unit}`);
            if (hasValue(it.rate)) parts.push(`Rate: ₹${(parseIndianAmount(it.rate) ?? 0).toLocaleString('en-IN')}/${unit}`);
            if (parts.length > 0) {
              summary += `  • *${name}* → ${parts.join(' | ')}\n`;
            } else if (newSpec && (!oldSpec || newSpec.toLowerCase() !== oldSpec.toLowerCase())) {
              summary += `  • *${name}* → Spec: ${newSpec}\n`;
            } else {
              summary += `  • *${name}*\n`;
            }
          };
          if (targets.length > 0) {
            targets.forEach(target => {
              const baseName = target.sku_text || target.description || it.sku_text || it.description || `Item ${i + 1}`;
              const oldSpec = target.dimensions || target.spec || '';
              const newSpec = it.dimensions || it.spec || '';

              let displayName = baseName;
              if (oldSpec && displayName.toLowerCase().includes(oldSpec.toLowerCase())) {
                const regex = new RegExp(`\\s*\\(?\\s*${oldSpec.replace('.', '\\.')}\\s*\\)?`, 'gi');
                displayName = displayName.replace(regex, '').trim();
              }

              if (newSpec && oldSpec && newSpec.toLowerCase() !== oldSpec.toLowerCase()) {
                displayName = `${displayName} (${oldSpec} → ${newSpec})`;
              } else if (newSpec) {
                displayName = `${displayName} (${newSpec})`;
              } else if (oldSpec) {
                displayName = `${displayName} (${oldSpec})`;
              }

              renderLine(displayName, target.unit || it.unit || 'MT', oldSpec, newSpec);
            });
          } else {
            const baseName = it.sku_text || it.description || `Item ${i + 1}`;
            const newSpec = it.dimensions || it.spec || '';
            const displayName = newSpec ? `${baseName} (${newSpec})` : baseName;
            renderLine(displayName, it.unit || 'MT', null, newSpec);
          }
        });
      }
      break;
    }

    case 'LOG_ORDER': {
      if (draft.inquiry_id) {
        const cleanDisplayInq = draft.inquiry_id.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        summary += `• *Inquiry ID:* INQ-${cleanDisplayInq}\n`;
      }
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *PO Number:* ${draft.po_number || '-'}\n`;
      if (draft.reference_po_number) {
        summary += `• *Reference PO:* ${draft.reference_po_number}\n`;
      }
      summary += `• *PO Date:* ${draft.po_date || '-'}\n`;
      summary += `• *Delivery Location:* ${draft.delivery_location || '-'}\n`;
      summary += `• *Payment Terms:* ${draft.payment_terms || '-'}\n`;
      let subtotal = 0;
      let totalTonnage = 0;
      let primaryUnit = 'MT';
      if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
        draft.line_items.forEach((it) => {
          const qty = Number(it.quantity) || 0;
          const rate = Number(it.rate) || 0;
          const amount = Number(it.amount) || qty * rate;
          subtotal += amount;
          totalTonnage += qty;
          primaryUnit = it.unit || 'MT';
        });
        if (draft.line_items.length === 1) {
          summary += `• *Product:* ${formatDetailedInquiryItemsList(draft.line_items)}\n`;
        } else {
          summary += `• *Line Items:*\n${formatDetailedInquiryItemsList(draft.line_items).split('\n').map(l => `  ${l}`).join('\n')}\n`;
        }
      }
      if (totalTonnage > 0) {
        summary += `• *Total Tonnage:* ${formatLineItemsTonnage(draft.line_items) || `${totalTonnage.toLocaleString('en-IN')} ${primaryUnit}`}\n`;
      }
      const breakdown = calculateQuotationBreakdown(subtotal);
      summary += `• *Sub Total:* ₹${breakdown.formattedSubtotal}\n`;
      summary += `• *GST (18%):* ₹${breakdown.formattedGST}\n`;
      summary += `• *Total Order Value:* ${breakdown.formattedGrandTotal}\n`;
      break;
    }

    case 'UPDATE_ORDER': {
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      const poToDisplay = draft.updates?.po_number || draft.po_number;
      if (poToDisplay) {
        summary += `• *PO Number:* ${poToDisplay}\n`;
      }
      if (draft.inquiry_id) {
        const cleanDisplayInq = draft.inquiry_id.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        summary += `• *Inquiry ID:* INQ-${cleanDisplayInq}\n`;
      }
      if (draft.updates && Object.keys(draft.updates).length > 0) {
        const headerEntries = Object.entries(draft.updates).filter(([k, v]) => v && k !== 'po_number' && k !== 'company_name' && k !== 'rate' && k !== 'quantity');
        if (headerEntries.length > 0) {
          summary += `• *Header Updates:*\n`;
          for (const [k, v] of headerEntries) {
            const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            summary += `  • *${label}* → ${v}\n`;
          }
        }
      }

      const existingItems = Array.isArray(draft.existing_items) ? draft.existing_items : [];
      const lineUpdates = Array.isArray(draft.line_item_updates) ? draft.line_item_updates : [];

      if (existingItems.length > 0) {
        summary += `• *Updated Line Items:*\n`;
        let subtotal = 0;
        const mappedItems = existingItems.map((item, idx) => {
          const matchedUpd = matchLineItemUpdate(item, idx, existingItems.length, lineUpdates);

          let itQty = Number(item.quantity) || 0;
          let itRate = Number(item.rate) || 0;
          let itUnit = item.unit || 'MT';
          let itDim = item.dimensions || item.spec || null;
          let itSku = item.sku_text || item.description || 'Steel Material';

          if (matchedUpd) {
            if (matchedUpd.quantity !== null && matchedUpd.quantity !== undefined && matchedUpd.quantity !== '') {
              itQty = parseNumericValue(matchedUpd.quantity) ?? itQty;
            }
            if (matchedUpd.rate !== null && matchedUpd.rate !== undefined && matchedUpd.rate !== '') {
              itRate = parseIndianAmount(matchedUpd.rate) ?? itRate;
            }
            if (matchedUpd.unit) itUnit = matchedUpd.unit;
            const newDim = matchedUpd.dimensions || matchedUpd.spec;
            if (newDim !== null && newDim !== undefined && String(newDim).trim() !== '') {
              itDim = String(newDim).trim();
            }
            if (matchedUpd.sku_text && !isGenericLineUpdateRef(matchedUpd.sku_text)) {
              itSku = matchedUpd.sku_text;
            } else if (matchedUpd.description && !isGenericLineUpdateRef(matchedUpd.description)) {
              itSku = matchedUpd.description;
            }
            if (String(matchedUpd.operation || '').toLowerCase() === 'replace' && matchedUpd.replace_source) {
              itSku = `${matchedUpd.replace_source} → ${itSku}`;
            }
          }
          const itAmt = itQty * itRate;
          subtotal += itAmt;
          return {
            ...item,
            sku_text: itSku,
            description: itSku,
            quantity: itQty,
            rate: itRate,
            unit: itUnit,
            dimensions: itDim,
            spec: itDim,
            amount: itAmt,
          };
        });

        summary += `${formatDetailedInquiryItemsList(mappedItems).split('\n').map(l => `  ${l}`).join('\n')}\n`;

        const addUpdates = lineUpdates.filter(u => u && /^(?:add|insert|new)$/i.test(String(u.operation || '')));
        for (const addUpd of addUpdates) {
          const addQty = Number(addUpd.quantity) || 0;
          const addRate = Number(addUpd.rate) || 0;
          subtotal += addQty > 0 && addRate > 0 ? addQty * addRate : 0;
          const addSpec = addUpd.spec || addUpd.dimensions || '';
          const addQtyText = (addUpd.quantity !== null && addUpd.quantity !== undefined && addUpd.quantity !== '') ? ` | ${addUpd.quantity} ${addUpd.unit || 'MT'}` : '';
          summary += `  • *Add:* ${addUpd.sku_text || addUpd.description || 'New item'}${addSpec ? ` (${addSpec})` : ''}${addQtyText}\n`;
        }

        if (subtotal > 0) {
          const gst = Math.round(subtotal * 0.18);
          const grandTotal = subtotal + gst;
          summary += `• *Subtotal:* ₹${subtotal.toLocaleString('en-IN')}\n`;
          summary += `• *GST (18%):* ₹${gst.toLocaleString('en-IN')}\n`;
          summary += `• *New Total Order Value:* ₹${grandTotal.toLocaleString('en-IN')}\n`;
        }
      } else if (lineUpdates.length > 0) {
        summary += `• *Line Item Updates:*\n`;
        lineUpdates.forEach((liu, idx) => {
          summary += `  ${idx + 1}. *${liu.item_reference || liu.description || 'Line Item'}* — Qty ${liu.quantity || '-'} ${liu.unit || 'MT'}, Rate ₹${liu.rate || '-'}\n`;
        });
      }
      break;
    }

    case 'LOG_VISIT': {
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *Person Met:* ${draft.person_met || '-'}\n`;
      summary += `• *Contact Phone:* ${draft.contact_phone || '-'}\n`;
      summary += `• *City / Location:* ${draft.city_location || '-'}\n`;
      summary += `• *Visit Date:* ${draft.visit_date || '-'}\n`;
      summary += `• *Visit Outcome:* ${draft.visit_outcome || '-'}\n`;
      if (draft.followup_action) {
        summary += `• *Follow-up Action:* ${draft.followup_action}\n`;
        const visitBaseDate = draft.visit_date || draft.visited_at || new Date();
        const parsedFuDate = extractFollowUpDate(draft.followup_action, visitBaseDate);
        if (parsedFuDate) {
          summary += `• *Follow-up Date:* ${formatDateDDMMYYYY(new Date(parsedFuDate))}\n`;
        }
        summary += `• *Follow-up Status:* Pending\n`;
      }
      summary += `• *Meeting Remarks:* ${draft.meeting_remarks || '-'}\n`;
      if (draft.designation) summary += `• *Designation:* ${draft.designation}\n`;
      if (draft.email) summary += `• *Email:* ${draft.email}\n`;
      if (draft.customer_type) summary += `• *Customer Type:* ${draft.customer_type}\n`;
      if (draft.visit_type) summary += `• *Visit Type:* ${draft.visit_type}\n`;
      if (draft.customer_probability) summary += `• *Customer Probability:* ${draft.customer_probability}\n`;
      if (draft.product_details) summary += `• *Product Details:* ${draft.product_details}\n`;
      if (draft.monthly_consumption) summary += `• *Monthly Consumption:* ${draft.monthly_consumption}\n`;
      if (draft.current_requirement) summary += `• *Current Requirement:* ${draft.current_requirement}\n`;
      if (draft.next_purchase_expected) summary += `• *Next Purchase Expected:* ${draft.next_purchase_expected}\n`;
      if (draft.delivery_location) summary += `• *Delivery Location:* ${draft.delivery_location}\n`;
      if (draft.preferred_make) summary += `• *Preferred Make:* ${draft.preferred_make}\n`;
      if (draft.preferred_make_other) summary += `• *Other Brand:* ${draft.preferred_make_other}\n`;
      if (draft.payment_terms) summary += `• *Payment Terms:* ${draft.payment_terms}\n`;
      if (draft.follow_up_date) summary += `• *Follow-up Date:* ${draft.follow_up_date}\n`;
      if (Array.isArray(draft.attachments) && draft.attachments.length > 0) {
        const photoCount = draft.attachments.length;
        summary += `• *Photos Attached:* ${photoCount} ${photoCount === 1 ? 'geotagged site photo' : 'geotagged site photos'}\n`;
      } else if (draft.gps_photo_url) {
        summary += `• *Photos Attached:* 1 geotagged site photo\n`;
      }
      if (typeof draft.gps_latitude === 'number' && typeof draft.gps_longitude === 'number') {
        const accTag = draft.gps_accuracy ? ` (±${Math.round(draft.gps_accuracy)}m)` : '';
        summary += `• *GPS Tag:* ${draft.gps_latitude.toFixed(6)}, ${draft.gps_longitude.toFixed(6)}${accTag}\n`;
      }
      break;
    }

    case 'UPDATE_VISIT': {
      const targetVis = draft.visit_id ? `${draft.company_name ? `${draft.company_name} ` : ''}(#${draft.visit_id.slice(0, 8)})` : `${draft.company_name}${draft.visit_date ? ` (Visit Date: ${draft.visit_date})` : ''}`;
      summary += `• *Customer / Company:* ${targetVis}\n`;
      summary += `• *Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (k === 'new_attachments' || k === 'attachments') {
          if (Array.isArray(v) && v.length > 0) {
            summary += `  • *New Photos Added* → ${v.length} additional photo(s)\n`;
          }
        } else if (k === 'gps_photo_url' || k === 'gps_latitude' || k === 'gps_longitude' || k === 'gps_accuracy') {
          // Handled separately below
        } else if (k === 'followup_action' || k === 'follow_up_action') {
          if (v) {
            summary += `  • *Follow-up Action* → ${v}\n`;
            const visitBaseDate = draft.updates?.visit_date || draft.visit_date || draft.visited_at || new Date();
            const parsedFuDate = extractFollowUpDate(v, visitBaseDate);
            if (parsedFuDate) {
              summary += `  • *Follow-up Date* → ${formatDateDDMMYYYY(new Date(parsedFuDate))}\n`;
            }
            summary += `  • *Follow-up Status* → Pending\n`;
          }
        } else if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `  • *${label}* → ${v}\n`;
        }
      }
      const updLat = draft.updates?.gps_latitude ?? draft.gps_latitude;
      const updLng = draft.updates?.gps_longitude ?? draft.gps_longitude;
      const updAcc = draft.updates?.gps_accuracy ?? draft.gps_accuracy;
      if (typeof updLat === 'number' && typeof updLng === 'number') {
        const accTag = updAcc ? ` (±${Math.round(updAcc)}m)` : '';
        summary += `  • *GPS Tag* → ${updLat.toFixed(6)}, ${updLng.toFixed(6)}${accTag}\n`;
      }
      break;
    }

    case 'LOG_NEW_CUSTOMER': {
      summary += `• *Company Name:* ${draft.company_name || '-'}\n`;
      summary += `• *Contact Person:* ${draft.contact_person || '-'}\n`;
      const phoneVal = draft.mobile_number || draft.phone || draft.contact_phone || '-';
      summary += `• *Mobile Number:* ${phoneVal}\n`;
      const locVal = draft.delivery_location || draft.city_location || draft.address || '-';
      summary += `• *Delivery Location:* ${locVal}\n`;
      summary += `• *Email:* ${draft.email || '-'}\n`;
      const gstVal = draft.gst_number || draft.gst || '-';
      summary += `• *GST Number:* ${gstVal}\n`;
      break;
    }

    case 'LOG_COMPLAINT': {
      const attCount = Array.isArray(draft.attachments) ? draft.attachments.length : 0;
      summary += `• *Customer / Company:* ${draft.company_name || '-'}\n`;
      summary += `• *Complaint Date:* ${draft.complaint_date || formatDateDDMMYYYY(new Date())}\n`;
      summary += `• *Complaint Raised By:* ${draft.raised_by || draft.contact_person || draft.person_met || '-'}\n`;
      const isUnlinkedCmp = !draft.linked_inquiry_or_po && !draft.po_number && !draft.deal_id &&
        draft._unlinked_complaint && draft._unlinked_complaint_customer === String(draft.company_name || '').trim().toLowerCase();
      if (isUnlinkedCmp) {
        summary += `• *Linked Order / Ref:* Not linked (no confirmed order found for this customer — will be logged as a general complaint${draft._unverified_order_ref ? `; "${draft._unverified_order_ref}" not found` : ''})\n`;
      } else {
        summary += `• *Linked Order / Ref:* ${draft.linked_inquiry_or_po || (draft.po_number ? `PO: ${draft.po_number}` : '-')}\n`;
      }
      summary += `• *Product / Material:* ${draft.affected_product || draft.product_name || '-'}\n`;
      summary += `• *Complaint Type:* ${draft.complaint_type || 'Quality Defect'}\n`;
      if (draft.challan_no) {
        summary += `• *Invoice / Challan No.:* ${draft.challan_no}\n`;
      }
      summary += `• *Description:* ${draft.complaint_description || draft.description || draft.affected_product || '-'}\n`;
      if (attCount > 0) {
        summary += `• *Evidence:* ${attCount} file(s) attached\n`;
      }
      if (draft.corrective_action) {
        summary += `• *Corrective Action:* ${draft.corrective_action}\n`;
      }
      if (draft.customer_communication) {
        summary += `• *Customer Communication:* ${draft.customer_communication}\n`;
      }
      if (draft.resolution_notes) {
        summary += `• *Resolution Notes:* ${draft.resolution_notes}\n`;
      }
      if (draft.resolution_date) {
        summary += `• *Resolution Date:* ${draft.resolution_date}\n`;
      }
      summary += `• *Status:* Open (48-Hour SLA Clock Started)\n`;
      break;
    }

    case 'UPDATE_COMPLAINT': {
      const targetCmp = draft.linked_inquiry_or_po || draft.complaint_id || 'Active Complaint';
      if (draft.company_name) {
        summary += `• *Customer / Company:* ${draft.company_name}\n`;
      }
      if (draft.linked_inquiry_or_po) {
        summary += `• *Linked Order / Ref:* ${targetCmp}\n`;
      }
      summary += `• *Updating Fields:*\n`;
      for (const [k, v] of Object.entries(draft.updates || {})) {
        if (v) {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          summary += `  • *${label}* → ${v}\n`;
        }
      }
      if (Array.isArray(draft._locked_complaint_update_fields) && draft._locked_complaint_update_fields.length > 0) {
        summary += `\n⚠️ *Permission Notice:* You are not allowed to edit these fields after a complaint is logged: *${draft._locked_complaint_update_fields.join(', ')}*.\n` +
          `Only Complaint Raised By, Complaint Type, Complaint Description, Status, and Resolution Notes can be updated.\n`;
      }
      break;
    }
  }

  return summary;
}

// ── COMPLAINT RESOLUTION HELPERS ─────────────────────────────────────────────

function normalizeComplaintType(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return 'Quality Defect';
  const t = typeStr.trim().toLowerCase();
  if (t.includes('spec') || t.includes('mismatch')) return 'Specification Mismatch';
  if (t.includes('damage') || t.includes('physical') || t.includes('broken') || t.includes('crack') || t.includes('bend')) return 'Physical Damage';
  if (t.includes('short') || t.includes('qty') || t.includes('quantity') || t.includes('kam')) return 'Quantity Shortage';
  if (t.includes('delay') || t.includes('late') || t.includes('delivery')) return 'Delivery Delay';
  if (t.includes('bill') || t.includes('invoice') || t.includes('price') || t.includes('rate') || t.includes('amount')) return 'Billing Mismatch';
  if (t.includes('quality') || t.includes('rust') || t.includes('defect') || t.includes('reject')) return 'Quality Defect';
  if (t.includes('other')) return 'Other';
  return typeStr.trim().replace(/\b\w/g, l => l.toUpperCase());
}

function extractProductFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const str = text.trim();

  // Pattern 1: e.g. "12 MT MS angle", "15 MT CR Sheet 1.20mm", "10 MT HR Coil", "60 MT MS plates"
  const m1 = str.match(/(?:(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?|bundle|bundles))\s+)?\b(MS\s+Plates?|MS\s+Sheets?|HR\s+Coils?|HR\s+Sheets?|CR\s+Coils?|CR\s+Sheets?|TMT\s+Bars?|GI\s+Sheets?|GI\s+Coils?|GP\s+Sheets?|GP\s+Coils?|Chequered\s+Plates?|MS\s+Pipes?|Seamless\s+Pipes?|ERW\s+Pipes?|MS\s+Angles?|MS\s+Channels?|MS\s+Beams?|MS\s+Flats?|MS\s+Rounds?|Square\s+Bars?|Beams?|Channels?|Angles?|Flats?|Rounds?|Alloy\s+Steel|Stainless\s+Steel|IS\s+2062(?:\s+E250)?)\b(?:\s+([0-9.]+\s*mm(?:(?:\s*x\s*[0-9.]+\s*mm)+)?))?(?:\s+(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?)))?/i);
  if (m1) {
    const qty = (m1[1] || m1[4] || '').trim();
    const prod = m1[2].trim();
    const dims = (m1[3] || '').trim();
    let res = prod;
    if (dims) res += ` ${dims}`;
    if (qty) res += ` (${qty})`;
    return res;
  }

  // Pattern 2: e.g. "MS Plate", "HR Coil", "CR Sheet", "MS Angle", "Chequered Plate"
  const m2 = str.match(/\b(MS\s+Plate|MS\s+Plates|MS\s+Sheet|MS\s+Sheets|HR\s+Coil|HR\s+Coils|HR\s+Sheet|HR\s+Sheets|CR\s+Coil|CR\s+Coils|CR\s+Sheet|CR\s+Sheets|TMT\s+Bar|TMT\s+Bars|GI\s+Sheet|GI\s+Sheets|GI\s+Coil|GI\s+Coils|Chequered\s+Plate|Chequered\s+Plates|MS\s+Pipe|MS\s+Pipes|MS\s+Angle|MS\s+Angles|MS\s+Channel|MS\s+Channels|MS\s+Beam|MS\s+Beams)\b/i);
  if (m2) {
    return m2[1];
  }

  return null;
}

async function findAndMatchComplaint(draft, senderPhone) {
  const targetRef = (draft.linked_inquiry_or_po || draft.target_ref || draft.complaint_id || '').trim();
  const companyName = (draft.company_name || '').trim();

  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let complaintsQuery = supabase
    .from('complaints')
    .select('*')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    complaintsQuery = complaintsQuery.in('reported_by', targetPhones);
  }

  const { data: allComplaints } = await complaintsQuery.limit(100);

  if (!allComplaints || allComplaints.length === 0) return null;

  // 0. A complaint already picked by id wins over PO / customer matching (several complaints can share a PO)
  if (draft.complaint_id) {
    const exactIdMatch = allComplaints.find(c => c.id === draft.complaint_id);
    if (exactIdMatch) return exactIdMatch;
  }

  // 1. Direct match by targetRef (PO Number, Inquiry ID / Deal ID, or Complaint UUID)
  if (targetRef) {
    const cleanRef = targetRef.replace(/^#?(?:INQ|DEAL|PO)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    // Direct check on complaints table
    const directMatch = allComplaints.find(c => {
      const cId = (c.id || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const po = (c.po_number || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const dealId = (c.deal_id || '').replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const cust = (c.customer_name || '').toLowerCase();

      return (
        (cleanRef.length >= 4 && cId.startsWith(cleanRef)) ||
        (cleanRef.length >= 2 && po.includes(cleanRef)) ||
        (cleanRef.length >= 2 && dealId.includes(cleanRef)) ||
        (cleanRef.length >= 3 && cust.includes(cleanRef))
      );
    });

    if (directMatch) return directMatch;

    // Lookup deals table if cleanRef matches a deal ID or PO
    try {
      let dealsQuery = supabase
        .from('deals')
        .select('id, po_number, customer_name, salesperson_phone');

      if (!scope.isAdmin && targetPhones.length > 0) {
        dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
      }

      const { data: deals } = await dealsQuery.limit(100);

      const matchedDeal = deals?.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toLowerCase();
        const dPo = (d.po_number || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        return (cleanRef.length >= 3 && dId.startsWith(cleanRef)) || (cleanRef.length >= 3 && dPo.includes(cleanRef));
      });

      if (matchedDeal) {
        const dealMatch = allComplaints.find(c =>
          (c.deal_id && (c.deal_id === matchedDeal.id || c.deal_id.toLowerCase().includes(matchedDeal.id.toLowerCase()))) ||
          (c.po_number && matchedDeal.po_number && c.po_number.toLowerCase().includes(matchedDeal.po_number.toLowerCase())) ||
          (c.customer_name && matchedDeal.customer_name && c.customer_name.toLowerCase().includes(matchedDeal.customer_name.toLowerCase()))
        );
        if (dealMatch) return dealMatch;
      }
    } catch (e) {
      console.warn('[CatalogFlow] Error in deal lookup for complaint:', e.message);
    }
  }

  // 2. Match by companyName
  if (companyName) {
    const cleanCust = companyName.toLowerCase();
    const custMatches = allComplaints.filter(c =>
      (c.customer_name || '').toLowerCase().includes(cleanCust) ||
      cleanCust.includes((c.customer_name || '').toLowerCase())
    );

    if (custMatches.length > 0) {
      const openMatch = custMatches.find(c =>
        ['open', 'pending', 'reported', 'in progress', 'reopened'].includes((c.status || '').toLowerCase())
      );
      return openMatch || custMatches[0];
    }
  }

  // 3. Unscoped fallback by targetRef (PO Number, Inquiry ID / Deal ID, or Complaint UUID)
  if (targetRef && !scope.isAdmin) {
    try {
      const { data: rawUnscopedComplaints } = await supabase
        .from('complaints')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      const unscopedComplaints = await filterRecordsToCallerScope(rawUnscopedComplaints, scope, { phoneField: 'reported_by', customerField: 'customer_name' });

      if (unscopedComplaints && unscopedComplaints.length > 0) {
        const cleanRef = targetRef.replace(/^#?(?:INQ|DEAL|PO)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const unscopedMatch = unscopedComplaints.find(c => {
          const cId = (c.id || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const po = (c.po_number || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const dealId = (c.deal_id || '').replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const cust = (c.customer_name || '').toLowerCase();

          return (
            (cleanRef.length >= 4 && cId.startsWith(cleanRef)) ||
            (cleanRef.length >= 2 && po.includes(cleanRef)) ||
            (cleanRef.length >= 2 && dealId.includes(cleanRef)) ||
            (cleanRef.length >= 3 && cust.includes(cleanRef))
          );
        });

        if (unscopedMatch) return unscopedMatch;
      }
    } catch (e) {
      console.warn('[CatalogFlow] Error in unscoped complaint fallback:', e.message);
    }
  }

  return null;
}

// ── EXECUTE ACTION HANDLERS ──────────────────────────────────────────────────

async function executeAction(action, draft, senderPhone) {
  try {
    const { denialReply } = require('../utils/permissions');
    const denied = await denialReply(senderPhone, action);
    if (denied) {
      return denied;
    }
    switch (action) {
      case 'LOG_INQUIRY': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          city: draft.delivery_location || null,
        });

        const totalAmount = 0;
        const notesWithTarget = customerTargetNote(draft);

        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const calc = calculateLineItem({ ...it, rate: null, amount: null });
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const hCode = resolveProductHsnOrEmpty(sText || it.description || '', sDim, it.hsn_code || it.hsn_sac, draft);
              const itQty = calc.quantity || Number(it.quantity) || 0;
              return {
                sku_text: sText,
                description: it.description || sText,
                dimensions: sDim,
                spec: sDim,
                grade: it.grade || null,
                hsn_code: hCode,
                hsn_sac: hCode,
                quantity: itQty,
                unit: calc.unit || it.unit || 'MT',
                rate: null,
                amount: null,
              };
            })
          : [
              {
                sku_text: draft.product_description || 'Hot Rolled',
                description: draft.product_description || 'Hot Rolled',
                dimensions: '',
                spec: '',
                hsn_code: resolveProductHsnOrEmpty(draft.product_description || '', '', '', draft),
                hsn_sac: resolveProductHsnOrEmpty(draft.product_description || '', '', '', draft),
                quantity: 0,
                unit: 'MT',
                rate: null,
                amount: null,
              }
            ];

        const structuredAiJson = {
          customer: {
            name: companyName,
            phone: null,
            email: draft.email || null,
            address: draft.delivery_location || null,
            match_status: 'matched',
          },
          customer_name: companyName,
          companyName: companyName,
          customer_email: draft.email || null,
          customerEmail: draft.email || null,
          delivery_location: draft.delivery_location || null,
          delivery_address: draft.delivery_location || null,
          payment_terms: draft.payment_terms || null,
          preferred_make: draft.preferred_make || null,
          additional_notes: notesWithTarget || null,
          rate: null,
          unitPrice: null,
          total_amount: null,
          totalAmount: null,
          po_number: draft.po_number || null,
          reference_po_number: draft.reference_po_number || null,
          generated_po_number: draft.generated_po_number || null,
          po_source: draft.po_source || null,
          po_status: 'confirmed',
          product_requirement: draft.product_description || (structuredLineItems[0] ? structuredLineItems[0].sku_text : null),
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          inquiry_type: 'inquiry',
          overall_confidence: 0.95,
        };

        let humanRawText = `Customer: ${companyName}\n`;
        if (structuredLineItems.length > 0 && structuredLineItems[0].quantity > 0) {
          humanRawText += `Products:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} - ${it.quantity} ${it.unit}`).join('\n') + `\n`;
        } else if (draft.product_description) {
          humanRawText += `Product: ${draft.product_description}\n`;
        }
        if (draft.preferred_make) humanRawText += `Preferred Make: ${draft.preferred_make}\n`;
        if (draft.email) humanRawText += `Email: ${draft.email}\n`;
        if (draft.payment_terms) humanRawText += `Payment Terms: ${draft.payment_terms}\n`;
        if (draft.delivery_location) humanRawText += `Delivery Location: ${draft.delivery_location}\n`;
        if (notesWithTarget) humanRawText += `Notes: ${notesWithTarget}\n`;
        const inquirySourceMediaUrls = Array.isArray(draft.attachments)
          ? draft.attachments
            .map(a => a?.url || a?.file_url)
            .filter(Boolean)
          : [];

        // 1. Insert into inquiries (primary canonical table with pipeline fields)
        const procurementStamp = await procurementStampForSalesperson(senderPhone);
        const inquiryInsert = {
            source_channel: draft.source_channel || 'WhatsApp',
            sender_name: companyName,
            customer_name: companyName,
            raw_text: (draft._source_original_text || humanRawText).trim(),
            media_urls: inquirySourceMediaUrls,
            sender_phone: senderPhone,
            salesperson_phone: senderPhone,
            status: 'new_inquiry',
            stage: 'new_inquiry',
            delivery_location: draft.delivery_location || null,
            payment_terms: draft.payment_terms || null,
            total_amount: null,
            pricing_status: procurementStamp.pricing_status,
            procurement_number: procurementStamp.procurement_number,
            procurement_employee_id: procurementStamp.procurement_employee_id,
            procurement_assigned_at: procurementStamp.procurement_assigned_at,
            ai_extraction_json: structuredAiJson,
            overall_confidence: 0.95,
            inquiry_type: 'inquiry',
            created_at: new Date().toISOString(),
          };
        let { data: inqRow, error: inqErr } = await supabase
          .from('inquiries')
          .insert(inquiryInsert)
          .select()
          .single();
        if (inqErr && /procurement_number|pricing_status|procurement_employee_id|procurement_assigned_at/i.test(inqErr.message || '')) {
          delete inquiryInsert.pricing_status;
          delete inquiryInsert.procurement_number;
          delete inquiryInsert.procurement_employee_id;
          delete inquiryInsert.procurement_assigned_at;
          ({ data: inqRow, error: inqErr } = await supabase.from('inquiries').insert(inquiryInsert).select().single());
        }

        if (inqErr || !inqRow) {
          console.error('[CatalogFlow] Inquiry insert error:', inqErr);
          return `❌ *Failed to log inquiry for ${companyName}.*\n\nReason: ${inqErr?.message || 'Database write error'}. Please try again.`;
        }

        const targetRecordId = inqRow.id;
        const hexCode = targetRecordId ? targetRecordId.replace(/-/g, '').slice(0, 6).toUpperCase() : Math.random().toString(16).substring(2, 8).toUpperCase();
        const inquiryCode = `INQ-${hexCode}`;

        structuredAiJson.inquiry_code = inquiryCode;
        structuredAiJson.display_id = inquiryCode;
        await supabase.from('inquiries').update({ ai_extraction_json: structuredAiJson }).eq('id', inqRow.id);

        // 2. Insert line items into inquiry_items (canonical items table)
        if (structuredLineItems.length > 0) {
          const inqItemsPayload = structuredLineItems.map(it => ({
            inquiry_id: inqRow.id,
            sku_text: it.sku_text || it.description,
            dimensions: it.dimensions || it.spec || null,
            grade: it.grade || null,
            quantity: Number(it.quantity) || null,
            unit: it.unit || 'MT',
            rate: null,
            amount: null,
            confidence: 0.95,
            created_at: new Date().toISOString(),
          }));
          let { error: inqItemsErr } = await supabase.from('inquiry_items').insert(inqItemsPayload);
          if (inqItemsErr) {
            console.warn('[CatalogFlow] inquiry_items insert failed, retrying once:', inqItemsErr.message);
            ({ error: inqItemsErr } = await supabase.from('inquiry_items').insert(inqItemsPayload));
          }
          if (inqItemsErr) {
            // Products are the core of the inquiry: roll back the header so a retry does not leave a product-less duplicate
            console.error('[CatalogFlow] inquiry_items insert failed, rolling back inquiry:', inqItemsErr.message);
            try {
              await supabase.from('inquiry_items').delete().eq('inquiry_id', inqRow.id);
              await supabase.from('inquiries').delete().eq('id', inqRow.id);
            } catch (rbErr) {
              console.error('[CatalogFlow] Inquiry rollback error:', rbErr?.message);
            }
            return `❌ *Failed to log inquiry for ${companyName}.*\n\nReason: product line items could not be saved (${inqItemsErr.message || 'Database write error'}). Please try again.`;
          }
        }

        // 3. Mirror into deals & deal_items (with id = inqRow.id, inquiry_id = inqRow.id for 100% backward-compatibility)
        const { error: dealErr } = await supabase
          .from('deals')
          .insert({
            id: inqRow.id,
            inquiry_id: inqRow.id,
            stage: 'new_inquiry',
            customer_name: companyName,
            customer_address: draft.delivery_location || null,
            delivery_location: draft.delivery_location || null,
            payment_terms: draft.payment_terms || null,
            total_amount: null,
            inquiry_type: 'inquiry',
            status: 'auto_created',
            salesperson_phone: senderPhone,
            created_at: new Date().toISOString(),
          });

        if (dealErr) console.warn('[CatalogFlow] Deal mirror insert warning:', dealErr);

        if (structuredLineItems.length > 0) {
          const itemsPayload = structuredLineItems.map(it => ({
            deal_id: inqRow.id,
            sku_text: it.sku_text || it.description,
            dimensions: it.dimensions || it.spec || null,
            grade: it.grade || null,
            quantity: Number(it.quantity) || null,
            unit: it.unit || 'MT',
            rate: null,
            amount: null,
            confidence: 0.95,
            created_at: new Date().toISOString(),
          }));
          let { error: dealItemsErr } = await supabase.from('deal_items').insert(itemsPayload);
          if (dealItemsErr && !dealErr) {
            console.warn('[CatalogFlow] deal_items mirror insert failed, retrying once:', dealItemsErr.message);
            ({ error: dealItemsErr } = await supabase.from('deal_items').insert(itemsPayload));
          }
          if (dealItemsErr) console.error('[CatalogFlow] deal_items mirror insert failed:', dealItemsErr.message);
        }

        // 4. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'new_inquiry',
          customer_name: companyName,
          description: `Logged New Inquiry ${inquiryCode} for ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 5. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New inquiry ${inquiryCode} logged for ${companyName}${totalAmount ? ` (₹${Number(totalAmount).toLocaleString('en-IN')})` : ''}`,
            module: 'Inquiries',
            customer_name: companyName,
            entity_id: inqRow.id,
            entity_type: 'inquiry',
            action_type: 'inquiry_created',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_INQUIRY:', actErr?.message);
        }

        const displayItems = structuredLineItems.map((item) => ({ ...item, rate: null, amount: null }));
        let productSummaryLines = '';
        if (displayItems.length > 0) {
          if (displayItems.length === 1) {
            productSummaryLines = `• *Product:* ${formatDetailedInquiryItemsList(displayItems)}\n`;
          } else {
            productSummaryLines = `• *Line Items:*\n${formatDetailedInquiryItemsList(displayItems).split('\n').map(l => `  ${l}`).join('\n')}\n`;
          }
        } else {
          productSummaryLines = `• *Product:* ${draft.product_description || 'Steel Material'}\n`;
        }
        const procurementLabel = inqRow.procurement_number || procurementStamp.procurement_number;
        draft.procurement_number = procurementLabel;

        return `🎉 *Inquiry Successfully Created!*\n\n` +
          `• *Inquiry ID:* ${inquiryCode}\n` +
          `• *Procurement number:* ${procurementLabel}\n` +
          `• *Customer / Company:* ${companyName}\n` +
          productSummaryLines +
          (draft.preferred_make ? `• *Preferred Make:* ${draft.preferred_make}\n` : '') +
          (draft.payment_terms ? `• *Payment Terms:* ${draft.payment_terms}\n` : '') +
          (draft.delivery_location ? `• *Delivery Location:* ${draft.delivery_location}\n` : '') +
          (notesWithTarget ? `• *Notes:* ${notesWithTarget}\n` : '') +
          `\nProcurement can see ${procurementLabel}. Choose *Price This Inquiry* to enter the base, transport, loading, credit, and margin. ✅`;
      }

      case 'UPDATE_INQUIRY': {
        const rawId = (draft.inquiry_id || '').trim();
        const cleanId = rawId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/[^0-9A-Z]/gi, '').trim().toUpperCase();
        const companyName = (draft.company_name || '').trim();

        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        let deal = null;
        let matchedInquiryRecord = null;

        // 1. Direct UUID lookup on deals and inquiries
        if (rawId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
          let dByIdQuery = supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .or(`id.eq.${rawId},inquiry_id.eq.${rawId}`);
          if (!scope.isAdmin && targetPhones.length > 0) {
            dByIdQuery = dByIdQuery.in('salesperson_phone', targetPhones);
          }
          const { data: dById } = await dByIdQuery.limit(1);
          if (dById && dById.length > 0) {
            deal = dById[0];
          }

          if (!deal) {
            let inqByIdQuery = supabase
              .from('inquiries')
              .select('id, sender_name, salesperson_phone, status, raw_text, ai_extraction_json, deals(*)')
              .eq('id', rawId);
            if (!scope.isAdmin && targetPhones.length > 0) {
              inqByIdQuery = inqByIdQuery.in('salesperson_phone', targetPhones);
            }
            const { data: inqById } = await inqByIdQuery.limit(1);
            if (inqById && inqById.length > 0) {
              matchedInquiryRecord = inqById[0];
              if (matchedInquiryRecord.deals && matchedInquiryRecord.deals.length > 0) {
                deal = matchedInquiryRecord.deals[0];
              }
            }
          }
        }

        // 2. Prefix / Clean ID match on deals table
        if (!deal && cleanId) {
          let dealsQuery = supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
          }
          const { data: deals } = await dealsQuery.limit(500);

          if (deals && deals.length > 0) {
            deal = deals.find(d => {
              const dId = (d.id || '').replace(/-/g, '').toUpperCase();
              const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
              return dId.startsWith(cleanId) || inqId.startsWith(cleanId) || (cleanId.length >= 4 && (dId.includes(cleanId) || inqId.includes(cleanId)));
            }) || null;
          }
        }

        // 3. Prefix / Clean ID match on inquiries table
        if (!deal && cleanId) {
          let inqQuery = supabase
            .from('inquiries')
            .select('id, sender_name, salesperson_phone, status, raw_text, ai_extraction_json, deals(*)')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            inqQuery = inqQuery.in('salesperson_phone', targetPhones);
          }
          const { data: inqRows } = await inqQuery.limit(500);
          if (inqRows) {
            for (const inq of inqRows) {
              const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
              if (inqCode.startsWith(cleanId) || inqCode.includes(cleanId)) {
                matchedInquiryRecord = inq;
                if (inq.deals && inq.deals.length > 0) {
                  deal = inq.deals[0];
                }
                break;
              }
            }
          }
        }

        // 4. Unscoped fallback by cleanId across deals and inquiries
        if (!deal && cleanId) {
          const { data: rawAllDeals } = await supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .order('created_at', { ascending: false })
            .limit(500);
          const allDeals = await filterRecordsToCallerScope(rawAllDeals, scope, { customerField: 'customer_name' });

          if (allDeals && allDeals.length > 0) {
            deal = allDeals.find(d => {
              const dId = (d.id || '').replace(/-/g, '').toUpperCase();
              const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
              return dId.startsWith(cleanId) || inqId.startsWith(cleanId) || (cleanId.length >= 4 && (dId.includes(cleanId) || inqId.includes(cleanId)));
            }) || null;
          }

          if (!deal) {
            const { data: rawAllInqRows } = await supabase
              .from('inquiries')
              .select('id, sender_name, salesperson_phone, status, raw_text, ai_extraction_json, deals(*)')
              .order('created_at', { ascending: false })
              .limit(500);
            const allInqRows = await filterRecordsToCallerScope(rawAllInqRows, scope, { customerField: 'sender_name' });

            if (allInqRows) {
              for (const inq of allInqRows) {
                const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
                if (inqCode.startsWith(cleanId) || inqCode.includes(cleanId)) {
                  matchedInquiryRecord = inq;
                  if (inq.deals && inq.deals.length > 0) {
                    deal = inq.deals[0];
                  }
                  break;
                }
              }
            }
          }
        }

        // 5. Company Name Match ONLY if NO cleanId was provided and still no deal found
        if (!deal && !matchedInquiryRecord && !cleanId && companyName) {
          const cleanWord = cleanLegalSuffixes(companyName).split(' ').filter(w => w.length >= 2)[0] || companyName;
          let dealsByNameQuery = supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, stage, total_amount, payment_terms, delivery_location, salesperson_phone')
            .ilike('customer_name', `%${cleanWord}%`)
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            dealsByNameQuery = dealsByNameQuery.in('salesperson_phone', targetPhones);
          }
          const { data: nameDeals } = await dealsByNameQuery.limit(500);
          if (nameDeals && nameDeals.length > 0) {
            deal = nameDeals.find(d => isCustomerMatch(companyName, null, d.customer_name, null) && !['won', 'lost', 'closed', 'completed', 'cancelled'].includes((d.stage || '').toLowerCase())) ||
                   nameDeals.find(d => isCustomerMatch(companyName, null, d.customer_name, null)) || null;
          }
        }

        // 6. Ensure deal record exists if matchedInquiryRecord was found
        if (!deal && matchedInquiryRecord) {
          const inqJson = matchedInquiryRecord.ai_extraction_json || {};
          const newDealPayload = {
            inquiry_id: matchedInquiryRecord.id,
            customer_name: matchedInquiryRecord.sender_name || inqJson.customer_name || inqJson.companyName || companyName || 'Customer',
            salesperson_phone: matchedInquiryRecord.salesperson_phone || senderPhone,
            stage: 'new_inquiry',
            total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0) || null,
            delivery_location: inqJson.delivery_location || inqJson.location || null,
            customer_address: inqJson.delivery_location || inqJson.location || null,
            payment_terms: inqJson.payment_terms || null,
            status: 'active',
            created_at: new Date().toISOString(),
          };
          const { data: newDealRow, error: newDealErr } = await insertDealMirroringInquiry(newDealPayload, { onExisting: 'reuse' });
          if (!newDealErr && newDealRow) {
            deal = newDealRow;
          }
        }

        if (!deal) {
          const missingIdentifier = draft.inquiry_id ? `Inquiry ID "${draft.inquiry_id}"` : (companyName ? `Customer "${companyName}"` : 'the specified inquiry');
          return `❌ Could not find an existing inquiry matching ${missingIdentifier} in your records.\n\nPlease verify the Inquiry ID or Customer Name and try again.`;
        }

        const canonicalTargetId = deal.inquiry_id || deal.id;
        const displayInqId = draft._inquiry_display_id || (canonicalTargetId ? `INQ-${canonicalTargetId.replace(/-/g, '').slice(0, 6).toUpperCase()}` : (deal ? (deal.deal_number || `INQ-${deal.id.slice(0, 6).toUpperCase()}`) : (draft.inquiry_id || 'Inquiry')));
        const displayCustName = deal?.customer_name || draft.company_name || 'Customer';

        const updates = draft.updates || {};
        const dealUpdates = {};

        if (updates.payment_terms) {
          dealUpdates.payment_terms = updates.payment_terms;
        }
        if (updates.delivery_location) {
          dealUpdates.delivery_location = updates.delivery_location;
          dealUpdates.customer_address = updates.delivery_location;
        }
        const stageInput = updates.stage || updates.status || draft.stage || draft.status || draft.new_stage;
        if (stageInput) {
          const s = String(stageInput).toLowerCase();
          if (/\b(?:new\s*inquiry|new\s*enquiry|new)\b/i.test(s)) dealUpdates.stage = 'new_inquiry';
          else if (s.includes('won') || s.includes('order')) dealUpdates.stage = 'won';
          else if (s.includes('lost')) dealUpdates.stage = 'lost';
          else if (s.includes('negot')) dealUpdates.stage = 'negotiation';
          else if (s.includes('hold')) dealUpdates.stage = 'on_hold';
          else if (s.includes('quote') || s.includes('price')) dealUpdates.stage = 'quoted';
          else {
            const stageKey = normalizeDealStageKey(stageInput);
            if (stageKey) dealUpdates.stage = stageKey;
          }
        }

        // Synchronize inquiries table (ai_extraction_json AND raw_text)
        let targetInqId = deal.inquiry_id || deal.id;
        let inqRow = null;
        if (targetInqId) {
          const { data: directInq, error: fetchInqErr } = await supabase.from('inquiries').select('id, raw_text, ai_extraction_json, status, pricing_status').eq('id', targetInqId).single();
          if (!fetchInqErr && directInq) {
            inqRow = directInq;
          }
        }
        if (!inqRow && cleanId) {
          const { data: matchedInqs } = await supabase.from('inquiries').select('id, raw_text, ai_extraction_json, status, pricing_status').order('created_at', { ascending: false }).limit(500);
          if (matchedInqs) {
            inqRow = matchedInqs.find(i => (i.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanId) || (i.id || '').replace(/-/g, '').toUpperCase().includes(cleanId)) || null;
            if (inqRow) {
              targetInqId = inqRow.id;
              if (deal.id && deal.inquiry_id !== inqRow.id) {
                await supabase.from('deals').update({ inquiry_id: inqRow.id }).eq('id', deal.id);
                deal.inquiry_id = inqRow.id;
              }
            }
          }
        }

        const hasSellRate = Boolean(updates.rate) || (Array.isArray(draft.line_item_updates) && draft.line_item_updates.some((item) => item && item.rate != null && String(item.rate).trim() !== ''));
        const blockedUpdate = prematureUpdateReply({
          pricingStatus: inqRow?.pricing_status,
          stage: dealUpdates.stage,
          hasRate: hasSellRate,
        });
        if (blockedUpdate) return blockedUpdate;

        let itemsUpdated = false;
        let totalAmount = 0;
        let { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);

        if ((!dItems || dItems.length === 0) && (Array.isArray(draft.line_item_updates) || updates.rate)) {
          let seedItems = [];
          const { data: inqItems } = await supabase.from('inquiry_items').select('*').eq('inquiry_id', targetInqId);
          if (inqItems && inqItems.length > 0) {
            seedItems = inqItems.map(it => ({
              deal_id: deal.id,
              sku_text: it.sku_text || it.description || 'Item',
              dimensions: it.dimensions || it.spec || null,
              grade: it.grade || null,
              quantity: Number(it.quantity) || 0,
              unit: it.unit || 'MT',
              rate: Number(it.rate) || 0,
              amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
              created_at: new Date().toISOString(),
            }));
          } else {
            const aiJsonItems = matchedInquiryRecord?.ai_extraction_json?.line_items || matchedInquiryRecord?.ai_extraction_json?.lineItems || inqRow?.ai_extraction_json?.line_items || inqRow?.ai_extraction_json?.lineItems || [];
            if (aiJsonItems && aiJsonItems.length > 0) {
              seedItems = aiJsonItems.map(it => ({
                deal_id: deal.id,
                sku_text: it.sku_text || it.description || it.product_requirement || 'Item',
                dimensions: it.dimensions || it.spec || null,
                grade: it.grade || null,
                quantity: Number(it.quantity) || 0,
                unit: it.unit || 'MT',
                rate: Number(it.rate) || 0,
                amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
                created_at: new Date().toISOString(),
              }));
            }
          }
          if (seedItems.length > 0) {
            const { data: insertedDItems } = await supabase.from('deal_items').insert(seedItems).select();
            if (insertedDItems && insertedDItems.length > 0) {
              dItems = insertedDItems;
            }
          }
        }

        // 1. Specific line item updates
        if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0 && dItems && dItems.length > 0) {
          for (let i = 0; i < dItems.length; i++) {
            const currentItem = dItems[i];
            const matchedUpd = matchLineItemUpdate(currentItem, i, dItems.length, draft.line_item_updates);

            let itRate = Number(currentItem.rate) || 0;
            let itQty = Number(currentItem.quantity) || 0;
            let itDim = currentItem.dimensions || currentItem.spec || null;
            let newSkuText = currentItem.sku_text;

            if (matchedUpd) {
              if (matchedUpd.rate !== null && matchedUpd.rate !== undefined && matchedUpd.rate !== '') {
                itRate = parseIndianAmount(matchedUpd.rate) ?? itRate;
              }
              if (matchedUpd.quantity !== null && matchedUpd.quantity !== undefined && matchedUpd.quantity !== '') {
                itQty = parseNumericValue(matchedUpd.quantity) ?? itQty;
              }
              const newDim = matchedUpd.dimensions || matchedUpd.spec;
              if (newDim !== null && newDim !== undefined && String(newDim).trim() !== '') {
                itDim = String(newDim).trim();
              }

              if (matchedUpd.sku_text && !isGenericLineUpdateRef(matchedUpd.sku_text)) {
                newSkuText = matchedUpd.sku_text;
              } else if (matchedUpd.description && !isGenericLineUpdateRef(matchedUpd.description)) {
                newSkuText = matchedUpd.description;
              } else if (newDim && newSkuText) {
                const oldThk = (currentItem.dimensions || '').match(/\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g)/i)?.[0];
                if (oldThk) {
                  const regex = new RegExp(`\\s*\\(?\\s*${oldThk.replace('.', '\\.')}\\s*\\)?`, 'gi');
                  const cleaned = newSkuText.replace(regex, '').trim();
                  if (cleaned.length > 2) {
                    newSkuText = cleaned;
                  }
                }
              }
            }

            const itAmt = itQty > 0 && itRate > 0 ? itQty * itRate : 0;
            totalAmount += itAmt;

            const { error: dItemErr } = await supabase.from('deal_items').update({
              rate: itRate,
              quantity: itQty,
              amount: itAmt,
              dimensions: itDim,
              sku_text: newSkuText,
            }).eq('id', currentItem.id);

            if (dItemErr) {
              console.error('[CatalogFlow] Deal item update error:', dItemErr);
              return `❌ *Failed to update inquiry ${displayInqId} for ${displayCustName}.*\n\nReason: ${dItemErr.message || 'Database item update error'}. Please try again.`;
            }
            itemsUpdated = true;
          }
          const addedLines = await insertAddedDealLineItems(deal.id, draft.line_item_updates);
          if (addedLines.error) {
            console.error('[CatalogFlow] Deal item add error:', addedLines.error);
            return `❌ *Failed to update inquiry ${displayInqId} for ${displayCustName}.*\n\nReason: ${addedLines.error.message || 'Database item update error'}. Please try again.`;
          }
          if (addedLines.inserted) {
            totalAmount += addedLines.addedAmount;
            itemsUpdated = true;
          }
        } else if (updates.rate && dItems && dItems.length > 0 && (dItems.length === 1 || draft._apply_rate_to_all)) {
          // 2. Global rate update across all items (only for single item or explicit all)
          const newRate = parseIndianAmount(updates.rate) || 0;
          if (newRate > 0) {
            for (const it of dItems) {
              const itQty = Number(it.quantity) || 0;
              const itAmt = itQty > 0 ? itQty * newRate : 0;
              totalAmount += itAmt;
              const { error: dItemErr } = await supabase.from('deal_items').update({ rate: newRate, amount: itAmt }).eq('id', it.id);
              if (dItemErr) {
                console.error('[CatalogFlow] Global rate update error:', dItemErr);
                return `❌ *Failed to update inquiry ${displayInqId} for ${displayCustName}.*\n\nReason: ${dItemErr.message || 'Database item update error'}. Please try again.`;
              }
            }
            itemsUpdated = true;
          }
        }

        let missingPriceQuotePrompt = null;
        if (itemsUpdated && totalAmount > 0) {
          dealUpdates.total_amount = totalAmount;
        }

        const wantsQuotedStage = dealUpdates.stage === 'quoted' || (!dealUpdates.stage && itemsUpdated && totalAmount > 0 && (!deal.stage || deal.stage === 'new_inquiry' || deal.stage === 'review'));

        if (wantsQuotedStage) {
          const { data: latestDealItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
          const { evaluateMandatoryFields } = require('../agents/salesAgent');
          const comp = evaluateMandatoryFields({
            customerName: deal.customer_name || companyName,
            lineItems: latestDealItems || [],
            deliveryLocation: dealUpdates.delivery_location || deal.delivery_location || inqRow?.ai_extraction_json?.delivery_location,
            paymentTerms: dealUpdates.payment_terms || deal.payment_terms || inqRow?.ai_extraction_json?.payment_terms,
            totalAmount: totalAmount || dealUpdates.total_amount || deal.total_amount,
          });

          if (comp.isComplete) {
            dealUpdates.stage = 'quoted';
          } else {
            delete dealUpdates.stage;
            missingPriceQuotePrompt = comp.missingFields;
          }
        }

        if (Object.keys(dealUpdates).length > 0) {
          const { error: dealUpdErr } = await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
          if (dealUpdErr) {
            console.error('[CatalogFlow] Deal update error:', dealUpdErr);
            return `❌ *Failed to update inquiry ${displayInqId} for ${displayCustName}.*\n\nReason: ${dealUpdErr.message || 'Database update error'}. Please try again.`;
          }
        }

        if (targetInqId && inqRow) {
            const aiJson = inqRow.ai_extraction_json || {};
            if (updates.payment_terms) {
              aiJson.payment_terms = updates.payment_terms;
              aiJson.paymentTerms = updates.payment_terms;
            }
            if (updates.email) {
              aiJson.customer_email = updates.email;
              aiJson.customerEmail = updates.email;
              if (aiJson.customer) aiJson.customer.email = updates.email;
            }
            if (updates.delivery_location) {
              aiJson.delivery_location = updates.delivery_location;
              aiJson.deliveryLocation = updates.delivery_location;
              aiJson.delivery_address = updates.delivery_location;
              if (aiJson.customer) aiJson.customer.address = updates.delivery_location;
            }
            if (updates.preferred_make) aiJson.preferred_make = updates.preferred_make;
            if (updates.additional_notes) aiJson.additional_notes = updates.additional_notes;
            if (dealUpdates.stage) {
              aiJson.stage = dealUpdates.stage;
              aiJson.status = dealUpdates.stage;
            }

            if (itemsUpdated) {
              const { data: refreshedItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
              if (refreshedItems && refreshedItems.length > 0) {
                aiJson.line_items = refreshedItems.map(it => ({
                  sku_text: it.sku_text,
                  description: it.sku_text,
                  dimensions: it.dimensions,
                  spec: it.dimensions,
                  hsn_code: resolveProductHsnOrEmpty(it.sku_text, it.dimensions, it.hsn_code, draft),
                  hsn_sac: resolveProductHsnOrEmpty(it.sku_text, it.dimensions, it.hsn_code, draft),
                  quantity: Number(it.quantity) || 0,
                  unit: it.unit || 'MT',
                  rate: Number(it.rate) || 0,
                  amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
                }));
                aiJson.lineItems = aiJson.line_items;
                aiJson.rate = refreshedItems[0]?.rate ?? aiJson.rate;
                aiJson.unitPrice = refreshedItems[0]?.rate ?? aiJson.unitPrice;
                aiJson.total_amount = totalAmount;
                aiJson.totalAmount = totalAmount;
              }
            }

            // Sync raw_text so frontend line-by-line fallback regex matches the updated values
            let updatedRawText = inqRow.raw_text || '';
            if (updates.delivery_location) {
              if (/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i, `Delivery Location: ${updates.delivery_location}`);
              } else {
                updatedRawText += `\nDelivery Location: ${updates.delivery_location}`;
              }
            }
            if (updates.payment_terms) {
              if (/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i, `Payment Terms: ${updates.payment_terms}`);
              } else {
                updatedRawText += `\nPayment Terms: ${updates.payment_terms}`;
              }
            }
            if (updates.rate) {
              if (/(?:Rate|@)\s*[:=-]?\s*(?:₹|rs\.?)?\s*([^\n|/]+)(?:\/MT)?/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:Rate|@)\s*[:=-]?\s*(?:₹|rs\.?)?\s*([^\n|/]+)(?:\/MT)?/i, `Rate: ₹${updates.rate}/MT`);
              } else {
                updatedRawText += `\nRate: ₹${updates.rate}/MT`;
              }
            }
            if (updates.additional_notes) {
              if (/(?:notes?|additional\s*notes?|remarks?)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:notes?|additional\s*notes?|remarks?)\s*[:=-]\s*([^\n|]+)/i, `Notes: ${updates.additional_notes}`);
              } else {
                updatedRawText += `\nNotes: ${updates.additional_notes}`;
              }
            }

            const inqUpdatePayload = {
              ai_extraction_json: aiJson,
              raw_text: updatedRawText.trim(),
            };
            if (dealUpdates.stage) {
              inqUpdatePayload.stage = dealUpdates.stage;
              inqUpdatePayload.status = dealUpdates.stage === 'won' ? 'confirmed' : dealUpdates.stage;
            }
            if (dealUpdates.total_amount) inqUpdatePayload.total_amount = dealUpdates.total_amount;
            if (dealUpdates.delivery_location) inqUpdatePayload.delivery_location = dealUpdates.delivery_location;
            if (dealUpdates.payment_terms) inqUpdatePayload.payment_terms = dealUpdates.payment_terms;
            if (dealUpdates.po_number) inqUpdatePayload.po_number = dealUpdates.po_number;
            if (dealUpdates.po_date) inqUpdatePayload.po_date = dealUpdates.po_date;
            if (dealUpdates.won_at) inqUpdatePayload.won_at = dealUpdates.won_at;
            if (dealUpdates.lost_reason) inqUpdatePayload.lost_reason = dealUpdates.lost_reason;
            
            const { error: inqUpdErr } = await supabase.from('inquiries').update(inqUpdatePayload).eq('id', targetInqId);
            if (inqUpdErr) {
              console.error('[CatalogFlow] Inquiries table update error:', inqUpdErr);
              return `❌ *Failed to update inquiry ${displayInqId} for ${displayCustName}.*\n\nReason: ${inqUpdErr.message || 'Database write error'}. Please try again.`;
            }

            if (itemsUpdated) {
              const { data: refreshedItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
              if (refreshedItems && refreshedItems.length > 0) {
                await supabase.from('inquiry_items').delete().eq('inquiry_id', targetInqId);
                const inqItems = refreshedItems.map(it => ({
                  inquiry_id: targetInqId,
                  sku_text: it.sku_text,
                  dimensions: it.dimensions,
                  grade: it.grade,
                  quantity: it.quantity,
                  unit: it.unit,
                  rate: it.rate,
                  amount: it.amount,
                  confidence: 0.95,
                  created_at: new Date().toISOString(),
                }));
                await supabase.from('inquiry_items').insert(inqItems);
              }
            }
          }

        // Fetch latest line items for the inquiry/deal
        let finalItems = [];
        const { data: latestDealItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
        if (latestDealItems && latestDealItems.length > 0) {
          finalItems = latestDealItems;
        } else if (Array.isArray(dItems) && dItems.length > 0) {
          finalItems = dItems;
        } else if (Array.isArray(draft.existing_items) && draft.existing_items.length > 0) {
          finalItems = draft.existing_items;
        }

        let itemsListText = '';
        if (finalItems.length > 0) {
          itemsListText = formatDetailedInquiryItemsList(finalItems);
        } else if (draft.product_summary) {
          itemsListText = `1. *${draft.product_summary}*`;
        }

        let finalTotalAmt = totalAmount || Number(dealUpdates.total_amount || deal.total_amount || 0);
        if (!finalTotalAmt && finalItems.length > 0) {
          finalTotalAmt = finalItems.reduce((s, it) => {
            const q = Number(it.quantity || 0);
            const r = Number(it.rate || 0);
            const a = Number(it.amount || 0);
            return s + (a || (q * r));
          }, 0);
        }

        const quoteTotalBlock = finalTotalAmt > 0 ? `\n\nQuotation Total: ₹${finalTotalAmt.toLocaleString('en-IN')}` : '';

        const effectiveStage = dealUpdates.stage || deal.stage || draft.new_stage || draft.stage || inqRow?.status || 'Quoted';
        const stageLabel = formatStageLabel(effectiveStage);

        const effectivePaymentTerms = dealUpdates.payment_terms || deal.payment_terms || draft.updates?.payment_terms || draft.payment_terms || inqRow?.payment_terms || null;
        const effectiveDeliveryLocation = dealUpdates.delivery_location || deal.delivery_location || draft.updates?.delivery_location || draft.delivery_location || inqRow?.delivery_location || null;
        const effectivePreferredMake = draft.updates?.preferred_make || draft.preferred_make || deal.preferred_make || inqRow?.ai_extraction_json?.preferred_make || null;
        const effectiveAdditionalNotes = draft.updates?.additional_notes || draft.additional_notes || deal.additional_notes || inqRow?.ai_extraction_json?.additional_notes || null;

        const loggedStage = activityStageName(updates.stage);
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Inquiry ${displayInqId} details updated for ${displayCustName}${loggedStage ? ` (Stage: ${loggedStage})` : ''}`,
            module: 'Inquiries',
            customer_name: displayCustName,
            entity_id: canonicalTargetId,
            entity_type: 'inquiry',
            action_type: 'inquiry_updated',
            change_detail: dealUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_INQUIRY:', actErr?.message);
        }

        let inquiryDetailsBlock = `✏️ *Selected Inquiry ${displayInqId} (${displayCustName}):*\n\n` +
          `• *Stage:* ${formatAttributeValue(stageLabel)}\n` +
          `• *Payment Terms:* ${formatAttributeValue(effectivePaymentTerms)}\n` +
          `• *Delivery Location:* ${formatAttributeValue(effectiveDeliveryLocation)}\n`;

        if (effectivePreferredMake && formatAttributeValue(effectivePreferredMake) !== '-') {
          inquiryDetailsBlock += `• *Preferred Make:* ${formatAttributeValue(effectivePreferredMake)}\n`;
        }
        if (effectiveAdditionalNotes && formatAttributeValue(effectiveAdditionalNotes) !== '-') {
          inquiryDetailsBlock += `• *Additional Notes:* ${formatAttributeValue(effectiveAdditionalNotes)}\n`;
        }

        if (itemsListText) {
          inquiryDetailsBlock += `\n*Current Line Items:*\n\n${itemsListText}`;
        }
        inquiryDetailsBlock += quoteTotalBlock;

        let noticeBlock = '';
        if (missingPriceQuotePrompt && missingPriceQuotePrompt.length > 0) {
          noticeBlock = `\n\n⚠️ *Inquiry remains in ${stageLabel} stage.*\n` +
            `*Please fill the mandatory field(s) to update the stage to Price Quote:*\n` +
            missingPriceQuotePrompt.map(f => `• ${f}`).join('\n');
        }

        return `✅ *Inquiry Updated Successfully!*\n\n` +
          `${inquiryDetailsBlock}` +
          noticeBlock + `\n\n` +
          `Updated details saved to Sales Pipeline & Inquiries! 📈`;
      }

      case 'LOG_ORDER': {
        const linkedInquiryId = String(draft.inquiry_id || '').trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(linkedInquiryId)) {
          const { data: pricedInquiry } = await supabase.from('inquiries').select('pricing_status').eq('id', linkedInquiryId).maybeSingle();
          const orderBlock = orderRateReply(pricedInquiry?.pricing_status);
          if (orderBlock) return orderBlock;
        }
        const companyName = (draft.company_name || 'Customer').trim();
        const poResolution = await resolveFinalPo({
          poNumber: draft.po_number,
          generatedPoNumber: draft.generated_po_number,
          referencePoNumber:
            draft.reference_po_number || draft.customer_po_number,
          reservationToken: draft.po_reservation_token,
          dealId: draft.deal_id || null,
        });
        Object.assign(draft, poResolution);
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          city: draft.delivery_location || null,
        });

        let subtotal = 0;
        const structuredLineItems = (Array.isArray(draft.line_items) && draft.line_items.length > 0)
          ? draft.line_items.map((it) => {
              const calc = calculateLineItem(it);
              const sText = it.sku_text || it.description || '';
              const sDim = it.dimensions || it.spec || '';
              const qty = calc.quantity || 0;
              const rate = calc.rate || 0;
              const amt = calc.amount || qty * rate;
              subtotal += amt;
              const hCode = resolveProductHsnOrEmpty(sText || it.description || '', sDim, it.hsn_code || it.hsn_sac, draft);
              return {
                sku_text: sText,
                description: it.description || sText,
                dimensions: sDim,
                spec: sDim,
                hsn_code: hCode,
                hsn_sac: hCode,
                quantity: qty,
                unit: calc.unit || 'MT',
                rate: rate,
                amount: amt,
                cgst_rate: calc.cgst_rate || 9,
                cgst_amount: calc.cgst_amount || Math.round(amt * 0.09 * 100) / 100,
                sgst_rate: calc.sgst_rate || 9,
                sgst_amount: calc.sgst_amount || Math.round(amt * 0.09 * 100) / 100,
                total_gst: calc.total_gst || Math.round(amt * 0.18 * 100) / 100,
                final_amount: calc.final_amount || Math.round(amt * 1.18 * 100) / 100,
              };
            })
          : [];

        const breakdown = calculateQuotationBreakdown(subtotal);
        const totalAmount = breakdown.grandTotal;

        const structuredAiJson = {
          customer: {
            name: companyName,
            phone: null,
            address: draft.delivery_location || null,
            match_status: 'matched',
          },
          customer_name: companyName,
          companyName: companyName,
          inquiry_id: draft.inquiry_id || null,
          po_number: draft.po_number,
          reference_po_number: draft.reference_po_number || null,
          generated_po_number: draft.generated_po_number || null,
          po_source: draft.po_source || null,
          po_status: 'confirmed',
          po_generated_at: draft.po_generated_at || null,
          po_confirmed_at: draft.po_confirmed_at || null,
          po_date: draft.po_date,
          delivery_location: draft.delivery_location || null,
          delivery_address: draft.delivery_location || null,
          payment_terms: draft.payment_terms || null,
          product_requirement: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          productType: structuredLineItems[0] ? structuredLineItems[0].sku_text : null,
          line_items: structuredLineItems,
          lineItems: structuredLineItems,
          subtotal: breakdown.subtotal,
          cgst_amount: breakdown.CGST,
          sgst_amount: breakdown.SGST,
          total_amount: totalAmount,
          grand_total: totalAmount,
          inquiry_type: 'purchase_order',
          overall_confidence: 0.98,
        };

        const sourceOriginalText = String(draft._source_original_text || '').trim();
        const hasSourceDocument =
          Array.isArray(draft.attachments) && draft.attachments.length > 0;
        const sourceMediaUrls = hasSourceDocument
          ? draft.attachments
            .map(a => a?.url || a?.file_url)
            .filter(Boolean)
          : [];
        let humanRawText = sourceOriginalText
          ? sourceOriginalText
          : hasSourceDocument
            ? `[PO Document Attached: ${draft.po_number}] ${companyName} - Original PO Document`
            : `Customer: ${companyName}\nSystem PO Number: ${draft.po_number}\n`;
        if (draft.reference_po_number) humanRawText += `Reference PO: ${draft.reference_po_number}\n`;
        humanRawText += `PO Date: ${draft.po_date}\n`;
        if (draft.inquiry_id) humanRawText += `Linked Inquiry: ${draft.inquiry_id}\n`;
        if (structuredLineItems.length > 0) {
          humanRawText += `Line Items:\n` + structuredLineItems.map((it, i) => `${i + 1}. ${it.description || it.sku_text} ${it.dimensions ? `(${it.dimensions})` : ''} - ${it.quantity} ${it.unit} @ ₹${it.rate}/${it.unit}`).join('\n') + `\n`;
        }
        if (draft.payment_terms) humanRawText += `Payment Terms: ${draft.payment_terms}\n`;
        if (draft.delivery_location) humanRawText += `Delivery Location: ${draft.delivery_location}\n`;

        // 1. Resolve linked inquiry / deal ID and perform strict LIVE re-validation
        let targetInquiryId = null;
        let targetDealId = draft.deal_id || null;
        let liveMatchedInq = null;
        let liveMatchedDeal = null;

        const rawRef = draft.inquiry_id || draft.deal_id || draft._inquiry_display_id || null;
        if (rawRef) {
          const orderScope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
          const cleanCode = String(rawRef).replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase();
          const { data: rawMatchedInqRows } = await supabase
            .from('inquiries')
            .select('id, salesperson_phone, sender_phone, sender_name, status, stage, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, total_amount, delivery_location, payment_terms, ai_extraction_json, won_at')
            .order('created_at', { ascending: false })
            .limit(500);
          const matchedInqRows = await filterRecordsToCallerScope(rawMatchedInqRows, orderScope, { customerField: 'sender_name' });
          liveMatchedInq = matchedInqRows.find(i => (i.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanCode)) || null;

          const { data: rawMatchedDealRows } = await supabase
            .from('deals')
            .select('id, inquiry_id, salesperson_phone, customer_name, stage, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, total_amount, delivery_location, payment_terms, won_at, customer_address')
            .order('created_at', { ascending: false })
            .limit(500);
          const matchedDealRows = await filterRecordsToCallerScope(rawMatchedDealRows, orderScope, { customerField: 'customer_name' });
          liveMatchedDeal = matchedDealRows.find(d =>
            (d.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanCode) ||
            (d.inquiry_id && d.inquiry_id.replace(/-/g, '').toUpperCase().startsWith(cleanCode)) ||
            (liveMatchedInq && d.inquiry_id === liveMatchedInq.id) ||
            (liveMatchedInq && d.id === liveMatchedInq.id)
          ) || null;

          if (liveMatchedInq) {
            targetInquiryId = liveMatchedInq.id;
          }
          if (liveMatchedDeal) {
            targetDealId = liveMatchedDeal.id;
            if (!targetInquiryId && liveMatchedDeal.inquiry_id) {
              targetInquiryId = liveMatchedDeal.inquiry_id;
            }
          }

          // If rawRef was provided but neither inquiry nor deal was found in DB
          if (!liveMatchedInq && !liveMatchedDeal) {
            return `❌ *Inquiry Not Found or Inaccessible*\n\nCould not find a valid, accessible inquiry matching "${rawRef}". Please verify the Inquiry ID and try again.`;
          }

          // ── LIVE STAGE & ELIGIBILITY RE-VALIDATION AT SAVE TIME ──
          const rawLiveStage = (liveMatchedDeal ? liveMatchedDeal.stage : (liveMatchedInq ? (liveMatchedInq.stage || liveMatchedInq.status) : null)) || 'new_inquiry';
          const liveStageLower = String(rawLiveStage).toLowerCase().trim();
          const displayInq = liveMatchedInq ? `INQ-${liveMatchedInq.id.replace(/-/g, '').slice(0, 6).toUpperCase()}` : (liveMatchedDeal?.inquiry_id ? `INQ-${liveMatchedDeal.inquiry_id.replace(/-/g, '').slice(0, 6).toUpperCase()}` : `INQ-${cleanCode.slice(0, 6)}`);

          if (['won', 'closed won', 'closed_won', 'confirmed'].includes(liveStageLower)) {
            const existingPo = liveMatchedDeal?.po_number || liveMatchedInq?.po_number || draft.po_number || 'Existing PO';
            return `⚠️ *Order Already Recorded*\n\nInquiry ${displayInq} has already been marked as WON (PO: ${existingPo}).\n\nTo update details for this existing order, please choose *4. Update Order*.`;
          }

          if (['new_inquiry', 'new', 'auto_created', 'inquiry', 'review'].includes(liveStageLower)) {
            return `⚠️ *Order Cannot Be Created*\n\nInquiry ${displayInq} is currently in *${liveStageLower === 'new_inquiry' ? 'New Inquiry' : liveStageLower}* stage.\n\nA quotation must be sent and the inquiry must be in *Price Quote* or *Negotiation* stage before an order can be logged.`;
          }

          if (['lost', 'closed lost', 'closed_lost', 'cancelled'].includes(liveStageLower)) {
            return `⚠️ *Order Cannot Be Created*\n\nInquiry ${displayInq} is currently marked as *Lost / Cancelled*.\n\nPlease reopen or quote the inquiry first before logging an order.`;
          }

          const isEligibleOrderStage = ['quoted', 'price quote', 'price_quote', 'negotiation', 'on_hold', 'hold'].includes(liveStageLower);
          if (!isEligibleOrderStage) {
            return `⚠️ *Order Cannot Be Created*\n\nInquiry ${displayInq} is currently in *${rawLiveStage}* stage.\n\nAn order can only be logged for inquiries in *Price Quote*, *Negotiation*, or *On Hold* stages.`;
          }
        }

        // A previous confirm attempt may have created the inquiry before a later step failed.
        if (!targetInquiryId && draft._saved_order_inquiry_id) {
          targetInquiryId = draft._saved_order_inquiry_id;
        }

        // 2. Snapshot pre-existing states for Compensating Rollback
        const prevInquirySnapshot = liveMatchedInq ? { ...liveMatchedInq } : null;
        const prevDealSnapshot = liveMatchedDeal ? { ...liveMatchedDeal } : null;
        let isNewInquiryInserted = false;
        let isNewDealInserted = false;
        let finalInquiryId = targetInquiryId;
        let finalDealId = targetDealId;

        // 3. Multi-table Atomic Order Execution with Compensating Rollback
        try {
          // A. Handle Inquiries table
          if (finalInquiryId) {
            const { error: inqUpdErr } = await supabase
              .from('inquiries')
              .update({
                stage: 'won',
                status: 'confirmed',
                won_at: new Date().toISOString(),
                po_number: draft.po_number,
                reference_po_number: draft.reference_po_number || null,
                generated_po_number: draft.generated_po_number || null,
                po_source: draft.po_source || null,
                po_status: 'confirmed',
                po_generated_at: draft.po_generated_at || null,
                po_confirmed_at: draft.po_confirmed_at || null,
                po_date: draft.po_date,
                total_amount: totalAmount,
                delivery_location: draft.delivery_location || null,
                payment_terms: draft.payment_terms || null,
                ai_extraction_json: structuredAiJson,
                ...(sourceMediaUrls.length > 0
                  ? { media_urls: sourceMediaUrls }
                  : {}),
              })
              .eq('id', finalInquiryId);

            if (inqUpdErr) {
              throw new Error(`Inquiry update error: ${inqUpdErr.message || 'Database write error'}`);
            }
          } else {
            const { data: inqRow, error: inqErr } = await supabase
              .from('inquiries')
              .insert({
                source_channel: draft.source_channel || 'WhatsApp',
                customer_name: companyName,
                sender_name: companyName,
                raw_text: humanRawText.trim(),
                media_urls: sourceMediaUrls,
                sender_phone: senderPhone,
                salesperson_phone: senderPhone,
                status: 'confirmed',
                stage: 'won',
                won_at: new Date().toISOString(),
                po_number: draft.po_number,
                reference_po_number: draft.reference_po_number || null,
                generated_po_number: draft.generated_po_number || null,
                po_source: draft.po_source || null,
                po_status: 'confirmed',
                po_generated_at: draft.po_generated_at || null,
                po_confirmed_at: draft.po_confirmed_at || null,
                po_date: draft.po_date,
                total_amount: totalAmount,
                delivery_location: draft.delivery_location || null,
                payment_terms: draft.payment_terms || null,
                ai_extraction_json: structuredAiJson,
                overall_confidence: 0.98,
                inquiry_type: 'purchase_order',
                created_at: new Date().toISOString(),
              })
              .select()
              .single();

            if (inqErr || !inqRow) {
              throw new Error(`Inquiry insert error: ${inqErr?.message || 'Database write error'}`);
            }
            finalInquiryId = inqRow.id;
            isNewInquiryInserted = true;
            draft._saved_order_inquiry_id = inqRow.id;
          }

          // B. Update or Insert inquiry_items
          if (finalInquiryId && structuredLineItems.length > 0) {
            await supabase.from('inquiry_items').delete().eq('inquiry_id', finalInquiryId);
            const inqItemsPayload = structuredLineItems.map(it => ({
              inquiry_id: finalInquiryId,
              sku_text: it.sku_text || it.description,
              dimensions: it.dimensions || it.spec || null,
              grade: it.grade || null,
              quantity: Number(it.quantity) || 0,
              unit: it.unit || 'MT',
              rate: Number(it.rate) || 0,
              amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
              confidence: 0.95,
              created_at: new Date().toISOString(),
            }));
            const { error: inqItemsErr } = await supabase.from('inquiry_items').insert(inqItemsPayload);
            if (inqItemsErr) {
              throw new Error(`Inquiry items insert error: ${inqItemsErr.message || 'Database write error'}`);
            }
          }

          // C. Handle Deals table (Crucial for Orders page in frontend)
          if (finalDealId) {
            const { error: updErr } = await supabase
              .from('deals')
              .update({
                inquiry_id: finalInquiryId || null,
                stage: 'won',
                won_at: new Date().toISOString(),
                po_number: draft.po_number,
                reference_po_number: draft.reference_po_number || null,
                generated_po_number: draft.generated_po_number || null,
                po_source: draft.po_source || null,
                po_status: 'confirmed',
                po_generated_at: draft.po_generated_at || null,
                po_confirmed_at: draft.po_confirmed_at || null,
                po_date: draft.po_date,
                total_amount: totalAmount,
                delivery_location: draft.delivery_location,
                payment_terms: draft.payment_terms,
                customer_name: companyName,
                customer_address: draft.delivery_location || null,
                inquiry_type: 'purchase_order',
              })
              .eq('id', finalDealId);

            if (updErr) {
              throw new Error(`Deal update error: ${updErr.message || 'Database write error'}`);
            }
          } else {
            const { data: newDealRow, error: dealErr } = await insertDealMirroringInquiry({
              inquiry_id: finalInquiryId || null,
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: draft.po_number,
              reference_po_number: draft.reference_po_number || null,
              generated_po_number: draft.generated_po_number || null,
              po_source: draft.po_source || null,
              po_status: 'confirmed',
              po_generated_at: draft.po_generated_at || null,
              po_confirmed_at: draft.po_confirmed_at || null,
              po_date: draft.po_date,
              customer_name: companyName,
              customer_address: draft.delivery_location || null,
              delivery_location: draft.delivery_location,
              payment_terms: draft.payment_terms,
              total_amount: totalAmount,
              inquiry_type: 'purchase_order',
              status: 'auto_created',
              salesperson_phone: senderPhone,
              created_at: new Date().toISOString(),
            }, { onExisting: 'update' });

            if (dealErr || !newDealRow) {
              throw new Error(`Deal insert error: ${dealErr?.message || 'Database write error'}`);
            }
            finalDealId = newDealRow.id;
            isNewDealInserted = true;
          }

          await claimPoNumber(
            draft.po_number,
            draft.po_reservation_token,
            finalDealId,
          );

          // D. Update or Insert deal_items (Crucial for Orders line items in frontend)
          if (finalDealId && structuredLineItems.length > 0) {
            await supabase.from('deal_items').delete().eq('deal_id', finalDealId);
            const itemsPayload = structuredLineItems.map(it => ({
              deal_id: finalDealId,
              sku_text: it.sku_text || it.description,
              dimensions: it.dimensions || it.spec || null,
              grade: it.grade || null,
              quantity: Number(it.quantity) || 0,
              unit: it.unit || 'MT',
              rate: Number(it.rate) || 0,
              amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
              created_at: new Date().toISOString(),
            }));
            const { error: dealItemsErr } = await supabase.from('deal_items').insert(itemsPayload);
            if (dealItemsErr) {
              throw new Error(`Deal items insert error: ${dealItemsErr.message || 'Database write error'}`);
            }
          }

          // E. Log KRA 1 (Won Deal)
          await supabase.from('kra_logs').insert({
            salesperson_phone: senderPhone,
            kra_number: 1,
            kra_type: 'won_deal',
            value: totalAmount,
            customer_name: companyName,
            description: `Order Logged: PO #${draft.po_number} for ${companyName} (${breakdown.formattedGrandTotal})`,
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear(),
            created_at: new Date().toISOString(),
          });

          // F. Log to activity_logs
          try {
            logBotActivity({
              salesperson_phone: senderPhone,
              description: `New order PO: ${draft.po_number || 'N/A'} recorded for ${companyName}${totalAmount ? ` (${breakdown?.formattedGrandTotal || `₹${Number(totalAmount).toLocaleString('en-IN')}`})` : ''}`,
              module: 'Orders',
              customer_name: companyName,
              entity_id: finalDealId || finalInquiryId,
              entity_type: 'deal',
              action_type: 'order_created',
            });
          } catch (actErr) {
            console.warn('[CatalogFlow] Activity log notice for LOG_ORDER:', actErr?.message);
          }
        } catch (execErr) {
          console.error('[CatalogFlow] Order creation execution failed. Initiating compensating rollback:', execErr);

          // ── COMPENSATING ROLLBACK ──
          try {
            if (isNewInquiryInserted && finalInquiryId) {
              await supabase.from('inquiry_items').delete().eq('inquiry_id', finalInquiryId);
              await supabase.from('inquiries').delete().eq('id', finalInquiryId);
            } else if (prevInquirySnapshot && finalInquiryId) {
              await supabase.from('inquiries').update({
                stage: prevInquirySnapshot.stage,
                status: prevInquirySnapshot.status,
                won_at: prevInquirySnapshot.won_at,
                po_number: prevInquirySnapshot.po_number,
                reference_po_number: prevInquirySnapshot.reference_po_number,
                generated_po_number: prevInquirySnapshot.generated_po_number,
                po_source: prevInquirySnapshot.po_source,
                po_status: prevInquirySnapshot.po_status,
                po_generated_at: prevInquirySnapshot.po_generated_at,
                po_confirmed_at: prevInquirySnapshot.po_confirmed_at,
                po_date: prevInquirySnapshot.po_date,
                total_amount: prevInquirySnapshot.total_amount,
                delivery_location: prevInquirySnapshot.delivery_location,
                payment_terms: prevInquirySnapshot.payment_terms,
                ai_extraction_json: prevInquirySnapshot.ai_extraction_json,
              }).eq('id', finalInquiryId);
            }

            if (isNewDealInserted && finalDealId) {
              await supabase.from('deal_items').delete().eq('deal_id', finalDealId);
              await supabase.from('deals').delete().eq('id', finalDealId);
            } else if (prevDealSnapshot && finalDealId) {
              await supabase.from('deals').update({
                stage: prevDealSnapshot.stage,
                won_at: prevDealSnapshot.won_at,
                po_number: prevDealSnapshot.po_number,
                reference_po_number: prevDealSnapshot.reference_po_number,
                generated_po_number: prevDealSnapshot.generated_po_number,
                po_source: prevDealSnapshot.po_source,
                po_status: prevDealSnapshot.po_status,
                po_generated_at: prevDealSnapshot.po_generated_at,
                po_confirmed_at: prevDealSnapshot.po_confirmed_at,
                po_date: prevDealSnapshot.po_date,
                total_amount: prevDealSnapshot.total_amount,
                delivery_location: prevDealSnapshot.delivery_location,
                payment_terms: prevDealSnapshot.payment_terms,
                customer_address: prevDealSnapshot.customer_address,
              }).eq('id', finalDealId);
            }
          } catch (rbErr) {
            console.error('[CatalogFlow] Order creation compensating rollback error:', rbErr?.message);
          }

          return `❌ *Failed to record order for ${companyName}.*\n\nReason: ${execErr.message || 'Database write error'}. Please try again.`;
        }

        const inqRaw = (draft.inquiry_id || draft.deal_id || '').trim();
        const cleanInqCode = inqRaw.replace(/^#?(?:INQ|DEAL)-?/i, '').replace(/-/g, '').toUpperCase().slice(0, 6);
        const inqDisplay = cleanInqCode ? `• *Inquiry ID:* INQ-${cleanInqCode}\n` : '';

        let itemsSummaryStr = '';
        if (structuredLineItems.length === 1) {
          itemsSummaryStr = `• *Product:* ${formatDetailedInquiryItemsList(structuredLineItems)}\n`;
        } else if (structuredLineItems.length > 1) {
          itemsSummaryStr = `• *Line Items:*\n${formatDetailedInquiryItemsList(structuredLineItems).split('\n').map(l => `  ${l}`).join('\n')}\n`;
        }

        const totalTonnage = structuredLineItems.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
        const mainUnit = structuredLineItems[0]?.unit || 'MT';
        const tonnageDisplay = totalTonnage > 0 ? `• *Total Tonnage:* ${formatLineItemsTonnage(structuredLineItems) || `${totalTonnage.toLocaleString('en-IN')} ${mainUnit}`}\n` : '';

        return `🎉 *Order Recorded & Deal Marked as WON!*\n\n` +
          inqDisplay +
          `• *Customer / Company:* ${companyName}\n` +
          `• *PO Number:* ${draft.po_number}\n` +
          (draft.reference_po_number ? `• *Reference PO:* ${draft.reference_po_number}\n` : '') +
          `• *PO Date:* ${draft.po_date}\n` +
          `• *Delivery Location:* ${draft.delivery_location}\n` +
          `• *Payment Terms:* ${draft.payment_terms}\n` +
          itemsSummaryStr +
          tonnageDisplay +
          `• *Sub Total:* ₹${breakdown.formattedSubtotal}\n` +
          `• *GST (18%):* ₹${breakdown.formattedGST}\n` +
          `• *Total Order Value:* ${breakdown.formattedGrandTotal}\n\n` +
          `Updated Sales Achievement Card! 🏆`;
      }

      case 'UPDATE_ORDER': {
        const rawInqId = (draft.inquiry_id || '').trim();
        const cleanInqId = rawInqId.replace(/^#?(?:DEAL|INQ)-?/i, '').replace(/-/g, '').trim().toUpperCase();
        const rawPo = (draft.updates?.po_number || draft.po_number || '').trim();
        const rawReferencePo = (
          draft.updates?.reference_po_number ||
          draft.reference_po_number ||
          ''
        ).trim();
        const cleanPo = rawPo.replace(/^(?:PO[-_:#\s]*)/i, '').trim();
        const rawCompany = (draft.company_name || '').trim();

        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        // 1. Fetch recent deals to match
        let dealsQuery = supabase
          .from('deals')
          .select('id, inquiry_id, customer_name, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
          .order('created_at', { ascending: false });

        if (!scope.isAdmin && targetPhones.length > 0) {
          dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
        }

        const { data: deals } = await dealsQuery.limit(500);

        let deal = null;
        if (draft.deal_id) {
          if (deals && deals.length > 0) {
            deal = deals.find(d => d.id === draft.deal_id) || deals.find(d => d.inquiry_id === draft.deal_id) || null;
          }
          if (!deal) {
            let { data: dRow } = await supabase.from('deals').select('*').eq('id', draft.deal_id).maybeSingle();
            if (!dRow) {
              const { data: byInquiry } = await supabase.from('deals').select('*').eq('inquiry_id', draft.deal_id).order('created_at', { ascending: false }).limit(1);
              dRow = byInquiry && byInquiry.length > 0 ? byInquiry[0] : null;
            }
            if (dRow) {
              const [scopedRow] = await filterRecordsToCallerScope([dRow], scope, { customerField: 'customer_name' });
              if (scopedRow) deal = scopedRow;
            }
          }
        }

        if (!deal && deals && deals.length > 0) {
          // A. Match by Inquiry ID / Deal ID prefix or exact code
          if (cleanInqId) {
            deal = deals.find(d => {
              const dId = (d.id || '').replace(/-/g, '').toUpperCase();
              const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
              return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
            }) || null;
          }

          // B. Match by existing PO Number (if inquiry ID was not specified)
          if (!deal && rawPo) {
            deal = deals.find(d => {
              if (!d.po_number) return false;
              const dPo = String(d.po_number).trim();
              return dPo.toLowerCase() === rawPo.toLowerCase() ||
                     (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
            }) || null;
          }

          // C. Match by Customer Name
          if (!deal && rawCompany) {
            deal = deals.find(d => d.customer_name && d.customer_name.toLowerCase().includes(rawCompany.toLowerCase())) || null;
          }
        }

        // 2. If not found in deals and cleanInqId was supplied, check inquiries table
        if (!deal && cleanInqId) {
          let inqQuery = supabase
            .from('inquiries')
            .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
            .order('created_at', { ascending: false });

          if (!scope.isAdmin && targetPhones.length > 0) {
            inqQuery = inqQuery.in('salesperson_phone', targetPhones);
          }
          const { data: inqRows } = await inqQuery.limit(500);
          if (inqRows) {
            for (const inq of inqRows) {
              const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
              if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
                if (inq.deals && inq.deals.length > 0) {
                  deal = inq.deals[0];
                } else {
                  const inqJson = inq.ai_extraction_json || {};
                  const { data: newDealRow } = await insertDealMirroringInquiry({
                    inquiry_id: inq.id,
                    customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                    salesperson_phone: inq.salesperson_phone || senderPhone,
                    stage: 'won',
                    won_at: new Date().toISOString(),
                    po_number: null,
                    reference_po_number: rawPo || null,
                    po_date: formatIsoDateIST(new Date()),
                    total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                    delivery_location: inqJson.delivery_location || inqJson.location || null,
                    customer_address: inqJson.delivery_location || inqJson.location || null,
                    payment_terms: inqJson.payment_terms || null,
                    status: 'active',
                  }, { onExisting: 'reuse' });
                  if (newDealRow) {
                    deal = newDealRow;
                  }
                }
                break;
              }
            }
          }
        }

        // 2b. Unscoped fallback by cleanInqId or rawPo if not found yet
        if (!deal && (cleanInqId || rawPo)) {
          const { data: rawAllDeals } = await supabase
            .from('deals')
            .select('id, inquiry_id, customer_name, po_number, reference_po_number, generated_po_number, po_source, po_status, po_generated_at, po_confirmed_at, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone')
            .order('created_at', { ascending: false })
            .limit(500);
          const allDeals = await filterRecordsToCallerScope(rawAllDeals, scope, { customerField: 'customer_name' });

          if (allDeals && allDeals.length > 0) {
            if (cleanInqId) {
              deal = allDeals.find(d => {
                const dId = (d.id || '').replace(/-/g, '').toUpperCase();
                const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
                return dId.startsWith(cleanInqId) || inqId.startsWith(cleanInqId) || dId.includes(cleanInqId) || inqId.includes(cleanInqId);
              }) || null;
            }
            if (!deal && rawPo) {
              deal = allDeals.find(d => {
                if (!d.po_number) return false;
                const dPo = String(d.po_number).trim();
                return dPo.toLowerCase() === rawPo.toLowerCase() ||
                       (cleanPo && dPo.toLowerCase().includes(cleanPo.toLowerCase()));
              }) || null;
            }
          }

          if (!deal && cleanInqId) {
            const { data: rawAllInqRows } = await supabase
              .from('inquiries')
              .select('id, sender_name, sender_phone, salesperson_phone, status, ai_extraction_json, deals(*)')
              .order('created_at', { ascending: false })
              .limit(500);
            const allInqRows = await filterRecordsToCallerScope(rawAllInqRows, scope, { customerField: 'sender_name' });

            if (allInqRows) {
              for (const inq of allInqRows) {
                const inqCode = (inq.id || '').replace(/-/g, '').toUpperCase();
                if (inqCode.startsWith(cleanInqId) || inqCode.includes(cleanInqId)) {
                  if (inq.deals && inq.deals.length > 0) {
                    deal = inq.deals[0];
                  } else {
                    const inqJson = inq.ai_extraction_json || {};
                    const { data: newDealRow } = await insertDealMirroringInquiry({
                      inquiry_id: inq.id,
                      customer_name: inq.sender_name || inqJson.customer_name || inqJson.companyName || 'Customer',
                      salesperson_phone: inq.salesperson_phone || senderPhone,
                      stage: 'won',
                      won_at: new Date().toISOString(),
                      po_number: null,
                      reference_po_number: rawPo || null,
                      po_date: formatIsoDateIST(new Date()),
                      total_amount: Number(inqJson.total_amount || inqJson.totalAmount || 0),
                      delivery_location: inqJson.delivery_location || inqJson.location || null,
                      customer_address: inqJson.delivery_location || inqJson.location || null,
                      payment_terms: inqJson.payment_terms || null,
                      status: 'active',
                    }, { onExisting: 'reuse' });
                    if (newDealRow) {
                      deal = newDealRow;
                    }
                  }
                  break;
                }
              }
            }
          }
        }

        if (!deal) {
          const missingIdentifier = draft.inquiry_id ? `Inquiry ID "${draft.inquiry_id}"` : (rawPo ? `PO Number "${rawPo}"` : (rawCompany ? `Customer "${rawCompany}"` : 'specified reference'));
          return `❌ Could not find an existing order or inquiry matching ${missingIdentifier}.\n\nPlease check the Inquiry ID or PO Number and try again.`;
        }

        const updates = draft.updates || {};
        const dealUpdates = {};

        const shouldBeWon = deal.stage === 'won' ||
          String(updates.status || updates.stage || '').toLowerCase().includes('won');
        const legacyReferencePo =
          !deal.generated_po_number &&
          deal.po_number &&
          !/^EM\/PO\/\d+$/i.test(String(deal.po_number).trim())
            ? deal.po_number
            : null;

        // Every bot-updated won order must have a canonical system PO. A
        // supplied PO edits that canonical value; legacy PO values are kept
        // as the customer/reference PO instead of being reused as the
        // system identifier.
        if (rawPo || shouldBeWon) {
          try {
            const poResolution = await resolveFinalPo({
              poNumber: rawPo || (deal.generated_po_number ? deal.po_number : null),
              generatedPoNumber: deal.generated_po_number,
              referencePoNumber: rawReferencePo || deal.reference_po_number || legacyReferencePo,
              reservationToken: `bot-update:${deal.id}`,
              dealId: deal.id,
              existingDeal: deal,
            });
            dealUpdates.po_number = poResolution.po_number;
            dealUpdates.reference_po_number = poResolution.reference_po_number;
            dealUpdates.generated_po_number = poResolution.generated_po_number;
            dealUpdates.po_source = poResolution.po_source;
            dealUpdates.po_status = poResolution.po_status;
            dealUpdates.po_generated_at = poResolution.po_generated_at;
            dealUpdates.po_confirmed_at = poResolution.po_confirmed_at;
            deal.po_number = poResolution.po_number;
            deal.reference_po_number = poResolution.reference_po_number;
            deal.generated_po_number = poResolution.generated_po_number;
          } catch (poErr) {
            console.error('[CatalogFlow] PO update conflict:', poErr);
            if (poErr.code === 'PO_CONFLICT') {
              return `⚠️ *PO Number already exists.*\n\nThe system PO "${rawPo || deal.po_number}" is already assigned to another order. Please choose a different PO number.`;
            }
            return `❌ *Could not generate or validate the system PO.*\n\nReason: ${poErr.message || 'PO allocator unavailable'}. Please try again.`;
          }
        }
        if (rawReferencePo && !dealUpdates.reference_po_number) {
          dealUpdates.reference_po_number = rawReferencePo;
        }
        const displayPo = deal.po_number || rawPo || 'N/A';
        const displayCust = deal.customer_name || draft.company_name || 'Customer';
        if (updates.po_date) {
          dealUpdates.po_date = updates.po_date;
        }
        const orderNotices = [];
        const rawDeliveryDate = updates.delivery_date || draft.delivery_date;
        if (rawDeliveryDate) {
          const deliveryIso = parseUserDateToISOStrict(rawDeliveryDate);
          if (deliveryIso) {
            dealUpdates.delivery_date = formatIsoDateIST(new Date(deliveryIso));
          } else {
            orderNotices.push(`⚠️ Delivery date "${rawDeliveryDate}" was not understood, so the existing delivery date was kept. Please send it as DD-MM-YYYY.`);
          }
        }
        if (updates.delivery_location) {
          dealUpdates.delivery_location = updates.delivery_location;
          dealUpdates.customer_address = updates.delivery_location;
        }
        if (updates.payment_terms) {
          dealUpdates.payment_terms = updates.payment_terms;
        }

        // Stage only takes pipeline values; delivery progress (Delivered / Dispatched / ...) is tracked separately
        let fulfillmentStatus = null;
        if (updates.status || updates.stage) {
          const mappedStatus = mapOrderStatusUpdate(updates.status || updates.stage);
          if (mappedStatus.stage) dealUpdates.stage = mappedStatus.stage;
          fulfillmentStatus = mappedStatus.fulfillment;
        }

        // When deal is won, ensure won_at and po_date are set
        if (deal.stage === 'won' || dealUpdates.stage === 'won') {
          if (!deal.won_at && !dealUpdates.won_at) {
            dealUpdates.won_at = new Date().toISOString();
          }
          if (!deal.po_date && !dealUpdates.po_date) {
            dealUpdates.po_date = formatIsoDateIST(new Date());
          }
        }

        // Line item updates if any
        let itemsUpdated = false;
        if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
          const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
          if (dItems && dItems.length > 0) {
            let subtotal = 0;
            for (let i = 0; i < dItems.length; i++) {
              const currentItem = dItems[i];
              const matchedUpd = matchLineItemUpdate(currentItem, i, dItems.length, draft.line_item_updates);

              let itRate = Number(currentItem.rate) || 0;
              let itQty = Number(currentItem.quantity) || 0;
              let itDim = currentItem.dimensions || currentItem.spec || null;
              let newSkuText = currentItem.sku_text;

              if (matchedUpd) {
                if (matchedUpd.rate !== null && matchedUpd.rate !== undefined && matchedUpd.rate !== '') {
                  itRate = parseIndianAmount(matchedUpd.rate) ?? itRate;
                }
                if (matchedUpd.quantity !== null && matchedUpd.quantity !== undefined && matchedUpd.quantity !== '') {
                  itQty = parseNumericValue(matchedUpd.quantity) ?? itQty;
                }
                const newDim = matchedUpd.dimensions || matchedUpd.spec;
                if (newDim !== null && newDim !== undefined && String(newDim).trim() !== '') {
                  itDim = String(newDim).trim();
                }
                if (matchedUpd.sku_text && !isGenericLineUpdateRef(matchedUpd.sku_text)) {
                  newSkuText = matchedUpd.sku_text;
                } else if (matchedUpd.description && !isGenericLineUpdateRef(matchedUpd.description)) {
                  newSkuText = matchedUpd.description;
                }
              }
              const itAmt = itQty > 0 && itRate > 0 ? itQty * itRate : 0;
              subtotal += itAmt;
              const { error: dItemErr } = await supabase.from('deal_items').update({
                rate: itRate,
                quantity: itQty,
                amount: itAmt,
                dimensions: itDim,
                sku_text: newSkuText,
              }).eq('id', currentItem.id);

              if (dItemErr) {
                console.error('[CatalogFlow] Deal item update error in UPDATE_ORDER:', dItemErr);
                return `❌ *Failed to update order ${displayPo} for ${displayCust}.*\n\nReason: ${dItemErr.message || 'Database write error'}. Please try again.`;
              }
              itemsUpdated = true;
            }
            const addedLines = await insertAddedDealLineItems(deal.id, draft.line_item_updates);
            if (addedLines.error) {
              console.error('[CatalogFlow] Deal item add error in UPDATE_ORDER:', addedLines.error);
              return `❌ *Failed to update order ${displayPo} for ${displayCust}.*\n\nReason: ${addedLines.error.message || 'Database write error'}. Please try again.`;
            }
            if (addedLines.inserted) {
              subtotal += addedLines.addedAmount;
              itemsUpdated = true;
            }
            if (subtotal > 0) {
              const gst = Math.round(subtotal * 0.18);
              const grandTotal = subtotal + gst;
              dealUpdates.total_amount = grandTotal;
            }
          } else {
            let subtotal = 0;
            for (const upd of draft.line_item_updates) {
              const itRate = parseIndianAmount(upd.rate) || 0;
              const itQty = parseNumericValue(upd.quantity) || 0;
              const itAmt = itQty * itRate;
              subtotal += itAmt;
              await supabase.from('deal_items').insert({
                deal_id: deal.id,
                sku_text: upd.sku_text || upd.description || upd.item_reference || 'Steel Item',
                dimensions: upd.dimensions || upd.spec || null,
                quantity: itQty,
                unit: upd.unit || 'MT',
                rate: itRate,
                amount: itAmt,
              });
              itemsUpdated = true;
            }
            if (subtotal > 0) {
              const gst = Math.round(subtotal * 0.18);
              const grandTotal = subtotal + gst;
              dealUpdates.total_amount = grandTotal;
            }
          }
        }

        if (Object.keys(dealUpdates).length > 0) {
          const { error: dealUpdErr } = await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
          if (dealUpdErr) {
            console.error('[CatalogFlow] Deal update error in UPDATE_ORDER:', dealUpdErr);
            return `❌ *Failed to update order ${displayPo} for ${displayCust}.*\n\nReason: ${dealUpdErr.message || 'Database write error'}. Please try again.`;
          }
        }

        // Synchronize inquiries table (ai_extraction_json AND raw_text)
        if (deal.inquiry_id) {
          const { data: inqRow, error: fetchInqErr } = await supabase.from('inquiries').select('id, raw_text, ai_extraction_json, status').eq('id', deal.inquiry_id).single();
          if (inqRow) {
            const aiJson = inqRow.ai_extraction_json || {};
            if (dealUpdates.po_number) aiJson.po_number = dealUpdates.po_number;
            if (dealUpdates.reference_po_number) {
              aiJson.reference_po_number = dealUpdates.reference_po_number;
            }
            if (updates.po_date) aiJson.po_date = updates.po_date;
            if (dealUpdates.delivery_date) aiJson.delivery_date = dealUpdates.delivery_date;
            if (fulfillmentStatus) {
              aiJson.fulfillment_status = fulfillmentStatus;
              aiJson.fulfillment_updated_at = new Date().toISOString();
              if (fulfillmentStatus === 'delivered') aiJson.delivered_at = aiJson.fulfillment_updated_at;
            }
            if (updates.delivery_location) {
              aiJson.delivery_location = updates.delivery_location;
              aiJson.deliveryLocation = updates.delivery_location;
              aiJson.delivery_address = updates.delivery_location;
              if (aiJson.customer) aiJson.customer.address = updates.delivery_location;
            }
            if (updates.payment_terms) {
              aiJson.payment_terms = updates.payment_terms;
              aiJson.paymentTerms = updates.payment_terms;
            }

            if (itemsUpdated) {
              const { data: refreshedDealItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
              if (refreshedDealItems && refreshedDealItems.length > 0) {
                aiJson.line_items = refreshedDealItems.map(it => ({
                  sku_text: it.sku_text,
                  description: it.sku_text,
                  dimensions: it.dimensions,
                  spec: it.dimensions,
                  hsn_code: resolveProductHsnOrEmpty(it.sku_text, it.dimensions, it.hsn_code, draft),
                  hsn_sac: resolveProductHsnOrEmpty(it.sku_text, it.dimensions, it.hsn_code, draft),
                  quantity: Number(it.quantity) || 0,
                  unit: it.unit || 'MT',
                  rate: Number(it.rate) || 0,
                  amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
                }));
                aiJson.lineItems = aiJson.line_items;
                aiJson.rate = refreshedDealItems[0]?.rate ?? aiJson.rate;
                aiJson.unitPrice = refreshedDealItems[0]?.rate ?? aiJson.unitPrice;
                if (dealUpdates.total_amount) {
                  aiJson.total_amount = dealUpdates.total_amount;
                  aiJson.totalAmount = dealUpdates.total_amount;
                }

                await supabase.from('inquiry_items').delete().eq('inquiry_id', deal.inquiry_id);
                const syncInqItems = refreshedDealItems.map(it => ({
                  inquiry_id: deal.inquiry_id,
                  sku_text: it.sku_text,
                  dimensions: it.dimensions || null,
                  grade: it.grade || null,
                  quantity: Number(it.quantity) || 0,
                  unit: it.unit || 'MT',
                  rate: Number(it.rate) || 0,
                  amount: Number(it.amount) || (Number(it.quantity) * Number(it.rate)),
                  confidence: 0.95,
                  created_at: new Date().toISOString(),
                }));
                await supabase.from('inquiry_items').insert(syncInqItems);
              }
            }

            let updatedRawText = inqRow.raw_text || '';
            const poTextForRaw = dealUpdates.po_number || rawPo;
            if (poTextForRaw) {
              if (/(?:po\s*(?:number|no)?|purchase\s*order)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:po\s*(?:number|no)?|purchase\s*order)\s*[:=-]\s*([^\n|]+)/i, `PO Number: ${poTextForRaw}`);
              } else {
                updatedRawText += `\nPO Number: ${poTextForRaw}`;
              }
            }
            if (updates.delivery_location) {
              if (/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:delivery\s*(?:location|address)?|delivered\s*to|site\s*(?:location|address)?|destination)\s*[:=-]\s*([^\n|]+)/i, `Delivery Location: ${updates.delivery_location}`);
              } else {
                updatedRawText += `\nDelivery Location: ${updates.delivery_location}`;
              }
            }
            if (updates.payment_terms) {
              if (/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i.test(updatedRawText)) {
                updatedRawText = updatedRawText.replace(/(?:payment\s*terms?|payment|terms?)\s*[:=-]\s*([^\n|]+)/i, `Payment Terms: ${updates.payment_terms}`);
              } else {
                updatedRawText += `\nPayment Terms: ${updates.payment_terms}`;
              }
            }

            const inqPayload = {
              ai_extraction_json: aiJson,
              raw_text: updatedRawText.trim(),
            };
            if (dealUpdates.po_number) inqPayload.po_number = dealUpdates.po_number;
            if (dealUpdates.reference_po_number !== undefined) {
              inqPayload.reference_po_number = dealUpdates.reference_po_number;
            }
            if (dealUpdates.generated_po_number) {
              inqPayload.generated_po_number = dealUpdates.generated_po_number;
              inqPayload.po_source = dealUpdates.po_source;
              inqPayload.po_status = dealUpdates.po_status;
              inqPayload.po_generated_at = dealUpdates.po_generated_at;
              inqPayload.po_confirmed_at = dealUpdates.po_confirmed_at;
            }
            if (dealUpdates.stage === 'won' || deal.stage === 'won') {
              inqPayload.stage = 'won';
              inqPayload.status = 'confirmed';
            } else if (dealUpdates.stage) {
              inqPayload.stage = dealUpdates.stage;
              inqPayload.status = dealUpdates.stage;
            }
            const { error: inqUpdErr } = await supabase.from('inquiries').update(inqPayload).eq('id', deal.inquiry_id);
            if (inqUpdErr) {
              console.error('[CatalogFlow] Inquiries update error in UPDATE_ORDER:', inqUpdErr);
              return `❌ *Failed to update order ${displayPo} for ${displayCust}.*\n\nReason: ${inqUpdErr.message || 'Database write error'}. Please try again.`;
            }
          }
        }

        const finalDisplayPo = dealUpdates.po_number || deal.po_number || rawPo || 'N/A';
        const displayInq = `INQ-${(deal.id || deal.inquiry_id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
        const displayTotal = dealUpdates.total_amount || deal.total_amount || 0;
        const displayLoc = dealUpdates.delivery_location || deal.delivery_location;
        const displayPayment = dealUpdates.payment_terms || deal.payment_terms;
        const displayPoDate = dealUpdates.po_date || deal.po_date;
        const displayDeliveryDate = dealUpdates.delivery_date ? formatDateDDMMYYYY(new Date(dealUpdates.delivery_date)) : null;
        const fulfillmentLabel = fulfillmentStatus ? fulfillmentStatus.charAt(0).toUpperCase() + fulfillmentStatus.slice(1) : null;
        if (fulfillmentStatus && !deal.inquiry_id) {
          orderNotices.push(`⚠️ Delivery status "${fulfillmentLabel}" could not be recorded because this order has no linked inquiry.`);
        }

        // Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Order ${finalDisplayPo} updated for ${displayCust}${dealUpdates.stage ? ` (Stage: ${dealUpdates.stage})` : ''}${fulfillmentLabel && deal.inquiry_id ? ` (Delivery Status: ${fulfillmentLabel})` : ''}`,
            module: 'Orders',
            customer_name: displayCust,
            entity_id: deal.id,
            entity_type: 'deal',
            action_type: 'order_updated',
            change_detail: dealUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_ORDER:', actErr?.message);
        }

        return `✅ *Order Updated Successfully!*\n\n` +
          `• *Inquiry ID:* ${displayInq}\n` +
          `• *Customer / Company:* ${displayCust}\n` +
          `• *PO Number:* ${finalDisplayPo}\n` +
          (displayPoDate ? `• *PO Date:* ${displayPoDate}\n` : '') +
          (displayDeliveryDate ? `• *Delivery Date:* ${displayDeliveryDate}\n` : '') +
          (fulfillmentLabel && deal.inquiry_id ? `• *Delivery Status:* ${fulfillmentLabel}\n` : '') +
          (displayLoc ? `• *Delivery Location:* ${displayLoc}\n` : '') +
          (displayPayment ? `• *Payment Terms:* ${displayPayment}\n` : '') +
          (displayTotal > 0 ? `• *Total Order Value:* ₹${Number(displayTotal).toLocaleString('en-IN')}\n` : '') +
          (orderNotices.length > 0 ? `\n${orderNotices.join('\n')}\n` : '') +
          `\nAttached PO number to won order and logged in Orders module! 🏆`;
      }

      case 'LOG_VISIT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, {
          allowCreate: true,
          contact_person: draft.person_met,
          customer_phone: draft.contact_phone,
          city: draft.city_location,
        });

        const visitDateIso = parseDDMMYYYYtoISO(draft.visit_date);
        const parsedFollowUpDate = draft.followup_action ? extractFollowUpDate(draft.followup_action, new Date(visitDateIso)) : null;

        const outcomeTag = draft.visit_outcome ? `[Outcome: ${draft.visit_outcome}] ` : '';
        const locTag = draft.city_location ? `[Location: ${draft.city_location}] ` : '';
        const followupTag = draft.followup_action ? `[FollowUp: ${draft.followup_action}] ` : '';
        const fuDateTag = parsedFollowUpDate ? `[FollowUpDate: ${parsedFollowUpDate}] ` : '';
        const fuStatusTag = draft.followup_action ? `[FollowUpStatus: pending] ` : '';
        const formattedRemarks = `${outcomeTag}${locTag}${followupTag}${fuDateTag}${fuStatusTag}${draft.meeting_remarks || ''}`.trim();

        let employeeId = null;
        try {
          const cleanP = cleanPhone(senderPhone);
          const last10 = cleanP.slice(-10);
          const { data: empData } = await supabase
            .from('employees')
            .select('id')
            .or(`phone.eq.${cleanP},phone.eq.${last10},phone.eq.91${last10},phone.eq.+91${last10}`)
            .limit(1);
          if (empData && empData.length > 0) employeeId = empData[0].id;
        } catch (e) {}

        // 1. Insert into customer_visits
        const ready = assertReadyToSave(draft);
        if (!ready.ok) {
          return ready.message || `Please provide the remaining details:\n\n${ready.prompts.map((item) => `• *${item}*`).join('\n')}`;
        }
        const consumed = await consumeVisitCode(supabase, draft.contact_phone, draft.verification_token);
        if (!consumed.ok) return consumed.message;

        const verifiedColumns = visitRowColumns(draft);
        const visitPayload = {
          salesperson_phone: senderPhone,
          customer_name: companyName,
          customer_address: draft.city_location || null,
          person_met: draft.person_met || null,
          contact_no: draft.contact_phone || null,
          remarks: formattedRemarks,
          visited_at: visitDateIso,
          employee_id: employeeId,
          follow_up_status: draft.followup_action ? 'pending' : null,
          gps_accuracy: typeof draft.gps_accuracy === 'number' ? draft.gps_accuracy : null,
          attachments: Array.isArray(draft.attachments) && draft.attachments.length > 0 ? draft.attachments : null,
          ...verifiedColumns,
          follow_up_date: verifiedColumns.follow_up_date || parsedFollowUpDate || null,
        };

        const { error: visErr } = await supabase.from('customer_visits').insert(visitPayload);
        if (visErr) {
          await releaseVisitCode(supabase, consumed.id);
          console.error('[CatalogFlow] Visit insert error:', visErr.message);
          const reason = /column|schema cache/i.test(visErr.message || '')
            ? 'Visit verification columns are not applied yet. Ask an admin to apply the visit verification SQL.'
            : (visErr.message || 'Database write error');
          return `*Failed to log field visit for ${companyName}.*\n\nReason: ${reason}. Please try again.`;
        }

        // 2. Log KRA 9 (Site Visit)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 9,
          kra_type: 'site_visit',
          customer_name: companyName,
          description: `Customer Visit: ${companyName} (${draft.city_location}) - Met ${draft.person_met}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 3. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'site_visit',
          customer_name: companyName,
          description: `CRM Activity: Site Visit logged for ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 4. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Customer visit logged for ${companyName}${draft.city_location ? ` (${draft.city_location})` : ''}${draft.person_met ? ` - Met: ${draft.person_met}` : ''}`,
            module: 'Visits',
            customer_name: companyName,
            action_type: 'visit_logged',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_VISIT:', actErr?.message);
        }

        let extDetails = '';
        if (draft.designation) extDetails += `• *Designation:* ${draft.designation}\n`;
        if (draft.email) extDetails += `• *Email:* ${draft.email}\n`;
        if (draft.customer_type) extDetails += `• *Customer Type:* ${draft.customer_type}\n`;
        if (draft.visit_type) extDetails += `• *Visit Type:* ${draft.visit_type}\n`;
        if (draft.customer_probability) extDetails += `• *Customer Probability:* ${draft.customer_probability}\n`;
        if (draft.monthly_consumption) extDetails += `• *Monthly Consumption:* ${draft.monthly_consumption}\n`;
        if (draft.current_requirement) extDetails += `• *Current Requirement:* ${draft.current_requirement}\n`;
        if (draft.product_details) extDetails += `• *Product Details:* ${draft.product_details}\n`;
        if (draft.preferred_make) extDetails += `• *Preferred Make:* ${draft.preferred_make}\n`;
        if (draft.payment_terms) extDetails += `• *Payment Terms:* ${draft.payment_terms}\n`;
        if (draft.delivery_location) extDetails += `• *Delivery Location:* ${draft.delivery_location}\n`;
        if (draft.next_purchase_expected) extDetails += `• *Next Purchase Expected:* ${draft.next_purchase_expected}\n`;

        let fuLines = '';
        if (draft.followup_action) {
          fuLines += `• *Follow-up Action:* ${draft.followup_action}\n`;
          if (parsedFollowUpDate) {
            fuLines += `• *Follow-up Date:* ${formatDateDDMMYYYY(new Date(parsedFollowUpDate))}\n`;
          }
          fuLines += `• *Follow-up Status:* Pending\n`;
        }

        return `*Customer Field Visit Logged Successfully!*\n\n` +
          `• *Customer / Company:* ${companyName}\n` +
          `• *Person Met:* ${draft.person_met}\n` +
          `• *Contact Phone:* ${draft.contact_phone}\n` +
          `• *City / Location:* ${draft.city_location}\n` +
          `• *Visit Date:* ${draft.visit_date}\n` +
          `• *Visit Outcome:* ${draft.visit_outcome}\n` +
          extDetails +
          fuLines +
          `• *Meeting Remarks:* ${draft.meeting_remarks}\n\n` +
          `Logged to Customer Visits Card!`;
      }

      case 'UPDATE_VISIT': {
        const canUpdate = await canUserUpdateVisits(senderPhone);
        if (!canUpdate) {
          return `Access Denied: Field visits can only be updated by Sales Managers and Administrators.`;
        }

        const companyName = (draft.company_name || '').trim();
        const visitId = (draft.visit_id || '').trim();
        const targetDateIso = getStrictVisitDateIso(draft.visit_date);

        const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
        const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
        const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

        let visitQuery = supabase.from('customer_visits').select('*').order('visited_at', { ascending: false });
        if (!scope.isAdmin && targetPhones.length > 0) {
          visitQuery = visitQuery.in('salesperson_phone', targetPhones);
        }
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitId);
        if (visitId && isUUID) {
          visitQuery = visitQuery.eq('id', visitId);
        } else if (companyName) {
          visitQuery = visitQuery.ilike('customer_name', `%${companyName}%`);
        }
        const { data: allVisits } = await visitQuery.limit(50);

        // 1. Accessibility filtering by salesperson phone
        let candidateVisits = (allVisits || []).filter(v => {
          if (scope.isAdmin || scope.phones === null) return true;
          return isPhoneInScope(v.salesperson_phone, targetPhones);
        });

        // A partial name like "Steel" also pulls other companies' visits; prefer the matching customer
        if (!visitId && companyName) {
          const sameCustomer = candidateVisits.filter(v => isCustomerMatch(companyName, null, v.customer_name, null));
          if (sameCustomer.length > 0) candidateVisits = sameCustomer;
        }

        // 2. Separate real site visits from Bigin sync placeholder visits
        const realVisits = candidateVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
        const pool = realVisits.length > 0 ? realVisits : candidateVisits;

        // 3. Match by visit_id, then by date, then only if a single visit is left
        const ambiguousVisitReply = (count) =>
          `❌ *${count} visits match "${companyName || 'this customer'}"*, so nothing was updated.\n\nPlease start the update again and pick the exact visit from the list (or mention the visit date).`;
        let targetVisit = null;
        if (visitId) {
          targetVisit = pool.find(v => v.id === visitId || v.id.toLowerCase().includes(visitId.toLowerCase())) || null;
          if (!targetVisit) {
            return `❌ Could not find the selected visit record for "${companyName || visitId}". Please start the update again and pick the visit from the list.`;
          }
        }
        if (!targetVisit && targetDateIso) {
          const targetDay = formatIsoDateIST(new Date(targetDateIso));
          const sameDay = pool.filter(v => v.visited_at && formatIsoDateIST(new Date(v.visited_at)) === targetDay);
          if (sameDay.length === 1) targetVisit = sameDay[0];
          else if (sameDay.length > 1) return ambiguousVisitReply(sameDay.length);
        }

        if (!targetVisit) {
          if (pool.length === 1) targetVisit = pool[0];
          else if (pool.length > 1) return ambiguousVisitReply(pool.length);
        }

        if (!targetVisit) {
          return `❌ Could not find an existing customer visit record for "${companyName || visitId}". Please check the customer name and try again.`;
        }

        const updates = draft.updates || {};
        const visitUpdates = {};

        // 1. Extract existing metadata from targetVisit to preserve unedited tags
        const existingOutcome = targetVisit.outcome || targetVisit.remarks?.match(/\[Outcome:\s*([^\]]+)\]/i)?.[1] || null;
        const existingLoc = targetVisit.customer_address || targetVisit.location || targetVisit.remarks?.match(/\[Location:\s*([^\]]+)\]/i)?.[1] || null;
        const existingFollowup = targetVisit.follow_up_action || targetVisit.remarks?.match(/\[(?:Follow-?Up|Follow-?up\s*Action):\s*([^\]]+)\]/i)?.[1] || targetVisit.remarks?.match(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*([^|\]\n]+)/i)?.[1] || null;
        const existingFollowupDate = targetVisit.follow_up_date || targetVisit.remarks?.match(/\[Follow-?UpDate:\s*([^\]]+)\]/i)?.[1] || null;
        const existingFollowupStatus = targetVisit.follow_up_status || targetVisit.remarks?.match(/\[Follow-?UpStatus:\s*([^\]]+)\]/i)?.[1] || (existingFollowup ? 'pending' : null);

        const cleanExistingRemarks = (targetVisit.remarks || '')
          .replace(/\[(?:Outcome|Location|Follow-?Up|Follow-?up\s*Action|Follow-?UpDate|Follow-?UpStatus|Requirement|Requirements|Interests?):[^\]]*\]\s*/gi, '')
          .replace(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*[^|\n]+/gi, '')
          .replace(/^[\s|]+|[\s|]+$/g, '')
          .trim();

        // 2. Compute updated values
        const newOutcome = updates.visit_outcome || existingOutcome || null;
        const newLocation = updates.city_location || existingLoc || null;

        let newFollowup = existingFollowup;
        let newFollowupDate = existingFollowupDate;
        let newFollowupStatus = existingFollowupStatus;

        if (updates.followup_action !== undefined && updates.followup_action !== null && updates.followup_action !== '') {
          newFollowup = updates.followup_action;
          newFollowupStatus = 'pending';
          const visitBaseDate = (updates.visit_date && parseUserDateToISOStrict(updates.visit_date)) || targetVisit.visited_at || targetVisit.created_at || Date.now();
          const parsedFuDate = extractFollowUpDate(updates.followup_action, visitBaseDate);
          if (parsedFuDate) {
            newFollowupDate = parsedFuDate;
          }
        }

        // Completion detection
        const isExplicitCompleted = updates.status && /^(?:completed|done|resolved|closed)$/i.test(String(updates.status).trim());
        const isRemarksCompleted = updates.meeting_remarks && isAffirmativeCompletionRemark(updates.meeting_remarks) && !updates.followup_action;

        if (isExplicitCompleted || isRemarksCompleted) {
          newFollowupStatus = 'completed';
          visitUpdates.follow_up_completed_at = new Date().toISOString();
        }

        let newRemarksText = cleanExistingRemarks;
        if (updates.meeting_remarks !== undefined && updates.meeting_remarks !== null && updates.meeting_remarks !== '') {
          newRemarksText = updates.meeting_remarks.trim();
        }

        // 3. Construct structured remarks string matching LOG_VISIT
        const outcomeTag = newOutcome ? `[Outcome: ${newOutcome}] ` : '';
        const locTag = newLocation ? `[Location: ${newLocation}] ` : '';
        const followupTag = newFollowup ? `[FollowUp: ${newFollowup}] ` : '';
        const fuDateTag = newFollowupDate ? `[FollowUpDate: ${newFollowupDate}] ` : '';
        const fuStatusTag = newFollowupStatus ? `[FollowUpStatus: ${newFollowupStatus}] ` : '';

        visitUpdates.remarks = `${outcomeTag}${locTag}${followupTag}${fuDateTag}${fuStatusTag}${newRemarksText}`.trim();

        if (newFollowup !== null && newFollowup !== undefined) visitUpdates.follow_up_action = newFollowup;
        if (newFollowupDate !== null && newFollowupDate !== undefined) visitUpdates.follow_up_date = newFollowupDate;
        if (newFollowupStatus !== null && newFollowupStatus !== undefined) visitUpdates.follow_up_status = newFollowupStatus;

        if (updates.person_met) visitUpdates.person_met = updates.person_met;
        if (updates.contact_phone) visitUpdates.contact_no = cleanPhone(updates.contact_phone) || updates.contact_phone;
        if (newLocation) visitUpdates.customer_address = newLocation;
        const visitNotices = [];
        if (updates.visit_date) {
          const visitDateIsoStrict = parseUserDateToISOStrict(updates.visit_date);
          if (visitDateIsoStrict) {
            visitUpdates.visited_at = visitDateIsoStrict;
          } else {
            visitNotices.push(`⚠️ Visit date "${updates.visit_date}" was not understood, so the existing visit date was kept. Please send it as DD-MM-YYYY.`);
          }
        }
        if (updates.visit_outcome) visitUpdates.outcome = newOutcome;
        if (updates.email) visitUpdates.email = updates.email;
        if (updates.designation) visitUpdates.designation = updates.designation;
        if (updates.customer_type) visitUpdates.customer_type = updates.customer_type;
        if (updates.visit_type) visitUpdates.visit_type = updates.visit_type;
        if (updates.customer_probability) visitUpdates.customer_probability = updates.customer_probability;
        if (updates.product_details) visitUpdates.product_details = updates.product_details;
        if (updates.monthly_consumption) visitUpdates.monthly_consumption = updates.monthly_consumption;
        if (updates.current_requirement) visitUpdates.current_requirement = updates.current_requirement;
        if (updates.next_purchase_expected) visitUpdates.next_purchase_expected = updates.next_purchase_expected;
        if (updates.delivery_location) visitUpdates.delivery_location = updates.delivery_location;
        if (updates.preferred_make) visitUpdates.preferred_make = updates.preferred_make;
        if (updates.payment_terms) visitUpdates.payment_terms = updates.payment_terms;

        // Photo & attachments handling for UPDATE_VISIT (User can only ADD new photos, cannot replace existing)
        let existingAttachments = [];
        if (Array.isArray(targetVisit.attachments)) {
          existingAttachments = [...targetVisit.attachments];
        } else if (typeof targetVisit.attachments === 'string') {
          try {
            const parsed = JSON.parse(targetVisit.attachments);
            if (Array.isArray(parsed)) existingAttachments = parsed;
          } catch (e) {}
        }

        const newAttachmentsToAdd = [
          ...(Array.isArray(updates.new_attachments) ? updates.new_attachments : []),
          ...(Array.isArray(updates.attachments) ? updates.attachments : []),
          ...(Array.isArray(draft.attachments) ? draft.attachments : []),
        ];

        const existingUrls = new Set(existingAttachments.map(a => a && a.url).filter(Boolean));
        const distinctNew = newAttachmentsToAdd.filter(a => a && a.url && !existingUrls.has(a.url));

        if (distinctNew.length > 0) {
          visitUpdates.attachments = [...existingAttachments, ...distinctNew];
          // Never replace previously added pic: only populate gps_photo_url if not set
          if (!targetVisit.gps_photo_url) {
            visitUpdates.gps_photo_url = distinctNew[0].url;
          }
        }

        const updLat = updates.gps_latitude ?? draft.gps_latitude;
        const updLng = updates.gps_longitude ?? draft.gps_longitude;
        const updAcc = updates.gps_accuracy ?? draft.gps_accuracy;
        if (typeof updLat === 'number' && typeof updLng === 'number') {
          if (!targetVisit.gps_latitude || !targetVisit.gps_longitude) {
            visitUpdates.gps_latitude = updLat;
            visitUpdates.gps_longitude = updLng;
            if (typeof updAcc === 'number') visitUpdates.gps_accuracy = updAcc;
          }
        }

        const resolvedCust = targetVisit ? targetVisit.customer_name : (draft.company_name || 'Customer');

        if (Object.keys(visitUpdates).length > 0) {
          const { error: updErr } = await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
          if (updErr) {
            console.error('[CatalogFlow] Visit update error with dedicated columns, retrying fallback:', updErr.message);
            delete visitUpdates.follow_up_action;
            delete visitUpdates.follow_up_date;
            delete visitUpdates.follow_up_status;
            delete visitUpdates.follow_up_completed_at;
            const { error: fbUpdErr } = await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
            if (fbUpdErr) {
              console.error('[CatalogFlow] Visit fallback update error, retrying without attachments/gps:', fbUpdErr.message);
              delete visitUpdates.attachments;
              delete visitUpdates.gps_photo_url;
              delete visitUpdates.gps_latitude;
              delete visitUpdates.gps_longitude;
              delete visitUpdates.gps_accuracy;
              const { error: thirdUpdErr } = await supabase.from('customer_visits').update(visitUpdates).eq('id', targetVisit.id);
              if (thirdUpdErr) {
                console.error('[CatalogFlow] Visit third fallback update error:', thirdUpdErr.message);
                return `*Failed to update customer visit for ${resolvedCust}.*\n\nReason: ${thirdUpdErr.message || 'Database write error'}. Please try again.`;
              }
            }
          }

          // Sync customer master profile if contact details changed
          if (updates.person_met || updates.contact_phone || updates.city_location) {
            const custUpdates = { updated_at: new Date().toISOString() };
            if (updates.person_met) custUpdates.contact_person = updates.person_met;
            if (updates.contact_phone) custUpdates.customer_phone = cleanPhone(updates.contact_phone) || updates.contact_phone;
            if (updates.city_location) custUpdates.customer_address = updates.city_location;
            const exactCustomerName = String(targetVisit.customer_name || '').trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
            if (exactCustomerName) {
              await supabase
                .from('recurring_customers')
                .update(custUpdates)
                .ilike('customer_name', exactCustomerName);
            }
          }
        }

        let updatesSummary = '';
        if (distinctNew.length > 0) updatesSummary += `• *Photos Added:* ${distinctNew.length} new photo(s) attached\n`;
        if (visitUpdates.gps_latitude && visitUpdates.gps_longitude) updatesSummary += `• *GPS Tag:* ${visitUpdates.gps_latitude.toFixed(6)}, ${visitUpdates.gps_longitude.toFixed(6)}\n`;
        if (visitUpdates.person_met) updatesSummary += `• *Person Met:* ${visitUpdates.person_met}\n`;
        if (visitUpdates.designation) updatesSummary += `• *Designation:* ${visitUpdates.designation}\n`;
        if (visitUpdates.contact_no) updatesSummary += `• *Contact Phone:* ${visitUpdates.contact_no}\n`;
        if (visitUpdates.email) updatesSummary += `• *Email:* ${visitUpdates.email}\n`;
        if (visitUpdates.customer_address && updates.city_location) updatesSummary += `• *City / Location:* ${visitUpdates.customer_address}\n`;
        if (visitUpdates.visited_at && updates.visit_date) updatesSummary += `• *Visit Date:* ${formatDateDDMMYYYY(visitUpdates.visited_at)}\n`;
        if (updates.visit_outcome) updatesSummary += `• *Visit Outcome:* ${newOutcome}\n`;
        if (visitUpdates.customer_type) updatesSummary += `• *Customer Type:* ${visitUpdates.customer_type}\n`;
        if (visitUpdates.visit_type) updatesSummary += `• *Visit Type:* ${visitUpdates.visit_type}\n`;
        if (visitUpdates.customer_probability) updatesSummary += `• *Customer Probability:* ${visitUpdates.customer_probability}\n`;
        if (visitUpdates.product_details) updatesSummary += `• *Product Details:* ${visitUpdates.product_details}\n`;
        if (visitUpdates.monthly_consumption) updatesSummary += `• *Monthly Consumption:* ${visitUpdates.monthly_consumption}\n`;
        if (visitUpdates.current_requirement) updatesSummary += `• *Current Requirement:* ${visitUpdates.current_requirement}\n`;
        if (visitUpdates.next_purchase_expected) updatesSummary += `• *Next Purchase Expected:* ${visitUpdates.next_purchase_expected}\n`;
        if (visitUpdates.delivery_location) updatesSummary += `• *Delivery Location:* ${visitUpdates.delivery_location}\n`;
        if (visitUpdates.preferred_make) updatesSummary += `• *Preferred Make:* ${visitUpdates.preferred_make}\n`;
        if (visitUpdates.payment_terms) updatesSummary += `• *Payment Terms:* ${visitUpdates.payment_terms}\n`;
        if (updates.followup_action) {
          updatesSummary += `• *Follow-up Action:* ${visitUpdates.follow_up_action}\n`;
          if (visitUpdates.follow_up_date) {
            const fuDateObj = new Date(visitUpdates.follow_up_date);
            const fuDateStr = !isNaN(fuDateObj.getTime()) ? formatDateDDMMYYYY(fuDateObj) : visitUpdates.follow_up_date;
            updatesSummary += `• *Follow-up Date:* ${fuDateStr}\n`;
          }
          if (visitUpdates.follow_up_status) {
            updatesSummary += `• *Follow-up Status:* ${visitUpdates.follow_up_status.charAt(0).toUpperCase() + visitUpdates.follow_up_status.slice(1)}\n`;
          }
        } else if (newFollowupStatus && (isExplicitCompleted || isRemarksCompleted)) {
          updatesSummary += `• *Follow-up Status:* Completed\n`;
        }
        if (updates.meeting_remarks) updatesSummary += `• *Meeting Remarks:* ${updates.meeting_remarks}\n`;

        // Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Customer visit updated for ${resolvedCust}${visitUpdates.follow_up_action ? ` (Follow-up: ${visitUpdates.follow_up_action})` : ''}`,
            module: 'Visits',
            customer_name: resolvedCust,
            entity_id: targetVisit?.id,
            entity_type: 'visit',
            action_type: 'visit_updated',
            change_detail: visitUpdates,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for UPDATE_VISIT:', actErr?.message);
        }

        return `*Field Visit Updated Successfully!*\n\n` +
          `• *Customer / Company:* ${resolvedCust}\n` +
          updatesSummary +
          (visitNotices.length > 0 ? `\n${visitNotices.join('\n')}\n` : '') +
          `\nVisit details updated in Customer Visits Card!`;
      }

      case 'LOG_NEW_CUSTOMER': {
        const companyName = String(draft.company_name || '').trim();
        const contactPerson = draft.contact_person ? String(draft.contact_person).trim() : null;
        const mobileNumber = cleanPhone(draft.mobile_number || draft.phone || draft.contact_phone);
        const deliveryLoc = (draft.delivery_location || draft.city_location || draft.address || '').trim() || null;
        const gstNum = (draft.gst_number || draft.gst || '').trim() || null;
        const email = draft.email ? String(draft.email).trim() : null;

        // 1. Exact duplicate check across recurring_customers
        const regCheck = await checkCompanyWideCustomerRegistration(companyName, senderPhone);
        if (regCheck && regCheck.isRegistered) {
          return regCheck.conflictMessage;
        }

        // 2. Insert new record into recurring_customers
        const { data: newCust, error: custErr } = await supabase
          .from('recurring_customers')
          .insert({
            customer_name: companyName,
            contact_person: contactPerson,
            customer_phone: mobileNumber || null,
            customer_address: deliveryLoc,
            customer_gst: gstNum,
            notes: email ? `Email: ${email}` : null,
            assigned_salesperson_phone: senderPhone,
            is_active: true,
            avg_order_frequency_days: 30,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (custErr || !newCust) {
          console.error('[CatalogFlow] Customer insert error:', custErr);
          return `❌ *Failed to add customer ${companyName}.*\n\nReason: ${custErr?.message || 'Database write error'}. Please try again.`;
        }

        // 3. Log KRA 2 (New Customer Acquisition)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 2,
          kra_type: 'new_customer',
          customer_name: companyName,
          description: `New Customer Acquired: ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 4. Log KRA 6 (CRM Compliance)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 6,
          kra_type: 'new_customer',
          customer_name: companyName,
          description: `Added New Customer: ${companyName}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: new Date().toISOString(),
        });

        // 5. Log to activity_logs
        try {
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New customer acquired: ${companyName}${contactPerson ? ` (${contactPerson})` : ''}`,
            module: 'Customers',
            customer_name: companyName,
            entity_id: newCust.id,
            entity_type: 'customer',
            action_type: 'customer_created',
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice for LOG_NEW_CUSTOMER:', actErr?.message);
        }

        return `🎉 *New Customer Successfully Added!*\n\n` +
          `• *Company Name:* ${companyName}\n` +
          `• *Contact Person:* ${contactPerson || 'N/A'}\n` +
          `• *Mobile Number:* ${mobileNumber || 'N/A'}\n` +
          `• *Delivery Location:* ${deliveryLoc || 'N/A'}\n` +
          (email ? `• *Email:* ${email}\n` : '') +
          (gstNum ? `• *GST Number:* ${gstNum}\n` : '') +
          `\nCustomer record created & added to your portfolio! ✅`;
      }

      case 'LOG_COMPLAINT': {
        const companyName = (draft.company_name || 'Customer').trim();
        await ensureCustomerRecord(companyName, senderPhone, { allowCreate: true });

        const nowIso = new Date().toISOString();
        const slaDueAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
        const normalizedType = normalizeComplaintType(draft.complaint_type || 'quality');

        // Extract affected product
        let product = (draft.affected_product || draft.product_name || '').trim();
        if (!product && draft.complaint_description) {
          product = extractProductFromText(draft.complaint_description) || '';
        }
        if (!product) {
          product = 'Steel Material';
        }

        // If deal_id / po_number wasn't already resolved in draft, resolve via checkOrdersForComplaint
        let targetDealId = draft.deal_id || null;
        let targetPoNumber = draft.po_number || null;

        if (!targetDealId) {
          const ordCheck = await checkOrdersForComplaint('LOG_COMPLAINT', draft, senderPhone);
          if (ordCheck && ordCheck.draft && ordCheck.draft.deal_id) {
            targetDealId = ordCheck.draft.deal_id;
            targetPoNumber = ordCheck.draft.po_number || null;
            if (!draft.affected_product && ordCheck.draft.affected_product) {
              product = ordCheck.draft.affected_product;
            }
          }
        }

        // Clean description of any "Status: In Progress" prefixes
        const sanitizedDesc = (draft.complaint_description || '')
          .replace(/^status:\s*(?:in progress|pending|open|resolved|closed)[,\s]*/i, '')
          .trim() || draft.complaint_description || product;

        // 1. Insert into complaints (ALWAYS status: 'open')
        let cmpDateIso = nowIso;
        if (draft.complaint_date) {
          const parsed = parseDDMMYYYYtoISO(draft.complaint_date);
          if (parsed) cmpDateIso = parsed;
        }

        let resDateIso = null;
        if (draft.resolution_date) {
          const parsedRes = parseDDMMYYYYtoISO(draft.resolution_date);
          if (parsedRes) resDateIso = parsedRes;
        }

        let storedAttachments = Array.isArray(draft.attachments) ? draft.attachments : [];
        if (storedAttachments.length > 0) {
          try {
            storedAttachments = await persistComplaintAttachments(storedAttachments, senderPhone);
          } catch (storageErr) {
            console.error('[CatalogFlow] Complaint evidence storage error:', storageErr.message);
            return `❌ *Failed to store complaint evidence for ${companyName}.*\n\nReason: ${storageErr.message}`;
          }
        }

        const attachmentsPayload = storedAttachments.length > 0
          ? storedAttachments.map(a => ({
              file_url: a.file_url || a.url,
              file_name: a.file_name || a.name || `evidence-${Date.now()}`,
              file_type: a.file_type || a.type || 'image/jpeg',
              file_size: a.file_size || null,
              uploaded_at: a.uploaded_at || nowIso,
            }))
          : [];

        const mediaUrls = attachmentsPayload.map(a => a.file_url).filter(Boolean);

        const complaintPayload = {
          customer_name: companyName,
          complaint_date: cmpDateIso,
          raised_by: (draft.raised_by || draft.contact_person || draft.person_met || '').trim() || null,
          complaint_type: normalizedType,
          description: sanitizedDesc,
          reported_by: senderPhone,
          status: 'open',
          po_number: targetPoNumber,
          deal_id: targetDealId,
          challan_no: (draft.challan_no || '').trim() || null,
          product_name: product || null,
          affected_product: product || null,
          corrective_action: draft.corrective_action || null,
          customer_communication: draft.customer_communication || null,
          resolution_notes: draft.resolution_notes || null,
          resolution_date: resDateIso,
          reported_at: nowIso,
          created_at: nowIso,
          sla_due_at: slaDueAt,
        };

        const { data: insertedCmp, error: cmpErr } = await supabase
          .from('complaints')
          .insert(complaintPayload)
          .select()
          .single();

        let createdComplaint = insertedCmp;

        if (cmpErr) {
          console.error('[CatalogFlow] Complaint insert error, retrying without optional columns:', cmpErr.message);
          const fallbackPayload = { ...complaintPayload };
          delete fallbackPayload.complaint_date;
          delete fallbackPayload.challan_no;
          delete fallbackPayload.customer_communication;
          delete fallbackPayload.resolution_notes;
          delete fallbackPayload.resolution_date;
          const { data: fbData, error: fbErr } = await supabase
            .from('complaints')
            .insert(fallbackPayload)
            .select()
            .single();
          if (fbErr) {
            console.error('[CatalogFlow] Fallback complaint insert error:', fbErr.message);
            return `❌ *Failed to log complaint for ${companyName}.*\n\nReason: ${fbErr.message || cmpErr.message || 'Database write error'}. Please try again.`;
          }
          createdComplaint = fbData;
        }

        // Insert evidence attachments into complaint_attachments table
        if (createdComplaint?.id && attachmentsPayload.length > 0) {
          try {
            const attRows = attachmentsPayload.map(a => ({
              complaint_id: createdComplaint.id,
              file_url: a.file_url,
              file_name: a.file_name,
              file_type: a.file_type,
              uploaded_at: a.uploaded_at || nowIso,
            }));
            const { error: attInsertErr } = await supabase.from('complaint_attachments').insert(attRows);
            if (attInsertErr) {
              console.warn('[CatalogFlow] Non-blocking complaint_attachments insert notice:', attInsertErr.message);
            }
          } catch (attErr) {
            console.warn('[CatalogFlow] Non-blocking complaint_attachments insert notice:', attErr?.message);
          }
        }

        // 2. Log KRA 7 (Quality Complaint)
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 7,
          kra_type: 'quality_complaint',
          customer_name: companyName,
          description: `Complaint Logged: ${companyName} - ${normalizedType}: ${sanitizedDesc}`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: nowIso,
        });

        // 3. Log bot activity
        try {
          const { logBotActivity } = require('../utils/activityLogger');
          const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.replace(/-/g, '').substring(0, 6).toUpperCase()) : '';
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `New complaint logged for ${companyName}${targetPoNumber ? ` (PO: ${targetPoNumber})` : cleanCode ? ` (Inquiry: INQ-${cleanCode})` : ''}`,
            module: 'Complaints',
            customer_name: companyName,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice:', actErr?.message);
        }

        // 4. Auto-resolve pending follow-up tasks
        try {
          const { resolveCustomerFollowupTasks } = require('../kra3');
          await resolveCustomerFollowupTasks(companyName, senderPhone, 'complaint_logged', targetDealId);
        } catch (rErr) {
          console.warn('[CatalogFlow] Follow-up auto-resolution notice:', rErr.message);
        }

        let linkedDisplay = '';
        const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.replace(/-/g, '').substring(0, 6).toUpperCase()) : '';
        if (targetPoNumber) {
          linkedDisplay = `• *Linked Order / Ref:* PO: ${targetPoNumber}${cleanCode ? ` (INQ-${cleanCode})` : ''}\n`;
        } else if (targetDealId) {
          linkedDisplay = `• *Linked Order / Ref:* INQ-${cleanCode}\n`;
        } else if (draft.linked_inquiry_or_po) {
          linkedDisplay = `• *Linked Order / Ref:* ${draft.linked_inquiry_or_po}\n`;
        } else if (draft._unlinked_complaint) {
          linkedDisplay = `• *Linked Order / Ref:* Not linked (general complaint)\n`;
        }

        const attCount = attachmentsPayload.length;
        return `⚠️ *Customer Complaint Logged Successfully!*\n\n` +
          `• *Customer / Company:* ${companyName}\n` +
          `• *Complaint Date:* ${draft.complaint_date || formatDateDDMMYYYY(new Date())}\n` +
          `• *Complaint Raised By:* ${draft.raised_by || draft.contact_person || draft.person_met || 'N/A'}\n` +
          linkedDisplay +
          (product ? `• *Product / Material:* ${product}\n` : '') +
          `• *Complaint Type:* ${normalizedType}\n` +
          (draft.challan_no ? `• *Invoice / Challan No.:* ${draft.challan_no}\n` : '') +
          `• *Description:* ${sanitizedDesc}\n` +
          (attCount > 0 ? `• *Evidence:* ${attCount} file(s) attached\n` : '') +
          (draft.corrective_action ? `• *Corrective Action:* ${draft.corrective_action}\n` : '') +
          (draft.customer_communication ? `• *Customer Communication:* ${draft.customer_communication}\n` : '') +
          (draft.resolution_notes ? `• *Resolution Notes:* ${draft.resolution_notes}\n` : '') +
          (draft.resolution_date ? `• *Resolution Date:* ${draft.resolution_date}\n` : '') +
          `• *Status:* Open (48-Hour SLA Clock Started)\n\n` +
          `Logged to Customer Complaints Card! (48h SLA Active) ⏱️`;
      }

      case 'UPDATE_COMPLAINT': {
        const matchedCmp = await findAndMatchComplaint(draft, senderPhone);

        if (!matchedCmp) {
          const refDisplay = draft.company_name || draft.linked_inquiry_or_po || 'specified reference';
          return `⚠️ Could not find an active complaint for *${refDisplay}*.\n\nPlease verify the Customer Name, Inquiry ID, or PO Number.`;
        }

        const updates = draft.updates || {};
        const cmpUpdates = {};
        const cmpNotices = [];

        if (updates.raised_by || updates.contact_person) {
          cmpUpdates.raised_by = (updates.raised_by || updates.contact_person).trim();
        }
        if (updates.complaint_type) cmpUpdates.complaint_type = normalizeComplaintType(updates.complaint_type);
        if (updates.complaint_description || updates.description) cmpUpdates.description = updates.complaint_description || updates.description;
        if (updates.resolution_notes) cmpUpdates.resolution_notes = updates.resolution_notes;
        const isResolved = updates.status && ['resolved', 'closed'].includes(String(updates.status).toLowerCase());
        if (updates.status) {
          let st = String(updates.status).toLowerCase().trim();
          if (st === 'reopen' || st === 're-open' || st === 're-opened') st = 'reopened';
          cmpUpdates.status = st;
          // Reopening: the complaint must no longer look resolved anywhere (resolved_at drives "resolved" checks)
          const wasResolved = Boolean(matchedCmp.resolved_at) || ['resolved', 'closed'].includes(String(matchedCmp.status || '').toLowerCase());
          if (!isResolved && wasResolved && ['reopened', 'open', 'pending', 'in progress', 'in_progress'].includes(st)) {
            cmpUpdates.resolved_at = null;
            cmpUpdates.resolution_time_hrs = null;
          }
          if (isResolved) {
            const { isInvalidOrGenericResolutionNotes } = require('../kra8');
            if (isInvalidOrGenericResolutionNotes(updates.resolution_notes, matchedCmp.customer_name)) {
              return `⚠️ *Resolution Notes Required for ${matchedCmp.customer_name}*\n\nA complaint cannot be marked as resolved without providing resolution notes. Please provide the resolution details first.`;
            }
            const now = new Date();
            cmpUpdates.resolved_at = now.toISOString();
            const reportedAt = new Date(matchedCmp.reported_at || matchedCmp.created_at || Date.now());
            const resolutionHrs = Math.max(1, Math.round((now.getTime() - reportedAt.getTime()) / (1000 * 60 * 60)));
            cmpUpdates.resolution_time_hrs = resolutionHrs;
            cmpUpdates.escalated = resolutionHrs > 48;

            // Log to kra_logs (KRA 8)
            try {
              await supabase.from('kra_logs').insert({
                salesperson_phone: senderPhone,
                kra_number: 8,
                kra_type: 'complaint_resolved',
                description: `Complaint Resolved: ${matchedCmp.customer_name} (${resolutionHrs}h - ${resolutionHrs <= 48 ? 'Within SLA ✅' : 'SLA BREACHED ⚠️'})`,
                customer_name: matchedCmp.customer_name,
                month: now.getMonth() + 1,
                year: now.getFullYear(),
                created_at: now.toISOString(),
              });
            } catch (kraErr) {
              console.warn('[CatalogFlow] KRA8 logging notice:', kraErr.message);
            }

            // Auto-resolve follow-up tasks
            try {
              const { resolveCustomerFollowupTasks } = require('../kra3');
              await resolveCustomerFollowupTasks(matchedCmp.customer_name, senderPhone, 'complaint_resolved', matchedCmp.deal_id);
            } catch (rErr) {
              console.warn('[CatalogFlow] Follow-up auto-resolution notice:', rErr.message);
            }
          }
        }

        if (Object.keys(cmpUpdates).length === 0) {
          return `ℹ️ No updates were provided for the complaint of *${matchedCmp.customer_name}*.${cmpNotices.length > 0 ? `\n\n${cmpNotices.join('\n')}` : ''}`;
        }

        const { error: updateErr } = await supabase
          .from('complaints')
          .update(cmpUpdates)
          .eq('id', matchedCmp.id);

        if (updateErr) {
          console.error('[CatalogFlow] Supabase complaint update error, retrying without optional columns:', updateErr.message);
          const fallbackUpdates = { ...cmpUpdates };
          delete fallbackUpdates.raised_by;
          delete fallbackUpdates.resolution_notes;

          if (Object.keys(fallbackUpdates).length > 0) {
            const { error: fbErr } = await supabase
              .from('complaints')
              .update(fallbackUpdates)
              .eq('id', matchedCmp.id);
            if (fbErr) {
              console.error('[CatalogFlow] Fallback complaint update error:', fbErr.message);
              return `❌ *Failed to update complaint for ${matchedCmp.customer_name}.*\n\nReason: ${fbErr.message || updateErr.message || 'Database write error'}. Please try again.`;
            }
          } else {
            return `❌ *Failed to update complaint for ${matchedCmp.customer_name}.*\n\nReason: ${updateErr.message || 'Database write error'}. Please try again.`;
          }
        }

        // Log to activity_logs
        try {
          const { logBotActivity } = require('../utils/activityLogger');
          logBotActivity({
            salesperson_phone: senderPhone,
            description: `Complaint updated for ${matchedCmp.customer_name}: ${Object.entries(cmpUpdates).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            module: 'Complaints',
            customer_name: matchedCmp.customer_name,
          });
        } catch (actErr) {
          console.warn('[CatalogFlow] Activity log notice:', actErr?.message);
        }

        const cleanCmpCode = matchedCmp.deal_id ? matchedCmp.deal_id.replace(/^#?(?:INQ|DEAL)-?/i, '').substring(0, 6).toUpperCase() : '';
        const linkedOrderRef = matchedCmp.po_number
          ? `PO: ${matchedCmp.po_number}${cleanCmpCode ? ` (INQ-${cleanCmpCode})` : ''}`
          : matchedCmp.deal_id
          ? `INQ-${cleanCmpCode}`
          : '';

        if (isResolved) {
          const resolutionHrs = cmpUpdates.resolution_time_hrs || 1;
          const isSlaCompliant = resolutionHrs <= 48;
          return `✅ *Customer Complaint Resolved Successfully!*\n\n` +
            `• *Customer / Company:* ${matchedCmp.customer_name}\n` +
            (cmpUpdates.raised_by ? `• *Complaint Raised By:* ${cmpUpdates.raised_by}\n` : '') +
            (linkedOrderRef ? `• *Linked Order / Ref:* ${linkedOrderRef}\n` : '') +
            `• *Product / Material:* ${matchedCmp.product_name || matchedCmp.affected_product || 'Steel Material'}\n` +
            `• *Complaint Type:* ${cmpUpdates.complaint_type || matchedCmp.complaint_type || 'Quality Defect'}\n` +
            `• *Status:* ${updates.status || 'Resolved'}\n` +
            `• *Resolution Notes:* ${cmpUpdates.resolution_notes || 'Resolved'}\n` +
            `• *Resolution Time:* ${resolutionHrs} Hours\n` +
            `• *SLA Target (48h):* ${isSlaCompliant ? '✅ Achieved - Within SLA Target!' : '⚠️ Breached - Escalated!'}\n\n` +
            (cmpNotices.length > 0 ? `${cmpNotices.join('\n')}\n\n` : '') +
            `Updated details saved to Customer Complaints Card! ✅`;
        }

        let fieldsSummary = '';
        if (cmpUpdates.raised_by) fieldsSummary += `• *Complaint Raised By:* ${cmpUpdates.raised_by}\n`;
        if (cmpUpdates.complaint_type) fieldsSummary += `• *Complaint Type:* ${cmpUpdates.complaint_type}\n`;
        if (cmpUpdates.description) fieldsSummary += `• *Description:* ${cmpUpdates.description}\n`;
        if (updates.status) fieldsSummary += `• *Status:* ${updates.status}\n`;
        if (cmpUpdates.resolution_notes) fieldsSummary += `• *Resolution Notes:* ${cmpUpdates.resolution_notes}\n`;

        return `✅ *Customer Complaint Updated Successfully!*\n\n` +
          `• *Customer / Company:* ${matchedCmp.customer_name}\n` +
          (linkedOrderRef ? `• *Linked Order / Ref:* ${linkedOrderRef}\n` : '') +
          fieldsSummary +
          (cmpNotices.length > 0 ? `\n${cmpNotices.join('\n')}\n` : '') +
          `\nUpdated details saved to Customer Complaints Card! ✅`;
      }

      default:
        return `✅ Action ${action} completed successfully!`;
    }
  } catch (err) {
    console.error(`[CatalogFlow] Execution error for ${action}:`, err.message);
    return `❌ An error occurred while saving: ${err.message}. Please try again.`;
  }
}

// ── OPERATIONAL ACTION & QUERY DETECTION HELPERS ─────────────────────────────

/**
 * Detects queries asking for delivery tracking, dispatch status, vehicle tracking,
 * shipment in transit, or pending orders that haven't been delivered yet.
 * These are currently out of scope for the WhatsApp bot.
 */
function isOutOfScopeDeliveryQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // Guard: If it's pure data entry like "Delivery Location: Mumbai" or "Delivery: Pune" during form filling, NOT out of scope.
  if (/^(?:delivery\s*location|delivery\s*address|delivery\s*city|destination|target\s*delivery\s*date)\s*[:=-]/i.test(lower)) {
    return false;
  }
  // Guard: If it's asking "what is the delivery location on PO 123" -> in scope (delivery_location field)
  if (/\b(?:delivery\s+location|delivery\s+address|site\s+location)\b/i.test(lower) && 
      !/\b(?:deliver(?:ed|ing|y)?\s+(?:status|tracking|update|time|delay|kya|kab|pending)|undelivered|un-delivered|dispatch|transit|tracking|shipped|shipment|consignment|transporter|truck|vehicle|eway|e-way|lr\s*no|lorry)\b/i.test(lower)) {
    return false;
  }

  // Comprehensive Out-of-Scope Patterns for Delivery, Dispatch & Logistics Tracking
  const outOfScopePatterns = [
    // 1. Delivery status / tracking / progress / ETA
    /\b(?:delivery\s+status|delivery\s+tracking|track\s+(?:my\s+|the\s+)?delivery|track\s+(?:my\s+|the\s+)?order\s+delivery|live\s+delivery|delivery\s+update|delivery\s+progress|delivery\s+eta|delivery\s+timeline)\b/i,
    
    // 2. Undelivered / Pending delivery / Not delivered / Yet to be delivered
    /\b(?:haven'?t\s+been\s+delivered|hasn'?t\s+been\s+delivered|have\s+not\s+been\s+delivered|has\s+not\s+been\s+delivered|not\s+(?:yet\s+|been\s+|ever\s+)*delivered)\b/i,
    /\b(?:pending\s+deliver(?:y|ies)|undelivered|un-delivered|non-delivered|non\s+delivered|yet\s+to\s+be\s+delivered|waiting\s+(?:for\s+)?delivery|awaiting\s+delivery)\b/i,
    /\b(?:orders?\s+(?:that\s+)?(?:are\s+|have\s+)?(?:not\s+delivered|pending\s+delivery|in\s+transit|undelivered))\b/i,
    /\b(?:orders?\s+not\s+delivered|pending\s+orders?\s+not\s+delivered|orders?\s+pending\s+delivery|undelivered\s+(?:orders?|pos?|deals?|materials?|goods?))\b/i,
    
    // 3. Questions asking if delivered or when delivered
    /\b(?:has|have|is|was|will|got)\b.*\bdelivered\b/i,
    /\b(?:when\s+will\b.*\bdelivered)\b/i,
    
    // 4. Dispatch status / tracking / date / update
    /\b(?:dispatch\s+status|dispatched\s+status|dispatch\s+tracking|track\s+dispatch|dispatch\s+update|dispatch\s+details|dispatch\s+date|dispatched\s+date)\b/i,
    /\b(?:has|have|is|was|will|got)\b.*\bdispatched\b/i,
    /\b(?:when\s+will\b.*\bdispatched)\b/i,
    /\b(?:dispatched\s+yet|dispatched\s+kya|material\s+dispatched|order\s+dispatched)\b/i,
    
    // 5. In-transit, vehicle, truck & logistics tracking
    /\b(?:in\s+transit|material\s+in\s+transit|goods\s+in\s+transit|orders?\s+in\s+transit)\b/i,
    /\b(?:truck\s+status|truck\s+tracking|vehicle\s+tracking|vehicle\s+status|track\s+truck|track\s+vehicle|where\s+is\s+(?:the\s+|my\s+)?truck)\b/i,
    /\b(?:shipment\s+tracking|track\s+shipment|where\s+is\s+(?:the\s+|my\s+)?shipment|shipment\s+status|where\s+is\s+(?:the\s+|my\s+)?consignment)\b/i,
    /\b(?:logistics\s+status|logistics\s+tracking|transporter\s+details|transporter\s+status|lr\s+(?:no|number)|lorry\s+receipt|eway\s+bill|e-way\s+bill)\b/i,
    /\b(?:where\s+is\s+(?:my\s+|the\s+)?(?:order|delivery|material|consignment)\s*(?:currently|now|reached)?)\b/i,

    // 6. Hinglish delivery / dispatch / truck tracking questions
    /\b(?:deliver\s+(?:hua|ho\s+gaya|kab|nahi|ho\s+chuka))\b/i,
    /\b(?:delivery\s+(?:hui|kab|kahan|pending|nahi))\b/i,
    /\b(?:dispatch\s+(?:hua|ho\s+gaya|kab|nahi|kahan))\b/i,
    /\b(?:gaadi|truck|driver|vehicle)\b.*\b(?:nikli|nikla|kahan|kab|pahunch|aayeg|aaya)\b/i,
  ];

  return outOfScopePatterns.some((pattern) => pattern.test(lower));
}

/**
 * Detects whether a query is within the domain of Enlight Metals B2B SalesOS
 * (CRM entities, metal/steel products, customers, suppliers, sales metrics, or SOPs).
 */
function isSalesOsDomainQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // 1. Sales & CRM Domain Terms
  const salesTerms = /\b(?:inquir(?:y|ies)|enquir(?:y|ies)|deal|deals|order|orders|po[-_#\s]*\d*|purchase\s*order|visit|visits|visited|meeting|meetings|person\s*met|contact\s*person|contact\s*phone|mobile|complaint|complaints|defect|rejection|damage|claim|resolution|payment|payments|advance|outstanding|cheque|upi|neft|rtgs|ledger|balance|customer|customers|client|clients|party|parties|new\s*customer|customer\s*master|customer\s*360|pipeline|leaderboard|kra|target|achievement|churn|retention|reorder|loss|quote|quotes|quotation|quotations|rfq|rate|rates|bhav|price|pricing|discount|credit|payment\s*terms|delivery\s*location|sop|moq|policy|enlight|salesos|gst|gstin|pan|turnover|follow-?up|stage|pipeline)\b/i;

  // 2. Metal & Steel Products, Grades & Specifications
  const metalTerms = /\b(?:steel|metal|iron|coil|coils|sheet|sheets|plate|plates|tmt|pipe|pipes|tube|tubes|beam|beams|angle|angles|channel|channels|round|flat|flats|billet|billets|wire|hr|cr|gp|hrpo|galvalume|chequered|ms|ss|carbon|alloy|is\s*2062|e250|e350|fe500|fe550|ss304|ss316|ton|tons|tonne|tonnes|tonnage|mt|kg|pcs|pieces|sheets|bundles|thickness|width|length|grade|gauge|hsn|hsn_code|prime|secondary)\b/i;

  // 3. Known Mills, Major Suppliers & CRM Accounts
  const supplierTerms = /\b(?:jsw|sail|tata|tata\s*steel|jindal|jindal\s*steel|amns|posco|vedanta|arcelor|vizag|rashtriya|bhushan|shyam|electrosteel|apex|delta|mehta|om\s*traders|horizon|supreme)\b/i;

  // 4. System Entity IDs (INQ-*, PO-*, VIS-*, CMP-*, DEAL-*)
  const entityIdTerms = /\b(?:INQ|DEAL|PO|VIS|CMP)-[A-Z0-9-]+\b|#INQ-[A-Z0-9]+/i;

  return salesTerms.test(lower) || metalTerms.test(lower) || supplierTerms.test(lower) || entityIdTerms.test(text);
}

/**
 * Detects obvious generic, out-of-scope prompts (celebrities, sports, cricketers, trivia, science, coding, jokes, etc.)
 */
function isOutOfScopeGenericPrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // If it matches steel / sales domain terms, it is in-scope
  if (isSalesOsDomainQuery(text)) return false;

  const outOfScopePatterns = [
    /\b(?:virat|kohli|dhoni|rohit\s*sharma|sachin|cricket|ipl|football|messi|ronaldo|olympics|world\s*cup|match\s*score|cinema|movie|actor|actress|bollywood|hollywood)\b/i,
    /\b(?:who\s+is\s+(?:the\s+)?(?:president|prime\s*minister|pm|governor|actor|actress|singer|cricketer|player|captain|founder|ceo\s+of\s+(?!enlight)|king|queen))\b/i,
    /\b(?:capital\s+of|weather\s+(?:in|today|forecast)|temperature\s+in|distance\s+between|speed\s+of\s+light|photosynthesis|gravity|earthquake|solar\s+system|planet)\b/i,
    /\b(?:tell\s+(?:me\s+)?a\s+joke|make\s+me\s+laugh|write\s+(?:a\s+)?poem|sing\s+(?:a\s+)?song|recipe\s+for|how\s+to\s+cook|how\s+to\s+make\s+(?:tea|coffee|cake|pizza|biryani|paneer))\b/i,
    /\b(?:write\s+(?:a\s+)?(?:python|javascript|java|c\+\+|html|css|sql|code|script|program)|how\s+to\s+code|how\s+to\s+program)\b/i,
    /\b(?:how\s+are\s+you\s+feeling|who\s+created\s+you|who\s+made\s+you|are\s+you\s+(?:chatgpt|gpt|gemini|openai|ai|human|bot|robot))\b/i,
    /\b(?:meaning\s+of\s+life|translate\s+(?:to|in|from)|solve\s+(?:this\s+)?math|square\s+root\s+of|calculate\s+\d+\s*[\+\-\*\/]\s*\d+)\b/i,
    /\b(?:who\s+is\s+[a-z]+(?:\s+[a-z]+)?)\s*\??$/i,
  ];

  return outOfScopePatterns.some(p => p.test(lower));
}

function isOperationalQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // 1. Explicit greeting or navigation selections / confirmation buttons (Yes, No, Edit, Cancel, 1-10) are NOT queries
  if (/^(?:hi|hello|hey|namaste|yes|no|y|n|1|2|3|4|5|6|7|8|9|10|confirm|edit|cancel|save|discard|stop|exit|quit|upadte|update)$/i.test(lower)) {
    return false;
  }

  // 2. Explicit Operational Logging / Creation / Action Commands
  if (/^(?:log|record|add|create|raise|onboard|acquire)\s+(?:new\s+|a\s+|an\s+)?(?:inquiry|deal|order|visit|complaint|customer|acquisition|po)\b/i.test(lower)) {
    return false;
  }
  if (/^(?:update|change|modify|set|mark|close|resolve|reopen|upadte)\s+(?:the\s+|a\s+)?(?:inquiry|deal|order|visit|complaint|customer|rate|price|status|stage)\b/i.test(lower)) {
    return false;
  }

  // Strip leading entity ID prefix if present: e.g. "INQ-27D7BD, show this inquiry in more detail" -> "show this inquiry in more detail"
  const strippedOfId = lower.replace(/^#?(?:inq|deal|po|ord|cmp|vis)[-_][a-z0-9]+[,\s:-]*/i, '').trim();

  // 3. Clear Read / Retrieval / Question Patterns
  if (
    /^(?:show|shoe|shw|sho|list|get|check|find|filter|tell me|give me|display|fetch|search|lookup|query|view|see|read|retrieve|track)\b/i.test(lower) ||
    /^(?:show|shoe|shw|sho|list|get|check|find|filter|tell me|give me|display|fetch|search|lookup|query|view|see|read|retrieve|track)\b/i.test(strippedOfId) ||
    /^(?:what|which|who|whom|whose|when|where|why|how|how many|how much|did we|is there|are there|can you show|can you tell|can you list|can you find|could you show|could you tell|could you list|do we have|have we)\b/i.test(lower) ||
    /^(?:what|which|who|whom|whose|when|where|why|how|how many|how much|did we|is there|are there|can you show|can you tell|can you list|can you find|could you show|could you tell|could you list|do we have|have we)\b/i.test(strippedOfId) ||
    /\b(?:kya hai|batao|dikhao|dikhaye|kitne|kitna|kaun hai|kaun tha|kiska|kab hua|kahan|list karo|check karo|details batao|kya chal raha hai|kya rate hai|rate kya hai)\b/i.test(lower) ||
    /\b(?:what is the|what was the|what are the|how many|how much|status of|status for|status kya hai|outcome of|last rate|rates? quoted|pending complaints|closed complaints|my visits|my inquiries|my orders|my deals|details of|details for|history of|history for|summary of|summary for|info on|info about|report on|report for)\b/i.test(lower) ||
    /\b(?:what is the|what was the|what are the|how many|how much|status of|status for|status kya hai|outcome of|last rate|rates? quoted|pending complaints|closed complaints|my visits|my inquiries|my orders|my deals|details of|details for|history of|history for|summary of|summary for|info on|info about|report on|report for)\b/i.test(strippedOfId) ||
    lower.endsWith('?') ||
    (strippedOfId && strippedOfId.endsWith('?'))
  ) {
    return true;
  }

  // 4. Standalone lookup terms (or stripped ID lookup terms like "INQ-27D7BD details", "INQ-27D7BD status")
  if (/^(?:inquiry id|inquiry ids|deal id|deal ids|order id|order ids|complaint id|complaint ids|visit id|visit ids|summary|leaderboard|pipeline|radar|360|knowledge base|sop|moq|pricing sheet)\b/i.test(lower)) {
    return true;
  }
  if (strippedOfId && strippedOfId !== lower && /^(?:details?|more details?|status|rate|rates|quotation|quote|summary|items|info|information)$/i.test(strippedOfId)) {
    return true;
  }

  return false;
}

/**
 * Fast LLM Query Classifier fallback
 * Classifies whether text is a valid Sales/CRM query vs out of scope / other
 */
async function isOperationalQueryWithLLM(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 4) return false;
  const clean = text.trim();

  // If starts with clear action commands, not a query
  if (/^(?:1|2|3|4|5|6|7|8|9|10|yes|no|y|n|confirm|edit|cancel|save|discard|stop|exit|quit|upadte|update)$/i.test(clean)) return false;
  if (/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte)\b/i.test(clean)) return false;

  const prompt = `You are a strict domain classifier for Enlight Metals SalesOS (a B2B metal & steel sales CRM system).
Classify whether this user message is a VALID SALES/CRM QUERY RELATED TO ENLIGHT METALS (inquiries, orders, visits, complaints, payments, customers, metal products, sales data, company SOPs) OR an OUT-OF-SCOPE / IRRELEVANT PROMPT (e.g. general knowledge, celebrities, sports, trivia, personal chit-chat, politics, science, recipes, coding, general AI queries).

User message: "${clean}"

Options:
- SALES_QUERY: User is asking a legitimate question about Enlight Metals sales data, CRM records, customers, products, pricing, or sales operations.
- OUT_OF_SCOPE: User is asking general trivia, sports, celebrities, politics, science, coding, recipes, jokes, or non-sales questions.
- OTHER: User is giving an operational command, greeting, or random text.

Respond with ONLY "SALES_QUERY", "OUT_OF_SCOPE", or "OTHER".`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)]);
    const result = (typeof res.content === 'string' ? res.content : '').trim().toUpperCase();
    return result.includes('SALES_QUERY');
  } catch (err) {
    return false;
  }
}

/**
 * Recognizes direct stage transition requests on deals / inquiries
 * (e.g. "stage update to won", "mark deal for SS Industries as won", "deal won", "update stage to price quote for above inquiry", etc.)
 */
function isStageUpdatePrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();

  // If explicitly logging or creating a new record, it is a write operation that must remain menu-gated
  if (/^\s*(?:log|record|create|add)\s+(?:new\s+)?(?:inquiry|deal|order|visit|field\s*visit|complaint)\b/i.test(lower)) {
    return false;
  }

  const stageWord = '(?:stage|satge|stgae|stag|stages|satges)';
  const stageTarget = '(?:won|lost|closed\\s*won|closed\\s*lost|order\\s*confirmed|order\\s*placed|negotiat\\w*|quoted|quotated|price\\s*quotes?|price\\s*quotations?|on\\s*hold|hold|new\\s*inquiry|new\\s*enquiry|sauda\\s*pakka(?:\\s*ho\\s*gaya)?|deal\\s*pakk[ai]|deal\\s*confirm(?:ed)?|order\\s*mil\\s*gaya|final\\s*ho\\s*gaya|deal\\s*done)';

  // 1. Explicit stage keyword (e.g. "stage update to won", "update stage to quoted", "change stage to new inquiry")
  if (new RegExp(`\\b(?:${stageWord}\\s*(?:update|change|status|to|is|:)|(?:update|upadte|change|set|move|mark)\\s+(?:the\\s+)?${stageWord})\\b`, 'i').test(lower)) {
    return true;
  }

  // 2. Direct Hinglish or English deal closing phrases anywhere in text
  // e.g. "sauda pakka ho gaya for ABC infra", "deal pakki for XYZ", "order mil gaya from ABC"
  if (/\b(?:sauda\s*pakka(?:\s*ho\s*gaya)?|deal\s*pakk[ai]|deal\s*confirm(?:ed)?|order\s*mil\s*gaya|final\s*ho\s*gaya|deal\s*done)\b/i.test(lower)) {
    return true;
  }

  // 3. Mark/update with customer or target in between, e.g. "mark ABC infra deal won", "mark ABC infra as won", "mark deal won for ABC"
  if (new RegExp(`\\b(?:mark|move|put|change|set|update|upadte)\\s+.{1,40}?\\b(?:as\\s+|to\\s+)?(?:won|lost|closed\\s*won|closed\\s*lost|quoted|negotiat\\w*|on\\s*hold|hold)\\b`, 'i').test(lower)) {
    return true;
  }

  // 4. "deal won", "deal lost", "inquiry quoted", "order won", etc.
  if (new RegExp(`\\b(?:deal|inquiry|order)\\s+(?:won|lost|closed|quoted|negotiat\\w*|on\\s*hold|hold)\\b`, 'i').test(lower)) {
    return true;
  }

  // 5. "${closingTarget} for / of / from <Customer>" e.g. "deal won for ABC infra", "won for ABC infra"
  if (new RegExp(`\\b(?:won|lost|closed|quoted|negotiat\\w*|on\\s*hold|deal\\s*done|sauda\\s*pakka)\\s+(?:for|of|from)\\b`, 'i').test(lower)) {
    return true;
  }

  // 6. Direct command or status phrase
  if (
    new RegExp(`^(?:${stageWord}\\s+(?:is\\s+)?(?:to\\s+)?${stageTarget}|marked?\\s+(?:as\\s+)?${stageTarget})\\b`, 'i').test(lower) ||
    new RegExp(`^(?:mark\\s+as\\s+)?${stageTarget}(?:\\s+for\\s+.+)?$`, 'i').test(lower)
  ) {
    return true;
  }

  return false;
}

/** Stage-only request. A message that also changes rate, quantity, or other fields stays in the normal edit flow. */
function inquiryEditsAreStageOnly(draft) {
  if (!draft || !draft._inquiry_verified) return false;
  const updates = draft.updates || {};
  const keys = Object.entries(updates)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k]) => k);
  const hasStage = keys.some(k => k === 'stage' || k === 'status');
  const hasOther = keys.some(k => k !== 'stage' && k !== 'status');
  const hasLines = Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0;
  return hasStage && !hasOther && !hasLines;
}

async function saveStageOnlyInquiryUpdateIfNeeded(text, senderPhone, activeState, action, draft) {
  if (action !== 'UPDATE_INQUIRY' || !inquiryEditsAreStageOnly(draft)) return null;
  const stageLabel = draft.updates?.stage || draft.updates?.status || 'quoted';
  const stageText = isStageUpdatePrompt(text) ? text : `update the stage to ${stageLabel}`;
  return handleMidFlowStageUpdate(stageText, senderPhone, activeState, action, draft);
}

function isStageOnlyUpdate(text) {
  if (!isStageUpdatePrompt(text)) return false;

  // Remove entity IDs (e.g. INQ-734D48, DEAL-123456, ORD-123, PO-123)
  let stripped = String(text)
    .replace(/\b(?:INQ|DEAL|ORD|PO)[-_][A-Z0-9]+\b/gi, ' ')
    .replace(/\b(?:price\s*quotes?|price\s*quotations?)\b/gi, ' ')
    .replace(/\b(?:quoted|quotated|negotiation|on\s*hold|new\s*inquiry|new\s*enquiry|won|lost|closed\s*won|closed\s*lost)\b/gi, ' ')
    .replace(/\b(?:sauda\s*pakka(?:\s*ho\s*gaya)?|deal\s*pakk[ai]|deal\s*confirm(?:ed)?|order\s*mil\s*gaya|final\s*ho\s*gaya|deal\s*done)\b/gi, ' ')
    .replace(/\b(?:stage|satge|stgae|stages|satges|status)\b/gi, ' ')
    .replace(/\b(?:update|upadte|updated|change|changed|set|mark|marked|move|moved|put|make|turn)\b/gi, ' ')
    .replace(/\b(?:the|to|as|for|inquiry|deal|order|this|above|it|ko|kar\s*do|karo|me|in|of|and|an|a|is|ho|gaya|gayi|mil|pakka|pakki)\b/gi, ' ');

  // 1. Any keywords indicating other fields (rates, prices, quantities, delivery, payment, notes, etc.)
  if (/\b(?:rate|rates|price|prices|pricing|target\s*price|unit\s*price|cost|bhav|daam|amount)\b/i.test(stripped)) return false;
  if (/\b(?:qty|quantity|quantities|tonnage|tons?|tonne|kg|pieces?|pcs|nos|sheets?|meters?|mtr|dimension|dimensions|spec|specs|specification|specifications|thickness|thk|gauge|size|grade)\b/i.test(stripped)) return false;
  if (/\b(?:payment|terms?|credit|advance|days?|din|pdc|lc|cad|rtgs|neft|cod)\b/i.test(stripped)) return false;
  if (/\b(?:delivery|dispatch|dispatched|destination|address|location|site|transport|freight|city)\b/i.test(stripped)) return false;
  if (/\b(?:notes?|remarks?|comments?|make|brand|preferred\s*make)\b/i.test(stripped)) return false;
  if (/\b(?:po\s*number|po\s*no|po\s*date|delivery\s*date)\b/i.test(stripped)) return false;

  // 2. Common steel product names or categories
  if (/\b(?:coil|coils|sheet|sheets|plate|plates|pipe|pipes|tube|tubes|bar|bars|tmt|beam|beams|channel|channels|angle|angles|billet|billets|wire\s*rod|structure|structural|hr|cr|ms|ss|gi|gp)\b/i.test(stripped)) return false;

  // 3. Currency or unit syntax (e.g. 8/MT, ₹500, @ 50, etc.)
  if (/[₹@]|(?:rs\.?|inr)\b/i.test(stripped)) return false;
  if (/(?:\/|per|\s*@\s*)\s*(?:mt|tons?|tonne|kg|mm|mtr|nos|pcs|pieces?)/i.test(stripped)) return false;

  // 4. Any numbers remaining (rates, quantities, dimensions)
  if (/\b\d+(?:\.\d+)?\b/.test(stripped)) return false;

  return true;
}

/**
 * Checks if incoming text is a data retrieval query (either by pattern or LLM).
 */
async function isMidFlowReadQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();

  // Standalone IDs or references for form fields are NOT mid-flow read queries
  if (/^#?(?:inq|po|ord|cmp|vis)[-_][a-z0-9]+$/i.test(clean)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return false;
  if (/^[0-9a-f]{6,8}$/i.test(clean)) return false;
  if (/^(?:option\s*)?[1-9]\.?$/i.test(clean)) return false;

  // Pure payment terms, credit terms, or durations are form field values, NOT read queries
  if (/^\s*(?:\d+\s*(?:days?|din|months?|weeks?)(?:\s*(?:credit|term|terms|advance|net|payment|after\s+delivery))?|100%\s*advance|advance|immediate|pdc|lc|cad|credit|online|rtgs|neft|against\s+delivery|cash\s+on\s+delivery|cod)\s*$/i.test(clean)) return false;

  // Contact inputs (e.g. "tarak mehta,8945561223") are form field values
  if (/^[a-zA-Z\s]{2,40}[,\s]+[6-9]\d{9}$/i.test(clean)) return false;

  // Pure numeric quantities / rates / dimensions are form field values
  if (/^\s*₹?\s*\d+(?:,\d+)*(?:\.\d+)?\s*(?:\/\s*mt|\/\s*ton|\/\s*kg|per\s*mt|per\s*ton|mt|ton|tons|tonne|kg|pcs|nos|pieces|mm)?\s*$/i.test(clean)) return false;

  if (isOperationalQuery(clean)) return true;
  if (clean.length >= 8 && !/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte|edit|cancel|save|yes|no|discard|btn_)\b/i.test(clean)) {
    return await isOperationalQueryWithLLM(clean);
  }
  return false;
}

/**
 * Builds a contextual resume prompt that explicitly tells the user which record ID and/or company
 * they were working on, rather than just a generic module name.
 * e.g.: "You were in the middle of updating *INQ-8E15BC* for *Menon Industries* — do you want to continue?"
 */
function buildResumePrompt(action, draft = {}) {
  let d = draft;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      d = {};
    }
  }
  d = d || {};

  const companyName = (d.company_name || d.customer_name || '').trim();
  let inqId = d._inquiry_display_id ? String(d._inquiry_display_id).trim() : '';
  if (!inqId && d.inquiry_id) {
    const rawInq = String(d.inquiry_id).trim();
    inqId = rawInq.toUpperCase().startsWith('INQ-') ? rawInq : `INQ-${rawInq.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  }
  const rawPo = d.po_number || d.updates?.po_number || (d.order_id ? (String(d.order_id).toUpperCase().startsWith('ORD-') ? d.order_id : `ORD-${String(d.order_id).replace(/-/g, '').slice(0, 6).toUpperCase()}`) : '');
  const poNum = rawPo ? String(rawPo).trim() : '';

  switch (action) {
    case 'UPDATE_INQUIRY': {
      if (inqId && companyName) return `You were in the middle of updating *${inqId}* for *${companyName}* — do you want to continue?`;
      if (inqId) return `You were in the middle of updating *${inqId}* — do you want to continue?`;
      if (companyName) return `You were in the middle of updating inquiry for *${companyName}* — do you want to continue?`;
      return `You were in the middle of updating an Inquiry — do you want to continue?`;
    }
    case 'LOG_INQUIRY': {
      if (companyName) return `You were in the middle of logging an Inquiry for *${companyName}* — do you want to continue?`;
      return `You were in the middle of logging a New Inquiry — do you want to continue?`;
    }
    case 'UPDATE_ORDER': {
      const orderRef = poNum || inqId;
      if (orderRef && companyName) return `You were in the middle of updating order *${orderRef}* for *${companyName}* — do you want to continue?`;
      if (orderRef) return `You were in the middle of updating order *${orderRef}* — do you want to continue?`;
      if (companyName) return `You were in the middle of updating order for *${companyName}* — do you want to continue?`;
      return `You were in the middle of updating an Order — do you want to continue?`;
    }
    case 'LOG_ORDER': {
      if (companyName) return `You were in the middle of logging an Order for *${companyName}* — do you want to continue?`;
      return `You were in the middle of logging a New Order — do you want to continue?`;
    }
    case 'UPDATE_VISIT': {
      if (companyName) return `You were in the middle of updating field visit for *${companyName}* — do you want to continue?`;
      return `You were in the middle of updating a Field Visit — do you want to continue?`;
    }
    case 'LOG_VISIT': {
      if (companyName) return `You were in the middle of logging a Field Visit for *${companyName}* — do you want to continue?`;
      return `You were in the middle of logging a Field Visit — do you want to continue?`;
    }
    case 'UPDATE_COMPLAINT': {
      if (companyName) return `You were in the middle of updating complaint for *${companyName}* — do you want to continue?`;
      return `You were in the middle of updating a Complaint — do you want to continue?`;
    }
    case 'LOG_COMPLAINT': {
      if (companyName) return `You were in the middle of logging a Complaint for *${companyName}* — do you want to continue?`;
      return `You were in the middle of logging a Customer Complaint — do you want to continue?`;
    }
    case 'LOG_NEW_CUSTOMER': {
      if (companyName) return `You were in the middle of onboarding *${companyName}* — do you want to continue?`;
      return `You were in the middle of New Customer Acquisition — do you want to continue?`;
    }
    default: {
      const actionDisplayName = getModuleDisplayName(action);
      if (companyName) return `You were in the middle of *${actionDisplayName}* for *${companyName}* — do you want to continue?`;
      return `You were in the middle of *${actionDisplayName}* — do you want to continue?`;
    }
  }
}

/**
 * Handles a read/retrieval query mid-flow without dropping or wiping the active catalog state.
 * Returns the answer along with a prompt to resume the active form and Yes/No quick action buttons.
 */
async function handleMidFlowRetrievalQuery(text, senderPhone, activeState, action, draft) {
  const { runOrchestrator } = require('./orchestrator');
  const queryAnswer = await runOrchestrator(text, senderPhone);

  const resumeMsg = buildResumePrompt(action, draft);
  const combinedReply = `${queryAnswer}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft)}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: RESUME_QUERY_BUTTONS,
  };
}

/**
 * Handles a complaint resolution request mid-flow without dropping or wiping the active catalog state.
 * Executes the complaint resolution in Supabase via handleComplaintResolution (kra8.js), logs it,
 * and appends the resume prompt with Yes/No quick action buttons.
 */
async function handleMidFlowComplaintResolution(text, senderPhone, activeState, action, draft) {
  const { handleComplaintResolution } = require('../kra8');
  const resolutionReply = await handleComplaintResolution(text, senderPhone);

  // If the user was already in a complaint flow, finalize cleanly without resume prompt
  if (action === 'UPDATE_COMPLAINT' || action === 'LOG_COMPLAINT') {
    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', resolutionReply, {
      action_type: action,
      customer_name: draft?.company_name || null,
    });
    recordInactiveDraft(senderPhone, action, draft, 'saved');
    await finalizeCurrentSession(senderPhone, 'Complaint resolved directly', { action_type: action });
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return {
      handled: true,
      reply: resolutionReply,
      interactiveType: 'buttons',
      interactiveButtons: getPostActivityButtons(action),
    };
  }

  const resumeMsg = buildResumePrompt(action, draft);
  const combinedReply = `${resolutionReply}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft?.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft?.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: RESUME_QUERY_BUTTONS,
  };
}

/**
 * Handles a stage update request mid-flow without dropping or corrupting the active catalog state.
 * Executes the stage update directly against deals and inquiries tables in Supabase with pipeline validation,
 * confirms the update, and appends the resume prompt with Yes/No quick action buttons.
 */
async function handleMidFlowStageUpdate(text, senderPhone, activeState, action, draft) {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  // 1. Identify target stage
  let targetStage = null;
  let stageDisplayName = null;
  let targetCustomerName = null;

  if (/\b(?:price\s*quote|price\s*quotation|quoted|quote|proposal|prop|quotation\s*bheja|quote\s*bheja|quote\s*diya|bhav\s*diya|proposal\s*diya)\b/i.test(lower)) {
    targetStage = 'quoted';
    stageDisplayName = 'Price Quote';
  } else if (/\b(?:negotiat(?:ion|ing|e)?|negot|baatcheet|mol\s*bhav|rate\s*discussion|discussion\s*in\s*progress)\b/i.test(lower)) {
    targetStage = 'negotiation';
    stageDisplayName = 'Negotiation';
  } else if (/\b(?:on\s*hold|hold|hold\s*pe|baad\s*me|pending\s*discussion)\b/i.test(lower)) {
    targetStage = 'on_hold';
    stageDisplayName = 'On Hold';
  } else if (/\b(?:won|closed\s*won|order\s*confirmed|order\s*placed|deal\s*won|sauda\s*pakka|deal\s*pakki|deal\s*confirm|order\s*mil\s*gaya|final\s*ho\s*gaya|deal\s*done)\b/i.test(lower)) {
    targetStage = 'won';
    stageDisplayName = 'Closed Won';
  } else if (/\b(?:lost|closed\s*lost|deal\s*lost|cancelled|canceled|drop|mana\s*kar\s*diya|mana\s*kiya|deal\s*cancel|party\s*ne\s*mana\s*kiya|deal\s*drop)\b/i.test(lower)) {
    targetStage = 'lost';
    stageDisplayName = 'Closed Lost';
  } else if (/\b(?:new\s*inquiry|new\s*enquiry|naya\s*inquiry|naya\s*enquiry|initial\s*stage)\b/i.test(lower)) {
    targetStage = 'new_inquiry';
    stageDisplayName = 'New Inquiry';
  }

  // 2. Identify target inquiry / deal ID
  let targetInqId = null;
  const directIdMatch = clean.match(/(?:^|[\s#(,])(?:INQ|DEAL)[-_:#\s]+([A-Za-z0-9_-]{4,36})\b/i) ||
    clean.match(/(?:^|[\s#(,])(?:INQ|DEAL)-?([A-Fa-f0-9]{4,36})\b/i) ||
    clean.match(/#([A-Fa-f0-9]{4,8})\b/i) ||
    clean.match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);

  if (directIdMatch) {
    const candidate = directIdMatch[1].replace(/^#+/, '').trim().toUpperCase();
    if (!/^(?:UIRY|UIRE|STATUS|UPDATE|STAGE|RATE|DETAILS?|NOTES?|WITH|FROM|FOR|THE|ABOVE|THIS|DEAL|ORDER)$/i.test(candidate)) {
      targetInqId = candidate;
    }
  }

  // If no explicit ID in text, or user said "above inquiry" / "this inquiry" / "it":
  if (!targetInqId) {
    if (draft && (draft.inquiry_id || draft.deal_id || draft._inquiry_display_id)) {
      const rawInq = draft.inquiry_id || draft.deal_id || draft._inquiry_display_id;
      targetInqId = String(rawInq).replace(/^#?(?:INQ|DEAL)[-_:#\s]*/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();
    }
  }

  // Fast regex customer extraction: "for <Customer>", "mark <Customer>", "<Customer> deal won", etc.
  if (!targetCustomerName) {
    const forCustMatch = clean.match(/\b(?:for|of|from)\s+([A-Za-z0-9\s.&'-]{2,40}?)(?:\s+(?:deal|inquiry|order|stage|as|to|won|lost|quoted)|\s*$)/i);
    if (forCustMatch && !/^(?:the|above|this|it|deal|inquiry|order)$/i.test(forCustMatch[1].trim())) {
      targetCustomerName = forCustMatch[1].trim();
    }
    if (!targetCustomerName) {
      const markCustMatch = clean.match(/\b(?:mark|move|put|change|set|update)\s+([A-Za-z0-9\s.&'-]{2,40}?)\s+(?:as|to|deal|inquiry|stage|won|lost|quoted)\b/i);
      if (markCustMatch && !/^(?:the|a|an|deal|inquiry|order|status|stage)$/i.test(markCustMatch[1].trim())) {
        targetCustomerName = markCustMatch[1].trim();
      }
    }
    if (!targetCustomerName) {
      const beforeDealMatch = clean.match(/^([A-Za-z0-9\s.&'-]{2,40}?)\s+(?:deal\s+won|deal\s+lost|sauda\s+pakka|order\s+won)\b/i);
      if (beforeDealMatch && !/^(?:the|a|an|deal|inquiry|order|status|stage|mark|update)$/i.test(beforeDealMatch[1].trim())) {
        targetCustomerName = beforeDealMatch[1].trim();
      }
    }
  }

  // If targetStage or targetInqId is still missing, attempt LLM extraction
  if (!targetStage || !targetInqId) {
    try {
      const extractPrompt = `Extract the target deal/inquiry ID, customer/company name, and new pipeline stage from the following message:
Message: "${clean}"
Active draft inquiry ID: "${draft?.inquiry_id || ''}"
Active draft customer name: "${draft?.company_name || ''}"

Return ONLY JSON:
{
  "inquiry_id": "<Inquiry ID e.g. INQ-D013D7 or null>",
  "customer_name": "<Customer / Company Name e.g. ABC Steels or null>",
  "target_stage": "quoted|negotiation|on_hold|won|lost|new_inquiry|null"
}`;
      const res = await invokeWithFallback([new HumanMessage(extractPrompt)], null);
      const jsonParsed = safeParseJSON(res.content, {});
      if (!targetStage && jsonParsed.target_stage) {
        targetStage = jsonParsed.target_stage;
        const stageMap = {
          quoted: 'Price Quote',
          negotiation: 'Negotiation',
          on_hold: 'On Hold',
          won: 'Closed Won',
          lost: 'Closed Lost',
          new_inquiry: 'New Inquiry',
        };
        stageDisplayName = stageMap[targetStage] || targetStage;
      }
      if (!targetInqId && jsonParsed.inquiry_id) {
        targetInqId = String(jsonParsed.inquiry_id).replace(/^#?(?:INQ|DEAL)[-_:#\s]*/i, '').replace(/^#+/, '').replace(/-/g, '').trim().toUpperCase();
      }
      if (!targetCustomerName && jsonParsed.customer_name) {
        targetCustomerName = String(jsonParsed.customer_name).trim();
      }
    } catch (e) {
      console.warn('[CatalogFlow] handleMidFlowStageUpdate LLM extraction notice:', e.message);
    }
  }

  if (!targetStage) {
    const stageClarificationPrompt = `Which stage would you like to update this inquiry to?\n\n` +
      `1️⃣ *Price Quote* (Quoted)\n` +
      `2️⃣ *Negotiation*\n` +
      `3️⃣ *Closed Won*\n` +
      `4️⃣ *Closed Lost*\n` +
      `5️⃣ *On Hold*\n` +
      `6️⃣ *New Inquiry*\n\n` +
      `Please reply with the stage name or option number (1–6).`;

    if (activeState === 'general' || !draft) {
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', stageClarificationPrompt, { action_type: 'UPDATE_INQUIRY' });
      await saveActiveSession(senderPhone, 'Customer', 'general');
      return {
        handled: true,
        reply: stageClarificationPrompt,
        interactiveType: 'buttons',
        interactiveButtons: [
          { id: 'stage_quoted', title: 'Price Quote' },
          { id: 'stage_negotiation', title: 'Negotiation' },
          { id: 'stage_won', title: 'Closed Won' },
        ],
      };
    }

    const resumeMsg = buildResumePrompt(action, draft);
    const combinedReply = `${stageClarificationPrompt}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
      action_type: action,
      customer_name: draft?.company_name || null,
    });

    await saveActiveSession(
      senderPhone,
      draft?.company_name || 'Customer',
      `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`
    );

    return {
      handled: true,
      reply: combinedReply,
      interactiveType: 'buttons',
      interactiveButtons: [
        { id: 'stage_quoted', title: 'Price Quote' },
        { id: 'stage_negotiation', title: 'Negotiation' },
        { id: 'stage_won', title: 'Closed Won' },
      ],
    };
  }

  const cleanInqCode = targetInqId ? targetInqId.replace(/-/g, '').toUpperCase() : null;

  // 3. Query deals and inquiries in Supabase
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let dealsQuery = supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at')
    .order('created_at', { ascending: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
  }

  const { data: deals } = await dealsQuery.limit(500);

  let deal = null;
  if (deals && deals.length > 0 && cleanInqCode) {
    deal = deals.find(d => {
      const dId = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
      return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
    }) || null;
  }

  let inq = null;
  if (!deal && cleanInqCode) {
    let inqsQuery = supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
      .order('created_at', { ascending: false });

    if (!scope.isAdmin && targetPhones.length > 0) {
      inqsQuery = inqsQuery.in('salesperson_phone', targetPhones);
    }

    const { data: inqRows } = await inqsQuery.limit(500);
    if (inqRows && inqRows.length > 0) {
      for (const iRow of inqRows) {
        const iId = (iRow.id || '').replace(/-/g, '').toUpperCase();
        if (iId.startsWith(cleanInqCode) || iId.includes(cleanInqCode)) {
          inq = iRow;
          if (iRow.deals && iRow.deals.length > 0) {
            deal = iRow.deals[0];
          }
          break;
        }
      }
    }
  }

  // 3b. Unscoped fallback by explicit cleanInqCode if not found in scoped query
  if (!deal && !inq && cleanInqCode) {
    const { data: rawAllDeals } = await supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, po_number, delivery_location, payment_terms, salesperson_phone, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    const allDeals = await filterRecordsToCallerScope(rawAllDeals, scope, { customerField: 'customer_name' });

    if (allDeals && allDeals.length > 0) {
      deal = allDeals.find(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        return dId.startsWith(cleanInqCode) || inqId.startsWith(cleanInqCode) || dId.includes(cleanInqCode) || inqId.includes(cleanInqCode);
      }) || null;
    }

    if (!deal) {
      const { data: rawAllInqRows } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(500);
      const allInqRows = await filterRecordsToCallerScope(rawAllInqRows, scope, { customerField: 'sender_name' });

      if (allInqRows && allInqRows.length > 0) {
        for (const iRow of allInqRows) {
          const iId = (iRow.id || '').replace(/-/g, '').toUpperCase();
          if (iId.startsWith(cleanInqCode) || iId.includes(cleanInqCode)) {
            inq = iRow;
            if (iRow.deals && iRow.deals.length > 0) {
              deal = iRow.deals[0];
            }
            break;
          }
        }
      }
    }
  }

  // 3c. Fallback by customer name (from user message or active draft company_name)
  const searchCustomerName = targetCustomerName || draft?.company_name;
  if (!deal && !inq && searchCustomerName) {
    if (deals && deals.length > 0) {
      deal = deals.find(d => isCustomerMatch(searchCustomerName, null, d.customer_name, null)) ||
             deals.find(d => d.customer_name && d.customer_name.toLowerCase().includes(searchCustomerName.toLowerCase())) || null;
    }

    if (!deal) {
      const { data: matchInqs } = await supabase
        .from('inquiries')
        .select('id, sender_name, sender_phone, status, salesperson_phone, ai_extraction_json, deals(*)')
        .order('created_at', { ascending: false })
        .limit(200);

      if (matchInqs && matchInqs.length > 0) {
        const matched = matchInqs.find(i => {
          const ai = i.ai_extraction_json || {};
          const cName = i.sender_name || ai.companyName || ai.customer_name || '';
          return isCustomerMatch(searchCustomerName, null, cName, null) ||
                 (cName && cName.toLowerCase().includes(searchCustomerName.toLowerCase()));
        });
        if (matched) {
          inq = matched;
          if (matched.deals && matched.deals.length > 0) deal = matched.deals[0];
        }
      }
    }
  }

  // If no deal or inquiry found
  if (!deal && !inq) {
    const missingRef = targetInqId ? `"${targetInqId}"` : (targetCustomerName ? `customer "${targetCustomerName}"` : 'the specified reference');
    const errorMsg = `❌ *Inquiry Not Found*\n\nCould not find an inquiry or deal matching ${missingRef}.\n\nPlease check the Inquiry ID (e.g. INQ-D013D7) or Customer Name and try again.`;
    if (activeState === 'general' || !draft) {
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', errorMsg, { action_type: action || 'UPDATE_INQUIRY' });
      await saveActiveSession(senderPhone, 'Customer', 'general');
      return {
        handled: true,
        reply: errorMsg,
      };
    }
    const resumeMsg = buildResumePrompt(action, draft);
    const combinedReply = `${errorMsg}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', combinedReply, { action_type: action });
    await saveActiveSession(senderPhone, draft?.company_name || 'Customer', `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`);

    return {
      handled: true,
      reply: combinedReply,
      interactiveType: 'buttons',
      interactiveButtons: RESUME_QUERY_BUTTONS,
    };
  }

  // 4. Validate Pipeline Stage Transition Rules
  const rawCurrentStage = (deal ? deal.stage : inq?.status) || 'new_inquiry';
  const currStageLower = String(rawCurrentStage).toLowerCase().trim();
  const formattedDisplayId = deal
    ? `INQ-${(deal.inquiry_id || deal.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`
    : `INQ-${inq.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

  let transitionError = null;

  // Rule: Cannot jump from New Inquiry directly to Won
  if (targetStage === 'won' && ['new_inquiry', 'new', 'auto_created', 'inquiry'].includes(currStageLower)) {
    transitionError = `Order cannot be marked as Won directly from New Inquiry stage. A quotation must be sent and the inquiry must be in Quoted stage before an order can be recorded.`;
  } else if (targetStage === 'won' && ['lost', 'closed lost', 'closed_lost'].includes(currStageLower)) {
    transitionError = `Inquiry ${formattedDisplayId} is marked as Lost. Please reopen or update the inquiry to Quoted or Negotiation before recording an order.`;
  } else if (targetStage === 'quoted') {
    let itemsToCheck = [];
    if (deal) {
      const { data: dItems } = await supabase.from('deal_items').select('*').eq('deal_id', deal.id);
      if (dItems && dItems.length > 0) itemsToCheck = dItems;
    }
    if (itemsToCheck.length === 0 && (deal?.inquiry_id || inq?.id)) {
      const inqIdTarget = deal?.inquiry_id || inq?.id;
      const { data: iItems } = await supabase.from('inquiry_items').select('*').eq('inquiry_id', inqIdTarget);
      if (iItems && iItems.length > 0) itemsToCheck = iItems;
    }
    if (itemsToCheck.length === 0) {
      const aiJson = inq?.ai_extraction_json || (deal?.inquiry_id ? (await supabase.from('inquiries').select('ai_extraction_json').eq('id', deal.inquiry_id).single()).data?.ai_extraction_json : null);
      if (aiJson) {
        const parsed = typeof aiJson === 'string' ? JSON.parse(aiJson) : aiJson;
        if (Array.isArray(parsed?.line_items) && parsed.line_items.length > 0) {
          itemsToCheck = parsed.line_items;
        }
      }
    }

    const custName = draft?.company_name || deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName;
    const deliveryLoc = draft?.updates?.delivery_location || deal?.delivery_location || inq?.ai_extraction_json?.delivery_location;
    const paymentTerms = draft?.updates?.payment_terms || deal?.payment_terms || inq?.ai_extraction_json?.payment_terms;

    const { evaluateMandatoryFields } = require('../agents/salesAgent');
    const comp = evaluateMandatoryFields({
      customerName: custName,
      lineItems: itemsToCheck,
      deliveryLocation: deliveryLoc,
      paymentTerms: paymentTerms,
    });

    if (!comp.isComplete) {
      transitionError = `Cannot update stage to Price Quote.\n\nInquiry ${formattedDisplayId} has missing mandatory field(s):\n${comp.missingFields.map(f => `• ${f}`).join('\n')}\n\nPlease fill the mandatory fields to update the stage to Price Quote.`;
    }
  }

  if (transitionError) {
    if (activeState === 'general' || !draft) {
      const errReply = `⚠️ ${transitionError}`;
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', errReply, { action_type: action || 'UPDATE_INQUIRY' });
      await saveActiveSession(senderPhone, 'Customer', 'general');
      return {
        handled: true,
        reply: errReply,
      };
    }
    const resumeMsg = buildResumePrompt(action, draft);
    const combinedReply = `⚠️ ${transitionError}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;

    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', combinedReply, { action_type: action });
    await saveActiveSession(senderPhone, draft?.company_name || 'Customer', `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`);

    return {
      handled: true,
      reply: combinedReply,
      interactiveType: 'buttons',
      interactiveButtons: RESUME_QUERY_BUTTONS,
    };
  }

  // 5. Execute Stage Update against database
  if (deal) {
    const dealUpdates = {
      stage: targetStage,
    };
    if (targetStage === 'won' && !deal.won_at) {
      dealUpdates.won_at = new Date().toISOString();
    }
    const { error: dUpdErr } = await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
    if (dUpdErr) console.error('[CatalogFlow] handleMidFlowStageUpdate deal update error:', dUpdErr.message);
  }

  const targetInquiryId = deal?.inquiry_id || deal?.id || inq?.id;
  if (targetInquiryId) {
    const inqUpdates = {
      stage: targetStage,
      status: targetStage === 'won' ? 'confirmed' : targetStage,
    };
    const { data: inqRow } = await supabase.from('inquiries').select('id, ai_extraction_json').eq('id', targetInquiryId).single();
    if (inqRow && inqRow.ai_extraction_json) {
      inqUpdates.ai_extraction_json = {
        ...inqRow.ai_extraction_json,
        stage: targetStage,
        status: targetStage,
      };
    }
    const { error: iUpdErr } = await supabase.from('inquiries').update(inqUpdates).eq('id', targetInquiryId);
    if (iUpdErr) console.warn('[CatalogFlow] handleMidFlowStageUpdate inq update notice:', iUpdErr.message);
  }

  // Log to activity_logs
  try {
    const custName = draft?.company_name || deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName || 'Customer';
    logBotActivity({
      salesperson_phone: senderPhone,
      description: `Stage for ${formattedDisplayId} (${custName}) updated to ${stageDisplayName}`,
      module: 'Inquiries',
      customer_name: custName,
      entity_id: targetInquiryId,
      entity_type: 'inquiry',
      action_type: 'inquiry_updated',
      change_detail: { stage: targetStage },
    });
  } catch (actErr) {
    console.warn('[CatalogFlow] Activity log notice for handleMidFlowStageUpdate:', actErr?.message);
  }

  // 6. Build Confirmation and Resume Prompt
  if (draft) {
    if (!draft.inquiry_id && formattedDisplayId) {
      draft.inquiry_id = formattedDisplayId;
      draft._inquiry_display_id = formattedDisplayId;
    }
    if (!draft.company_name) {
      draft.company_name = deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName || null;
    }
    // Keep the open inquiry card in sync with the stage that was just saved.
    if (action === 'UPDATE_INQUIRY') {
      draft.stage = formatStageLabel(targetStage);
      if (draft.updates) {
        delete draft.updates.stage;
        delete draft.updates.status;
      }
    }
  }

  const cleanCust = deal?.customer_name || inq?.sender_name || inq?.ai_extraction_json?.companyName || draft?.company_name || '';
  if (activeState === 'general' || !draft) {
    const cleanConfirmation = `✅ *Inquiry Stage Updated!*\n\n• *Inquiry:* ${formattedDisplayId}${cleanCust ? ` (${cleanCust})` : ''}\n• *New Stage:* *${stageDisplayName}*`;
    await recordSessionMessage(senderPhone, 'user', text);
    await recordSessionMessage(senderPhone, 'assistant', cleanConfirmation, {
      action_type: 'UPDATE_INQUIRY',
      customer_name: cleanCust || null,
    });
    await saveActiveSession(senderPhone, cleanCust || 'Customer', 'general');
    return {
      handled: true,
      reply: cleanConfirmation,
      interactiveType: 'buttons',
      interactiveButtons: getPostActivityButtons('UPDATE_INQUIRY'),
    };
  }

  const confirmationMsg = `Stage for ${formattedDisplayId} has been updated to ${stageDisplayName}.`;
  const resumeMsg = buildResumePrompt(action, draft);
  const combinedReply = `${confirmationMsg}\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;
  const resumeButtons = action === 'UPDATE_INQUIRY' ? STAGE_UPDATE_RESUME_BUTTONS : RESUME_QUERY_BUTTONS;

  await recordSessionMessage(senderPhone, 'user', text);
  await recordSessionMessage(senderPhone, 'assistant', combinedReply, {
    action_type: action,
    customer_name: draft?.company_name || null,
  });

  await saveActiveSession(
    senderPhone,
    draft?.company_name || 'Customer',
    `catalog_resume_ask|${activeState}|${action}|${JSON.stringify(draft || {})}`
  );

  return {
    handled: true,
    reply: combinedReply,
    interactiveType: 'buttons',
    interactiveButtons: resumeButtons,
  };
}

function inquiryDraftHasPendingEdits(draft) {
  const updates = draft?.updates || {};
  const hasHeader = Object.values(updates).some(v => v !== null && v !== undefined && v !== '');
  const hasLines = Array.isArray(draft?.line_item_updates) && draft.line_item_updates.length > 0;
  return hasHeader || hasLines;
}

function buildSelectedInquiryCardFromDraft(draft) {
  const items = Array.isArray(draft.existing_items) ? draft.existing_items : [];
  const record = {
    displayId: draft._inquiry_display_id || null,
    inquiry_id: draft.inquiry_id,
    customer_name: draft.company_name,
    date_formatted: draft.date_formatted || draft.inquiry_date || null,
    stage: draft.stage || 'New Inquiry',
    preferred_make: draft.preferred_make,
    payment_terms: draft.payment_terms,
    delivery_location: draft.delivery_location,
    additional_notes: draft.additional_notes,
    existing_items: items,
    total_amount: draft.total_amount,
  };
  const itemsListText = items.length > 0
    ? formatDetailedInquiryItemsList(items)
    : `1. *${draft.product_description || 'Steel Material'}*`;
  return formatSelectedInquiryPrompt(record, itemsListText);
}

/**
 * Restores the exact interrupted flow state and re-prompts the exact pending question or summary.
 * Re-validates and auto-loads database entity records (Inquiry/Deal/Items) merged with user session data.
 */
async function restoreInterruptedFlow(senderPhone, interruptedState, action, draft) {
  const actionName = getActionFriendlyName(action);

  if (interruptedState === 'catalog_implicit_prod_add') {
    const pendingProd = draft._pending_add_product || {
      product_name: draft._unrecognized_product_input?.rawProduct || '',
      dimensions: draft._unrecognized_product_input?.rawSpecs || '',
      hsn_code: '',
    };
    const promptCard = buildAddProductPromptCard(pendingProd);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_prod_add|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: promptCard,
      interactiveType: 'buttons',
      interactiveButtons: ADD_PRODUCT_CONFIRM_BUTTONS,
    };
  }

  if (action === 'LOG_ORDER') {
    if (draft.inquiry_id || draft.deal_id || draft._inquiry_display_id) {
      const stageCheck = await validateOrderInquiryStage(draft, senderPhone);
      if (!stageCheck.isValid) {
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: stageCheck.reply,
        };
      }
    }

    if (draft.rate && Array.isArray(draft.line_items) && draft.line_items.length > 0) {
      const globalRate = (parseIndianAmount(draft.rate) ?? 0) || 0;
      if (globalRate > 0) {
        draft.line_items = draft.line_items.map(it => {
          const qty = Number(it.quantity) || 0;
          const r = globalRate || it.rate;
          return {
            ...it,
            rate: r,
            amount: qty > 0 && r > 0 ? qty * r : (it.amount || 0),
          };
        });
      }
    }

    if (!draft.po_date) {
      draft.po_date = formatDateDDMMYYYY(new Date());
    }

    const prodCheck = validateDraftProducts('LOG_ORDER', draft);
    if (!prodCheck.isValid) {
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: prodCheck.reply,
        ...(prodCheck.canAddProduct
          ? { interactiveType: 'buttons', interactiveButtons: UNKNOWN_PRODUCT_BUTTONS }
          : {}),
      };
    }

    const missing = validateMandatoryFields('LOG_ORDER', draft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary('LOG_ORDER', draft);
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const askMissing = `Please provide the remaining mandatory details for this order:\n\n${missingList}`;
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_ORDER|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  if (interruptedState === 'catalog_update_select') {
    const selectionRes = await fetchAndRenderUpdateSelection(action, senderPhone, {
      page: draft.page || 1,
      customerFilter: draft.customerFilter || null,
    });
    await saveActiveSession(senderPhone, draft.customerFilter || 'Customer', `catalog_update_select|${action}|${JSON.stringify(selectionRes.state)}`);
    return catalogSelectionResult(selectionRes);
  }

  if (interruptedState === 'catalog_confirm') {
    const summary = buildConfirmationSummary(action, draft);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: summary,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_editing') {
    const editPrompt = getEditPromptForAction(action);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: editPrompt,
      interactiveType: 'buttons',
      interactiveButtons: DISCARD_DRAFT_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_cust_match_confirm') {
    const fetchedName = draft.company_name || 'Customer';
    const candidates = await getMatchingAssignedCustomers(fetchedName, senderPhone, fetchedName);
    const askPrompt = buildCustomerMatchValidationMessage(fetchedName, fetchedName, candidates);
    await saveActiveSession(senderPhone, fetchedName, `catalog_cust_match_confirm|${action}|${fetchedName}|${JSON.stringify(candidates)}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askPrompt,
      interactiveType: 'buttons',
      interactiveButtons: CUST_MATCH_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_implicit_cust_ask') {
    const askPrompt = `Is *${draft.company_name || 'this customer'}* a new customer you would like to onboard now?`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_cust_ask|${action}|${draft.company_name || 'Customer'}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askPrompt,
      interactiveType: 'buttons',
      interactiveButtons: NEW_CUSTOMER_BUTTONS,
    };
  }

  if (interruptedState === 'catalog_implicit_cust_collect') {
    const missing = validateMandatoryFields('LOG_NEW_CUSTOMER', draft);
    const missingList = missing.map((m) => `• *${m}*`).join('\n');
    const askRemaining = `Please provide the remaining customer details for *${draft.company_name || 'Customer'}*:\n\n${missingList}`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_cust_collect|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askRemaining,
      interactiveType: 'buttons',
      interactiveButtons: DISCARD_DRAFT_BUTTONS,
    };
  }

  // Default: catalog_flow
  // An inquiry that is already open, with no field edits captured yet, resumes as the
  // selected-inquiry card. Loaded payment terms and delivery location are the record
  // itself, not pending changes, so they must not collapse this into a save summary.
  if (action === 'UPDATE_INQUIRY' && draft && draft._inquiry_verified && !inquiryDraftHasPendingEdits(draft)) {
    const card = buildSelectedInquiryCardFromDraft(draft);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|UPDATE_INQUIRY|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: card,
    };
  }

  const prodCheck = validateDraftProducts(action, draft);
  if (!prodCheck.isValid) {
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: prodCheck.reply,
      ...(prodCheck.canAddProduct
        ? { interactiveType: 'buttons', interactiveButtons: UNKNOWN_PRODUCT_BUTTONS }
        : {}),
    };
  }

  const missing = validateMandatoryFields(action, draft);
  const optionNotice = draft._inquiry_option_notice ? `${draft._inquiry_option_notice}\n\n` : '';
  delete draft._inquiry_option_notice;
  if (missing.length === 0) {
    const summary = buildConfirmationSummary(action, draft);
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: `${optionNotice}${summary}`,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  } else {
    const missingList = missing.map((m) => `• *${m}*`).join('\n');
    const indexTag = draft._totalCount > 1 ? ` (${draft._currentIndex || 1} of ${draft._totalCount}: ${draft.company_name || 'Item'})` : '';
    const askMissing = `${optionNotice}Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: askMissing,
    };
  }
}

function detectOperationalAction(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();

  // If message is a pure query / search, do not intercept
  if (isOperationalQuery(lower)) return null;

  // 1. Customer Acquisition
  if (
    !/\b(?:visit|visited|meeting|met|site\s+visit|field\s+visit|client\s+visit|market\s+visit|office\s+visit|factory\s+visit)\b/i.test(lower) &&
    /\b(?:new\s+customer|customer\s+acquisition|onboard\s+customer|add\s+customer|acquire\s+customer|register\s+customer|nayi\s+party|naya\s+customer|customer\s+onboarding)\b/i.test(lower)
  ) {
    return 'LOG_NEW_CUSTOMER';
  }

  // 2. Complaint patterns (prioritized so complaints citing POs or Inquiries are categorized as complaints)
  if (
    /\b(?:complaint|defect|defective|damaged\s+material|rust\s+on|rusty|short\s+delivery|wrong\s+material|rejection|rejected\s+material|material\s+return|wapas\s+kiya|issue\s+aa\s+gaya|quality\s+issue|bad\s+material|damaged\s+coils|damaged\s+sheets)\b/i.test(lower)
  ) {
    if (/\b(?:update|change|modify|set|mark\s+as\s+resolved|mark\s+resolved|resolve|resolved|close|reopen|correct|fix|edit)\b/i.test(lower)) {
      return 'UPDATE_COMPLAINT';
    }
    return 'LOG_COMPLAINT';
  }

  // 3. New Order / PO Received patterns (prioritized before generic po- ID updates)
  if (
    /\b(?:purchase\s+order\s+received|po\s+received|received\s+purchase\s+order|received\s+po|order\s+confirmed|new\s+order|booked\s+order|order\s+logged|order\s+recorded)\b/i.test(lower) ||
    /^\s*(?:log|record|new)\s+(?:purchase\s+order|order|po)\b/i.test(lower)
  ) {
    return 'LOG_ORDER';
  }

  // 4. Visit / Meeting patterns
  const hasFutureVisitIntent = /\b(?:plan(?:ning)?\s+to\s+visit|will\s+(?:surely\s+)?visit|want\s+to\s+visit|hope\s+to\s+visit|future\s+visit|schedule\s+(?:a\s+)?visit|visit\s+(?:you|u)\s+later|plan\s+to\s+visit\s+(?:you|u))\b/i.test(lower);
  const hasExplicitInquiryIntent = /\b(?:i\s+want\s+to\s+inquir(?:y|e)|want\s+to\s+inquir(?:y|e)|inquir(?:y|ies)|enquir(?:y|ies)|rfq|pricing|price\s+quote|bhav|rates?)\b/i.test(lower) ||
    (/\b(?:coil|coils|sheet|sheets|plate|plates|structural|beam|beams|channel|channels|pipe|pipes|tube|tubes|tmt|angle|angles|round|flat|square|metal|steel|hr|cr|hrpo|gp|galvalume|chequered)\b/i.test(lower) && /\b\d+(?:\.\d+)?\s*(?:mt|tons?|tonne|kg|pcs|nos|pieces|sheets|plates|coils|bundles|lengths)\b/i.test(lower));

  if (
    !hasFutureVisitIntent &&
    (/\b(?:visit(?:ed|ing|s)?|met\b|meet(?:ing)?(?:\s+(?:with|at|in|up|to))?|had\s+a\s+visit|had\s+a\s+meeting|site\s+visit|field\s+visit|client\s+visit|market\s+visit|office\s+visit|factory\s+visit|went\s+to(?:\s+meet)?|gaya\s+tha|mila\s+aaj|milne\s+gaye|visit\s+kiya|visit\s+report)\b/i.test(lower) ||
    /\b(?:visit\s+outcome|person\s+met|discussion\s+notes|meeting\s+remarks|neutral\s+response|positive\s+response|negative\s+response)\b/i.test(lower))
  ) {
    if (/\b(?:update|change|modify|edit|correct|amend)\b/i.test(lower)) {
      return 'UPDATE_VISIT';
    }
    return 'LOG_VISIT';
  }

  // 5. Direct sales agent operations (stage transitions on existing deals) -> UPDATE_INQUIRY
  if (
    /\b(?:mark|move|put|change|update|set)\b.*?\b(?:stage|status)?.*?\b(negotiation|won|lost|quoted|quotated|on\s+hold|hold|review|new\s+inquiry)\b/i.test(lower) ||
    /\b(?:is\s+on\s+hold|is\s+lost|is\s+won|is\s+negotiation|is\s+quoted|deal\s+won|deal\s+lost|stage\s+won|stage\s+lost|stage\s+quoted|stage\s+negotiation)\b/i.test(lower) ||
    /^\s*(?:stage|status)\s*(?:to|as|:|=)?\s*(?:won|lost|negotiation|quoted|on\s+hold|hold|review|new\s+inquiry)\b/i.test(lower)
  ) {
    return 'UPDATE_INQUIRY';
  }

  // 6. Standalone rate/quantity updates on existing deals -> UPDATE_INQUIRY
  if (
    /^(?:make\s+the\s+quantity|update\s+rate|change\s+rate|set\s+rate|rate\s+is\b|rate\s+for\b|quantity\s+for\b|change\s+quantity|update\s+quantity)/i.test(lower)
  ) {
    return 'UPDATE_INQUIRY';
  }

  // 7. Explicit ID-based updates (requires update/link verb or standalone ID input)
  if (/\b(?:attach|link|set|update|modify|change|edit)\b.*?\b(?:po-|\bpo\b)/i.test(lower) || /^\s*po-[a-z0-9-]+\s*$/i.test(lower)) {
    return 'UPDATE_ORDER';
  }
  if (/\b(?:inq-)\b/i.test(lower)) {
    if (/\b(?:attach|link|set|update)\b.*?\b(?:po-|\bpo\b)/i.test(lower)) return 'UPDATE_ORDER';
    if (/\b(?:update|change|modify|set|edit|revise)\b/i.test(lower) || /^\s*inq-[a-z0-9-]+\s*$/i.test(lower)) {
      return 'UPDATE_INQUIRY';
    }
  }
  if (/\b(?:vis-)\b/i.test(lower) && /\b(?:update|change|modify|set|edit)\b/i.test(lower)) {
    return 'UPDATE_VISIT';
  }

  // 8. Explicit Update patterns
  if (/\b(?:update|change|modify|set|mark|resolve|close|reopen|attach|link|add\s+po|correct|fix|edit|amend|revise|increase|decrease|reduce|adjust|make)\b/i.test(lower)) {
    // 8a. Complaints
    if (
      /\b(?:complaint|complaints|defect|defective|rejection|damage|damaged|rust)\b/i.test(lower) ||
      /\b(?:mark\s+as\s+resolved|mark\s+resolved|resolve\s+complaint|close\s+complaint|reopen\s+complaint)\b/i.test(lower)
    ) {
      return 'UPDATE_COMPLAINT';
    }

    // 8b. Visits
    if (/\b(?:visit|vis-|site\s+visit|field\s+visit|meeting|person\s+met|contact\s+person)\b/i.test(lower)) {
      return 'UPDATE_VISIT';
    }

    // 8c. Orders
    if (/\b(?:order|orders|purchase\s+order|po\s*no|po\s*number|delivery\s*date|po\s*date|attach\s+po|link\s+po|attach\s+(?:the\s+)?po|set\s+po)\b/i.test(lower)) {
      return 'UPDATE_ORDER';
    }

    // 8d. Inquiries
    if (/\b(?:inquiry|inquiries|deal|deals|quote|quotation|rfq|rate|price|quantity|qty|specs|terms)\b/i.test(lower)) {
      if (/\b(?:po[-_:#\s]*\d+|po\s*no|po\s*number|purchase\s*order)\b/i.test(lower) && /\b(?:attach|link|set)\b/i.test(lower)) {
        return 'UPDATE_ORDER';
      }
      return 'UPDATE_INQUIRY';
    }
  }

  // 9. Order / PO patterns (fallback)
  if (
    /\b(?:purchase\s+order|po\s+received|received\s+po|order\s+confirmed|po-\d+|po\s*no|po\s*number|order\s+logged|order\s+recorded|deal\s+won|new\s+order|booked\s+order|order\s+for)\b/i.test(lower) ||
    /^\s*(?:po|purchase\s+order)\b/i.test(lower)
  ) {
    return 'LOG_ORDER';
  }

  // 10. Inquiry / Requirements patterns
  if (
    /\b(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|rfqs|deal|deals)\b/i.test(lower) ||
    /\b(?:quote|quotes|quotation|quotations|price|pricing|rates?|bhav)\b/i.test(lower) ||
    /\b(?:chahiye|manga|pucha|mang\s+rahe|zaroorat|needs?|requires?|wants?|demands?|asking\s+for|interested\s+in)\b/i.test(lower) ||
    /\b(?:party|client|customer|buyer|company)\s*(?:name)?\s*[:=-]\s*/i.test(lower) ||
    /\b(?:material|product|item|items|description)\s*[:=-]\s*/i.test(lower) ||
    /\b(?:qty|quantity|tonnage|tons?|mt|weight)\s*[:=-]\s*/i.test(lower) ||
    /\b(?:ek\s+)?inquiry\s+(?:aayi\s+hai|aayi|mili|hai)\b/i.test(lower) ||
    /\b(?:log|create|new|add|record|enter|save)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|deal)\b/i.test(lower) ||
    /\b(?:new\s+)?deal\s+(?:for|from|with|creation|logging)\b/i.test(lower) ||
    // Steel product mentioned together with numeric quantity
    (/\b(?:coil|coils|sheet|sheets|plate|plates|structural|beam|beams|channel|channels|pipe|pipes|tube|tubes|tmt|angle|angles|round|flat|square|metal|steel|hr|cr|hrpo|gp|galvalume|chequered)\b/i.test(lower) && /\b\d+(?:\.\d+)?\s*(?:mt|tons?|tonne|kg|pcs|nos|pieces|sheets|plates|coils|bundles|lengths)\b/i.test(lower))
  ) {
    return 'LOG_INQUIRY';
  }

  return null;
}

const DIRECT_ACTION_MAP = [
  // 1. Customer Acquisition
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:log|record|add|create|onboard|acquire)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?customer\b/i, action: 'LOG_NEW_CUSTOMER' },
  { pattern: /^\s*(?:new\s+customer\s+acquisition|customer\s+acquisition|new\s+customer\s+onboarding)\b/i, action: 'LOG_NEW_CUSTOMER' },

  // 2. Complaints Update
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:update|resolve|change|modify|close|reopen|set|mark)\s+(?:the\s+|a\s+)?(?:customer\s+)?complaint\b/i, action: 'UPDATE_COMPLAINT' },
  { pattern: /^\s*(?:mark|set)\s+(?:the\s+)?complaint\s+(?:as\s+)?(?:resolved|closed|pending|in progress|reopened)\b/i, action: 'UPDATE_COMPLAINT' },
  { pattern: /^\s*(?:resolve|close|reopen)\s+(?:the\s+)?complaint\b/i, action: 'UPDATE_COMPLAINT' },

  // 3. Complaints Log
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:log|record|raise|report|register|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?complaint\b/i, action: 'LOG_COMPLAINT' },
  { pattern: /^\s*(?:log|record|raise|register|new)\s+complaint\b/i, action: 'LOG_COMPLAINT' },

  // 4. Visits Update
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:update|change|modify|set|correct|fix|edit|amend|revise)\s+(?:the\s+|a\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'UPDATE_VISIT' },

  // 5. Visits Log
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:log|record|add|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i, action: 'LOG_VISIT' },
  { pattern: /^\s*(?:log|record|new)\s+(?:field\s*|customer\s*|site\s*)?visit\b/i, action: 'LOG_VISIT' },

  // 6. Orders Update
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:update|change|modify)\s+(?:the\s+|a\s+)?(?:purchase\s+)?order\b/i, action: 'UPDATE_ORDER' },
  { pattern: /^\s*(?:attach|link|update)\s+(?:the\s+)?po\s*(?:no|number|#)?\s+(?:to|for)\b/i, action: 'UPDATE_ORDER' },

  // 7. Orders Log
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:record|log|create|add|place|enter)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:purchase\s+)?order\b/i, action: 'LOG_ORDER' },
  { pattern: /^\s*(?:log|record|create|new)\s+(?:purchase\s+)?order\b/i, action: 'LOG_ORDER' },

  // 8. Inquiries Update
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:update|edit|modify|change|correct|revise|amend)\s+(?:an?\s+|the\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|deal|deals)\b/i, action: 'UPDATE_INQUIRY' },
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:mark|move|put|change|update|set)\s+(?:the\s+|a\s+|an\s+)?(?:deal|inquiry)?\s*(?:stage|status)?\s*(?:as\s+|to\s+)?(?:won|lost|negotiation|quoted|on\s+hold|hold|review|new\s+inquiry)\b/i, action: 'UPDATE_INQUIRY' },
  { pattern: /^\s*(?:stage|status)\s*(?:to|as|:|=)?\s*(?:won|lost|negotiation|quoted|on\s+hold|hold|review|new\s+inquiry)\b/i, action: 'UPDATE_INQUIRY' },

  // 9. Inquiries Log
  { pattern: /^\s*(?:i\s+want\s+to\s+|please\s+|kindly\s+|can\s+you\s+)?(?:log|create|new|add|record|enter|save)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:customer\s+)?(?:inquiry|inquiries|enquiry|enquiries|requirement|requirements|rfq|deal)\b/i, action: 'LOG_INQUIRY' },
  { pattern: /^\s*(?:log|create|new)\s+(?:inquiry|enquiry|rfq|deal)\b/i, action: 'LOG_INQUIRY' },
];

async function classifyActiveSessionIntent(activeActivity, text) {
  if (!activeActivity || !text || typeof text !== 'string') return { classification: 'SAME_ACTIVITY' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { classification: 'SAME_ACTIVITY' };

  // 1. Standalone reference IDs (INQ-*, PO-*, CMP-*, VIS-*, hex UUIDs) are field inputs for active draft
  const isPureRefId = /^#?(?:INQ|DEAL|PO|VIS|CMP|ORD)[-_][A-Z0-9-]+$/i.test(trimmed) ||
    /^[A-F0-9]{6,36}$/i.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(trimmed) ||
    /^#?[A-F0-9]{6,8}$/i.test(trimmed);
  if (isPureRefId) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 1b. Fast guard for candidate list pagination and navigation commands ("next 10 customers", "more", "prev", etc.)
  if (isPaginationRequest(trimmed) || isPreviousPaginationRequest(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 2. Candidate disambiguation selections (1, 2, option 1, 16, etc.) are field inputs
  if (/^(?:option\s*|choice\s*|#\s*)?(?:[1-9]\d?)\s*[.)]?$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 3. Pure payment terms, credit terms, or durations (e.g. "45 days", "30 days credit", "advance", "online", "50 days term")
  if (/^\s*(?:\d+\s*(?:days?|din|months?|weeks?)(?:\s*(?:credit|term|terms|advance|net|payment|after\s+delivery))?|100%\s*advance|advance|immediate|pdc|lc|cad|credit|online|rtgs|neft|against\s+delivery|cash\s+on\s+delivery|cod)\s*$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 4. Shorthand customer contact inputs (e.g. "tarak mehta,8945561223" or "Rajesh Sharma 9820123456")
  if (/^[a-zA-Z\s]{2,40}[,\s]+[6-9]\d{9}$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // 5. Pure numeric quantities / rates / dimensions
  if (/^\s*₹?\s*\d+(?:,\d+)*(?:\.\d+)?\s*(?:\/\s*mt|\/\s*ton|\/\s*kg|per\s*mt|per\s*ton|mt|ton|tons|tonne|kg|pcs|nos|pieces|mm)?\s*$/i.test(trimmed)) {
    return { classification: 'SAME_ACTIVITY' };
  }

  // A detailed "new customer visit" report is still data for an active visit form.
  // Preserve explicit update/change commands for the dedicated visit-update workflow.
  if (
    getModuleFamily(activeActivity) === 'VISIT' &&
    /\b(?:add|log|record|create|visit(?:ed)?|meeting|met)\b/i.test(trimmed) &&
    !/\b(?:update|change|modify|edit|correct|amend|revise)\b/i.test(trimmed)
  ) {
    return { classification: 'SAME_ACTIVITY' };
  }

  const currentFamily = getModuleFamily(activeActivity);
  const activityDisplayName = getModuleDisplayName(activeActivity);

  // Fast guard for obvious out-of-scope trivia/celebrity/sports queries
  if (isOutOfScopeGenericPrompt(trimmed)) {
    return { classification: 'OUT_OF_SCOPE_GENERIC' };
  }

  // In UPDATE_INQUIRY or UPDATE_ORDER, updating stage/status, rate, quantity, or line items is part of editing the active record
  if (activeActivity === 'UPDATE_INQUIRY' || activeActivity === 'UPDATE_ORDER') {
    const targetMatch = trimmed.match(/\b(?:INQ|DEAL|ORD|PO)-([A-Z0-9]+)\b/i);
    if (!targetMatch) {
      if (!isOutOfScopeGenericPrompt(trimmed) && !detectOutOfScopeActionAttempt(activeActivity, trimmed)) {
        if (isStageOnlyUpdate(trimmed)) {
          return { classification: 'STAGE_UPDATE' };
        }
        if (isStageUpdatePrompt(trimmed) || /\b(?:rate|price|qty|quantity|po|date|payment|delivery|status|stage|satge)\b/i.test(trimmed)) {
          return { classification: 'SAME_ACTIVITY' };
        }
      }
    }
  }

  const prompt = `You are a strict conversational intent classifier for an active B2B sales workflow session on WhatsApp.

The user is currently in the active [${activeActivity}] (${activityDisplayName}) workflow.
Incoming message: "${trimmed}"

Classify this incoming message:
- If this message asks to change, edit, rename, or set a SYSTEM-GENERATED field of the current record (Inquiry ID, Deal ID, Enquiry Number, Inquiry Date / date of the inquiry, Order ID, Complaint Ticket ID, Visit ID, Customer ID, Logged By / Created By, Creation Date, Salesperson), e.g. "edit inquiry id for ABC Steels to IN897", "change inquiry number to 897", "INQ-F2785B ko IN897 kar do", "change created date", "update the date of the inquiry to tomorrow" -> SAME_ACTIVITY (the active workflow will explain that the field can't be edited). NEVER classify these as STAGE_UPDATE, RETRIEVAL_QUERY, or DIFFERENT_ACTIVITY.
- If the user is in [UPDATE_INQUIRY] or [UPDATE_ORDER], updating stage/status (Negotiation, Won, Lost, Quoted, On Hold, Confirmed, Pending, Processing, Dispatched, Delivered), rate, price, quantity, PO details, delivery, or line items is a core field edit for the active record -> SAME_ACTIVITY. Do NOT classify as STAGE_UPDATE unless a DIFFERENT record ID is explicitly specified or it is strictly a stage-only update without any other fields.
- If the user provides field details (rates, prices, quantities, products, PO details, delivery location, payment terms, remarks, notes, or compound stage + rate updates) for the active [${activeActivity}] (${activityDisplayName}) form -> SAME_ACTIVITY
- If this message is STRICTLY requesting to update, change, set, move, or mark ONLY the pipeline stage/status of an inquiry or deal WITHOUT other product or pricing details (e.g. "update the stage to price quote for above inquiry", "update stage to quoted", "mark as negotiation", "move to on hold", "set status to price quote", "stage won", "set stage to lost") -> STAGE_UPDATE
- If this message is reporting or logging a customer complaint, quality issue, defect, damage, rust, shortage, service problem, or delivery issue -> DIFFERENT_ACTIVITY:LOG_COMPLAINT
- If this message is recording or logging a purchase order / PO -> DIFFERENT_ACTIVITY:LOG_ORDER
- If this message is logging a new customer inquiry, requirement, or RFQ -> DIFFERENT_ACTIVITY:LOG_INQUIRY
- If this message is onboarding a new customer profile -> DIFFERENT_ACTIVITY:LOG_NEW_CUSTOMER
- If this message is logging a customer field visit / client meeting -> DIFFERENT_ACTIVITY:LOG_VISIT
- If this message is asking a read-only data query or search about Enlight Metals sales data or CRM records (asking for rates, checking status, listing inquiries, checking orders) -> RETRIEVAL_QUERY
- If this message is asking an out-of-scope generic question or prompt (celebrities, sports, cricketers, trivia, science, geography, jokes, coding, recipes) -> OUT_OF_SCOPE_GENERIC

Respond strictly with ONLY the classification label on a single line, nothing else. Valid responses:
SAME_ACTIVITY
DIFFERENT_ACTIVITY:LOG_COMPLAINT
DIFFERENT_ACTIVITY:LOG_VISIT
DIFFERENT_ACTIVITY:LOG_ORDER
DIFFERENT_ACTIVITY:LOG_INQUIRY
DIFFERENT_ACTIVITY:LOG_NEW_CUSTOMER
DIFFERENT_ACTIVITY:UPDATE_VISIT
DIFFERENT_ACTIVITY:UPDATE_COMPLAINT
RETRIEVAL_QUERY
STAGE_UPDATE
OUT_OF_SCOPE_GENERIC

Classification:`;

  try {
    const res = await invokeWithFallback([new HumanMessage(prompt)], null);
    const raw = (typeof res.content === 'string' ? res.content : '').trim().replace(/[*`]/g, '');
    console.log('[CatalogFlow] AI active session intent classifier raw response:', JSON.stringify(raw));

    if (/STAGE_UPDATE/i.test(raw)) {
      if (!isStageOnlyUpdate(trimmed) && !trimmed.match(/\b(?:INQ|DEAL|ORD|PO)-([A-Z0-9]+)\b/i)) {
        return { classification: 'SAME_ACTIVITY' };
      }
      return { classification: 'STAGE_UPDATE' };
    }

    const diffMatch = raw.match(/DIFFERENT_?ACTIVITY(?:\s*:\s*([A-Z_]+))?/i);
    if (diffMatch) {
      let target = (diffMatch[1] || '').trim().toUpperCase();
      if (!target || target === 'OTHER') {
        target = 'LOG_COMPLAINT';
      }
      const targetFamily = getModuleFamily(target);
      if (targetFamily !== 'OTHER' && targetFamily !== currentFamily) {
        return { classification: 'DIFFERENT_ACTIVITY', targetAction: target };
      }
      return { classification: 'SAME_ACTIVITY' };
    }

    if (/RETRIEVAL_QUERY/i.test(raw)) {
      return { classification: 'RETRIEVAL_QUERY' };
    }

    if (/SAME_ACTIVITY/i.test(raw)) {
      if (isStageOnlyUpdate(trimmed)) {
        return { classification: 'STAGE_UPDATE' };
      }
      // Check if deterministic regex detects a clear cross-module action that LLM might have missed
      const fallbackDiff = detectOutOfScopeActionAttempt(activeActivity, trimmed);
      if (fallbackDiff) {
        return { classification: 'DIFFERENT_ACTIVITY', targetAction: fallbackDiff };
      }
      return { classification: 'SAME_ACTIVITY' };
    }
  } catch (err) {
    console.warn('[CatalogFlow] AI active session intent classifier notice:', err.message);
  }

  // Deterministic fallback if model call failed or was ambiguous
  if (isStageUpdatePrompt(trimmed)) {
    if (!isStageOnlyUpdate(trimmed) && !trimmed.match(/\b(?:INQ|DEAL|ORD|PO)-([A-Z0-9]+)\b/i)) {
      return { classification: 'SAME_ACTIVITY' };
    }
    return { classification: 'STAGE_UPDATE' };
  }

  const fallbackDiff = detectOutOfScopeActionAttempt(activeActivity, trimmed);
  if (fallbackDiff) {
    return { classification: 'DIFFERENT_ACTIVITY', targetAction: fallbackDiff };
  }

  if (isOperationalQuery(trimmed)) {
    return { classification: 'RETRIEVAL_QUERY' };
  }

  return { classification: 'SAME_ACTIVITY' };
}

function detectOutOfScopeActionAttempt(currentAction, text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const currentFamily = getModuleFamily(currentAction);

  // 1. Fast guard: If message is explicitly targeting a field edit/update (notes, remarks, rate, qty, etc.),
  // it is data/edit for the current active flow, NEVER a module switch!
  const isExplicitFieldEdit = /^(?:(?:change|edit|update|modify|set|alter|revise|amend|replace)\s+(?:the\s+)?)?(?:additional\s*notes?|notes?|remarks?|meeting\s*remarks?|discussion\s*notes?|resolution\s*notes?|comments?|description|rate|price|target\s*price|bhav|quantity|qty|payment\s*terms?|delivery\s*location|location|city|person\s*met|contact\s*person|contact\s*phone|phone|mobile|visit\s*date|po\s*number|po\s*no|po\s*date|status|stage|preferred\s*make|make)\s*(?:to|as|is|:|=|\s+-)\s*/i.test(trimmed);
  if (isExplicitFieldEdit) {
    return null;
  }

  // Keep detailed "new customer visit" text inside an active visit workflow.
  if (
    currentFamily === 'VISIT' &&
    /\b(?:add|log|record|create|visit(?:ed)?|meeting|met)\b/i.test(trimmed) &&
    !/\b(?:update|change|modify|edit|correct|amend|revise)\b/i.test(trimmed)
  ) {
    return null;
  }

  // 2. If user sent an explicit menu command (menu_X / action keywords). Called only with an active flow,
  // so bare numbers are field input here, not catalog selections.
  const menuAction = matchActionFromInput(trimmed, true);
  if (menuAction && menuAction !== currentAction) {
    const menuFamily = getModuleFamily(menuAction);
    if (menuFamily !== 'OTHER' && menuFamily !== currentFamily) {
      return menuAction;
    }
  }

  // 3. If the input is primarily a reference ID (INQ-*, PO-*, VIS-*, CMP-*, or hex code),
  // it is data for the active draft (e.g. inquiry_id for LOG_ORDER, po_number for LOG_COMPLAINT).
  // Do NOT treat reference IDs as a switch action!
  const isPureRefId = /^#?(?:INQ|DEAL|PO|VIS|CMP)-[A-Z0-9-]+$/i.test(trimmed) ||
    /^[A-F0-9]{6,36}$/i.test(trimmed) ||
    /^#?[A-F0-9]{6,8}$/i.test(trimmed);
  if (isPureRefId) return null;

  // 4. Check DIRECT_ACTION_MAP for explicit cross-module action intents
  for (const entry of DIRECT_ACTION_MAP) {
    if (entry.pattern.test(trimmed) && entry.action !== currentAction) {
      const targetFamily = getModuleFamily(entry.action);
      if (targetFamily !== 'OTHER' && targetFamily !== currentFamily) {
        return entry.action;
      }
    }
  }

  return null;
}

// ── MAIN CATALOG FLOW HANDLER ────────────────────────────────────────────────

/**
 * Main entry point called by webhook before delegating to LangGraph orchestrator.
 * Returns:
 * { handled: true, reply: "..." } if intercepted and handled by catalog state machine
 * { handled: false } if message should proceed to general LangGraph Orchestrator
 */
async function beginVisitPhoneCode(draft, senderPhone) {
  let sent;
  try {
    sent = await requestVisitCode(supabase, draft.contact_phone || draft.contact_no);
  } catch {
    return { handled: true, reply: 'Unable to send the visit code right now.' };
  }
  if (!sent.ok) return { handled: true, reply: sent.message };
  await saveActiveSession(
    senderPhone,
    draft.company_name || 'Customer',
    `catalog_visit_otp|LOG_VISIT|${JSON.stringify(draft)}`,
  );
  return { handled: true, reply: sent.message };
}

async function handleCatalogVisitOtp(text, senderPhone, lastIntent) {
  const draft = safeParseJSON(lastIntent.split('|').slice(2).join('|'), {});
  const clean = String(text || '').trim();
  if (/^(?:cancel|discard|abort|stop|exit)$/i.test(clean)) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return { handled: true, reply: `Visit logging for ${draft.company_name || 'the customer'} cancelled.` };
  }
  if (/^(?:resend|send again|new code)$/i.test(clean)) {
    return beginVisitPhoneCode(draft, senderPhone);
  }
  if (!/^\d{6}$/.test(clean)) {
    return { handled: true, reply: 'Reply with the 6-digit visit code, or say resend.' };
  }
  await recordSessionMessage(senderPhone, 'user', 'Visit code entered', { action_type: 'LOG_VISIT' });
  const verified = await verifyVisitCode(supabase, draft.contact_phone || draft.contact_no, clean);
  if (!verified.ok) return { handled: true, reply: verified.message };
  draft.verification_token = verified.token;
  const reply = await executeAction('LOG_VISIT', draft, senderPhone);
  if (isExecutionFailureReply(reply)) {
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_visit_otp|LOG_VISIT|${JSON.stringify(draft)}`);
    return { handled: true, reply };
  }
  await recordSessionMessage(senderPhone, 'assistant', reply, {
    action_type: 'LOG_VISIT',
    customer_name: draft.company_name,
  });
  recordInactiveDraft(senderPhone, 'LOG_VISIT', draft, 'saved');
  await finalizeCurrentSession(senderPhone, null, {
    action_type: 'LOG_VISIT',
    customer_name: draft.company_name,
    extracted_data: draft,
  });
  await saveActiveSession(senderPhone, 'Unknown', 'general');
  return {
    handled: true,
    reply,
    interactiveType: 'buttons',
    interactiveButtons: getPostActivityButtons('LOG_VISIT'),
  };
}

async function handleCatalogFlow(rawText, senderPhone, options = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text && !options.imageBuffer) return { handled: false };

  if (typeof getCustomProductsList === 'function') {
    await getCustomProductsList().catch(() => {});
  }

  const { photoDataUrl, gpsData, attachmentObj, incomingAttachments } = extractPhotoAndGps(rawText, options);
  const canUpdateVisits = await canUserUpdateVisits(senderPhone);
  const callerSourceChannel = options.source_channel || options.channel || null;

  // ── 1. FETCH ACTIVE SESSION STATE ──────────────────────────────────────────
  const activeSession = await getFullActiveSession(senderPhone);
  let lastIntent = activeSession ? (activeSession.last_intent || '') : '';

  if (lastIntent.startsWith('catalog_visit_otp|')) {
    return await handleCatalogVisitOtp(text, senderPhone, lastIntent);
  }

  // If currently in a dedicated webhook rejection/payment/unit flow, do not intercept
  if (lastIntent.startsWith('pending_')) {
    return { handled: false };
  }

  const hasActiveCatalogSession = lastIntent.startsWith('catalog_');

  if (isSalesPriceText(text) || (lastIntent.startsWith('sales_price|') && !hasActiveCatalogSession)) {
    const priced = await handleSalesPriceChat(text, senderPhone, lastIntent, {
      supabase,
      saveActiveSession,
      getAccessibleSalespersonPhonesForBot,
      expandPhoneVariants,
    });
    if (priced?.handled) return priced;
  }

  const inFullPrice = String(lastIntent || '').startsWith('sales_full|');
  const fullPriceLeave = text.trim().toLowerCase();
  if (inFullPrice && /^(menu|hi|hello|hey|start|btn_post_menu)$/i.test(fullPriceLeave)) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    lastIntent = 'general';
  } else if (inFullPrice && isDiscardOrCancelIntent(text)) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    const userMenu = getCatalogMenu(canUpdateVisits);
    const userSections = getCatalogMenuSections(canUpdateVisits);
    return {
      handled: true,
      reply: `Activity cancelled.\n\n${userMenu}`,
      interactiveType: 'list',
      interactiveList: {
        bodyText: 'Here is the menu to start a new activity:',
        buttonText: 'Choose Action',
        sections: userSections,
      },
    };
  } else if (isFullPriceEntry(text) || inFullPrice || (!hasActiveCatalogSession && isBareAddPriceChoice(text))) {
    if (!inFullPrice && (isFullPriceEntry(text) || isBareAddPriceChoice(text))) {
      const { denialReply } = require('../utils/permissions');
      const denied = await denialReply(senderPhone, 'ADD_PRICE');
      if (denied) {
        await recordSessionMessage(senderPhone, 'assistant', denied, { action_type: 'ACCESS_DENIED' });
        return { handled: true, reply: denied };
      }
    }
    const quoted = await handleFullSalesPrice(text, senderPhone, lastIntent, {
      supabase,
      saveActiveSession,
      getAccessibleSalespersonPhonesForBot,
      expandPhoneVariants,
    });
    if (quoted?.handled) return quoted;
  }

  if (options.imageBuffer && (
    lastIntent.startsWith('catalog_flow|LOG_INQUIRY') ||
    lastIntent.startsWith('catalog_editing|LOG_INQUIRY') ||
    lastIntent.startsWith('catalog_confirm|LOG_INQUIRY') ||
    lastIntent.startsWith('catalog_selection|LOG_INQUIRY')
  )) {
    const caption = /^(?:attached image|photo uploaded)$/i.test(text) ? '' : text;
    return await handleInquiryDocumentOcr(
      options.imageBuffer,
      options.imageMimeType || 'image/jpeg',
      senderPhone,
      caption,
    );
  }

  if (options.imageBuffer && (
    lastIntent.startsWith('catalog_flow|LOG_ORDER') ||
    lastIntent.startsWith('catalog_editing|LOG_ORDER') ||
    lastIntent.startsWith('catalog_confirm|LOG_ORDER')
  )) {
    const caption = /^(?:attached image|photo uploaded)$/i.test(text) ? '' : text;
    return await handleOrderDocumentOcr(
      options.imageBuffer,
      options.imageMimeType || 'image/jpeg',
      senderPhone,
      caption,
    );
  }

  if (isDirectOrderRequest(text)) {
    const { can } = require('../utils/permissions');
    if (!await can(senderPhone, 'orders.create')) {
      const denied = 'You do not have permission to log orders. Please contact your admin.';
      await recordSessionMessage(senderPhone, 'assistant', denied, { action_type: 'ACCESS_DENIED' });
      return { handled: true, reply: denied };
    }
    return await beginDirectOrder(senderPhone, callerSourceChannel);
  }

  // ── 2-0. BARE NUMBER WITH NO OPEN SESSION ──
  // Only a displayed catalog menu (or a "reply with N" prompt) makes "1".."10" a catalog selection.
  // Legacy payload states (e.g. "duplicate_check|...") keep their existing handling.
  if (!hasActiveCatalogSession && !lastIntent.includes('|') && isBareCatalogNumber(text)) {
    const menuAwaiting = await isCatalogMenuAwaitingSelection(senderPhone);
    if (!menuAwaiting) {
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', BARE_NUMBER_NO_SESSION_REPLY, { action_type: 'BARE_NUMBER_NO_SESSION' });
      return { handled: true, reply: BARE_NUMBER_NO_SESSION_REPLY };
    }
  }

  // ── 2a. DIRECT EXPLICIT MENU SELECTION (PREEMPTION) ────────────────────────
  // When user selects any option from catalog list ([Choose Action] or direct action commands),
  // immediately clean up any prior flow and start the newly selected module prompt.
  const isAwaitingCandidateSelection = lastIntent.startsWith('catalog_update_select|');
  const menuAwaiting = (!isAwaitingCandidateSelection && isBareCatalogNumber(text))
    ? await isCatalogMenuAwaitingSelection(senderPhone)
    : false;

  const explicitAction = isExplicitMenuSelection(text, hasActiveCatalogSession && !menuAwaiting, canUpdateVisits);
  if (explicitAction) {
    const { denialReply } = require('../utils/permissions');
    const denied = await denialReply(senderPhone, explicitAction);
    if (denied) {
      await recordSessionMessage(senderPhone, 'assistant', denied, { action_type: 'ACCESS_DENIED' });
      return { handled: true, reply: denied };
    }
    if (hasActiveCatalogSession) {
      try {
        const parts = (lastIntent || '').split('|');
        const prevAction = parts[1];
        const prevDraft = parts[2] ? safeParseJSON(parts[2], {}) : {};
        recordInactiveDraft(senderPhone, prevAction, prevDraft, 'discarded');
      } catch (e) {}
      await finalizeCurrentSession(senderPhone, `Switched to ${getActionFriendlyName(explicitAction)}`);
    }
    await recordSessionMessage(senderPhone, 'user', text);

    if (explicitAction === 'GENERAL_QUERY') {
      const genReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
      await recordSessionMessage(senderPhone, 'assistant', genReply, { action_type: 'GENERAL_QUERY' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: genReply,
      };
    }

    if (['LOG_ORDER', 'UPDATE_INQUIRY', 'UPDATE_ORDER', 'UPDATE_VISIT', 'UPDATE_COMPLAINT'].includes(explicitAction)) {
      if (explicitAction === 'UPDATE_VISIT' && !canUpdateVisits) {
        const deniedReply = `Access Denied: Field visits can only be updated by Sales Managers and Administrators. Please contact your manager to update a logged visit.`;
        await recordSessionMessage(senderPhone, 'assistant', deniedReply, { action_type: 'ACCESS_DENIED' });
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return { handled: true, reply: deniedReply };
      }

      const selectionRes = await fetchAndRenderUpdateSelection(explicitAction, senderPhone, { page: 1, customerFilter: null });
      await startNewCatalogSession(senderPhone, selectionRes.reply);
      await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: explicitAction });
      if (selectionRes.hasRecords || explicitAction === 'LOG_ORDER') {
        await saveActiveSession(senderPhone, 'Unknown', `catalog_update_select|${explicitAction}|${JSON.stringify(selectionRes.state)}`);
      } else {
        await saveActiveSession(senderPhone, 'Unknown', 'general');
      }
      return catalogSelectionResult(selectionRes);
    }

    const initialPrompt = MODULE_PROMPTS[explicitAction];
    if (initialPrompt) {
      await startNewCatalogSession(senderPhone, initialPrompt);
      await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: explicitAction });
      const initialDraft = callerSourceChannel ? { source_channel: callerSourceChannel } : {};
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${explicitAction}|${JSON.stringify(initialDraft)}`);
      return {
        handled: true,
        reply: initialPrompt,
      };
    }
  }

  // ── 2-stale. STALE BUTTON / INACTIVE DRAFT INTERCEPTOR ─────────────────────
  const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!hasActiveCatalogSession && !lastIntent.includes('|')) {
    if (isStaleDraftButtonAction(cleanInput)) {
      return await handleStaleDraftButton(text, senderPhone, canUpdateVisits);
    }
    if (isStaleResumeNoAction(cleanInput)) {
      return await handleResumeMenuButton(text, senderPhone, canUpdateVisits);
    }
  }

  // A duplicate customer registration blocks the current draft. The only
  // supported action is discarding it; do not let arbitrary text resume or
  // overwrite the draft with a different customer.
  if (lastIntent.startsWith('catalog_duplicate_blocked|')) {
    const parts = lastIntent.split('|');
    const action = parts[1] || 'LOG_INQUIRY';
    const draft = safeParseJSON(parts.slice(2).join('|'), {});
    if (isDiscardOrCancelIntent(text)) {
      recordInactiveDraft(senderPhone, action, draft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Discarded ${getActionFriendlyName(action)} flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return await handleResumeMenuButton(text, senderPhone, canUpdateVisits);
    }

    const blockedReply = `This draft is paused because the customer is already registered under another representative.\n\nPlease select *Discard Draft* to close this entry.`;
    return buildDuplicateCustomerResponse(blockedReply);
  }

  // ── 2b. GREETING CHECK ──────────────────────────────────────────────────────
  if (await isGreeting(text)) {
    const userMenu = getCatalogMenu(canUpdateVisits);
    const userSections = getCatalogMenuSections(canUpdateVisits);
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    await startNewCatalogSession(senderPhone, userMenu);
    return {
      handled: true,
      reply: userMenu,
      interactiveType: 'list',
      interactiveList: {
        bodyText: `Welcome to *SalesOS Assistant*!\n\nHere is the menu to start a new activity:`,
        buttonText: 'Choose Action',
        sections: userSections,
      },
    };
  }

  // ── 2c. OUT-OF-SCOPE DELIVERY / DISPATCH QUERY CHECK ─────────────────────────
  if (isOutOfScopeDeliveryQuery(text)) {
    const outOfScopeMsg = `ℹ️ *Delivery & Dispatch Tracking is Out of Scope*\n\nOrder delivery, shipment, and dispatch tracking are not currently within my scope.\n\nPlease ask questions related to Inquiries, Won Orders, Customer Visits, Complaints, Payments, or Customer Master records.`;
    await recordSessionMessage(senderPhone, 'assistant', outOfScopeMsg);
    return {
      handled: true,
      reply: outOfScopeMsg,
    };
  }

  // ── 2d. INQUIRY SYSTEM-GENERATED FIELD EDIT GUARD (runs before AI classification / record search) ──
  const inqSystemFieldEdit = detectInquirySystemFieldEdit(text);
  if (inqSystemFieldEdit) {
    const sysParts = lastIntent.split('|');
    const sysState = sysParts[0];
    const sysAction = sysParts[1];
    const mentionsInquiry = /\b(?:inquiry|enquiry|inq|deal)\b|\b(?:INQ|DEAL)-[A-Z0-9]+/i.test(text);

    if (sysState === 'catalog_update_select' && sysAction === 'UPDATE_INQUIRY') {
      const sysReply = buildInquirySystemFieldReply(inqSystemFieldEdit.label);
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', sysReply, { action_type: sysAction });
      return { handled: true, reply: sysReply };
    }

    if (['catalog_flow', 'catalog_editing', 'catalog_confirm'].includes(sysState) && sysAction === 'UPDATE_INQUIRY') {
      const sysDraft = safeParseJSON(sysParts.slice(2).join('|'), {});
      const sysReply = buildInquirySystemFieldReply(inqSystemFieldEdit.label, sysDraft._inquiry_display_id || null);
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', sysReply, { action_type: sysAction, customer_name: sysDraft.company_name || null });
      return { handled: true, reply: sysReply };
    }

    if (!hasActiveCatalogSession && (inqSystemFieldEdit.field === 'inquiry_id' || mentionsInquiry)) {
      await recordSessionMessage(senderPhone, 'user', text);
      let custFilter = null;
      const custMatch = text.match(/\b(?:for|of|regarding)\s+([A-Za-z0-9\s&.,'-]+?)(?:,|\s+change|\s+edit|\s+update|\s+set|\s+modify|\s+to\b|$)/i);
      if (custMatch && custMatch[1]) {
        const candidateName = custMatch[1].trim().replace(/[.,\s]+$/, '');
        if (candidateName.length >= 2 && !/^(?:the|a|an|this|that|my|customer|inquiry|enquiry|inq|deal)$/i.test(candidateName)) {
          const hits = await fetchEditableRecordsForModule('UPDATE_INQUIRY', senderPhone, { customerFilter: candidateName });
          if (hits.length > 0) custFilter = candidateName;
        }
      }
      const sysHeader = buildInquirySystemFieldReply(inqSystemFieldEdit.label);
      const selectionRes = await fetchAndRenderUpdateSelection('UPDATE_INQUIRY', senderPhone, { page: 1, customerFilter: custFilter });
      const sysReply = selectionRes.hasRecords
        ? `${sysHeader}\n\n${selectionRes.reply}`
        : `*${inqSystemFieldEdit.label} is system-generated and can't be edited.*\n\n${selectionRes.reply}`;
      await startNewCatalogSession(senderPhone, sysReply);
      await recordSessionMessage(senderPhone, 'assistant', sysReply, { action_type: 'UPDATE_INQUIRY' });
      if (selectionRes.hasRecords) {
        await saveActiveSession(senderPhone, custFilter || 'Unknown', `catalog_update_select|UPDATE_INQUIRY|${JSON.stringify(selectionRes.state)}`);
      } else {
        await saveActiveSession(senderPhone, 'Unknown', 'general');
      }
      return { handled: true, reply: sysReply };
    }
  }

  // ── 2b. ACTIVE SESSION SCOPE GUARD (AI INTENT CLASSIFICATION) ──────────────
  if (
    hasActiveCatalogSession &&
    !lastIntent.startsWith('catalog_resume_ask|') &&
    !lastIntent.startsWith('catalog_cust_match_confirm|') &&
    !lastIntent.startsWith('catalog_implicit_cust_ask|') &&
    !lastIntent.startsWith('catalog_implicit_cust_collect|') &&
    !lastIntent.startsWith('catalog_implicit_prod_add|') &&
    !lastIntent.startsWith('catalog_update_select|')
  ) {
    const cleanInput = text.toLowerCase().replace(/[^a-z0-9\s_/]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = lastIntent.split('|');
    const activeState = parts[0];
    const currentAction = parts[1];
    const currentDraft = safeParseJSON(parts.slice(2).join('|'), {});

    // Check if user is resolving a complaint mid-flow
    const { isExplicitComplaintResolution } = require('../kra8');
    if (isExplicitComplaintResolution(text) && currentAction !== 'UPDATE_COMPLAINT' && currentAction !== 'LOG_COMPLAINT') {
      return await handleMidFlowComplaintResolution(text, senderPhone, activeState, currentAction, currentDraft);
    }

    const isControlReply =
      isDiscardOrCancelIntent(text) ||
      isDiscardOrCancelIntent(cleanInput) ||
      [
        'yes', 'y', '1', 'confirm', 'save', 'haan', 'ha', 'sahi hai', 'ok', 'sure', 'save / yes', 'save/yes', 'save yes',
        'edit', 'change', '2', 'edit details',
        'cancel', 'discard', 'no', 'n', '3', 'stop', 'exit', 'quit', 'nahi', 'wrong', 'galat',
        'btn_confirm_yes', 'btn_confirm_edit', 'btn_confirm_cancel',
        'btn_add_product', 'add product', 'btn_prod_save', 'save product'
      ].includes(cleanInput);
    const isComplaintEvidenceUpload =
      currentAction === 'LOG_COMPLAINT' &&
      Boolean(photoDataUrl || attachmentObj || incomingAttachments.length > 0);

    if (!isControlReply && !currentDraft._pending_line_choice && !isComplaintEvidenceUpload) {
      // AI Intent Classifier: Classify every non-control incoming message against active session
      const intentResult = await classifyActiveSessionIntent(currentAction, text);
      console.log(`[CatalogFlow] Active session (${currentAction}) AI classification for "${text.slice(0, 50)}...":`, intentResult);

      if (intentResult.classification === 'OUT_OF_SCOPE_GENERIC') {
        const resumeMsg = buildResumePrompt(currentAction, currentDraft);
        const outOfScopeMsg = `⚠️ *Out of Scope Request*\n\nI am the *Enlight Metals SalesOS Assistant* and cannot answer general knowledge, trivia, or non-sales questions.\n\n━━━━━━━━━━━━━━━━━━━━\n${resumeMsg}`;
        await recordSessionMessage(senderPhone, 'user', text);
        await recordSessionMessage(senderPhone, 'assistant', outOfScopeMsg, { action_type: 'OUT_OF_SCOPE_REDIRECT' });
        await saveActiveSession(senderPhone, currentDraft.company_name || 'Customer', `catalog_resume_ask|${activeState}|${currentAction}|${JSON.stringify(currentDraft)}`);
        return {
          handled: true,
          reply: outOfScopeMsg,
          interactiveType: 'buttons',
          interactiveButtons: RESUME_QUERY_BUTTONS,
        };
      }

      if (intentResult.classification === 'RETRIEVAL_QUERY') {
        return await handleMidFlowRetrievalQuery(text, senderPhone, activeState, currentAction, currentDraft);
      }

      if (intentResult.classification === 'STAGE_UPDATE') {
        return await handleMidFlowStageUpdate(text, senderPhone, activeState, currentAction, currentDraft);
      }

      if (intentResult.classification === 'DIFFERENT_ACTIVITY') {
        console.log(`[CatalogFlow] Strict activity scope guard: active=${currentAction}, incoming=${intentResult.targetAction}`);
        await recordSessionMessage(senderPhone, 'user', text);
        const outOfScopeRes = buildOutOfScopeActivityResponse(currentAction, intentResult.targetAction);
        await recordSessionMessage(senderPhone, 'assistant', outOfScopeRes.reply, { action_type: 'OUT_OF_SCOPE_REDIRECT' });
        // NOTE: Session state remains 100% intact in the background. DO NOT overwrite or finalize!
        return outOfScopeRes;
      }
      // If SAME_ACTIVITY, proceed into the flow below!
    }
  }

  // ── 2c. HANDLE UPDATE RECORD SELECTION STATE (catalog_update_select|action|stateJson) ──
  if (lastIntent.startsWith('catalog_update_select|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const selectionStateJson = parts.slice(2).join('|');
    const selectionState = safeParseJSON(selectionStateJson, {});
    return await handleUpdateSelectionState(text, senderPhone, action, selectionState);
  }

  // ── 3-0. HANDLE RESUME ASK STATE (catalog_resume_ask|interruptedState|action|draftJson) ──
  if (lastIntent.startsWith('catalog_resume_ask|')) {
    const parts = lastIntent.split('|');
    const interruptedState = parts[1] || 'catalog_flow';
    const action = parts[2] || 'LOG_INQUIRY';
    const draftJsonStr = parts.slice(3).join('|');
    const draft = safeParseJSON(draftJsonStr, {});

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // 1. User says YES -> restore the interrupted flow exactly
    if (
      cleanInput === 'btn_resume_yes' ||
      cleanInput === 'yes, continue' ||
      cleanInput === 'yes continue' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === 'haan' ||
      cleanInput === 'ha' ||
      cleanInput === 'continue' ||
      cleanInput === 'resume' ||
      cleanInput === 'proceed' ||
      cleanInput === 'sure' ||
      cleanInput === 'ok'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const res = await restoreInterruptedFlow(senderPhone, interruptedState, action, draft);
      await recordSessionMessage(senderPhone, 'assistant', res.reply, {
        action_type: action,
        customer_name: draft.company_name || null,
      });
      return res;
    }

    // 2. User says NO / Cancel / Menu -> finalize and show catalog
    if (
      cleanInput === 'btn_resume_no' ||
      cleanInput === 'no, go to menu' ||
      cleanInput === 'no go to menu' ||
      cleanInput === 'no' ||
      cleanInput === 'n' ||
      cleanInput === 'nahi' ||
      cleanInput === 'menu' ||
      cleanInput === 'cancel' ||
      cleanInput === 'discard' ||
      cleanInput === 'btn_post_menu' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      recordInactiveDraft(senderPhone, action, draft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft after query interruption`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      const userMenu = getCatalogMenu(canUpdateVisits);
      const userSections = getCatalogMenuSections(canUpdateVisits);
      const exitMsg = `Activity cancelled.\n\n` + userMenu;
      await recordSessionMessage(senderPhone, 'assistant', exitMsg, { action_type: 'CATALOG_MENU' });
      return {
        handled: true,
        reply: exitMsg,
        interactiveType: 'list',
        interactiveList: {
          bodyText: 'Here is the menu to start a new activity:',
          buttonText: 'Choose Action',
          sections: userSections,
        },
      };
    }

    // 3. User asks mid-resume complaint resolution, stage update, or retrieval query
    const { isExplicitComplaintResolution } = require('../kra8');
    if (isExplicitComplaintResolution(text) && action !== 'UPDATE_COMPLAINT' && action !== 'LOG_COMPLAINT') {
      return await handleMidFlowComplaintResolution(text, senderPhone, interruptedState, action, draft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, interruptedState, action, draft);
    }
    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, interruptedState, action, draft);
    }

    // 4. User directly provides field data / response for the interrupted flow
    // If interrupted state was catalog_update_select, delegate directly to handleUpdateSelectionState!
    if (interruptedState === 'catalog_update_select') {
      await saveActiveSession(senderPhone, draft.customerFilter || 'Customer', `catalog_update_select|${action}|${draftJsonStr}`);
      return await handleUpdateSelectionState(text, senderPhone, action, draft);
    }
    lastIntent = `${interruptedState}|${action}|${draftJsonStr}`;
  }

  // ── 3a-0. HANDLE CUSTOMER LOW-MATCH VALIDATION ASK (catalog_cust_match_confirm|...) ──
  if (lastIntent.startsWith('catalog_cust_match_confirm|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const fetchedName = parts[2];
    const candidates = safeParseJSON(parts[3], []);
    const originalDraftJsonStr = parts.slice(4).join('|');
    const originalDraft = safeParseJSON(originalDraftJsonStr, {});
    if (callerSourceChannel && !originalDraft.source_channel) {
      originalDraft.source_channel = callerSourceChannel;
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Check mid-flow interruptions
    const { isExplicitComplaintResolution } = require('../kra8');
    if (isExplicitComplaintResolution(text) && originalAction !== 'UPDATE_COMPLAINT' && originalAction !== 'LOG_COMPLAINT') {
      return await handleMidFlowComplaintResolution(text, senderPhone, 'catalog_cust_match_confirm', originalAction, originalDraft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, 'catalog_cust_match_confirm', originalAction, originalDraft);
    }
    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_cust_match_confirm', originalAction, originalDraft);
    }

    // Cancel / Discard
    if (
      isDiscardOrCancelIntent(text) ||
      cleanInput === 'btn_confirm_cancel' ||
      cleanInput === 'btn_cust_no' ||
      cleanInput === 'cancel' ||
      cleanInput === 'discard' ||
      cleanInput === 'stop' ||
      cleanInput === 'exit'
    ) {
      await clearActiveSession(senderPhone);
      await recordSessionMessage(senderPhone, 'assistant', 'Draft cancelled.', { action_type: originalAction });
      return { handled: true, reply: 'Activity cancelled. What would you like to do next?' };
    }

    let chosenCustomer = null;

    const isYes =
      cleanInput === 'btn_confirm_yes' ||
      cleanInput === 'btn_cust_yes' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === 'confirm' ||
      cleanInput === 'haan' ||
      cleanInput === 'ha' ||
      cleanInput === 'ok' ||
      cleanInput === 'sure' ||
      cleanInput === 'sahi hai';

    if (isYes) {
      chosenCustomer = fetchedName;
    } else {
      const numMatch = cleanInput.match(/^[#*]?\s*([1-3])\s*[.)]?$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < candidates.length) {
          chosenCustomer = candidates[idx];
        }
      }
    }

    if (!chosenCustomer) {
      const recheckedName = await verifyAndGetCustomerName(text, senderPhone);
      if (recheckedName) {
        chosenCustomer = recheckedName;
      }
    }

    if (chosenCustomer) {
      originalDraft.company_name = chosenCustomer;
      originalDraft._customer_verified = true;

      const custProdCheck = validateDraftProducts(originalAction, originalDraft);
      if (!custProdCheck.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', custProdCheck.clarificationMessage, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: custProdCheck.clarificationMessage,
          interactiveType: 'buttons',
          interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
        };
      }

      const parentMissing = validateMandatoryFields(originalAction, originalDraft);
      if (parentMissing.length === 0) {
        const lineChoice = await askLineItemChoiceIfNeeded(originalAction, originalDraft, senderPhone);
        if (lineChoice) return lineChoice;
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        await recordSessionMessage(senderPhone, 'assistant', summary, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: summary,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const missingList = parentMissing.map((m) => `• *${m}*`).join('\n');
        const askMsg = `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${missingList}`;
        await recordSessionMessage(senderPhone, 'assistant', askMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: askMsg };
      }
    }

    const rePrompt = buildCustomerMatchValidationMessage(text, fetchedName, candidates);
    return {
      handled: true,
      reply: rePrompt,
      interactiveType: 'buttons',
      interactiveButtons: CUST_MATCH_BUTTONS,
    };
  }

  // ── 3a. HANDLE IMPLICIT CUSTOMER CONFIRMATION ASK (catalog_implicit_cust_ask|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_ask|')) {
    // Format: catalog_implicit_cust_ask|ACTION|<customer name>|{draft json}
    // The customer name itself may contain '|', so split on the start of the JSON payload.
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const afterAction = parts.slice(2).join('|');
    const jsonStartIdx = afterAction.indexOf('|{');
    const unrecognizedName = jsonStartIdx >= 0 ? afterAction.slice(0, jsonStartIdx) : parts[2];
    const originalDraftJsonStr = jsonStartIdx >= 0 ? afterAction.slice(jsonStartIdx + 1) : parts.slice(3).join('|');
    const originalDraft = safeParseJSON(originalDraftJsonStr, {});
    if (callerSourceChannel && !originalDraft.source_channel) {
      originalDraft.source_channel = callerSourceChannel;
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Check mid-flow interruptions
    const { isExplicitComplaintResolution } = require('../kra8');
    if (isExplicitComplaintResolution(text) && originalAction !== 'UPDATE_COMPLAINT' && originalAction !== 'LOG_COMPLAINT') {
      return await handleMidFlowComplaintResolution(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }
    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_implicit_cust_ask', originalAction, originalDraft);
    }

    // User confirmed YES (This is a new customer) or provided customer details
    const isDirectCustDetails = /\b[6-9]\d{9}\b/.test(text) || (cleanInput.includes('yes') && text.length > 5);
    if (
      isDirectCustDetails ||
      cleanInput === 'btn_cust_yes' ||
      cleanInput === 'yes, add customer' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === '1' ||
      cleanInput === 'confirm' ||
      cleanInput === 'haan' ||
      cleanInput === 'ha' ||
      cleanInput === 'sahi hai' ||
      cleanInput === 'ok' ||
      cleanInput === 'sure' ||
      cleanInput === 'new customer' ||
      cleanInput === 'add'
    ) {
      let custDraft = {
        action: 'LOG_NEW_CUSTOMER',
        company_name: unrecognizedName,
        contact_person: originalDraft.person_met || originalDraft.contact_person || null,
        mobile_number: originalDraft.contact_phone || originalDraft.mobile_number || originalDraft.phone || null,
        // City / visit location does not imply a customer's delivery location.
        delivery_location: originalDraft.delivery_location || null,
        email: originalDraft.email || null,
        gst_number: originalDraft.gst_number || null,
        _parentAction: originalAction,
        _parentDraft: originalDraft,
      };

      if (isDirectCustDetails) {
        custDraft = await extractFieldsWithLLM('LOG_NEW_CUSTOMER', text, custDraft);
      }

      // Immediate duplicate registration check across recurring_customers
      const regCheck = await checkCompanyWideCustomerRegistration(custDraft.company_name || unrecognizedName, senderPhone);
      if (regCheck && regCheck.isRegistered) {
        const conflictReply = regCheck.conflictMessage;
        await recordSessionMessage(senderPhone, 'assistant', conflictReply, {
          action_type: originalAction,
          customer_name: custDraft.company_name || unrecognizedName,
        });
        originalDraft.company_name = null;
        await saveActiveSession(senderPhone, 'Customer', `catalog_duplicate_blocked|${originalAction}|${JSON.stringify(originalDraft)}`);
        return buildDuplicateCustomerResponse(conflictReply);
      }

      const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', custDraft);

      if (custMissing.length === 0) {
        // All customer mandatory fields already supplied (e.g. from field visit or direct input)
        const custActionRes = await executeAction('LOG_NEW_CUSTOMER', custDraft, senderPhone);
        if (isExecutionFailureReply(custActionRes) || (typeof custActionRes === 'string' && (custActionRes.includes('Customer Already') || custActionRes.includes('Failed to add customer')))) {
          const conflictReply = custActionRes;
          await recordSessionMessage(senderPhone, 'assistant', conflictReply, {
            action_type: originalAction,
            customer_name: custDraft.company_name,
          });
          originalDraft.company_name = null;
          await saveActiveSession(senderPhone, 'Customer', `catalog_duplicate_blocked|${originalAction}|${JSON.stringify(originalDraft)}`);
          return buildDuplicateCustomerResponse(conflictReply);
        }

        forwardCustomerDetailsToParentDraft(originalAction, originalDraft, custDraft);
        const custProdCheck = validateDraftProducts(originalAction, originalDraft);
        if (!custProdCheck.isValid) {
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n${custProdCheck.clarificationMessage}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
          return {
            handled: true,
            reply: resumeMsg,
            interactiveType: 'buttons',
            interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
          };
        }

        const parentMissing = validateMandatoryFields(originalAction, originalDraft);

        if (parentMissing.length === 0) {
          const summary = buildConfirmationSummary(originalAction, originalDraft);
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n` +
            `Now continuing with your ${getActionFriendlyName(originalAction)}:\n\n${summary}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
          return {
            handled: true,
            reply: resumeMsg,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          const parentMissingList = parentMissing.map(m => `• *${m}*`).join('\n');
          const resumeMsg = `✅ *New Customer "${custDraft.company_name}" Created!*\n\n` +
            `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${parentMissingList}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: originalDraft.company_name,
          });
          await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
          return { handled: true, reply: resumeMsg };
        }
      } else {
        const alreadyProvided = [];
        if (custDraft.contact_person) {
          alreadyProvided.push(`• *Contact Person:* ${custDraft.contact_person} (from your message)`);
        }
        if (custDraft.delivery_location) {
          alreadyProvided.push(`• *Delivery Location:* ${custDraft.delivery_location} (from your message)`);
        }
        if (custDraft.mobile_number) {
          alreadyProvided.push(`• *Mobile Number:* ${custDraft.mobile_number} (from your message)`);
        }

        const missingList = custMissing.map(m => `• *${m}*`).join('\n');
        let askCustMsg = `👤 *New Customer Acquisition — ${unrecognizedName}*\n\n`;
        if (alreadyProvided.length > 0) {
          askCustMsg += `${alreadyProvided.join('\n')}\n\n` +
            `Please provide the remaining details:\n\n` +
            `${missingList}\n\n` +
            `_(e.g. "Mobile: 9820123456, Delivery Location: Bhosari Pune")_`;
        } else {
          askCustMsg += `Please provide the required customer details before we continue with your ${getActionFriendlyName(originalAction)}:\n\n` +
            `${missingList}\n\n` +
            `_(e.g. "Contact Person: Rajesh Sharma, Mobile: 9820123456, Delivery Location: Bhosari Pune")_`;
        }

        await recordSessionMessage(senderPhone, 'assistant', askCustMsg, {
          action_type: 'LOG_NEW_CUSTOMER',
          customer_name: unrecognizedName,
        });
        await saveActiveSession(senderPhone, unrecognizedName, `catalog_implicit_cust_collect|${originalAction}|${JSON.stringify(custDraft)}`);
        return { handled: true, reply: askCustMsg };
      }
    }

    // User confirmed NO (Not a new customer -> re-enter correct name)
    if (
      cleanInput === 'btn_cust_no' ||
      cleanInput === 'no / cancel' ||
      cleanInput === 'no/cancel' ||
      cleanInput === 'no' ||
      cleanInput === 'n' ||
      cleanInput === 'nahi' ||
      cleanInput === 'wrong' ||
      cleanInput === 'galat' ||
      cleanInput === 'cancel'
    ) {
      originalDraft.company_name = null;
      const assignedList = await getAssignedCustomersList(senderPhone);
      const customerNames = (assignedList || []).map(c => c.customer_name).filter(Boolean);
      const pageSize = 10;
      const totalPages = Math.ceil(customerNames.length / pageSize);
      originalDraft._all_customer_candidates = customerNames;
      originalDraft._customer_candidates = customerNames.slice(0, pageSize);
      originalDraft._customer_candidates_page = 1;

      let listDisplay = '';
      if (customerNames.length > 0) {
        const pageItems = customerNames.slice(0, pageSize);
        listDisplay = `\n\n*Your Assigned Accounts (1–${pageItems.length} of ${customerNames.length}):*\n` +
          pageItems.map((name, i) => `  ${i + 1}. *${name}*`).join('\n');
      }

      const paginationHint = totalPages > 1
        ? `\n\n👉 Reply with the *Company Name* (or option number 1–${customerNames.length}), or tap *Next 10 Customers* to view more.`
        : (customerNames.length > 0 ? `\n\n👉 Reply with the *Company Name* or option number (1–${customerNames.length}).` : '');

      const reEnterPrompt = `Understood! 👍 Please reply with the correct *Company Name* so we can proceed with your ${getActionFriendlyName(originalAction)}.${listDisplay}${paginationHint}\n\n` +
        `_(Your other entered details have been preserved)_`;

      await recordSessionMessage(senderPhone, 'assistant', reEnterPrompt, {
        action_type: originalAction,
      });
      await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);

      const buttons = [];
      if (totalPages > 1) {
        buttons.push({ id: 'btn_next_customers', title: 'Next 10 Customers' });
      }
      buttons.push({ id: 'btn_confirm_cancel', title: 'Discard Draft' });

      return {
        handled: true,
        reply: reEnterPrompt,
        interactiveType: 'buttons',
        interactiveButtons: buttons,
      };
    }

    // If user directly typed the correct company name
    const recheckedName = await verifyAndGetCustomerName(text, senderPhone);
    if (recheckedName) {
      originalDraft.company_name = recheckedName;
      const recheckProd = validateDraftProducts(originalAction, originalDraft);
      if (!recheckProd.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', recheckProd.clarificationMessage, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: recheckProd.clarificationMessage,
          interactiveType: 'buttons',
          interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
        };
      }

      const parentMissing = validateMandatoryFields(originalAction, originalDraft);
      if (parentMissing.length === 0) {
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        await recordSessionMessage(senderPhone, 'assistant', summary, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: summary,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const missingList = parentMissing.map(m => `• *${m}*`).join('\n');
        const askMissing = `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${missingList}`;
        await recordSessionMessage(senderPhone, 'assistant', askMissing, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name, `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: askMissing };
      }
    }

    const retryPrompt = `Please reply *Yes* to onboard *${unrecognizedName}* as a new customer, or *No* to re-enter the company name.`;
    await recordSessionMessage(senderPhone, 'assistant', retryPrompt);
    return {
      handled: true,
      reply: retryPrompt,
      interactiveType: 'buttons',
      interactiveButtons: NEW_CUSTOMER_BUTTONS,
    };
  }

  // ── 3b. HANDLE IMPLICIT CUSTOMER DETAILS COLLECTION (catalog_implicit_cust_collect|...) ──
  if (lastIntent.startsWith('catalog_implicit_cust_collect|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1];
    const custDraftJsonStr = parts.slice(2).join('|');
    const custDraft = safeParseJSON(custDraftJsonStr, {});

    await recordSessionMessage(senderPhone, 'user', text);

    if (isDiscardOrCancelIntent(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      recordInactiveDraft(senderPhone, originalAction, custDraft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Discarded customer onboarding flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    // Check mid-flow interruptions
    const { isExplicitComplaintResolution } = require('../kra8');
    if (isExplicitComplaintResolution(text) && originalAction !== 'UPDATE_COMPLAINT' && originalAction !== 'LOG_COMPLAINT') {
      return await handleMidFlowComplaintResolution(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }
    if (isStageUpdatePrompt(text)) {
      return await handleMidFlowStageUpdate(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }

    const intentResult = await classifyActiveSessionIntent('LOG_NEW_CUSTOMER', text);
    if (intentResult.classification === 'RETRIEVAL_QUERY') {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_implicit_cust_collect', originalAction, custDraft);
    }
    if (intentResult.classification === 'DIFFERENT_ACTIVITY') {
      console.log(`[CatalogFlow] Strict activity scope guard in customer collect: active=LOG_NEW_CUSTOMER, incoming=${intentResult.targetAction}`);
      const outOfScopeRes = buildOutOfScopeActivityResponse('LOG_NEW_CUSTOMER', intentResult.targetAction);
      await recordSessionMessage(senderPhone, 'assistant', outOfScopeRes.reply, { action_type: 'OUT_OF_SCOPE_REDIRECT' });
      return outOfScopeRes;
    }

    let updatedCustDraft = await extractFieldsWithLLM('LOG_NEW_CUSTOMER', text, custDraft);
    if (!updatedCustDraft || typeof updatedCustDraft !== 'object') {
      updatedCustDraft = { ...custDraft };
    }
    if (!updatedCustDraft._parentDraft && custDraft._parentDraft) {
      updatedCustDraft._parentDraft = custDraft._parentDraft;
    }

    // Deterministic fallback for mobile_number if not yet extracted
    if (!updatedCustDraft.mobile_number) {
      const cleanDigits = text.replace(/\D/g, '');
      if (cleanDigits.length === 10) {
        updatedCustDraft.mobile_number = cleanDigits;
      } else if (cleanDigits.length === 12 && cleanDigits.startsWith('91')) {
        updatedCustDraft.mobile_number = cleanDigits.slice(-10);
      } else if (cleanDigits.length === 11 && cleanDigits.startsWith('0')) {
        updatedCustDraft.mobile_number = cleanDigits.slice(-10);
      }
    }

    // Deterministic fallback for delivery_location if phone is already set and text has no phone digits
    if (!updatedCustDraft.delivery_location && updatedCustDraft.mobile_number) {
      const cleanLoc = text.replace(/^(?:delivery\s*location|location|city|address)\s*[:=-]?\s*/i, '').trim();
      const hasPhoneDigits = /\b\d{10}\b/.test(text) || text.replace(/\D/g, '').length >= 10;
      if (!hasPhoneDigits && cleanLoc && cleanLoc.length >= 2 && cleanLoc.length <= 60 && !isDiscardOrCancelIntent(cleanLoc)) {
        updatedCustDraft.delivery_location = cleanLoc;
      }
    }

    const custMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', updatedCustDraft);

    if (custMissing.length === 0) {
      const custActionRes = await executeAction('LOG_NEW_CUSTOMER', updatedCustDraft, senderPhone);
      if (isExecutionFailureReply(custActionRes) || (typeof custActionRes === 'string' && (custActionRes.includes('Customer Already') || custActionRes.includes('Failed to add customer')))) {
        const conflictReply = custActionRes;
        await recordSessionMessage(senderPhone, 'assistant', conflictReply, {
          action_type: originalAction,
          customer_name: updatedCustDraft.company_name,
        });
        const originalDraft = updatedCustDraft._parentDraft || {};
        originalDraft.company_name = null;
        await saveActiveSession(senderPhone, 'Customer', `catalog_duplicate_blocked|${originalAction}|${JSON.stringify(originalDraft)}`);
        return buildDuplicateCustomerResponse(conflictReply);
      }

      const originalDraft = updatedCustDraft._parentDraft || {};
      forwardCustomerDetailsToParentDraft(originalAction, originalDraft, updatedCustDraft);
      const collectProdCheck = validateDraftProducts(originalAction, originalDraft);
      if (!collectProdCheck.isValid) {
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n${collectProdCheck.clarificationMessage}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: resumeMsg,
          interactiveType: 'buttons',
          interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
        };
      }
      const parentMissing = validateMandatoryFields(originalAction, originalDraft);

      if (parentMissing.length === 0) {
        const summary = buildConfirmationSummary(originalAction, originalDraft);
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n` +
          `Now continuing with your ${getActionFriendlyName(originalAction)}:\n\n${summary}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_confirm|${originalAction}|${JSON.stringify(originalDraft)}`);
        return {
          handled: true,
          reply: resumeMsg,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const parentMissingList = parentMissing.map(m => `• *${m}*`).join('\n');
        const resumeMsg = `✅ *New Customer "${updatedCustDraft.company_name}" Successfully Created!*\n\n` +
          `Please provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${parentMissingList}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: originalDraft.company_name,
        });
        await saveActiveSession(senderPhone, originalDraft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(originalDraft)}`);
        return { handled: true, reply: resumeMsg };
      }
    } else {
      const alreadyProvided = [];
      if (updatedCustDraft.contact_person) {
        alreadyProvided.push(`• *Contact Person:* ${updatedCustDraft.contact_person}`);
      }
      if (updatedCustDraft.mobile_number) {
        alreadyProvided.push(`• *Mobile Number:* ${updatedCustDraft.mobile_number}`);
      }
      if (updatedCustDraft.delivery_location) {
        alreadyProvided.push(`• *Delivery Location:* ${updatedCustDraft.delivery_location}`);
      }

      const missingList = custMissing.map(m => `• *${m}*`).join('\n');
      let askRemaining = `👤 *New Customer Acquisition — ${updatedCustDraft.company_name}*\n\n`;
      if (alreadyProvided.length > 0) {
        askRemaining += `${alreadyProvided.join('\n')}\n\n`;
      }
      askRemaining += `Please provide the remaining customer details for *${updatedCustDraft.company_name}*:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askRemaining, {
        action_type: 'LOG_NEW_CUSTOMER',
        customer_name: updatedCustDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedCustDraft.company_name, `catalog_implicit_cust_collect|${originalAction}|${JSON.stringify(updatedCustDraft)}`);
      return { handled: true, reply: askRemaining };
    }
  }

  // ── 3b-prod. HANDLE IMPLICIT PRODUCT ADDITION (catalog_implicit_prod_add|...) ──
  if (lastIntent.startsWith('catalog_implicit_prod_add|')) {
    const parts = lastIntent.split('|');
    const originalAction = parts[1] || 'LOG_INQUIRY';
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});
    if (callerSourceChannel && !draft.source_channel) {
      draft.source_channel = callerSourceChannel;
    }

    await recordSessionMessage(senderPhone, 'user', text);
    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    if (cleanInput === 'btn_confirm_cancel' || isDiscardOrCancelIntent(cleanInput) || isDiscardOrCancelIntent(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      recordInactiveDraft(senderPhone, originalAction, draft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Discarded product addition flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    const pendingProd = draft._pending_new_product || extractPendingNewProductSeed(draft);
    const isSaveConfirm = [
      'btn_prod_save', 'save product', 'save', 'yes', 'y', '1',
      'confirm', 'haan', 'ha', 'sahi hai', 'ok', 'sure', 'save / yes', 'save/yes', 'save yes',
    ].includes(cleanInput);

    if (isSaveConfirm) {
      const origName = String(pendingProd.original_name || pendingProd.product_name || '').trim();
      const prodName = String(pendingProd.product_name || '').trim();
      const prodSpecs = String(pendingProd.dimensions || '').trim();
      const prodHsn = String(pendingProd.hsn_code || '').trim();

      const missingProdFields = [];
      if (!prodName) missingProdFields.push('Product Name *');
      if (!prodSpecs) missingProdFields.push('Specs / Dimensions *');
      if (!prodHsn) missingProdFields.push('HSN/SAC Code *');

      if (missingProdFields.length > 0) {
        draft._pending_new_product = pendingProd;
        const blockMsg = buildAddProductPromptCard(
          pendingProd,
          `❌ *Cannot save product yet:* All 3 fields are mandatory. Please provide: *${missingProdFields.join(', ')}*.`,
        );
        await recordSessionMessage(senderPhone, 'assistant', blockMsg, {
          action_type: originalAction,
          customer_name: draft.company_name,
        });
        await saveActiveSession(
          senderPhone,
          draft.company_name || 'Customer',
          `catalog_implicit_prod_add|${originalAction}|${JSON.stringify(draft)}`,
        );
        return {
          handled: true,
          reply: blockMsg,
          interactiveType: 'buttons',
          interactiveButtons: ADD_PRODUCT_CONFIRM_BUTTONS,
        };
      }

      await createCustomProductRecord({
        product_name: prodName,
        dimensions: prodSpecs,
        hsn_code: prodHsn,
      });

      draft._verified_custom_products = Array.isArray(draft._verified_custom_products)
        ? draft._verified_custom_products
        : [];
      if (prodName && !draft._verified_custom_products.some((p) => String(p).toLowerCase() === prodName.toLowerCase())) {
        draft._verified_custom_products.push(prodName);
      }

      if (Array.isArray(draft.line_items) && draft.line_items.length > 0) {
        draft.line_items.forEach((it) => {
          const itName = String(it.sku_text || it.description || '').trim();
          const itLower = itName.toLowerCase();
          if (
            itLower === prodName.toLowerCase() ||
            (origName && itLower === origName.toLowerCase())
          ) {
            it.sku_text = prodName;
            it.description = prodName;
            if (prodSpecs) {
              it.dimensions = prodSpecs;
              it.spec = prodSpecs;
            }
            it.hsn_code = prodHsn;
            it.hsn_sac = prodHsn;
            it.is_valid_catalog = true;
          }
        });
      }
      if (Array.isArray(draft.line_item_updates) && draft.line_item_updates.length > 0) {
        draft.line_item_updates.forEach((it) => {
          const itName = String(it.sku_text || it.description || it.item_reference || '').trim();
          const itLower = itName.toLowerCase();
          if (
            itLower === prodName.toLowerCase() ||
            (origName && itLower === origName.toLowerCase())
          ) {
            it.sku_text = prodName;
            it.description = prodName;
            if (prodSpecs) {
              it.dimensions = prodSpecs;
              it.spec = prodSpecs;
            }
            it.hsn_code = prodHsn;
            it.hsn_sac = prodHsn;
            it.is_valid_catalog = true;
          }
        });
      }
      if (draft.product_description && origName) {
        const escapedOrig = origName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        draft.product_description = String(draft.product_description).replace(
          new RegExp(escapedOrig, 'gi'),
          prodName,
        );
      }
      delete draft._pending_new_product;

      if (draft._line_mutation?.awaiting === 'catalog') {
        const mutRes = startLineItemMutation(draft, {
          ...draft._line_mutation,
          productName: prodName,
          spec: prodSpecs || draft._line_mutation.spec,
        });
        if (mutRes?.reply) {
          const resumeMsg = `✅ *Product "${prodName}" Added!*\n\n${mutRes.reply}`;
          await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
            action_type: originalAction,
            customer_name: draft.company_name,
          });
          await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(draft)}`);
          return {
            handled: true,
            reply: resumeMsg,
            ...(mutRes.interactiveButtons ? { interactiveType: 'buttons', interactiveButtons: mutRes.interactiveButtons } : {}),
          };
        }
      }

      const nextProdCheck = validateDraftProducts(originalAction, draft);
      if (!nextProdCheck.isValid) {
        const resumeMsg = `✅ *Product "${prodName}" Added!*\n\n${nextProdCheck.clarificationMessage}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: draft.company_name,
        });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: resumeMsg,
          interactiveType: 'buttons',
          interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
        };
      }

      const missing = validateMandatoryFields(originalAction, draft);
      if (missing.length === 0) {
        const lineChoice = await askLineItemChoiceIfNeeded(originalAction, draft, senderPhone);
        if (lineChoice) return lineChoice;

        const summary = buildConfirmationSummary(originalAction, draft);
        const resumeMsg = `✅ *Product "${prodName}" Added!*\n\nNow continuing with your ${getActionFriendlyName(originalAction)}:\n\n${summary}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: draft.company_name,
        });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${originalAction}|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: resumeMsg,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      } else {
        const missingList = missing.map((m) => `• *${m}*`).join('\n');
        const resumeMsg = `✅ *Product "${prodName}" Added!*\n\nPlease provide the remaining mandatory details for this ${getActionFriendlyName(originalAction)}:\n\n${missingList}`;
        await recordSessionMessage(senderPhone, 'assistant', resumeMsg, {
          action_type: originalAction,
          customer_name: draft.company_name,
        });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${originalAction}|${JSON.stringify(draft)}`);
        return { handled: true, reply: resumeMsg };
      }
    }

    // User typed partial or complete Specs / HSN / Product Name before saving
    const updatedPendingProd = mergePartialAddProductInput(pendingProd, text);
    draft._pending_new_product = updatedPendingProd;
    const cardMsg = buildAddProductPromptCard(updatedPendingProd);
    await recordSessionMessage(senderPhone, 'assistant', cardMsg, {
      action_type: originalAction,
      customer_name: draft.company_name,
    });
    await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_implicit_prod_add|${originalAction}|${JSON.stringify(draft)}`);
    return {
      handled: true,
      reply: cardMsg,
      interactiveType: 'buttons',
      interactiveButtons: ADD_PRODUCT_CONFIRM_BUTTONS,
    };
  }

  // ── 3c. HANDLE CONFIRMATION STATE (catalog_confirm|...) ──────────────────────
  if (lastIntent.startsWith('catalog_confirm|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});
    if (callerSourceChannel && !draft.source_channel) {
      draft.source_channel = callerSourceChannel;
    }
    if (action === 'LOG_ORDER') {
      await ensureDraftSystemPo(
        draft,
        draft.po_reservation_token ||
          `catalog-edit:${senderPhone}:${Date.now()}`,
        draft.deal_id || null,
      );
    }

    if (await isMidFlowReadQuery(text)) {
      return await handleMidFlowRetrievalQuery(text, senderPhone, 'catalog_confirm', action, draft);
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Confirm YES
    if (
      cleanInput === 'btn_confirm_yes' ||
      cleanInput === 'save / yes' ||
      cleanInput === 'save/yes' ||
      cleanInput === 'yes' ||
      cleanInput === 'y' ||
      cleanInput === '1' ||
      cleanInput === 'confirm' ||
      cleanInput === 'save' ||
      cleanInput === 'haan' ||
      cleanInput === 'sahi hai' ||
      cleanInput === 'ok' ||
      cleanInput === 'sure'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);

      // A tap sent before this entry's confirmation was shown is a double tap on the previous entry.
      if (draft._confirm_shown_at && options.messageTimestampMs &&
          options.messageTimestampMs + 1000 < Number(draft._confirm_shown_at)) {
        const reviewMsg = `✅ The previous entry was saved.\n\nPlease review this ${getActionFriendlyName(action)} for *${draft.company_name || 'the next customer'}* and tap *Save / Yes* to confirm it.`;
        await recordSessionMessage(senderPhone, 'assistant', reviewMsg, { action_type: action, customer_name: draft.company_name });
        return {
          handled: true,
          reply: reviewMsg,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      }

      // Verify customer before final execution
      const custCheck = await verifyDraftCustomer(action, draft, senderPhone);
      if (!custCheck.isValid) {
        if (custCheck.isLowMatchCustomer) {
          await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
          await saveActiveSession(
            senderPhone,
            custCheck.fetchedName,
            `catalog_cust_match_confirm|${action}|${custCheck.fetchedName}|${JSON.stringify(custCheck.candidates)}|${JSON.stringify(draft)}`
          );
          return {
            handled: true,
            reply: custCheck.prompt,
            interactiveType: 'buttons',
            interactiveButtons: CUST_MATCH_BUTTONS,
          };
        }
        if (custCheck.isUnrecognizedCustomer) {
          await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
          await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(draft)}`);
          return {
            handled: true,
            reply: custCheck.prompt,
            interactiveType: 'buttons',
            interactiveButtons: NEW_CUSTOMER_BUTTONS,
          };
        } else {
          draft.company_name = null;
          await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
          await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
          return { handled: true, reply: custCheck.rejectionMessage };
        }
      }

      const prodCheckBeforeSave = validateDraftProducts(action, draft);
      if (!prodCheckBeforeSave.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', prodCheckBeforeSave.clarificationMessage, { action_type: action });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: prodCheckBeforeSave.clarificationMessage,
          interactiveType: 'buttons',
          interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
        };
      }

      const lineChoiceBeforeSave = await askLineItemChoiceIfNeeded(action, draft, senderPhone);
      if (lineChoiceBeforeSave) return lineChoiceBeforeSave;

      if (action === 'LOG_VISIT' && !draft.verification_token) {
        await fillVisitCity(draft);
        const ready = assertReadyToSave({ ...draft, verification_token: 'pending' });
        if (!ready.ok) {
          const ask = `Please provide the remaining details:\n\n${ready.prompts.map((item) => `• *${item}*`).join('\n')}`;
          await recordSessionMessage(senderPhone, 'assistant', ask, { action_type: action });
          await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|LOG_VISIT|${JSON.stringify(draft)}`);
          return { handled: true, reply: ask };
        }
        const codeReply = await beginVisitPhoneCode(draft, senderPhone);
        await recordSessionMessage(senderPhone, 'assistant', codeReply.reply, { action_type: action });
        return codeReply;
      }

      const reply = await executeAction(action, draft, senderPhone);

      if (isExecutionFailureReply(reply)) {
        const retryReply = `${reply}\n\n📝 Your details are still saved in this draft. Tap *Save / Yes* to try again, *Edit* to change something, or *Cancel* to discard.`;
        await recordSessionMessage(senderPhone, 'assistant', retryReply, {
          action_type: action,
          customer_name: draft.company_name,
        });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: retryReply,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      }
      markRecentConfirmedSave(senderPhone);

      await recordSessionMessage(senderPhone, 'assistant', reply, {
        action_type: action,
        customer_name: draft.company_name,
        po_number: draft.po_number,
        inquiry_id: draft.inquiry_id,
      });

      // Check if there are queued entries (e.g. 2nd customer visit/inquiry)
      if (draft._queue && Array.isArray(draft._queue) && draft._queue.length > 0) {
        const nextEntry = draft._queue.shift();
        nextEntry._queue = draft._queue;
        nextEntry._totalCount = draft._totalCount || (draft._queue.length + 2);
        nextEntry._currentIndex = (draft._currentIndex || 1) + 1;
        const nextAction = nextEntry.action || action;
        const missing = validateMandatoryFields(nextAction, nextEntry);

        if (missing.length === 0) {
          nextEntry._confirm_shown_at = Date.now();
          const summary = buildConfirmationSummary(nextAction, nextEntry);
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's confirm the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\n${summary}\n\n💡 _Tip: To skip or finish without logging for ${nextEntry.company_name}, reply "cancel" or "discard"._`;
          await recordSessionMessage(senderPhone, 'assistant', nextPrompt, {
            action_type: nextAction,
            customer_name: nextEntry.company_name,
          });
          await saveActiveSession(senderPhone, nextEntry.company_name || 'Customer', `catalog_confirm|${nextAction}|${JSON.stringify(nextEntry)}`);
          return {
            handled: true,
            reply: nextPrompt,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          const missingList = missing.map((m) => `• *${m}*`).join('\n');
          const nextPrompt = `${reply}\n\n━━━━━━━━━━━━━━━━━━━━\nNow let's complete the ${getActionFriendlyName(nextAction)} for *${nextEntry.company_name}* (${nextEntry._currentIndex} of ${nextEntry._totalCount}):\n\nPlease provide the remaining mandatory details:\n\n${missingList}\n\n💡 _Tip: To skip or finish without logging for ${nextEntry.company_name}, reply "cancel" or "discard"._`;
          await recordSessionMessage(senderPhone, 'assistant', nextPrompt, {
            action_type: nextAction,
            customer_name: nextEntry.company_name,
          });
          await saveActiveSession(senderPhone, nextEntry.company_name || 'Customer', `catalog_flow|${nextAction}|${JSON.stringify(nextEntry)}`);
          return {
            handled: true,
            reply: nextPrompt,
          };
        }
      }

      recordInactiveDraft(senderPhone, action, draft, 'saved');
      await finalizeCurrentSession(senderPhone, null, {
        action_type: action,
        customer_name: draft.company_name,
        po_number: draft.po_number,
        inquiry_id: draft.inquiry_id,
        extracted_data: draft,
      });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply,
        interactiveType: 'buttons',
        interactiveButtons: getPostActivityButtons(action, draft),
      };
    }

    // Request EDIT
    if (
      cleanInput === 'btn_confirm_edit' ||
      cleanInput === 'edit details' ||
      cleanInput === 'edit' ||
      cleanInput === 'change' ||
      cleanInput === 'modify' ||
      cleanInput === 'update' ||
      cleanInput === '2'
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const editPrompt = getEditPromptForAction(action);
      if (action === 'LOG_ORDER') draft._editing_system_po = true;
      await recordSessionMessage(senderPhone, 'assistant', editPrompt);
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: editPrompt,
      };
    }

    // CANCEL / DISCARD
    if (action === 'LOG_COMPLAINT' && isComplaintAttachmentSkip(text, draft)) {
      draft._attachments_completed = true;
      await recordSessionMessage(senderPhone, 'user', text);
      const attachmentSkipSummary = buildConfirmationSummary(action, draft);
      await recordSessionMessage(senderPhone, 'assistant', attachmentSkipSummary, {
        action_type: action,
        customer_name: draft.company_name,
      });
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(draft)}`);
      return {
        handled: true,
        reply: attachmentSkipSummary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    }

    if (
      cleanInput === 'btn_confirm_cancel' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      recordInactiveDraft(senderPhone, action, draft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft for ${draft.company_name || 'customer'}`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: cancelReply,
      };
    }

    // Check if user is attempting a write operation for a different module
    const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
    if (outOfScopeAction) {
      console.log(`[CatalogFlow] Strict activity scope guard in catalog_confirm: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
      return buildOutOfScopeActivityResponse(action, outOfScopeAction);
    }

    if (isBareCatalogNumber(text)) {
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', BARE_NUMBER_FIELD_INPUT_REPLY, { action_type: action });
      return { handled: true, reply: BARE_NUMBER_FIELD_INPUT_REPLY };
    }

    // Check if user is attempting to edit a non-editable or system-generated field
    const nonEditableCheckConfirm = detectNonEditableFieldAttempt(action, text, draft);
    if (nonEditableCheckConfirm.isNonEditable) {
      await recordSessionMessage(senderPhone, 'user', text);
      const fullReply = nonEditableCheckConfirm.compactReply || `${nonEditableCheckConfirm.message}\n\n*Editable fields for this ${getActionFriendlyName(action)}:*\n${nonEditableCheckConfirm.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: action });
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${draftJsonStr}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }

    // Direct inline edit attempt during confirmation
    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = await extractFieldsWithLLM(action, text, draft);

    if (action === 'LOG_VISIT') {
      attachVisitMedia(updatedDraft, attachmentObj, gpsData);
      await fillVisitCity(updatedDraft);
    } else if (action === 'UPDATE_VISIT') {
      if (attachmentObj) {
        updatedDraft.updates = updatedDraft.updates || {};
        const prevNew = Array.isArray(updatedDraft.updates.new_attachments) ? updatedDraft.updates.new_attachments : (Array.isArray(draft.updates?.new_attachments) ? draft.updates.new_attachments : []);
        if (!prevNew.some(a => a && a.url === attachmentObj.url)) {
          updatedDraft.updates.new_attachments = [...prevNew, attachmentObj];
        }
      }
      if (gpsData) {
        updatedDraft.updates = updatedDraft.updates || {};
        if (updatedDraft.updates.gps_latitude === undefined) {
          updatedDraft.updates.gps_latitude = gpsData.latitude;
          updatedDraft.updates.gps_longitude = gpsData.longitude;
          updatedDraft.updates.gps_accuracy = gpsData.accuracy;
        }
      }
    } else if (action === 'LOG_COMPLAINT') {
      if (incomingAttachments.length > 0) {
        const prevAtts = Array.isArray(updatedDraft.attachments) ? updatedDraft.attachments : (Array.isArray(draft.attachments) ? draft.attachments : []);
        const newAtts = [...prevAtts];
        for (const att of incomingAttachments) {
          if (newAtts.length >= 3) break;
          const fileUrl = att.url || att.file_url;
          if (!newAtts.some(a => (a.url === fileUrl || a.file_url === fileUrl))) {
            const isPdf = (att.type || att.file_type || '').includes('pdf');
            const compAtt = {
              name: att.name || att.file_name || `evidence-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`,
              url: fileUrl,
              file_url: fileUrl,
              file_name: att.name || att.file_name || `evidence-${Date.now()}`,
              file_type: att.type || att.file_type || 'image/jpeg',
              file_size: att.file_size || null,
              uploaded_at: att.uploaded_at || new Date().toISOString(),
            };
            newAtts.push(compAtt);
          }
        }
        updatedDraft.attachments = newAtts;
      }
    }

    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isLowMatchCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(
          senderPhone,
          custCheck.fetchedName,
          `catalog_cust_match_confirm|${action}|${custCheck.fetchedName}|${JSON.stringify(custCheck.candidates)}|${JSON.stringify(updatedDraft)}`
        );
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: CUST_MATCH_BUTTONS,
        };
      }
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    const confirmProdCheck = validateDraftProducts(action, updatedDraft);
    if (!confirmProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', confirmProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: confirmProdCheck.clarificationMessage,
        interactiveType: 'buttons',
        interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
      };
    }

    const missing = validateMandatoryFields(action, updatedDraft);
    if (missing.length === 0) {
      const lineChoice = await askLineItemChoiceIfNeeded(action, updatedDraft, senderPhone);
      if (lineChoice) return lineChoice;

      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    }

    const retryPrompt = `Please reply with:\n• *Yes* — to save\n• *Edit* — to change a field\n• *Cancel* — to discard`;
    await recordSessionMessage(senderPhone, 'assistant', retryPrompt);
    return {
      handled: true,
      reply: retryPrompt,
      interactiveType: 'buttons',
      interactiveButtons: CONFIRMATION_BUTTONS,
    };
  }

  // ── 4. HANDLE EDITING STATE (catalog_editing|...) ───────────────────────────
  if (lastIntent.startsWith('catalog_editing|')) {
    const parts = lastIntent.split('|');
    const action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    const draft = safeParseJSON(draftJsonStr, {});
    if (callerSourceChannel && !draft.source_channel) {
      draft.source_channel = callerSourceChannel;
    }

    const cleanInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();

    // Cancel during edit
    if (
      cleanInput === 'btn_confirm_cancel' ||
      isDiscardOrCancelIntent(cleanInput) ||
      isDiscardOrCancelIntent(text)
    ) {
      await recordSessionMessage(senderPhone, 'user', text);
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      recordInactiveDraft(senderPhone, action, draft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Cancelled ${getActionFriendlyName(action)} draft during edit`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: cancelReply };
    }

    // Edit button tapped again while already in edit mode
    if (cleanInput === 'btn_confirm_edit' || cleanInput === 'edit details' || cleanInput === 'edit') {
      const alreadyEditMsg = `You are currently editing this draft. ${getEditPromptForAction(action)}`;
      return { handled: true, reply: alreadyEditMsg };
    }

    // Check if user is attempting a write operation for a different module
    const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
    if (outOfScopeAction) {
      console.log(`[CatalogFlow] Strict activity scope guard in catalog_editing: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
      return buildOutOfScopeActivityResponse(action, outOfScopeAction);
    }

    if (action === 'UPDATE_INQUIRY' || action === 'UPDATE_ORDER') {
      const lineMutation = resolveLineItemMutationTurn(text, draft, action);
      if (lineMutation?.reply) {
        await recordSessionMessage(senderPhone, 'user', text);
        await recordSessionMessage(senderPhone, 'assistant', lineMutation.reply, { action_type: action });
        await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(draft)}`);
        return {
          handled: true,
          reply: lineMutation.reply,
          ...(lineMutation.interactiveButtons ? { interactiveType: 'buttons', interactiveButtons: lineMutation.interactiveButtons } : {}),
        };
      }
    }

    if (!draft._skip_llm_extract && isBareCatalogNumber(text)) {
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', BARE_NUMBER_FIELD_INPUT_REPLY, { action_type: action });
      return { handled: true, reply: BARE_NUMBER_FIELD_INPUT_REPLY };
    }

    // Check if user is attempting to edit a non-editable or system-generated field
    const nonEditableCheck = detectNonEditableFieldAttempt(action, text, draft);
    if (nonEditableCheck.isNonEditable) {
      await recordSessionMessage(senderPhone, 'user', text);
      const fullReply = nonEditableCheck.compactReply || `${nonEditableCheck.message}\n\n*Editable fields for this ${getActionFriendlyName(action)}:*\n${nonEditableCheck.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: action });
      await saveActiveSession(senderPhone, draft.company_name || 'Customer', `catalog_editing|${action}|${draftJsonStr}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }

    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = draft._skip_llm_extract
      ? { ...draft }
      : await extractFieldsWithLLM(action, text, draft);
    delete updatedDraft._skip_llm_extract;
    if (action === 'LOG_ORDER') {
      await ensureDraftSystemPo(
        updatedDraft,
        updatedDraft.po_reservation_token ||
          `catalog-edit:${senderPhone}:${Date.now()}`,
        updatedDraft.deal_id || null,
      );
      delete updatedDraft._editing_system_po;
    }

    if (action === 'LOG_VISIT') {
      attachVisitMedia(updatedDraft, attachmentObj, gpsData);
      await fillVisitCity(updatedDraft);
    } else if (action === 'UPDATE_VISIT') {
      if (attachmentObj) {
        updatedDraft.updates = updatedDraft.updates || {};
        const prevNew = Array.isArray(updatedDraft.updates.new_attachments) ? updatedDraft.updates.new_attachments : (Array.isArray(draft.updates?.new_attachments) ? draft.updates.new_attachments : []);
        if (!prevNew.some(a => a && a.url === attachmentObj.url)) {
          updatedDraft.updates.new_attachments = [...prevNew, attachmentObj];
        }
      }
      if (gpsData) {
        updatedDraft.updates = updatedDraft.updates || {};
        if (updatedDraft.updates.gps_latitude === undefined) {
          updatedDraft.updates.gps_latitude = gpsData.latitude;
          updatedDraft.updates.gps_longitude = gpsData.longitude;
          updatedDraft.updates.gps_accuracy = gpsData.accuracy;
        }
      }
    } else if (action === 'LOG_COMPLAINT') {
      if (incomingAttachments.length > 0) {
        const prevAtts = Array.isArray(updatedDraft.attachments) ? updatedDraft.attachments : (Array.isArray(draft.attachments) ? draft.attachments : []);
        const newAtts = [...prevAtts];
        for (const att of incomingAttachments) {
          if (newAtts.length >= 3) break;
          const fileUrl = att.url || att.file_url;
          if (!newAtts.some(a => (a.url === fileUrl || a.file_url === fileUrl))) {
            const isPdf = (att.type || att.file_type || '').includes('pdf');
            const compAtt = {
              name: att.name || att.file_name || `evidence-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`,
              url: fileUrl,
              file_url: fileUrl,
              file_name: att.name || att.file_name || `evidence-${Date.now()}`,
              file_type: att.type || att.file_type || 'image/jpeg',
              file_size: att.file_size || null,
              uploaded_at: att.uploaded_at || new Date().toISOString(),
            };
            newAtts.push(compAtt);
          }
        }
        updatedDraft.attachments = newAtts;
      }
    }

    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isLowMatchCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(
          senderPhone,
          custCheck.fetchedName,
          `catalog_cust_match_confirm|${action}|${custCheck.fetchedName}|${JSON.stringify(custCheck.candidates)}|${JSON.stringify(updatedDraft)}`
        );
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: CUST_MATCH_BUTTONS,
        };
      }
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    if (action === 'LOG_COMPLAINT') {
      const ordCheck = await checkOrdersForComplaint(action, updatedDraft, senderPhone, text);
      if (ordCheck && ordCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, { action_type: 'LOG_COMPLAINT' });
        await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|LOG_COMPLAINT|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
        return { handled: true, reply: ordCheck.reply };
      }
      if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
    }

    const editProdCheck = validateDraftProducts(action, updatedDraft);
    if (!editProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', editProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: editProdCheck.clarificationMessage,
        interactiveType: 'buttons',
        interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
      };
    }

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      const lineChoice = await askLineItemChoiceIfNeeded(action, updatedDraft, senderPhone);
      if (lineChoice) return lineChoice;

      const stageSaved = await saveStageOnlyInquiryUpdateIfNeeded(text, senderPhone, 'catalog_editing', action, updatedDraft);
      if (stageSaved) return stageSaved;

      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      let askMissing = '';
      if (updatedDraft._permissionNotice) {
        askMissing += `${updatedDraft._permissionNotice}\n\n`;
      }
      askMissing += `Let's finish your ${actionName}${indexTag} first. Please provide the missing mandatory details:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // ── 5. HANDLE DATA COLLECTION FLOW STATE (catalog_flow|...) ────────────────
  if (lastIntent.startsWith('catalog_flow|')) {
    const parts = lastIntent.split('|');
    let action = parts[1];
    const draftJsonStr = parts.slice(2).join('|');
    let existingDraft = safeParseJSON(draftJsonStr, {});
    if (callerSourceChannel && !existingDraft.source_channel) {
      existingDraft.source_channel = callerSourceChannel;
    }
    if (action === 'LOG_ORDER') {
      existingDraft = await ensureDraftSystemPo(
        existingDraft,
        existingDraft.po_reservation_token ||
          `catalog-flow:${senderPhone}:${Date.now()}`,
        existingDraft.deal_id || null,
      );
    }

    await recordSessionMessage(senderPhone, 'user', text);

    if (existingDraft._pending_line_choice && (action === 'UPDATE_INQUIRY' || action === 'UPDATE_ORDER')) {
      const choiceRes = await handleLineItemChoiceReply(text, senderPhone, action, existingDraft);
      if (choiceRes) return choiceRes;
    }

    // ── Pagination Handler for Candidate Lists (View More / Next) ────────────
    if (isPaginationRequest(text) || isPreviousPaginationRequest(text)) {
      if (existingDraft._all_customer_candidates && Array.isArray(existingDraft._all_customer_candidates)) {
        const pool = existingDraft._all_customer_candidates;
        const pageSize = 10;
        const totalPages = Math.ceil(pool.length / pageSize);
        const currentPage = Number(existingDraft._customer_candidates_page) || 1;
        const isPrev = isPreviousPaginationRequest(text);
        let targetPage = isPrev ? currentPage - 1 : currentPage + 1;

        if (isPrev && targetPage < 1) {
          targetPage = 1;
        }

        if (!isPrev && targetPage > totalPages) {
          const noMoreMsg = `ℹ️ *All ${pool.length} assigned accounts have already been displayed.*\n\n👉 Reply with the *Company Name* or *Option Number* (1–${pool.length}) to proceed with your ${getActionFriendlyName(action)}.`;
          await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
          return {
            handled: true,
            reply: noMoreMsg,
            interactiveType: 'buttons',
            interactiveButtons: [
              { id: 'btn_confirm_cancel', title: 'Discard Draft' },
            ],
          };
        }

        existingDraft._customer_candidates_page = targetPage;
        const startIdx = (targetPage - 1) * pageSize;
        const pageItems = pool.slice(startIdx, startIdx + pageSize);
        existingDraft._customer_candidates = pageItems;

        const listDisplay = pageItems.map((name, i) => `  ${startIdx + i + 1}. *${name}*`).join('\n');
        const headerText = `*Your Assigned Accounts (${startIdx + 1}–${startIdx + pageItems.length} of ${pool.length}):*`;
        const promptText = `Understood! 👍 Please reply with the correct *Company Name* so we can proceed with your ${getActionFriendlyName(action)}.\n\n${headerText}\n${listDisplay}\n\n` +
          `👉 Reply with the *Company Name* (or option number 1–${pool.length})${targetPage < totalPages ? ', or tap *Next 10 Customers* to view more.' : '.'}\n\n` +
          `_(Your other entered details have been preserved)_`;

        const buttons = [];
        if (targetPage < totalPages) {
          buttons.push({ id: 'btn_next_customers', title: 'Next 10 Customers' });
        }
        buttons.push({ id: 'btn_confirm_cancel', title: 'Discard Draft' });

        await recordSessionMessage(senderPhone, 'assistant', promptText, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return {
          handled: true,
          reply: promptText,
          interactiveType: 'buttons',
          interactiveButtons: buttons,
        };
      }

      if (existingDraft._all_visit_candidates && Array.isArray(existingDraft._all_visit_candidates)) {
        const pool = existingDraft._all_visit_candidates;
        const pageSize = 10;
        const totalPages = Math.ceil(pool.length / pageSize);
        let nextPage = (Number(existingDraft._visit_candidates_page) || 1) + 1;
        if (nextPage > totalPages) {
          const noMoreMsg = `ℹ️ *No more records.* All ${pool.length} record${pool.length === 1 ? ' is' : 's are'} already shown.\n\n👉 Reply with the *Option Number* (1–${pool.length}) to pick one.`;
          await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
          return { handled: true, reply: noMoreMsg };
        }
        existingDraft._visit_candidates_page = nextPage;

        const startIdx = (nextPage - 1) * pageSize;
        const pageItems = pool.slice(startIdx, startIdx + pageSize);

        const candidateSummaries = pageItems.map((v, idx) => {
          const details = extractVisitDetails(v);
          return {
            index: startIdx + idx + 1,
            id: details.id,
            company_name: details.customer_name || existingDraft.company_name,
            date: details.date_formatted,
            visited_at: details.visited_at,
            person_met: details.person_met,
            location: details.location,
            outcome: details.outcome,
            follow_up_action: details.follow_up_action,
            follow_up_date: details.follow_up_date,
            follow_up_status: details.follow_up_status,
            remarks: details.remarks !== 'Not specified' ? (details.remarks.length > 80 ? details.remarks.slice(0, 77) + '...' : details.remarks) : null,
            time: formatVisitTimeIST(v.visited_at || v.created_at),
          };
        });

        const pageDateCounts = candidateSummaries.reduce((acc, c) => acc.set(c.date, (acc.get(c.date) || 0) + 1), new Map());
        const choicesText = candidateSummaries
          .map(c => {
            const timeLabel = pageDateCounts.get(c.date) > 1 && c.time ? `, ${c.time}` : '';
            const lines = [
              `${c.index}. *Visit on ${c.date}${timeLabel}*`,
              `   • *Person Met:* ${c.person_met}`,
              `   • *Location:* ${c.location}`,
              `   • *Outcome:* ${c.outcome}`,
            ];
            if (c.follow_up_action) lines.push(`   • *Follow-up Action:* ${c.follow_up_action}`);
            if (c.follow_up_date) lines.push(`   • *Follow-up Date:* ${c.follow_up_date}`);
            if (c.follow_up_status) lines.push(`   • *Follow-up Status:* ${c.follow_up_status}`);
            if (c.remarks) lines.push(`   • *Remarks:* ${c.remarks}`);
            return lines.join('\n');
          })
          .join('\n\n');

        const headerText = `📅 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${pool.length} Visits for ${existingDraft.company_name} (Page ${nextPage} of ${totalPages}):*`;
        const footerText = `👉 Reply with the *Option Number* (1–${pool.length}), *Visit Date*, *Person Met*, or type *"View More"* to see more visits.`;
        const prompt = `${headerText}\n\n${choicesText}\n\n${footerText}`;

        existingDraft._visit_candidates = candidateSummaries;
        await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return { handled: true, reply: prompt };
      }

      if (existingDraft._all_inquiry_candidates && Array.isArray(existingDraft._all_inquiry_candidates)) {
        const pool = existingDraft._all_inquiry_candidates;
        const pageSize = 10;
        const totalPages = Math.ceil(pool.length / pageSize);
        let nextPage = (Number(existingDraft._inquiry_candidates_page) || 1) + 1;
        if (nextPage > totalPages) {
          const noMoreMsg = `ℹ️ *No more records.* All ${pool.length} record${pool.length === 1 ? ' is' : 's are'} already shown.\n\n👉 Reply with the *Option Number* (1–${pool.length}) to pick one.`;
          await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
          return { handled: true, reply: noMoreMsg };
        }
        existingDraft._inquiry_candidates_page = nextPage;

        const startIdx = (nextPage - 1) * pageSize;
        const pageItems = pool.slice(startIdx, startIdx + pageSize);

        const candidateSummaries = pageItems.map((inq, idx) => {
          let rateStr = null;
          let makeStr = null;
          if (Array.isArray(inq.deal_items) && inq.deal_items.length > 0) {
            const firstItem = inq.deal_items[0];
            if (firstItem.rate) rateStr = `₹${Number(firstItem.rate).toLocaleString('en-IN')}${firstItem.unit ? `/${firstItem.unit}` : '/MT'}`;
            if (firstItem.preferred_make || firstItem.make) makeStr = firstItem.preferred_make || firstItem.make;
          }
          return {
            index: startIdx + idx + 1,
            id: inq.inquiry_id || inq.id,
            displayId: inq.displayId,
            company_name: inq.company_name,
            date: inq.dateFormatted,
            stage: formatStageLabel ? formatStageLabel(inq.stage) : inq.stage,
            productSummary: inq.productSummary || 'Products on record',
            payment_terms: inq.payment_terms || 'Not specified',
            delivery_location: inq.delivery_location || 'Not specified',
            rate: rateStr,
            make: makeStr,
          };
        });

        const choicesText = candidateSummaries
          .map(c => `${c.index}. *${c.displayId}* (${c.date}) — _${c.stage}_\n   • *Product:* ${c.productSummary}\n   • *Delivery Location:* ${c.delivery_location}\n   • *Payment Terms:* ${c.payment_terms}${c.rate && !c.productSummary.includes('@ ₹') ? `\n   • *Rate:* ${c.rate}` : ''}${c.make ? `\n   • *Make:* ${c.make}` : ''}`)
          .join('\n\n');

        const headerText = `📋 *Showing ${startIdx + 1}–${startIdx + candidateSummaries.length} of ${pool.length} Inquiries for ${existingDraft.company_name || 'Customer'} (Page ${nextPage} of ${totalPages}):*`;
        const footerText = `👉 Reply with the *Option Number* (1–${pool.length}), *Inquiry ID*, *Product*, or type *"View More"* to see more inquiries.`;
        const prompt = `${headerText}\n\n${choicesText}\n\n${footerText}`;

        existingDraft._inquiry_candidates = candidateSummaries;
        await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return { handled: true, reply: prompt };
      }

      if (existingDraft._all_order_candidates && Array.isArray(existingDraft._all_order_candidates)) {
        const pool = existingDraft._all_order_candidates;
        const pageSize = 10;
        const totalPages = Math.ceil(pool.length / pageSize);
        let nextPage = (Number(existingDraft._order_candidates_page) || 1) + 1;
        if (nextPage > totalPages) {
          const noMoreMsg = `ℹ️ *No more records.* All ${pool.length} record${pool.length === 1 ? ' is' : 's are'} already shown.\n\n👉 Reply with the *Option Number* (1–${pool.length}) to pick one.`;
          await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
          return { handled: true, reply: noMoreMsg };
        }
        existingDraft._order_candidates_page = nextPage;

        const startIdx = (nextPage - 1) * pageSize;
        const pageDeals = pool.slice(startIdx, startIdx + pageSize);
        const orderList = pageDeals.map((d, idx) => {
          const poRef = d.po_number ? `PO: *${d.po_number}* (${d.deal_code || d.displayId || d.id})` : `*${d.deal_code || d.displayId || d.id}*`;
          const lines = [
            `${startIdx + idx + 1}. ${poRef} — _${d.stage ? (d.stage.charAt(0).toUpperCase() + d.stage.slice(1)) : 'Won'}_`,
          ];
          if (d.product_summary) lines.push(`   • *Product:* ${d.product_summary}`);
          if (d.location || d.delivery_location) lines.push(`   • *Delivery Location:* ${d.location || d.delivery_location}`);
          if (d.payment_terms) lines.push(`   • *Payment Terms:* ${d.payment_terms}`);
          if (d.total_amount > 0) lines.push(`   • *Total Value:* ₹${d.total_amount.toLocaleString('en-IN')}`);
          if (d.date_formatted) lines.push(`   • *Date:* ${d.date_formatted}`);
          return lines.join('\n');
        }).join('\n\n');

        const headerText = `⚠️ *Showing ${startIdx + 1}–${startIdx + pageDeals.length} of ${pool.length} Confirmed Orders (Page ${nextPage} of ${totalPages}):*`;
        const footerText = `👉 Reply with the *Number* (1–${pool.length}) or the *Inquiry ID* / *PO Number*.`;
        const prompt = `${headerText}\n\n${orderList}\n\n${footerText}`;

        existingDraft._order_candidates = pageDeals;
        await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return { handled: true, reply: prompt };
      }

      if (existingDraft._all_complaint_candidates && Array.isArray(existingDraft._all_complaint_candidates)) {
        const pool = existingDraft._all_complaint_candidates;
        const pageSize = 10;
        const totalPages = Math.ceil(pool.length / pageSize);
        let nextPage = (Number(existingDraft._complaint_candidates_page) || 1) + 1;
        if (nextPage > totalPages) {
          const noMoreMsg = `ℹ️ *No more records.* All ${pool.length} record${pool.length === 1 ? ' is' : 's are'} already shown.\n\n👉 Reply with the *Option Number* (1–${pool.length}) to pick one.`;
          await recordSessionMessage(senderPhone, 'assistant', noMoreMsg, { action_type: action });
          return { handled: true, reply: noMoreMsg };
        }
        existingDraft._complaint_candidates_page = nextPage;

        const startIdx = (nextPage - 1) * pageSize;
        const pageCmps = pool.slice(startIdx, startIdx + pageSize);
        const choicesText = pageCmps.map((c, idx) => {
          const poStr = c.po_number ? ` (PO: ${c.po_number})` : '';
          const lines = [
            `${startIdx + idx + 1}. *Complaint #${c.id.slice(0, 8)}* (${c.customer_name || 'Customer'}${poStr}) — _${c.status || 'Open'}_`,
            `   • *Type:* ${c.complaint_type || 'Quality Defect'}`,
          ];
          if (c.description) {
            const cleanDesc = c.description.length > 70 ? `${c.description.slice(0, 67)}...` : c.description;
            lines.push(`   • *Description:* ${cleanDesc}`);
          }
          return lines.join('\n');
        }).join('\n\n');

        const headerText = `⚠️ *Showing ${startIdx + 1}–${startIdx + pageCmps.length} of ${pool.length} Active Complaints (Page ${nextPage} of ${totalPages}):*`;
        const footerText = `👉 Reply with the *Number* (1–${pool.length}), *Customer Name*, or *PO Number*.`;
        const prompt = `${headerText}\n\n${choicesText}\n\n${footerText}`;

        existingDraft._complaint_candidates = pageCmps;
        await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return { handled: true, reply: prompt };
      }
    }

    // ── Out-of-Bounds Option Number Guard ────────────────────────────────────
    const totalVisibleCandidates =
      (existingDraft._visit_candidates && existingDraft._visit_candidates.length) ||
      (existingDraft._inquiry_candidates && existingDraft._inquiry_candidates.length) ||
      (existingDraft._order_candidates && existingDraft._order_candidates.length) ||
      (existingDraft._complaint_candidates && existingDraft._complaint_candidates.length) ||
      (existingDraft._customer_candidates && existingDraft._customer_candidates.length) || 0;

    const totalAllCandidates =
      (existingDraft._all_visit_candidates && existingDraft._all_visit_candidates.length) ||
      (existingDraft._all_inquiry_candidates && existingDraft._all_inquiry_candidates.length) ||
      (existingDraft._all_order_candidates && existingDraft._all_order_candidates.length) ||
      (existingDraft._all_complaint_candidates && existingDraft._all_complaint_candidates.length) ||
      (existingDraft._all_customer_candidates && existingDraft._all_customer_candidates.length) || totalVisibleCandidates;

    const maxAllowedCandidates = (action === 'LOG_ORDER' && (existingDraft._all_inquiry_candidates || existingDraft._inquiry_candidates))
      ? (totalAllCandidates + 1)
      : totalAllCandidates;

    if (totalVisibleCandidates > 0) {
      const outOfBoundsIdx = detectOutOfBoundsCandidateIndex(text, maxAllowedCandidates);
      if (outOfBoundsIdx !== null && !text.toLowerCase().includes('rate') && !text.toLowerCase().includes('qty') && !text.toLowerCase().includes('quantity') && !text.toLowerCase().includes('₹')) {
        const outOfBoundsReply = `⚠️ *Invalid Selection (${outOfBoundsIdx})*\n\nPlease choose a valid option number between **1 and ${maxAllowedCandidates}**, or type **Cancel** to exit.`;
        await recordSessionMessage(senderPhone, 'assistant', outOfBoundsReply, { action_type: action });
        return { handled: true, reply: outOfBoundsReply };
      }
    }

    // Add / replace line items in inquiry and order updates. Runs before the bare-number
    // guard so replies of "1" or "2" can answer the add-or-replace question.
    if (action === 'UPDATE_INQUIRY' || action === 'UPDATE_ORDER') {
      const lineMutation = resolveLineItemMutationTurn(text, existingDraft, action);
      if (lineMutation?.reply) {
        await recordSessionMessage(senderPhone, 'user', text);
        await recordSessionMessage(senderPhone, 'assistant', lineMutation.reply, { action_type: action });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
        return {
          handled: true,
          reply: lineMutation.reply,
          ...(lineMutation.interactiveButtons ? { interactiveType: 'buttons', interactiveButtons: lineMutation.interactiveButtons } : {}),
        };
      }
      if (existingDraft._skip_llm_extract) {
        await recordSessionMessage(senderPhone, 'user', text);
      }
    }

    // A bare number in an update flow whose record is already selected (no list awaiting a pick) carries no field.
    const isUpdateRecordSelected =
      (action === 'UPDATE_INQUIRY' && existingDraft._inquiry_verified) ||
      (action === 'UPDATE_ORDER' && existingDraft._order_verified) ||
      (action === 'UPDATE_VISIT' && existingDraft._visit_verified) ||
      (action === 'UPDATE_COMPLAINT' && existingDraft._complaint_verified);
    if (isUpdateRecordSelected && totalAllCandidates === 0 && !existingDraft._pending_line_choice && !existingDraft._skip_llm_extract && isBareCatalogNumber(text)) {
      await recordSessionMessage(senderPhone, 'assistant', BARE_NUMBER_FIELD_INPUT_REPLY, { action_type: action });
      await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
      return { handled: true, reply: BARE_NUMBER_FIELD_INPUT_REPLY };
    }

    // ── 1. Check Visit Candidate Selection ───────────────────────────────────
    let candidateResolved = false;
    if (existingDraft._visit_candidates && Array.isArray(existingDraft._visit_candidates)) {
      const numIdx = extractCandidateIndex(text, totalAllCandidates || existingDraft._visit_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null) {
        if (existingDraft._all_visit_candidates && Array.isArray(existingDraft._all_visit_candidates) && numIdx >= 1 && numIdx <= existingDraft._all_visit_candidates.length) {
          const v = existingDraft._all_visit_candidates[numIdx - 1];
          const details = extractVisitDetails(v);
          matchedCandidate = {
            id: details.id,
            company_name: details.customer_name || existingDraft.company_name,
            date: details.date_formatted,
            person_met: details.person_met,
            location: details.location,
            outcome: details.outcome,
            follow_up_action: details.follow_up_action,
            follow_up_date: details.follow_up_date,
            follow_up_status: details.follow_up_status,
            remarks: details.remarks,
          };
        } else if (numIdx >= 1 && numIdx <= existingDraft._visit_candidates.length) {
          matchedCandidate = existingDraft._visit_candidates[numIdx - 1];
        }
      }

      if (!matchedCandidate) {
        const normInputDate = normalizeDateToDDMMYYYY(text);
        const lowerText = text.toLowerCase();
        matchedCandidate = existingDraft._visit_candidates.find(c =>
          (normInputDate && (c.date === normInputDate || (c.visited_at && c.visited_at.startsWith(parseDDMMYYYYtoISO(normInputDate) || 'NOMATCH')))) ||
          (c.date && text.includes(c.date)) ||
          (c.person_met && c.person_met !== 'Not recorded' && lowerText.includes(c.person_met.toLowerCase())) ||
          (c.location && c.location !== 'Not recorded' && c.location.length >= 4 && lowerText.includes(c.location.toLowerCase()))
        );
      }

      if (matchedCandidate) {
        existingDraft.visit_id = matchedCandidate.id;
        existingDraft.visit_date = matchedCandidate.date;
        delete existingDraft._visit_candidates;
        delete existingDraft._all_visit_candidates;
        delete existingDraft._visit_candidates_page;
        candidateResolved = true;

        const isPureSelect = isPureOptionSelectorOnly(text) || isFullRecordSelection(text);
        const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
          Boolean(existingDraft.person_met || existingDraft.contact_phone || existingDraft.visit_outcome || existingDraft.meeting_remarks);

        if (isPureSelect && !hasUpdates) {
          const prompt = formatSelectedVisitPrompt(matchedCandidate);

          await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return { handled: true, reply: prompt };
        }
      }
    }

    // ── 2. Check Inquiry Candidate Selection ─────────────────────────────────
    let inquiryCandidateResolved = false;
    if (existingDraft._inquiry_candidates && Array.isArray(existingDraft._inquiry_candidates)) {
      const candidatesList = existingDraft._all_inquiry_candidates && Array.isArray(existingDraft._all_inquiry_candidates)
        ? existingDraft._all_inquiry_candidates
        : existingDraft._inquiry_candidates;
      const noneIdx = candidatesList.length + 1;

      // Check if user selected "None" (option N+1 or text 'none'/'skip'/'no link' etc.)
      const isNoneSelected = (action === 'LOG_ORDER') && (
        extractCandidateIndex(text, noneIdx) === noneIdx ||
        /^(?:none|skip|no\s*link|without\s*link(?:ing)?|do\s*not\s*link|unlinked|no\s*inquiry)\b/i.test(text.trim())
      );

      if (isNoneSelected) {
        delete existingDraft._inquiry_candidates;
        delete existingDraft._all_inquiry_candidates;
        delete existingDraft._inquiry_candidates_page;
        delete existingDraft.inquiry_id;
        delete existingDraft._inquiry_display_id;
        delete existingDraft.deal_id;
        delete existingDraft._matched_inquiry_id;
        inquiryCandidateResolved = true;

        const notice = `ℹ️ *No matching inquiry linked. Order will be recorded without an inquiry link.*\n\n`;
        const summary = buildConfirmationSummary('LOG_ORDER', existingDraft);
        const fullReply = notice + summary;

        await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_ORDER' });
        await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(existingDraft)}`);
        return {
          handled: true,
          reply: fullReply,
          interactiveType: 'buttons',
          interactiveButtons: CONFIRMATION_BUTTONS,
        };
      }

      const numIdx = extractCandidateIndex(text, totalAllCandidates || candidatesList.length);
      let matchedCandidate = null;

      if (numIdx !== null && numIdx >= 1 && numIdx <= candidatesList.length) {
        const inq = candidatesList[numIdx - 1];
        matchedCandidate = {
          id: inq.inquiry_id || inq.id,
          displayId: inq.displayId || `INQ-${(inq.inquiry_id || inq.id).slice(0, 6).toUpperCase()}`,
          deal_id: inq.deal_id || null,
          company_name: inq.company_name,
          date: inq.dateFormatted || formatDateDDMMYYYY(new Date(inq.created_at || Date.now())),
          stage: inq.stage || 'New Inquiry',
          productSummary: inq.productSummary || 'Products on record',
          deal_items: inq.deal_items || [],
          payment_terms: inq.payment_terms || 'Not specified',
          delivery_location: inq.delivery_location || 'Not specified',
        };
      }

      if (!matchedCandidate) {
        const cleanText = text.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        const lowerText = text.toLowerCase();
        matchedCandidate = candidatesList.find(c => {
          const cDisplay = (c.displayId || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cId = (c.inquiry_id || c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const hasIdMatch = cleanText.length >= 3 && (cleanText.includes(cDisplay) || cDisplay.includes(cleanText) || cleanText.includes(cId) || cId.includes(cleanText));
          const hasProdMatch = c.productSummary && (
            (lowerText.includes('hr coil') && c.productSummary.toLowerCase().includes('hr coil')) ||
            (lowerText.includes('cr sheet') && c.productSummary.toLowerCase().includes('cr sheet')) ||
            (lowerText.includes('plate') && c.productSummary.toLowerCase().includes('plate')) ||
            (lowerText.includes('tmt') && c.productSummary.toLowerCase().includes('tmt')) ||
            (lowerText.includes('pipe') && c.productSummary.toLowerCase().includes('pipe')) ||
            (lowerText.includes('beam') && c.productSummary.toLowerCase().includes('beam')) ||
            (lowerText.includes('angle') && c.productSummary.toLowerCase().includes('angle'))
          );
          return hasIdMatch || hasProdMatch;
        });
      }

      if (matchedCandidate) {
        if (action === 'LOG_ORDER') {
          existingDraft.inquiry_id = matchedCandidate.displayId || matchedCandidate.id;
          existingDraft._inquiry_display_id = matchedCandidate.displayId;
          existingDraft.deal_id = matchedCandidate.deal_id;
          existingDraft._matched_inquiry_id = matchedCandidate.id || matchedCandidate.inquiry_id;
          existingDraft._inquiry_verified = true;
          if (!existingDraft.delivery_location && matchedCandidate.delivery_location && matchedCandidate.delivery_location !== 'Not specified') {
            existingDraft.delivery_location = matchedCandidate.delivery_location;
          }
          if (!existingDraft.payment_terms && matchedCandidate.payment_terms && matchedCandidate.payment_terms !== 'Not specified') {
            existingDraft.payment_terms = matchedCandidate.payment_terms;
          }
          delete existingDraft._inquiry_candidates;
          delete existingDraft._all_inquiry_candidates;
          delete existingDraft._inquiry_candidates_page;
          inquiryCandidateResolved = true;

          const notice = `🔗 *Auto-linked to Quoted Inquiry ${matchedCandidate.displayId}*\n\n`;
          const summary = buildConfirmationSummary('LOG_ORDER', existingDraft);
          const fullReply = notice + summary;

          await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_ORDER' });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_confirm|LOG_ORDER|${JSON.stringify(existingDraft)}`);
          return {
            handled: true,
            reply: fullReply,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          existingDraft.inquiry_id = matchedCandidate.id || matchedCandidate.inquiry_id;
          existingDraft.deal_id = matchedCandidate.deal_id || null;
          existingDraft.company_name = matchedCandidate.company_name;
          existingDraft._inquiry_display_id = matchedCandidate.displayId;
          existingDraft._inquiry_verified = true;
          existingDraft.date_formatted = matchedCandidate.date || matchedCandidate.dateFormatted || matchedCandidate.date_formatted || existingDraft.date_formatted || null;
          existingDraft.stage = matchedCandidate.stage || existingDraft.stage || null;
          if (matchedCandidate.total_amount) existingDraft.total_amount = Number(matchedCandidate.total_amount);
          if (matchedCandidate.delivery_location) existingDraft.delivery_location = matchedCandidate.delivery_location;
          if (matchedCandidate.payment_terms) existingDraft.payment_terms = matchedCandidate.payment_terms;
          if (matchedCandidate.preferred_make) existingDraft.preferred_make = matchedCandidate.preferred_make;
          if (matchedCandidate.additional_notes) existingDraft.additional_notes = matchedCandidate.additional_notes;

          const candidateItems = Array.isArray(matchedCandidate.deal_items) ? matchedCandidate.deal_items : [];
          if (candidateItems.length > 0) {
            existingDraft.existing_items = candidateItems;
          }
          delete existingDraft._inquiry_candidates;
          delete existingDraft._all_inquiry_candidates;
          delete existingDraft._inquiry_candidates_page;
          inquiryCandidateResolved = true;

          const isPureSelect = isPureOptionSelectorOnly(text);
          const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
            (Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0);

          if (isPureSelect && !hasUpdates) {
            let itemsListText = '';
            if (candidateItems.length > 0) {
              itemsListText = formatDetailedInquiryItemsList(candidateItems);
            } else {
              itemsListText = `1. *${matchedCandidate.productSummary || 'Steel Material'}*`;
            }

            const prompt = formatSelectedInquiryPrompt(matchedCandidate, itemsListText);

            await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
            await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
            return { handled: true, reply: prompt };
          }
        }
      }
    }

    // ── 3. Check Order Candidate Selection ───────────────────────────────────
    let orderCandidateResolved = false;
    if (existingDraft._order_candidates && Array.isArray(existingDraft._order_candidates)) {
      const numIdx = extractCandidateIndex(text, totalAllCandidates || existingDraft._order_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null) {
        if (existingDraft._all_order_candidates && Array.isArray(existingDraft._all_order_candidates) && numIdx >= 1 && numIdx <= existingDraft._all_order_candidates.length) {
          matchedCandidate = existingDraft._all_order_candidates[numIdx - 1];
        } else if (numIdx >= 1 && numIdx <= existingDraft._order_candidates.length) {
          matchedCandidate = existingDraft._order_candidates[numIdx - 1];
        }
      }

      if (!matchedCandidate) {
        const cleanText = text.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*/i, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        const lowerText = text.toLowerCase();
        matchedCandidate = existingDraft._order_candidates.find(c => {
          const cDealCode = (c.deal_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cCleanCode = (c.clean_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cPo = (c.po_number || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cId = (c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const hasCodeMatch = (
            (cleanText.length >= 2 && cPo && (cleanText.includes(cPo) || cPo.includes(cleanText))) ||
            (cleanText.length >= 3 && (cDealCode.includes(cleanText) || cleanText.includes(cDealCode) || cCleanCode === cleanText || cId.startsWith(cleanText)))
          );
          const hasProdMatch = c.product_summary && (
            (lowerText.includes('hr coil') && c.product_summary.toLowerCase().includes('hr coil')) ||
            (lowerText.includes('cr sheet') && c.product_summary.toLowerCase().includes('cr sheet')) ||
            (lowerText.includes('plate') && c.product_summary.toLowerCase().includes('plate')) ||
            (lowerText.includes('tmt') && c.product_summary.toLowerCase().includes('tmt')) ||
            (lowerText.includes('pipe') && c.product_summary.toLowerCase().includes('pipe'))
          );
          return hasCodeMatch || hasProdMatch;
        });
      }

      if (matchedCandidate) {
        existingDraft.deal_id = matchedCandidate.effective_deal_id || matchedCandidate.inquiry_id || matchedCandidate.id;
        existingDraft.po_number = matchedCandidate.po_number || null;
        existingDraft.linked_inquiry_or_po = matchedCandidate.po_number
          ? `PO: ${matchedCandidate.po_number} (${matchedCandidate.deal_code})`
          : matchedCandidate.deal_code;
        existingDraft._order_verified = true;
        const dealProduct = matchedCandidate.product_summary || (matchedCandidate.items && matchedCandidate.items.length > 0 ? matchedCandidate.items.map(it => it.sku_text).filter(Boolean).join(', ') : null);
        const isCatProd = existingDraft.affected_product && isValidCatalogProduct(existingDraft.affected_product);
        if ((!existingDraft.affected_product || !isCatProd) && dealProduct) {
          existingDraft.affected_product = dealProduct;
        } else if (isCatProd) {
          const norm = normalizeProductToCatalog(existingDraft.affected_product);
          if (norm.catalogName) existingDraft.affected_product = norm.catalogName;
        }
        delete existingDraft._order_candidates;
        delete existingDraft._all_order_candidates;
        delete existingDraft._order_candidates_page;
        orderCandidateResolved = true;

        if (action === 'UPDATE_ORDER') {
          const isPureSelect = isPureOptionSelectorOnly(text);
          const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== '')) ||
            (Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0);

          if (isPureSelect && !hasUpdates) {
            let itemsListText = '';
            const items = Array.isArray(matchedCandidate.deal_items) ? matchedCandidate.deal_items : (Array.isArray(matchedCandidate.items) ? matchedCandidate.items : []);
            if (items.length > 0) {
              itemsListText = formatDetailedInquiryItemsList(items, { includeHsn: true });
            } else {
              itemsListText = `*${matchedCandidate.product_summary || 'Steel Material'}*`;
            }
            const prompt = formatSelectedOrderPrompt(matchedCandidate, itemsListText);

            await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
            await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
            return { handled: true, reply: prompt };
          }
        }
      }
    }

    // ── 4. Check Complaint Candidate Selection ───────────────────────────────
    let complaintCandidateResolved = false;
    if (existingDraft._complaint_candidates && Array.isArray(existingDraft._complaint_candidates)) {
      const numIdx = extractCandidateIndex(text, totalAllCandidates || existingDraft._complaint_candidates.length);
      let matchedCandidate = null;

      if (numIdx !== null) {
        if (existingDraft._all_complaint_candidates && Array.isArray(existingDraft._all_complaint_candidates) && numIdx >= 1 && numIdx <= existingDraft._all_complaint_candidates.length) {
          matchedCandidate = existingDraft._all_complaint_candidates[numIdx - 1];
        } else if (numIdx >= 1 && numIdx <= existingDraft._complaint_candidates.length) {
          matchedCandidate = existingDraft._complaint_candidates[numIdx - 1];
        }
      }

      if (!matchedCandidate) {
        const cleanText = text.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL|CMP|Complaint)[\s#:-]*/i, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        const lowerText = text.toLowerCase();
        matchedCandidate = existingDraft._complaint_candidates.find(c => {
          const cId = (c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cPo = (c.po_number || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          const cCust = (c.customer_name || '').toLowerCase();
          const cType = (c.complaint_type || '').toLowerCase();
          return (
            (cleanText.length >= 3 && (cId.startsWith(cleanText) || (cPo && (cleanText.includes(cPo) || cPo.includes(cleanText))))) ||
            (cCust && lowerText.includes(cCust)) ||
            (cType && lowerText.includes(cType))
          );
        });
      }

      if (matchedCandidate) {
        existingDraft.complaint_id = matchedCandidate.id;
        existingDraft.company_name = matchedCandidate.customer_name;
        if (matchedCandidate.po_number) {
          existingDraft.linked_inquiry_or_po = matchedCandidate.po_number;
        }
        existingDraft._complaint_verified = true;
        delete existingDraft._complaint_candidates;
        delete existingDraft._all_complaint_candidates;
        delete existingDraft._complaint_candidates_page;
        complaintCandidateResolved = true;

        const isPureSelect = isPureOptionSelectorOnly(text) || isFullRecordSelection(text);
        const hasUpdates = (existingDraft.updates && Object.values(existingDraft.updates).some(v => v !== null && v !== undefined && v !== ''));

        if (isPureSelect && !hasUpdates) {
          const prompt = formatSelectedRecordPrompt(action, matchedCandidate);

          await recordSessionMessage(senderPhone, 'assistant', prompt, { action_type: action });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return { handled: true, reply: prompt };
        }
      }
    }

    // ── 5. Check Assigned Customer Candidate Selection ───────────────────────
    if (existingDraft._all_customer_candidates && Array.isArray(existingDraft._all_customer_candidates)) {
      const numIdx = extractCandidateIndex(text, totalAllCandidates || existingDraft._all_customer_candidates.length);
      let matchedCust = null;
      if (numIdx !== null && numIdx >= 1 && numIdx <= existingDraft._all_customer_candidates.length) {
        matchedCust = existingDraft._all_customer_candidates[numIdx - 1];
      } else {
        const lowerInput = text.toLowerCase().trim();
        if (lowerInput.length >= 2 && !isPaginationRequest(text) && !isPreviousPaginationRequest(text) && !isDiscardOrCancelIntent(text)) {
          matchedCust = existingDraft._all_customer_candidates.find(name => {
            const lowerName = name.toLowerCase();
            return lowerName === lowerInput || lowerName.includes(lowerInput) || lowerInput.includes(lowerName);
          });
        }
      }

      if (matchedCust) {
        existingDraft.company_name = matchedCust;
        existingDraft._customer_verified = true;
        delete existingDraft._all_customer_candidates;
        delete existingDraft._customer_candidates;
        delete existingDraft._customer_candidates_page;

        const custProdCheck = validateDraftProducts(action, existingDraft);
        if (!custProdCheck.isValid) {
          await recordSessionMessage(senderPhone, 'assistant', custProdCheck.clarificationMessage, {
            action_type: action,
            customer_name: existingDraft.company_name,
          });
          await saveActiveSession(senderPhone, existingDraft.company_name, `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return {
            handled: true,
            reply: custProdCheck.clarificationMessage,
            interactiveType: 'buttons',
            interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
          };
        }

        const missing = validateMandatoryFields(action, existingDraft);
        if (missing.length === 0) {
          const lineChoice = await askLineItemChoiceIfNeeded(action, existingDraft, senderPhone);
          if (lineChoice) return lineChoice;

          const summary = buildConfirmationSummary(action, existingDraft);
          await recordSessionMessage(senderPhone, 'assistant', summary, {
            action_type: action,
            customer_name: existingDraft.company_name,
          });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(existingDraft)}`);
          return {
            handled: true,
            reply: summary,
            interactiveType: 'buttons',
            interactiveButtons: CONFIRMATION_BUTTONS,
          };
        } else {
          const missingList = missing.map(m => `• *${m}*`).join('\n');
          const askMissing = `✅ *Company:* ${existingDraft.company_name}\n\nPlease provide the remaining mandatory details for this ${getActionFriendlyName(action)}:\n\n${missingList}`;
          await recordSessionMessage(senderPhone, 'assistant', askMissing, {
            action_type: action,
            customer_name: existingDraft.company_name,
          });
          await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(existingDraft)}`);
          return { handled: true, reply: askMissing };
        }
      }
    }

    // Check if user replied "No" to complaint attachment prompt (this is NOT a discard intent)
    const isAttachmentNo = action === 'LOG_COMPLAINT' && isComplaintAttachmentSkip(text, existingDraft);

    // Check if user wants to abort / switch (only if not resolving candidate selection or skipping attachments)
    if (!isAttachmentNo && isDiscardOrCancelIntent(text)) {
      const cancelReply = `❌ Discarded. Send 'Hi' to start again.`;
      await recordSessionMessage(senderPhone, 'user', text);
      await recordSessionMessage(senderPhone, 'assistant', cancelReply);
      recordInactiveDraft(senderPhone, action, existingDraft, 'discarded');
      await finalizeCurrentSession(senderPhone, `Discarded ${getActionFriendlyName(action)} flow`);
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: cancelReply,
      };
    }

    // Check if user wants to abort / switch (only if not resolving candidate selection)
    if (!candidateResolved && !inquiryCandidateResolved && !orderCandidateResolved && !complaintCandidateResolved) {
      if (text.trim().toLowerCase() === 'general query' || text.trim() === '10' || text.trim() === '10.' || text.trim() === '11' || text.trim() === '11.' || text.trim() === 'menu_10') {
        const queryReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
        await recordSessionMessage(senderPhone, 'assistant', queryReply, { action_type: 'GENERAL_QUERY' });
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return {
          handled: true,
          reply: queryReply,
        };
      }

      const outOfScopeAction = detectOutOfScopeActionAttempt(action, text);
      if (outOfScopeAction) {
        console.log(`[CatalogFlow] Strict activity scope guard in catalog_flow: active=${action} (${getModuleFamily(action)}), incoming=${outOfScopeAction} (${getModuleFamily(outOfScopeAction)})`);
        return buildOutOfScopeActivityResponse(action, outOfScopeAction);
      }
    }

    // Check if user is clarifying an ambiguous/invalid product from prior prompt
    const existingProdCheck = validateDraftProducts(action, existingDraft);
    const cleanFlowInput = text.toLowerCase().replace(/[!.,?*]/g, '').trim();
    if (
      !existingProdCheck.isValid &&
      (cleanFlowInput === 'btn_add_product' || cleanFlowInput === 'add product' || cleanFlowInput === 'add new product')
    ) {
      const pendingProd = extractPendingNewProductSeed(existingDraft, existingProdCheck.invalidProducts?.[0]);
      existingDraft._pending_new_product = pendingProd;
      const cardMsg = buildAddProductPromptCard(pendingProd);
      await recordSessionMessage(senderPhone, 'assistant', cardMsg, {
        action_type: action,
        customer_name: existingDraft.company_name,
      });
      await saveActiveSession(senderPhone, existingDraft.company_name || 'Customer', `catalog_implicit_prod_add|${action}|${JSON.stringify(existingDraft)}`);
      return {
        handled: true,
        reply: cardMsg,
        interactiveType: 'buttons',
        interactiveButtons: ADD_PRODUCT_CONFIRM_BUTTONS,
      };
    }

    let resolvedProd = null;
    let resolvedInvalidSource = null;
    if (!existingProdCheck.isValid && existingProdCheck.invalidProducts.length > 0) {
      const explicitTarget = existingProdCheck.invalidProducts.find((inv) =>
        text.toLowerCase().includes(inv.toLowerCase()),
      );
      const targetOrder = explicitTarget
        ? [explicitTarget, ...existingProdCheck.invalidProducts.filter((p) => p !== explicitTarget)]
        : existingProdCheck.invalidProducts;

      for (const invProd of targetOrder) {
        const strippedText = explicitTarget
          ? text.replace(new RegExp(invProd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ').trim()
          : text;
        const candidate =
          resolveClarifiedProduct(strippedText || text, invProd) ||
          resolveClarifiedProduct(text, invProd);
        if (candidate) {
          resolvedProd = candidate;
          resolvedInvalidSource = invProd;
          break;
        }
      }
      if (resolvedProd && resolvedInvalidSource) {
        const targetLower = resolvedInvalidSource.trim().toLowerCase();
        const isSingleInvalid = existingProdCheck.invalidProducts.length === 1;
        const resolvedHsn = detectHsnCode(resolvedProd, '') || '';

        if (Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0) {
          existingDraft.line_item_updates.forEach((it) => {
            const pName = String(it.sku_text || it.description || it.item_reference || '').trim();
            const itNorm = normalizeProductToCatalog(pName, it.dimensions || it.spec);
            const matchesTarget =
              pName.toLowerCase() === targetLower ||
              pName.toLowerCase().includes(targetLower) ||
              (isSingleInvalid && !itNorm.isValid);
            if (matchesTarget) {
              it.sku_text = resolvedProd;
              it.description = resolvedProd;
              if (!isExplicitLineItemNumberRef(it)) {
                it.item_reference = resolvedProd;
              }
              const itemHsn = detectHsnCode(resolvedProd, it.dimensions || it.spec) || resolvedHsn;
              if (itemHsn) {
                it.hsn_code = itemHsn;
                it.hsn_sac = itemHsn;
              }
              it.is_valid_catalog = true;
            }
          });
        }
        if (Array.isArray(existingDraft.line_items) && existingDraft.line_items.length > 0) {
          existingDraft.line_items.forEach((it) => {
            const pName = String(it.sku_text || it.description || '').trim();
            const itNorm = normalizeProductToCatalog(pName, it.dimensions);
            const matchesTarget =
              pName.toLowerCase() === targetLower ||
              pName.toLowerCase().includes(targetLower) ||
              (isSingleInvalid && !itNorm.isValid);
            if (matchesTarget) {
              it.sku_text = resolvedProd;
              it.description = resolvedProd;
              const itemHsn = detectHsnCode(resolvedProd, it.dimensions) || resolvedHsn;
              if (itemHsn) {
                it.hsn_code = itemHsn;
                it.hsn_sac = itemHsn;
              }
              it.is_valid_catalog = true;
            }
          });
        }
        if (existingDraft.product_description) {
          const escapedTarget = resolvedInvalidSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const invRegex = new RegExp(escapedTarget, 'gi');
          existingDraft.product_description = existingDraft.product_description.replace(invRegex, resolvedProd);
        }
        if (existingDraft.affected_product && isSingleInvalid) {
          existingDraft.affected_product = resolvedProd;
        }
      }
    }

    // Extract fields from user message
    const isPureProductClarification = Boolean(
      resolvedProd &&
        !/\b(?:\d+(?:\.\d+)?\s*(?:mt|ton|tonne|kg|pcs|nos)|rate|price|@|bhav|₹|rs\.?|delivery|payment|advance|credit)\b/i.test(
          text,
        ),
    );
    const isPureCandidateSelection =
      ((candidateResolved || inquiryCandidateResolved || orderCandidateResolved || complaintCandidateResolved || resolvedProd) &&
        isPureOptionSelectorOnly(text)) ||
      isPureProductClarification;
    const isGenericMediaCaption = /^(?:image\s*received|document\s*received|photo\s*uploaded|evidence\s*(?:attachment|photo|photos|document)?\s*uploaded|uploaded\s*photo|attachment\s*uploaded)$/i.test(text.trim());

    const updatedDraft = (isPureCandidateSelection || isAttachmentNo || (incomingAttachments.length > 0 && isGenericMediaCaption) || existingDraft._skip_llm_extract)
      ? { ...existingDraft }
      : await extractFieldsWithLLM(action, text, existingDraft);
    delete updatedDraft._skip_llm_extract;

    if (resolvedProd && resolvedInvalidSource && Array.isArray(existingDraft.line_item_updates) && existingDraft.line_item_updates.length > 0) {
      const targetLower = resolvedInvalidSource.trim().toLowerCase();
      const isSingleInvalid = existingProdCheck.invalidProducts.length === 1;
      const textHasNewSpec = Boolean(text.match(/\b(?:\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g)|\d+X\d+X\d+|\d+\s*x\s*\d+)\b/i));
      const textHasNewQty = Boolean(text.match(/\b\d+(?:\.\d+)?\s*(?:mt|ton|tonne|kg|pcs|nos)\b/i));
      const textHasNewRate = Boolean(text.match(/(?:rate|price|@|bhav)[\s:=-]*(?:to\s+|as\s+|is\s+|be\s+|ko\s+)?(?:₹|rs\.?)?\s*\d+/i) || text.match(/(?:₹|rs\.?)\s*\d+/i) || text.match(/\d+\s*(?:₹|rs\.?)/i));

      if (!Array.isArray(updatedDraft.line_item_updates) || updatedDraft.line_item_updates.length === 0) {
        updatedDraft.line_item_updates = existingDraft.line_item_updates;
      } else {
        updatedDraft.line_item_updates.forEach((it, idx) => {
          const prev = existingDraft.line_item_updates[idx] || existingDraft.line_item_updates[0] || {};
          const pName = String(it.sku_text || it.description || it.item_reference || prev.sku_text || prev.description || '').trim();
          const itNorm = normalizeProductToCatalog(pName, it.dimensions || it.spec || prev.dimensions || prev.spec);
          if (pName.toLowerCase() === targetLower || pName.toLowerCase().includes(targetLower) || (isSingleInvalid && !itNorm.isValid)) {
            it.sku_text = resolvedProd;
            it.description = resolvedProd;
            it.is_valid_catalog = true;
          }
          if (!textHasNewSpec && (prev.dimensions || prev.spec)) {
            it.dimensions = prev.dimensions || prev.spec;
            it.spec = prev.spec || prev.dimensions;
          }
          if (!textHasNewQty && prev.quantity !== null && prev.quantity !== undefined) {
            it.quantity = prev.quantity;
          }
          if (!textHasNewRate) {
            it.rate = (prev.rate !== null && prev.rate !== undefined) ? prev.rate : null;
          }
        });
      }
    }
    if (resolvedProd && resolvedInvalidSource && Array.isArray(existingDraft.line_items) && existingDraft.line_items.length > 0) {
      const targetLower = resolvedInvalidSource.trim().toLowerCase();
      const isSingleInvalid = existingProdCheck.invalidProducts.length === 1;
      const textHasNewSpec = Boolean(text.match(/\b(?:\d+(?:\.\d+)?\s*(?:mm|thk|gauge|g)|\d+X\d+X\d+|\d+\s*x\s*\d+)\b/i));
      const textHasNewQty = Boolean(text.match(/\b\d+(?:\.\d+)?\s*(?:mt|ton|tonne|kg|pcs|nos)\b/i));
      const textHasNewRate = Boolean(text.match(/(?:rate|price|@|bhav)[\s:=-]*(?:to\s+|as\s+|is\s+|be\s+|ko\s+)?(?:₹|rs\.?)?\s*\d+/i) || text.match(/(?:₹|rs\.?)\s*\d+/i) || text.match(/\d+\s*(?:₹|rs\.?)/i));

      if (!Array.isArray(updatedDraft.line_items) || updatedDraft.line_items.length === 0) {
        updatedDraft.line_items = existingDraft.line_items;
      } else {
        updatedDraft.line_items.forEach((it, idx) => {
          const prev = existingDraft.line_items[idx] || existingDraft.line_items[0] || {};
          const pName = String(it.sku_text || it.description || '').trim();
          const itNorm = normalizeProductToCatalog(pName, it.dimensions || prev.dimensions);
          if (pName.toLowerCase() === targetLower || pName.toLowerCase().includes(targetLower) || (isSingleInvalid && !itNorm.isValid)) {
            it.sku_text = resolvedProd;
            it.description = resolvedProd;
            it.is_valid_catalog = true;
          }
          if (!textHasNewSpec && (prev.dimensions || prev.spec)) {
            it.dimensions = prev.dimensions || prev.spec;
            it.spec = prev.spec || prev.dimensions;
          }
          if (!textHasNewQty && prev.quantity !== null && prev.quantity !== undefined) {
            it.quantity = prev.quantity;
          }
          if (!textHasNewRate) {
            it.rate = (prev.rate !== null && prev.rate !== undefined) ? prev.rate : null;
          }
          if (!it.rate) {
            it.amount = null;
          } else if (it.rate && it.quantity) {
            it.amount = Number(it.rate) * Number(it.quantity);
          }
        });
      }
      if (!textHasNewRate) {
        updatedDraft.rate = (existingDraft.rate !== null && existingDraft.rate !== undefined) ? existingDraft.rate : null;
      }
    }

    const preserveKeys = [
      'source_channel',
      'visit_id', 'visit_date', 'inquiry_id', '_inquiry_display_id', '_inquiry_verified',
      'deal_id', 'po_number', 'linked_inquiry_or_po', 'affected_product', '_order_verified',
      'complaint_type', 'complaint_description', 'company_name', 'complaint_id', '_complaint_verified',
      'complaint_date', 'raised_by', 'challan_no', 'customer_communication', 'resolution_notes', 'resolution_date', 'corrective_action',
      '_attachments_asked', '_attachments_completed',
      'rate', '_customer_verified', '_new_customer_created',
      '_verified_custom_products', '_pending_new_product',
      'gps_photo_url', 'gps_latitude', 'gps_longitude', 'gps_accuracy', 'attachments'
    ];
    for (const key of preserveKeys) {
      if (existingDraft[key] !== undefined && (updatedDraft[key] === undefined || updatedDraft[key] === null || updatedDraft[key] === '')) {
        updatedDraft[key] = existingDraft[key];
      }
    }
    if (existingDraft._inquiry_display_id && !updatedDraft._inquiry_display_id) {
      updatedDraft._inquiry_display_id = existingDraft._inquiry_display_id;
    }
    if (callerSourceChannel && !updatedDraft.source_channel) {
      updatedDraft.source_channel = callerSourceChannel;
    }

    if (action === 'LOG_VISIT') {
      if (attachmentObj) {
        const prevAtts = Array.isArray(updatedDraft.attachments) ? updatedDraft.attachments : (Array.isArray(existingDraft.attachments) ? existingDraft.attachments : []);
        if (!prevAtts.some(a => a && a.url === attachmentObj.url)) {
          updatedDraft.attachments = [...prevAtts, attachmentObj];
        }
        if (!updatedDraft.gps_photo_url && !existingDraft.gps_photo_url) {
          updatedDraft.gps_photo_url = attachmentObj.url;
        }
      }
      if (gpsData && (updatedDraft.gps_latitude === undefined || updatedDraft.gps_latitude === null)) {
        updatedDraft.gps_latitude = gpsData.latitude;
        updatedDraft.gps_longitude = gpsData.longitude;
        updatedDraft.gps_accuracy = gpsData.accuracy;
      }
    } else if (action === 'UPDATE_VISIT') {
      if (attachmentObj) {
        updatedDraft.updates = updatedDraft.updates || {};
        const prevNew = Array.isArray(updatedDraft.updates.new_attachments) ? updatedDraft.updates.new_attachments : (Array.isArray(existingDraft.updates?.new_attachments) ? existingDraft.updates.new_attachments : []);
        if (!prevNew.some(a => a && a.url === attachmentObj.url)) {
          updatedDraft.updates.new_attachments = [...prevNew, attachmentObj];
        }
      }
      if (gpsData) {
        updatedDraft.updates = updatedDraft.updates || {};
        if (updatedDraft.updates.gps_latitude === undefined) {
          updatedDraft.updates.gps_latitude = gpsData.latitude;
          updatedDraft.updates.gps_longitude = gpsData.longitude;
          updatedDraft.updates.gps_accuracy = gpsData.accuracy;
        }
      }
    } else if (action === 'LOG_COMPLAINT') {
      if (incomingAttachments.length > 0) {
        const prevAtts = Array.isArray(updatedDraft.attachments) ? updatedDraft.attachments : (Array.isArray(existingDraft.attachments) ? existingDraft.attachments : []);
        const newAtts = [...prevAtts];
        for (const att of incomingAttachments) {
          if (newAtts.length >= 3) break;
          const fileUrl = att.url || att.file_url;
          if (!newAtts.some(a => (a.url === fileUrl || a.file_url === fileUrl))) {
            const isPdf = (att.type || att.file_type || '').includes('pdf');
            const compAtt = {
              name: att.name || att.file_name || `evidence-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`,
              url: fileUrl,
              file_url: fileUrl,
              file_name: att.name || att.file_name || `evidence-${Date.now()}`,
              file_type: att.type || att.file_type || 'image/jpeg',
              file_size: att.file_size || null,
              uploaded_at: att.uploaded_at || new Date().toISOString(),
            };
            newAtts.push(compAtt);
          }
        }
        updatedDraft.attachments = newAtts;
        updatedDraft._attachments_asked = true;
        updatedDraft._attachments_completed = true;
      }

      const isDoneOrSkip = isAttachmentNo || /^(?:done|skip|proceed|next|no|nah|none|no\s*photos?|no\s*evidence|btn_att_no)\b/i.test(text.trim());
      if (isDoneOrSkip && (existingDraft._attachments_asked || !existingDraft.complaint_description)) {
        updatedDraft._attachments_completed = true;
        updatedDraft._attachments_asked = true;
      }
    }

    // Check if user is attempting to edit a non-editable or system-generated field
    const nonEditableCheckFlow = detectNonEditableFieldAttempt(action, text, updatedDraft);
    if (nonEditableCheckFlow.isNonEditable) {
      const fullReply = nonEditableCheckFlow.compactReply || `${nonEditableCheckFlow.message}\n\n*Editable fields for this ${getActionFriendlyName(action)}:*\n${nonEditableCheckFlow.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || existingDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }

    // 0. LOG_ORDER Inquiry Quoted Stage Gate check
    if (action === 'LOG_ORDER' && (updatedDraft.inquiry_id || updatedDraft.deal_id || updatedDraft._inquiry_display_id)) {
      const stageCheck = await validateOrderInquiryStage(updatedDraft, senderPhone);
      if (!stageCheck.isValid) {
        await recordSessionMessage(senderPhone, 'assistant', stageCheck.reply, { action_type: action });
        await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: stageCheck.reply };
      }
    }

    const custCheck = await verifyDraftCustomer(action, updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isLowMatchCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(
          senderPhone,
          custCheck.fetchedName,
          `catalog_cust_match_confirm|${action}|${custCheck.fetchedName}|${JSON.stringify(custCheck.candidates)}|${JSON.stringify(updatedDraft)}`
        );
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: CUST_MATCH_BUTTONS,
        };
      }
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: action });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|${action}|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: action });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    if (custCheck.isValid && updatedDraft._all_customer_candidates) {
      delete updatedDraft._all_customer_candidates;
      delete updatedDraft._customer_candidates;
      delete updatedDraft._customer_candidates_page;
    }

    if (action === 'LOG_NEW_CUSTOMER' && updatedDraft.company_name) {
      const regCheck = await checkCompanyWideCustomerRegistration(updatedDraft.company_name, senderPhone);
      if (regCheck && regCheck.isRegistered) {
        const conflictReply = regCheck.conflictMessage;
        await recordSessionMessage(senderPhone, 'assistant', conflictReply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        updatedDraft.company_name = null;
        await saveActiveSession(senderPhone, 'Customer', `catalog_duplicate_blocked|LOG_NEW_CUSTOMER|${JSON.stringify(updatedDraft)}`);
        return buildDuplicateCustomerResponse(conflictReply);
      }
    }

    const flowProdCheck = validateDraftProducts(action, updatedDraft);
    if (!flowProdCheck.isValid) {
      await recordSessionMessage(senderPhone, 'assistant', flowProdCheck.clarificationMessage, { action_type: action });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: flowProdCheck.clarificationMessage,
        interactiveType: 'buttons',
        interactiveButtons: UNKNOWN_PRODUCT_BUTTONS,
      };
    }

    // 1. UPDATE_INQUIRY candidate check & ID verification
    if (action === 'UPDATE_INQUIRY' && !updatedDraft.inquiry_id && !updatedDraft.company_name) {
      const recent = lastInactiveDraftMetadata.get(cleanPhone(senderPhone || ''));
      if (recent && recent.action === 'UPDATE_INQUIRY' && recent.status === 'saved' && (Date.now() - recent.timestamp < 15 * 60 * 1000)) {
        if (recent.inquiry_id) updatedDraft.inquiry_id = recent.inquiry_id;
        if (recent.company_name) updatedDraft.company_name = recent.company_name;
        if (recent.draft?._inquiry_display_id) updatedDraft._inquiry_display_id = recent.draft._inquiry_display_id;
      }
    }

    if (action === 'UPDATE_INQUIRY' && (updatedDraft.inquiry_id || updatedDraft.company_name)) {
      const inqCheck = await checkInquiriesForUpdate(action, updatedDraft, senderPhone, text);
      if (inqCheck && inqCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', inqCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (inqCheck.status === 'MULTIPLE_EDITABLE' || inqCheck.status === 'SINGLE_EDITABLE_ASK_DETAILS' || inqCheck.status === 'ID_NOT_FOUND') {
          await saveActiveSession(senderPhone, (inqCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(inqCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: inqCheck.reply };
      }
      if (inqCheck && inqCheck.draft) Object.assign(updatedDraft, inqCheck.draft);
    }

    // 2. UPDATE_ORDER candidate check & ID verification
    if (action === 'UPDATE_ORDER' && (updatedDraft.inquiry_id || updatedDraft.po_number || updatedDraft.company_name)) {
      const ordCheck = await checkOrdersForUpdate(action, updatedDraft, senderPhone, text);
      if (ordCheck && ordCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (ordCheck.status === 'ASK_DETAILS' || ordCheck.status === 'ID_NOT_FOUND' || ordCheck.status === 'MULTIPLE_ORDERS') {
          await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: ordCheck.reply };
      }
      if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
    }

    // 3. UPDATE_COMPLAINT candidate check & reference verification
    if (action === 'UPDATE_COMPLAINT' && (updatedDraft.linked_inquiry_or_po || updatedDraft.company_name || updatedDraft.complaint_id)) {
      const cmpCheck = await checkComplaintsForUpdate(action, updatedDraft, senderPhone, text);
      if (cmpCheck && cmpCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', cmpCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (cmpCheck.status === 'ASK_DETAILS' || cmpCheck.status === 'NOT_FOUND' || cmpCheck.status === 'MULTIPLE_COMPLAINTS') {
          await saveActiveSession(senderPhone, (cmpCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(cmpCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', 'general');
        }
        return { handled: true, reply: cmpCheck.reply };
      }
      if (cmpCheck && cmpCheck.draft) Object.assign(updatedDraft, cmpCheck.draft);
    }

    // 4. LOG_COMPLAINT candidate check & PO / Order auto-resolution
    if (action === 'LOG_COMPLAINT' && (updatedDraft.linked_inquiry_or_po || updatedDraft.po_number || updatedDraft.company_name || /\b(?:PO[-_:#\s]*[A-Za-z0-9_-]+|INQ-[A-Z0-9]+)\b/i.test(text))) {
      const ordCheck = await checkOrdersForComplaint(action, updatedDraft, senderPhone, text);
      if (ordCheck && ordCheck.handled) {
        await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        if (ordCheck.status === 'MULTIPLE_ORDERS' || ordCheck.status === 'ORDER_NOT_FOUND') {
          await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
        } else {
          await saveActiveSession(senderPhone, 'Unknown', 'general');
        }
        return { handled: true, reply: ordCheck.reply };
      }
      if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
    }

    const missing = validateMandatoryFields(action, updatedDraft);

    if (missing.length === 0) {
      // Disambiguation check if multiple visits exist for the customer and date was not specified
      if (action === 'UPDATE_VISIT') {
        const disambig = await checkMultipleVisitsForUpdate(action, updatedDraft, senderPhone);
        if (disambig.needsDisambiguation) {
          await recordSessionMessage(senderPhone, 'assistant', disambig.prompt, {
            action_type: action,
            customer_name: updatedDraft.company_name,
          });
          await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(disambig.draft)}`);
          return { handled: true, reply: disambig.prompt };
        }
      }

      // Order validation & disambiguation for LOG_COMPLAINT if not yet bound to a deal
      if (action === 'LOG_COMPLAINT' && !updatedDraft.deal_id) {
        const ordCheck = await checkOrdersForComplaint(action, updatedDraft, senderPhone, text);
        if (ordCheck && ordCheck.handled) {
          await recordSessionMessage(senderPhone, 'assistant', ordCheck.reply, {
            action_type: action,
            customer_name: updatedDraft.company_name,
          });
          if (ordCheck.status === 'MULTIPLE_ORDERS' || ordCheck.status === 'ORDER_NOT_FOUND') {
            await saveActiveSession(senderPhone, (ordCheck.draft?.company_name || updatedDraft.company_name || 'Customer'), `catalog_flow|${action}|${JSON.stringify(ordCheck.draft || updatedDraft)}`);
          } else {
            await saveActiveSession(senderPhone, 'Unknown', 'general');
          }
          return { handled: true, reply: ordCheck.reply };
        }
        if (ordCheck && ordCheck.draft) Object.assign(updatedDraft, ordCheck.draft);
      }

      // Evidence / Attachments question for LOG_COMPLAINT before final confirmation
      if (action === 'LOG_COMPLAINT' && !updatedDraft._attachments_asked && (!Array.isArray(updatedDraft.attachments) || updatedDraft.attachments.length === 0) && !updatedDraft._attachments_completed) {
        updatedDraft._attachments_asked = true;
        const askAttachmentsPrompt = `Do you want to attach photos for this complaint? You can send 1 to 3 photos (max 15MB each) in one shot. If no attachments, tap 'No'.`;
        await recordSessionMessage(senderPhone, 'assistant', askAttachmentsPrompt, {
          action_type: action,
          customer_name: updatedDraft.company_name,
        });
        await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: askAttachmentsPrompt,
          interactiveType: 'buttons',
          interactiveButtons: ATTACHMENT_PROMPT_BUTTONS,
        };
      }

      const lineChoice = await askLineItemChoiceIfNeeded(action, updatedDraft, senderPhone);
      if (lineChoice) return lineChoice;

      const stageSaved = await saveStageOnlyInquiryUpdateIfNeeded(text, senderPhone, 'catalog_flow', action, updatedDraft);
      if (stageSaved) return stageSaved;

      // All mandatory fields present -> Show confirmation summary
      const summary = buildConfirmationSummary(action, updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      // Missing mandatory fields -> Ask only for missing fields
      const llmSystemField = updatedDraft._non_editable_request || null;
      delete updatedDraft._non_editable_request;
      if (action === 'UPDATE_INQUIRY' && llmSystemField && missing.some(m => /^At least one field to update/.test(m))) {
        const sysReply = buildInquirySystemFieldReply(llmSystemField, updatedDraft._inquiry_display_id || null);
        await recordSessionMessage(senderPhone, 'assistant', sysReply, { action_type: action, customer_name: updatedDraft.company_name });
        await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: sysReply };
      }
      const missingList = missing.map((m) => `- **${m}**`).join('\n');
      const actionName = getActionFriendlyName(action);
      const indexTag = updatedDraft._totalCount > 1 ? ` (${updatedDraft._currentIndex || 1} of ${updatedDraft._totalCount}: ${updatedDraft.company_name || 'Item'})` : '';
      let askMissing = '';
      if (updatedDraft._permissionNotice) {
        askMissing += `${updatedDraft._permissionNotice}\n\n`;
      }
      if (action === 'LOG_COMPLAINT' && attachmentObj) {
        const curCount = Array.isArray(updatedDraft.attachments) ? updatedDraft.attachments.length : 1;
        askMissing += `📎 *Evidence attachment received (${curCount}/3).*\n\n`;
      }
      askMissing += `Please provide the remaining mandatory details for this ${actionName}${indexTag}:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: action,
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|${action}|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // A bare number inside an open session is field input, never a catalog selection.
  if (hasActiveCatalogSession && isBareCatalogNumber(text)) {
    await recordSessionMessage(senderPhone, 'assistant', BARE_NUMBER_FIELD_INPUT_REPLY, { action_type: 'BARE_NUMBER_FIELD_INPUT' });
    return { handled: true, reply: BARE_NUMBER_FIELD_INPUT_REPLY };
  }

  // ── 6. DIRECT ACTION ROUTING (Menu Selection 1-10 or Action Keywords) ────────
  const matchedAction = matchActionFromInput(text, false, canUpdateVisits);
  if (matchedAction) {
    const { denialReply } = require('../utils/permissions');
    const denied = await denialReply(senderPhone, matchedAction);
    if (denied) {
      await recordSessionMessage(senderPhone, 'assistant', denied, { action_type: 'ACCESS_DENIED' });
      return { handled: true, reply: denied };
    }
    await recordSessionMessage(senderPhone, 'user', text);
    if (matchedAction === 'GENERAL_QUERY') {
      const genReply = `🔍 *SalesOS Search & Intelligence*\n\nAsk any question about your inquiries, quotations, customer profiles, site visits, or complaints!\n\n_Example: "What was the last rate quoted to Horizon Sheet Metal?" or "Show pending complaints"_`;
      await recordSessionMessage(senderPhone, 'assistant', genReply, { action_type: 'GENERAL_QUERY' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return {
        handled: true,
        reply: genReply,
      };
    }

    // 6a. Direct candidate browsing for UPDATE & ORDER actions
    if (['LOG_ORDER', 'UPDATE_INQUIRY', 'UPDATE_ORDER', 'UPDATE_VISIT', 'UPDATE_COMPLAINT'].includes(matchedAction)) {
      if (matchedAction === 'UPDATE_VISIT' && !canUpdateVisits) {
        const deniedReply = `Access Denied: Field visits can only be updated by Sales Managers and Administrators. Please contact your manager to update a logged visit.`;
        await recordSessionMessage(senderPhone, 'assistant', deniedReply, { action_type: 'ACCESS_DENIED' });
        await saveActiveSession(senderPhone, 'Unknown', 'general');
        return { handled: true, reply: deniedReply };
      }

      const selectionRes = await fetchAndRenderUpdateSelection(matchedAction, senderPhone, { page: 1, customerFilter: null });
      await startNewCatalogSession(senderPhone, selectionRes.reply);
      await recordSessionMessage(senderPhone, 'assistant', selectionRes.reply, { action_type: matchedAction });
      if (selectionRes.hasRecords || matchedAction === 'LOG_ORDER') {
        await saveActiveSession(senderPhone, 'Unknown', `catalog_update_select|${matchedAction}|${JSON.stringify(selectionRes.state)}`);
      } else {
        await saveActiveSession(senderPhone, 'Unknown', 'general');
      }
      return catalogSelectionResult(selectionRes);
    }

    const initialPrompt = MODULE_PROMPTS[matchedAction];
    if (initialPrompt) {
      await startNewCatalogSession(senderPhone, initialPrompt);
      await recordSessionMessage(senderPhone, 'assistant', initialPrompt, { action_type: matchedAction });
      const initialDraft = callerSourceChannel ? { source_channel: callerSourceChannel } : {};
      await saveActiveSession(senderPhone, 'Unknown', `catalog_flow|${matchedAction}|${JSON.stringify(initialDraft)}`);
      return { handled: true, reply: initialPrompt };
    }
  }

  // ── 6b. DIRECT UPDATE WITH NON-EDITABLE FIELD ATTEMPT (Cold-Start Guard) ──
  const detectedUpdateAction = matchedAction || detectOperationalAction(text);
  if (detectedUpdateAction === 'UPDATE_VISIT' && !canUpdateVisits) {
    await recordSessionMessage(senderPhone, 'user', text);
    const deniedReply = `Access Denied: Field visits can only be updated by Sales Managers and Administrators. Please contact your manager to update a logged visit.`;
    await recordSessionMessage(senderPhone, 'assistant', deniedReply, { action_type: 'ACCESS_DENIED' });
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return { handled: true, reply: deniedReply };
  }

  if (detectedUpdateAction && ['UPDATE_INQUIRY', 'UPDATE_ORDER', 'UPDATE_VISIT', 'UPDATE_COMPLAINT'].includes(detectedUpdateAction)) {
    let currentCust = null;
    const match = text.match(/(?:for|of|regarding|on)\s+([A-Za-z0-9\s&.,'-]+?)(?:,|\s+change|\s+edit|\s+update|\s+set|\s+modify|\s+to|$)/i);
    if (match && match[1] && !/^(?:the|a|an|customer|visit|order|inquiry|complaint)$/i.test(match[1].trim())) {
      currentCust = match[1].trim();
    }
    const tempDraft = { action: detectedUpdateAction, company_name: currentCust };
    const nonEditableCheckCold = detectNonEditableFieldAttempt(detectedUpdateAction, text, tempDraft);
    if (nonEditableCheckCold.isNonEditable) {
      await recordSessionMessage(senderPhone, 'user', text);
      const fullReply = `${nonEditableCheckCold.message}\n\n*Editable fields for this ${getActionFriendlyName(detectedUpdateAction)}:*\n${nonEditableCheckCold.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: detectedUpdateAction });
      await startNewCatalogSession(senderPhone, fullReply);
      await saveActiveSession(senderPhone, currentCust || 'Customer', `catalog_flow|${detectedUpdateAction}|${JSON.stringify(tempDraft)}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }
  }

  // ── 6c. COLD-START OPERATIONAL VISIT UPDATE ──
  const isColdUpdateVisit =
    detectedUpdateAction === 'UPDATE_VISIT' ||
    detectOperationalAction(text) === 'UPDATE_VISIT' ||
    /\b(?:update|change|modify|edit|amend|revise)\s+(?:the\s+|a\s+)?(?:customer\s*)?(?:field\s*|site\s*)?visit\b/i.test(text);

  if (isColdUpdateVisit) {
    if (!canUpdateVisits) {
      await recordSessionMessage(senderPhone, 'user', text);
      const deniedReply = `Access Denied: Field visits can only be updated by Sales Managers and Administrators. Please contact your manager to update a logged visit.`;
      await recordSessionMessage(senderPhone, 'assistant', deniedReply, { action_type: 'ACCESS_DENIED' });
      await saveActiveSession(senderPhone, 'Unknown', 'general');
      return { handled: true, reply: deniedReply };
    }
    let currentCust = null;
    const match = text.match(/(?:for|of|regarding|on)\s+([A-Za-z0-9\s&.,'-]+?)(?:,|\s+change|\s+edit|\s+update|\s+set|\s+modify|\s+to|$)/i);
    if (match && match[1] && !/^(?:the|a|an|customer|visit|order|inquiry|complaint)$/i.test(match[1].trim())) {
      currentCust = match[1].trim();
    }
    const initialUpdateDraft = {
      action: 'UPDATE_VISIT',
      company_name: currentCust,
      updates: {},
      ...(attachmentObj ? { updates: { new_attachments: [attachmentObj] } } : {}),
      ...(gpsData ? {
        updates: {
          ...(attachmentObj ? { new_attachments: [attachmentObj] } : {}),
          gps_latitude: gpsData.latitude,
          gps_longitude: gpsData.longitude,
          gps_accuracy: gpsData.accuracy,
        }
      } : {}),
    };

    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = await extractFieldsWithLLM('UPDATE_VISIT', text, initialUpdateDraft);
    if (attachmentObj) {
      updatedDraft.updates = updatedDraft.updates || {};
      const prevNew = Array.isArray(updatedDraft.updates.new_attachments) ? updatedDraft.updates.new_attachments : [];
      if (!prevNew.some(a => a && a.url === attachmentObj.url)) {
        updatedDraft.updates.new_attachments = [...prevNew, attachmentObj];
      }
    }
    if (gpsData) {
      updatedDraft.updates = updatedDraft.updates || {};
      if (updatedDraft.updates.gps_latitude === undefined) {
        updatedDraft.updates.gps_latitude = gpsData.latitude;
        updatedDraft.updates.gps_longitude = gpsData.longitude;
        updatedDraft.updates.gps_accuracy = gpsData.accuracy;
      }
    }

    const nonEditableColdUpdate = detectNonEditableFieldAttempt('UPDATE_VISIT', text, updatedDraft);
    if (nonEditableColdUpdate.isNonEditable) {
      const fullReply = `${nonEditableColdUpdate.message}\n\n*Editable fields for this ${getActionFriendlyName('UPDATE_VISIT')}:*\n${nonEditableColdUpdate.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'UPDATE_VISIT' });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|UPDATE_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }

    const missing = validateMandatoryFields('UPDATE_VISIT', updatedDraft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary('UPDATE_VISIT', updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: 'UPDATE_VISIT',
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|UPDATE_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const askMissing = `Please provide the remaining mandatory details for this visit update:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: 'UPDATE_VISIT',
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|UPDATE_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // ── 6d. COLD-START OPERATIONAL VISIT LOGGING (With Photo / GPS or Detailed Notes) ──
  const isColdVisitIntent =
    !isColdUpdateVisit &&
    ((detectedUpdateAction === 'LOG_VISIT' || detectOperationalAction(text) === 'LOG_VISIT') ||
    (Boolean(attachmentObj) && /\b(?:visit|site|meeting|met|client|customer|office|plant|factory)\b/i.test(text)));

  if (isColdVisitIntent) {
    const initialVisitDraft = {
      action: 'LOG_VISIT',
      ...(photoDataUrl ? { gps_photo_url: photoDataUrl } : {}),
      ...(attachmentObj ? { attachments: [attachmentObj] } : {}),
      ...(gpsData ? {
        gps_latitude: gpsData.latitude,
        gps_longitude: gpsData.longitude,
        gps_accuracy: gpsData.accuracy,
      } : {}),
    };

    await recordSessionMessage(senderPhone, 'user', text);
    const updatedDraft = await extractFieldsWithLLM('LOG_VISIT', text, initialVisitDraft);

    if (photoDataUrl && !updatedDraft.gps_photo_url) updatedDraft.gps_photo_url = photoDataUrl;
    if (attachmentObj) {
      if (!Array.isArray(updatedDraft.attachments) || updatedDraft.attachments.length === 0) {
        updatedDraft.attachments = [attachmentObj];
      }
    }
    if (gpsData && (updatedDraft.gps_latitude === undefined || updatedDraft.gps_latitude === null)) {
      updatedDraft.gps_latitude = gpsData.latitude;
      updatedDraft.gps_longitude = gpsData.longitude;
      updatedDraft.gps_accuracy = gpsData.accuracy;
    }

    const nonEditableColdLog = detectNonEditableFieldAttempt('LOG_VISIT', text, updatedDraft);
    if (nonEditableColdLog.isNonEditable) {
      const fullReply = `${nonEditableColdLog.message}\n\n*Editable fields for this ${getActionFriendlyName('LOG_VISIT')}:*\n${nonEditableColdLog.allowedFieldsList}\n\nWhich editable field would you like to change?`;
      await recordSessionMessage(senderPhone, 'assistant', fullReply, { action_type: 'LOG_VISIT' });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|LOG_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: fullReply,
        interactiveType: 'buttons',
        interactiveButtons: NON_EDITABLE_REPLY_BUTTONS,
      };
    }

    const custCheck = await verifyDraftCustomer('LOG_VISIT', updatedDraft, senderPhone);
    if (!custCheck.isValid) {
      if (custCheck.isLowMatchCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: 'LOG_VISIT' });
        await saveActiveSession(
          senderPhone,
          custCheck.fetchedName,
          `catalog_cust_match_confirm|LOG_VISIT|${custCheck.fetchedName}|${JSON.stringify(custCheck.candidates)}|${JSON.stringify(updatedDraft)}`
        );
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: CUST_MATCH_BUTTONS,
        };
      }
      if (custCheck.isUnrecognizedCustomer) {
        await recordSessionMessage(senderPhone, 'assistant', custCheck.prompt, { action_type: 'LOG_VISIT' });
        await saveActiveSession(senderPhone, custCheck.unverifiedName, `catalog_implicit_cust_ask|LOG_VISIT|${custCheck.unverifiedName}|${JSON.stringify(updatedDraft)}`);
        return {
          handled: true,
          reply: custCheck.prompt,
          interactiveType: 'buttons',
          interactiveButtons: NEW_CUSTOMER_BUTTONS,
        };
      } else {
        updatedDraft.company_name = null;
        await recordSessionMessage(senderPhone, 'assistant', custCheck.rejectionMessage, { action_type: 'LOG_VISIT' });
        await saveActiveSession(senderPhone, 'Customer', `catalog_flow|LOG_VISIT|${JSON.stringify(updatedDraft)}`);
        return { handled: true, reply: custCheck.rejectionMessage };
      }
    }

    const missing = validateMandatoryFields('LOG_VISIT', updatedDraft);
    if (missing.length === 0) {
      const summary = buildConfirmationSummary('LOG_VISIT', updatedDraft);
      await recordSessionMessage(senderPhone, 'assistant', summary, {
        action_type: 'LOG_VISIT',
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_confirm|LOG_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: summary,
        interactiveType: 'buttons',
        interactiveButtons: CONFIRMATION_BUTTONS,
      };
    } else {
      const missingList = missing.map((m) => `• *${m}*`).join('\n');
      const askMissing = `Please provide the remaining mandatory details for this field visit:\n\n${missingList}`;
      await recordSessionMessage(senderPhone, 'assistant', askMissing, {
        action_type: 'LOG_VISIT',
        customer_name: updatedDraft.company_name,
      });
      await saveActiveSession(senderPhone, updatedDraft.company_name || 'Customer', `catalog_flow|LOG_VISIT|${JSON.stringify(updatedDraft)}`);
      return {
        handled: true,
        reply: askMissing,
      };
    }
  }

  // ── 7. FREE DATA RETRIEVAL QUERIES VS OUT-OF-SCOPE PROMPTS ──
  const userMenu = getCatalogMenu(canUpdateVisits);
  const userSections = getCatalogMenuSections(canUpdateVisits);

  const isGenericOutOfScope = isOutOfScopeGenericPrompt(text);
  if (isGenericOutOfScope) {
    await recordSessionMessage(senderPhone, 'user', text);
    const outOfScopeReply = `*Out of Scope Request*\n\n` +
      `I am the *Enlight Metals SalesOS Assistant* dedicated exclusively to managing and supporting your metal sales operations, inquiries, customer visits, orders, payments, and complaints.\n\n` +
      `I cannot assist with general knowledge, trivia, or non-sales prompts.\n\n` +
      `*Here is the SalesOS menu to assist you with your daily activities:*\n\n` +
      userMenu;

    await recordSessionMessage(senderPhone, 'assistant', outOfScopeReply, { action_type: 'OUT_OF_SCOPE_PROMPT' });
    await startNewCatalogSession(senderPhone, outOfScopeReply);
    return {
      handled: true,
      reply: outOfScopeReply,
      interactiveType: 'list',
      interactiveList: {
        bodyText: `I am the *Enlight Metals SalesOS Assistant*. Here is the menu to start a sales activity:`,
        buttonText: 'Choose Action',
        sections: userSections,
      },
    };
  }

  // Check if this is a timeframe response or query continuation (e.g. 'this week', 'this month', 'today')
  const isTimeframe = /^(?:today|yesterday|this week|last week|this month|last month|all time|last \d+ days?)$/i.test(text.trim());
  if (isTimeframe) {
    return { handled: false };
  }

  const isDomainQuery = isSalesOsDomainQuery(text);
  const isQueryPattern = isOperationalQuery(text);

  if (isDomainQuery && isQueryPattern) {
    // Valid in-scope CRM/sales query -> delegate to LangGraph Orchestrator
    return { handled: false };
  }

  if (isQueryPattern && !isDomainQuery) {
    // Question format but lacks obvious metal/sales terms -> test with LLM domain classifier
    const isLlmSalesQuery = await isOperationalQueryWithLLM(text);
    if (isLlmSalesQuery) {
      return { handled: false };
    }

    // It is an out-of-scope generic / trivia question!
    await recordSessionMessage(senderPhone, 'user', text);
    const outOfScopeReply = `*Out of Scope Request*\n\n` +
      `I am the *Enlight Metals SalesOS Assistant* dedicated exclusively to managing and supporting your metal sales operations, inquiries, customer visits, orders, payments, and complaints.\n\n` +
      `I cannot assist with general knowledge, trivia, or non-sales prompts.\n\n` +
      `*Here is the SalesOS menu to assist you with your daily activities:*\n\n` +
      userMenu;

    await recordSessionMessage(senderPhone, 'assistant', outOfScopeReply, { action_type: 'OUT_OF_SCOPE_PROMPT' });
    await startNewCatalogSession(senderPhone, outOfScopeReply);
    return {
      handled: true,
      reply: outOfScopeReply,
      interactiveType: 'list',
      interactiveList: {
        bodyText: `I am the *Enlight Metals SalesOS Assistant*. Here is the menu to start a sales activity:`,
        buttonText: 'Choose Action',
        sections: userSections,
      },
    };
  }

  if (!isQueryPattern && text.length >= 8 && !/^(?:log|record|add|create|new|onboard|acquire|update|modify|change|set|mark|resolve|close|upadte|edit|cancel|save)\b/i.test(text)) {
    const isLlmSalesQuery = await isOperationalQueryWithLLM(text);
    if (isLlmSalesQuery) {
      return { handled: false };
    }
  }

  // ── 7.5 STAGE UPDATES IN IDLE / STALE / EMPTY STATE ──
  // Per requirement: In stale/empty state, ONLY data retrieval queries and stage updates
  // are allowed to be processed directly. All other write actions remain strictly gated.
  if (isStageUpdatePrompt(text)) {
    return await handleMidFlowStageUpdate(text, senderPhone, 'general', 'UPDATE_INQUIRY', null);
  }

  // ── 8. ALL OTHER MESSAGES OUTSIDE ACTIVE SESSION -> STRICT CATALOG GATING ──
  // Per architecture requirement:
  // Direct write logging outside an active catalog flow is disabled.
  // All write activities (Log/Update Inquiry, Order, Field Visit, Customer Acquisition, Complaint)
  // MUST strictly be initiated via Catalog Menu selection (1–10 / buttons).
  // Direct free-text input in idle state is reserved exclusively for read-only data queries.
  await recordSessionMessage(senderPhone, 'user', text);
  const gatingReply = `To start an activity, please select the relevant option from the menu below:\n\nHere is the menu to start a new activity:\n\n` + userMenu;
  await recordSessionMessage(senderPhone, 'assistant', gatingReply, { action_type: 'CATALOG_GATED_PROMPT' });
  await startNewCatalogSession(senderPhone, gatingReply);
  return {
    handled: true,
    reply: gatingReply,
    interactiveType: 'list',
    interactiveList: {
      bodyText: `Here is the menu to start a new activity:`,
      buttonText: 'Choose Action',
      sections: userSections,
    },
  };
}

module.exports = {
  CATALOG_MENU,
  MODULE_PROMPTS,
  isGreeting,
  isGreetingWithLLM,
  matchActionFromInput,
  isExplicitMenuSelection,
  validateMandatoryFields,
  buildConfirmationSummary,
  buildDuplicateCustomerResponse,
  checkCompanyWideCustomerRegistration,
  isDiscardOrCancelIntent,
  executeAction,
  handleCatalogFlow,
  isOperationalQuery,
  isSalesOsDomainQuery,
  isOutOfScopeGenericPrompt,
  isStageUpdatePrompt,
  isStageOnlyUpdate,
  detectOperationalAction,
  extractFieldsWithLLM,
  mergeDraft,
  forwardCustomerDetailsToParentDraft,
  validateOrderInquiryStage,
  checkInquiriesForUpdate,
  checkOrdersForUpdate,
  checkComplaintsForUpdate,
  isCustomerMatch,
  cleanLegalSuffixes,
  extractFollowUpDate,
  parseDDMMYYYYtoISO,
  formatDateDDMMYYYY,
  getPostActivityButtons,
  RESUME_QUERY_BUTTONS,
  restoreInterruptedFlow,
  handleMidFlowStageUpdate,
  classifyActiveSessionIntent,
  validateDraftProducts,
  resolveClarifiedProduct,
  classifyLineItemMutation,
  resolveLineItemMutationTurn,
  detectNonEditableFieldAttempt,
  fetchEditableRecordsForModule,
  formatRecordLineForModule,
  fetchAndRenderUpdateSelection,
  handleUpdateSelectionState,
  findMatchingInquiriesForPo,
  handleInquiryDocumentOcr,
  handleOrderDocumentOcr,
  CATALOG_MENU_SECTIONS,
  CONFIRMATION_BUTTONS,
  UNKNOWN_PRODUCT_BUTTONS,
  ADD_PRODUCT_CONFIRM_BUTTONS,
  extractPhotoAndGps,
  canUserUpdateVisits,
  getCatalogMenu,
  getCatalogMenuSections,
  extractVisitDetails,
  formatSelectedVisitPrompt,
  formatSelectedComplaintPrompt,
  formatSelectedRecordPrompt,
  formatVisitSelectionLine,
  formatComplaintSelectionLine,
  extractVerbatimNotes,
  detectOutOfScopeActionAttempt,
  buildResumePrompt,
  formatAttributeValue,
  extractInquiryAttributes,
  formatDetailedInquiryItemsList,
  formatSelectedInquiryPrompt,
  formatSelectedOrderPrompt,
  formatSelectedInquiryForOrderPrompt,
  recordInactiveDraft,
  getLastInactiveDraft,
  getModuleCatalogName,
  formatDraftContextLabel,
  isStaleDraftButtonAction,
  isStaleResumeNoAction,
  handleStaleDraftButton,
  handleResumeMenuButton,
  getAllowedFieldsListForAction,
  matchInquiryOption,
  getEditPromptForAction,
  scoreLineItemAgainstUpdate,
  matchLineItemUpdate,
  resolveLineItemUpdateTargets,
  pickLineItemChoice,
  pinLineUpdateToItems,
  buildLineItemChoicePrompt,
  handleLineItemChoiceReply,
  isPureOptionSelectorOnly,
  isNumericOptionSelector,
  extractThicknessTransition,
  calculateCustomerMatchPercentage,
  getMatchingAssignedCustomers,
  buildCustomerMatchValidationMessage,
  CUST_MATCH_BUTTONS,
};
