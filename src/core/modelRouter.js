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

/**
 * Invoke Gemini 3.7 Flash with automatic retry.
 */
async function invokeWithFallback(messages, tools = null, isPaidTask = false) {
  try {
    const model = getPaidHighAccuracyModel(tools);
    return await model.invoke(messages);
  } catch (err) {
    console.warn(`[ModelRouter] Primary model (${PRIMARY_MODEL}) error: ${err.message}. Retrying...`);
    const retryModel = getPaidHighAccuracyModel(tools);
    return await retryModel.invoke(messages);
  }
}

module.exports = {
  getModel,
  getPaidHighAccuracyModel,
  getLightweightModel,
  invokeWithFallback,
};
