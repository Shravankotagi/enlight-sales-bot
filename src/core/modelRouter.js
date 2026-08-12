/**
 * modelRouter.js — Smart Dual-Tier Google Gemini Model Router
 *
 * TIER 1 (PAID API KEY - High Accuracy & Vision/OCR):
 * - Used exclusively for:
 *   1. Image Processing & OCR (PO photos, RFQs, handwritten metal notes, visiting cards)
 *   2. PDF / Multi-Page Document PO extraction
 *   3. Complex Reasoning & Multi-step Agent decisions
 * - Key: process.env.GEMINI_PAID_API_KEY
 * - Model: gemini-2.5-flash (Highest precision vision & reasoning model)
 *
 * TIER 2 (STANDARD API KEY - Simple & High Volume):
 * - Used for: Simple Intent Classification, Query Type Routing, Basic FAQ responses
 * - Key: process.env.GEMINI_API_KEY
 * - Model: gemini-3.1-flash-lite (Fast & cost-effective)
 */

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const PAID_KEY =
  process.env.GEMINI_PAID_API_KEY ||
  process.env.GEMINI_API_KEY;

const STANDARD_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
].filter(Boolean);

let roundRobinIdx = 0;

function getStandardGeminiKey() {
  if (STANDARD_KEYS.length === 0) return process.env.GEMINI_API_KEY || PAID_KEY;
  const key = STANDARD_KEYS[roundRobinIdx % STANDARD_KEYS.length];
  roundRobinIdx++;
  return key;
}

/**
 * High-Accuracy Model for Image Processing, OCR, PDFs, & Complex Reasoning.
 * Powered strictly by GEMINI_PAID_API_KEY.
 */
function getPaidHighAccuracyModel(tools = null) {
  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: PAID_KEY,
    temperature: 0.1,
    maxRetries: 2,
  });

  return tools ? model.bindTools(tools) : model;
}

/**
 * Lightweight Model for Simple Tasks (Intent routing, greetings, simple queries).
 * Powered by standard GEMINI_API_KEY with gemini-3.1-flash-lite.
 */
function getLightweightModel(tools = null) {
  const key = getStandardGeminiKey();
  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-3.1-flash-lite',
    apiKey: key,
    temperature: 0.1,
    maxRetries: 1,
  });

  return tools ? model.bindTools(tools) : model;
}

function getModel(tools = null) {
  return getLightweightModel(tools);
}

/**
 * Invoke model with automatic routing:
 * - If isPaidTask === true (images, OCR, PDFs, complex reasoning), uses GEMINI_PAID_API_KEY (gemini-2.5-flash)
 * - If isPaidTask === false (intent classification, query routing), uses standard GEMINI_API_KEY (gemini-3.1-flash-lite)
 */
async function invokeWithFallback(messages, tools = null, isPaidTask = false) {
  if (isPaidTask) {
    try {
      const paidModel = getPaidHighAccuracyModel(tools);
      return await paidModel.invoke(messages);
    } catch (paidErr) {
      console.warn(`[ModelRouter] Paid model invocation warning: ${paidErr.message}. Retrying...`);
      const retryModel = getPaidHighAccuracyModel(tools);
      return await retryModel.invoke(messages);
    }
  }

  // Standard lightweight task
  try {
    const lightModel = getLightweightModel(tools);
    return await lightModel.invoke(messages);
  } catch (err) {
    console.warn(`[ModelRouter] Lightweight model warning: ${err.message}. Falling back to paid key.`);
    const fallbackPaid = getPaidHighAccuracyModel(tools);
    return await fallbackPaid.invoke(messages);
  }
}

module.exports = {
  getModel,
  getPaidHighAccuracyModel,
  getLightweightModel,
  invokeWithFallback,
};
