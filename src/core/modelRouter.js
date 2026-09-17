/**
 * modelRouter.js - Google Gemini Model Router
 *
 * UNIFIED HIGH-ACCURACY MODEL CONFIGURATION:
 * - Primary Model: gemini-3.7-flash
 * - Secondary Model: gemini-3.0-flash
 * - Tertiary Model: gemini-2.5-flash
 * - Key: process.env.GEMINI_PAID_API_KEY || process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2
 */

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const GEMINI_API_KEY =
  process.env.GEMINI_PAID_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GEMINI_API_KEY_1 ||
  process.env.GEMINI_API_KEY_2;

const PRIMARY_MODEL = process.env.GEMINI_PRIMARY_MODEL || 'gemini-3.7-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.0-flash';
const LITE_FALLBACK_MODEL = process.env.GEMINI_LITE_MODEL || 'gemini-2.5-flash';

/**
 * High-accuracy Gemini model for Image Processing, OCR, PDFs, & Complex Reasoning.
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
 * Standard Gemini model for Intent routing, greetings, query classification, and line item extractions.
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
 * Invoke Gemini with automatic model fallback:
 * 1. gemini-3.7-flash (Primary)
 * 2. gemini-3.0-flash (Secondary)
 * 3. gemini-2.5-flash (Tertiary)
 * 4. gemini-2.0-flash (Quaternary)
 * 5. gemini-1.5-flash (Final resilient fallback)
 */
async function invokeWithFallback(messages, tools = null, isPaidTask = false) {
  const cascadeModels = [
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    LITE_FALLBACK_MODEL,
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ];

  const uniqueModels = Array.from(new Set(cascadeModels.filter(Boolean)));
  let lastError = null;

  for (let i = 0; i < uniqueModels.length; i++) {
    const currentModelName = uniqueModels[i];
    try {
      const model = new ChatGoogleGenerativeAI({
        model: currentModelName,
        apiKey: GEMINI_API_KEY,
        temperature: 0.1,
        maxRetries: 0,
      });
      const bound = tools ? model.bindTools(tools) : model;
      return await bound.invoke(messages);
    } catch (err) {
      lastError = err;
      const nextModel = uniqueModels[i + 1];
      if (nextModel) {
        console.warn(`[ModelRouter] Model (${currentModelName}) error: ${err.message}. Retrying with fallback (${nextModel})...`);
      }
    }
  }

  throw lastError || new Error('All Gemini models in fallback cascade failed.');
}

module.exports = {
  getModel,
  getPaidHighAccuracyModel,
  getLightweightModel,
  invokeWithFallback,
};
