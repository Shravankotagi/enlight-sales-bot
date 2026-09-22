/**
 * Dedicated Knowledge Base Retrieval Service for Enlight Metals Sales OS
 *
 * Architecture:
 * Tier 1: Vector similarity search on admin-uploaded documents (kb_chunks + kb_documents) via match_kb_chunks RPC with RBAC.
 * Tier 2: Text-based search on kb_chunks / kb_documents with RBAC filtering.
 * Tier 3: Backward-compatible search on legacy knowledge_base table.
 * Tier 4: Practical Enlight Metals domain-specific operational fallbacks (pricing, MOQ, credit terms, MTC quality, rejections).
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Derives allowed visibility roles based on caller context.
 */
function getAllowedRoles(callerRole) {
  const r = String(callerRole || 'salesperson').toLowerCase();
  if (r.includes('admin')) {
    return ['all', 'salesperson', 'manager', 'manager_plus', 'admin', 'admin_only'];
  }
  if (r.includes('manager')) {
    return ['all', 'salesperson', 'manager', 'manager_plus'];
  }
  return ['all', 'salesperson'];
}

/**
 * Generates a 768-dimension vector embedding using Gemini embedding model.
 */
async function generateQueryEmbedding(text) {
  const apiKey =
    process.env.GEMINI_PAID_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY_1 ||
    process.env.GEMINI_API_KEY_2;

  if (!apiKey) {
    throw new Error('Gemini API key is not configured for vector embeddings');
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    const result = await model.embedContent(text);
    const raw = result?.embedding?.values || [];
    return raw.length > 768 ? raw.slice(0, 768) : raw;
  } catch (err) {
    // Fallback: check if @langchain/google-genai can embed
    try {
      const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
      const embeddings = new GoogleGenerativeAIEmbeddings({
        model: 'gemini-embedding-001',
        apiKey: apiKey,
      });
      const raw = await embeddings.embedQuery(text);
      return raw.length > 768 ? raw.slice(0, 768) : raw;
    } catch (fallbackErr) {
      console.warn('[KbRetrievalService] Vector embedding failed:', fallbackErr.message);
      return null;
    }
  }
}

/**
 * Practical Enlight Metals Sales Operations Fallback Standards.
 * Realistic, domain-specific SOP guidance when no uploaded document exists.
 */
const PRACTICAL_SOP_FALLBACKS = {
  pricing_and_discounts: {
    keywords: ['price', 'pricing', 'discount', 'rebate', 'margin', 'rate', 'validity', 'quote', 'quotation', 'per mt'],
    title: 'Commercial Pricing & Discount SOP',
    content:
      'Standard Enlight Metals Commercial Policy: Steel prices (HR/CR coils, TMT, structural, plates) are tied to daily mill and mandi market parity. Standard quotes remain valid for the same business day only. Any volume discount, rebate, or price concession exceeding standard price-list margins requires explicit Sales Manager or Commercial Head approval prior to issuing a formal Proforma Invoice.',
  },
  moq_and_logistics: {
    keywords: ['moq', 'minimum order', 'truckload', 'ftl', 'delivery', 'transport', 'freight', 'dispatch', 'loading', 'ex-godown', 'for destination', 'logistics', 'vehicle'],
    title: 'Order Quantity & Logistics SOP',
    content:
      'Standard Enlight Metals Logistics Policy: Direct primary mill dispatches require Full Truckload (FTL) ~25-30 MT. Stockyard and godown dispatches adhere to standard packaging bundles/coils (typically 3-5 MT per item/grade). Standard delivery terms are Ex-Godown / Ex-Mill unless freight-paid FOR destination is formally quoted and confirmed.',
  },
  payment_and_credit: {
    keywords: ['payment', 'credit', 'advance', 'pdc', 'lc', 'letter of credit', 'terms', 'overdue', 'outstanding', 'credit limit', 'bank guarantee'],
    title: 'Payment Terms & Credit Control SOP',
    content:
      'Standard Enlight Metals Credit Policy: Default terms are 100% advance against Proforma Invoice or confirmed at-sight Letter of Credit (LC) prior to loading. Any credit period (15/30/45 days) or unsecured credit limit requires formal KYC, financial vetting, and written signoff from the Credit Committee / Finance Director.',
  },
  quality_and_rejections: {
    keywords: ['mtc', 'tc', 'test cert', 'certificate', 'quality', 'grade', 'rejection', 'defect', 'damage', 'tolerance', 'is 2062', 'is 1786', 'astm', 'spec '],
    title: 'Quality Verification & Claims SOP',
    content:
      'Standard Enlight Metals Quality SOP: All consignments are dispatched with authentic Mill Test Certificates (MTC) conforming to IS 2062 / IS 1786 / ASTM standards matching batch heat numbers. Any claims regarding visual defects, dimensional tolerances, or weight discrepancies must be lodged within 72 hours of delivery with weighbridge slips and photographic evidence before material is processed or cut.',
  },
  general_operations: {
    keywords: [],
    title: 'Standard Sales Operations Guidelines',
    content:
      'Enlight Metals Sales Operations Reference: No specific custom uploaded documentation was found for this query in the Knowledge Base. Standard sales guidelines and daily price confirmation apply. For unlisted specifications, custom grades, or non-standard commercial terms, please consult your Sales Manager or Operations Lead, or upload the official SOP via the Knowledge Base portal in the dashboard.',
  },
};

/**
 * Matches a query against practical Enlight Metals operational fallbacks.
 */
function getPracticalDomainFallback(queryText) {
  const lowerQ = (queryText || '').toLowerCase();
  for (const [key, fallback] of Object.entries(PRACTICAL_SOP_FALLBACKS)) {
    if (key === 'general_operations') continue;
    if (fallback.keywords.some((kw) => {
      if (kw.length <= 3) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        return regex.test(lowerQ);
      }
      return lowerQ.includes(kw);
    })) {
      return fallback;
    }
  }
  return PRACTICAL_SOP_FALLBACKS.general_operations;
}

/**
 * Searches the Knowledge Base using a non-destructive 4-tier waterfall:
 * 1. Admin Vector Search (kb_chunks + match_kb_chunks RPC with RBAC)
 * 2. Admin Document Text Search (kb_chunks / kb_documents with RBAC)
 * 3. Legacy knowledge_base table ILIKE search
 * 4. Practical Enlight Metals domain-specific SOP fallbacks
 */
async function searchKnowledgeBase(queryText, callerContext = {}, supabaseAdmin) {
  const cleanQuery = (queryText || '').trim();
  if (!cleanQuery) {
    return {
      source: 'none',
      query: cleanQuery,
      results_found: 0,
      knowledge_snippet: 'Query parameter is required for knowledge base search.',
      chunks: [],
    };
  }

  const role = callerContext.role || 'salesperson';
  const allowedRoles = getAllowedRoles(role);

  // ─── TIER 1: Vector Search on kb_chunks via match_kb_chunks RPC ───────────────
  try {
    const queryEmbedding = await generateQueryEmbedding(cleanQuery);
    if (queryEmbedding && supabaseAdmin) {
      let { data: chunks, error: rpcErr } = await supabaseAdmin.rpc('match_kb_chunks', {
        query_embedding: queryEmbedding,
        match_count: 4,
        allowed_roles: allowedRoles,
      });

      // Fallback: try stringified array if vector cast needed
      if (rpcErr && rpcErr.message && rpcErr.message.includes('type')) {
        const res2 = await supabaseAdmin.rpc('match_kb_chunks', {
          query_embedding: JSON.stringify(queryEmbedding),
          match_count: 4,
          allowed_roles: allowedRoles,
        });
        chunks = res2.data;
        rpcErr = res2.error;
      }

      if (!rpcErr && chunks && chunks.length > 0) {
        // Filter out very low similarity matches if score available
        const validChunks = chunks.filter((c) => c.similarity === undefined || c.similarity >= 0.35);
        if (validChunks.length > 0) {
          const formattedChunks = validChunks.map((c) => ({
            id: c.id,
            doc_id: c.doc_id,
            title: c.title || 'Company Policy Document',
            visibility_role: c.visibility_role || 'all',
            snippet: (c.content || '').trim(),
            similarity: c.similarity || null,
          }));

          const combinedSnippet = formattedChunks
            .map((c, idx) => `[Source: ${c.title}]\n${c.snippet}`)
            .join('\n\n---\n\n');

          return {
            source: 'admin_vector_kb',
            query: cleanQuery,
            results_found: formattedChunks.length,
            knowledge_snippet: combinedSnippet,
            chunks: formattedChunks,
          };
        }
      }
    }
  } catch (vectorErr) {
    console.warn('[KbRetrievalService] Tier 1 Vector Search encountered error, progressing to text search:', vectorErr.message);
  }

  // ─── TIER 2: Text Search on kb_chunks / kb_documents with RBAC ───────────────
  try {
    if (supabaseAdmin) {
      const { data: textChunks, error: textErr } = await supabaseAdmin
        .from('kb_chunks')
        .select('id, content, metadata, doc_id, kb_documents!inner(title, visibility_role)')
        .ilike('content', `%${cleanQuery}%`)
        .in('kb_documents.visibility_role', allowedRoles)
        .limit(3);

      if (!textErr && textChunks && textChunks.length > 0) {
        const formattedChunks = textChunks.map((c) => ({
          id: c.id,
          doc_id: c.doc_id,
          title: c.kb_documents?.title || 'Company Policy Document',
          visibility_role: c.kb_documents?.visibility_role || 'all',
          snippet: (c.content || '').trim(),
        }));

        const combinedSnippet = formattedChunks
          .map((c) => `[Source: ${c.title}]\n${c.snippet}`)
          .join('\n\n---\n\n');

        return {
          source: 'admin_text_kb',
          query: cleanQuery,
          results_found: formattedChunks.length,
          knowledge_snippet: combinedSnippet,
          chunks: formattedChunks,
        };
      }
    }
  } catch (textErr) {
    console.warn('[KbRetrievalService] Tier 2 Text Search encountered error:', textErr.message);
  }

  // ─── TIER 3: Legacy knowledge_base table Search ──────────────────────────────
  try {
    if (supabaseAdmin) {
      const { data: legacyDocs, error: legErr } = await supabaseAdmin
        .from('knowledge_base')
        .select('id, title, content, category, tags')
        .or(`title.ilike.%${cleanQuery}%,content.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%`)
        .limit(3);

      if (!legErr && legacyDocs && legacyDocs.length > 0) {
        const formattedResults = legacyDocs.map((d) => ({
          title: d.title || 'Knowledge Base',
          category: d.category || 'General',
          snippet: (d.content || '').trim(),
        }));

        const combinedSnippet = formattedResults
          .map((d) => `[Source: ${d.title} (${d.category})]\n${d.snippet}`)
          .join('\n\n---\n\n');

        return {
          source: 'legacy_kb_table',
          query: cleanQuery,
          results_found: formattedResults.length,
          knowledge_snippet: combinedSnippet,
          results: formattedResults,
        };
      }
    }
  } catch (legacyErr) {
    console.warn('[KbRetrievalService] Tier 3 Legacy Search encountered error:', legacyErr.message);
  }

  // ─── TIER 4: Practical Enlight Metals Domain-Specific Fallback ────────────────
  const practicalFallback = getPracticalDomainFallback(cleanQuery);

  return {
    source: 'domain_sop_fallback',
    query: cleanQuery,
    results_found: 1,
    knowledge_snippet: `[Practical SOP Guidance: ${practicalFallback.title}]\n${practicalFallback.content}`,
    fallback_guidance: practicalFallback,
  };
}

module.exports = {
  searchKnowledgeBase,
  generateQueryEmbedding,
  getAllowedRoles,
  getPracticalDomainFallback,
  PRACTICAL_SOP_FALLBACKS,
};
