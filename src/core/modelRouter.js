/**
 * modelRouter.js - Google Gemini 3.7 Flash Model Router
 *
 * UNIFIED HIGH-ACCURACY MODEL CONFIGURATION:
 * - Model: gemini-3.7-flash
 * - Key: process.env.GEMINI_PAID_API_KEY || process.env.GEMINI_API_KEY
 * - All tasks (Vision/OCR, Multi-page PO Documents, Agent Decisions, Intent Classification, Query Routing, Extractions)
 */

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const GEMINI_API_KEY =
  process.env.GEMINI_PAID_API_KEY ||
  process.env.GEMINI_API_KEY;

const PRIMARY_MODEL = 'gemini-3.7-flash';

/**
 * High-accuracy Gemini 3.7 Flash model for Image Processing, OCR, PDFs, & Complex Reasoning.
 */
function getPaidHighAccuracyModel(tools = null) {
  const model = new ChatGoogleGenerativeAI({
    model: PRIMARY_MODEL,
    apiKey: GEMINI_API_KEY,
    temperature: 0.1,
    maxRetries: 2,
  });

  return tools ? model.bindTools(tools) : model;
}

/**
 * Standard Gemini 3.7 Flash model for Intent routing, greetings, query classification, and line item extractions.
 */
function getLightweightModel(tools = null) {
  const model = new ChatGoogleGenerativeAI({
    model: PRIMARY_MODEL,
    apiKey: GEMINI_API_KEY,
    temperature: 0.1,
    maxRetries: 2,
  });

  return tools ? model.bindTools(tools) : model;
}

function getModel(tools = null) {
  return getPaidHighAccuracyModel(tools);
}

const FALLBACK_MODEL = 'gemini-2.5-flash';

/**
 * Invoke Gemini with automatic model fallback (gemini-3.7-flash -> gemini-2.5-flash).
 */
async function invokeWithFallback(messages, tools = null, isPaidTask = false) {
  try {
    const model = getPaidHighAccuracyModel(tools);
    return await model.invoke(messages);
  } catch (err) {
    console.warn(`[ModelRouter] Primary model (${PRIMARY_MODEL}) error: ${err.message}. Retrying with fallback (${FALLBACK_MODEL})...`);
    try {
      const fallbackModel = new ChatGoogleGenerativeAI({
        model: FALLBACK_MODEL,
        apiKey: GEMINI_API_KEY,
        temperature: 0.1,
        maxRetries: 2,
      });
      const boundFallback = tools ? fallbackModel.bindTools(tools) : fallbackModel;
      return await boundFallback.invoke(messages);
    } catch (fallbackErr) {
      console.warn(`[ModelRouter] Fallback model (${FALLBACK_MODEL}) error: ${fallbackErr.message}. Retrying with gemini-2.5-flash-lite...`);
      const liteModel = new ChatGoogleGenerativeAI({
        model: 'gemini-2.5-flash-lite',
        apiKey: GEMINI_API_KEY,
        temperature: 0.1,
        maxRetries: 2,
      });
      const boundLite = tools ? liteModel.bindTools(tools) : liteModel;
      return await boundLite.invoke(messages);
    }
  }
}

module.exports = {
  getModel,
  getPaidHighAccuracyModel,
  getLightweightModel,
  invokeWithFallback,
};
