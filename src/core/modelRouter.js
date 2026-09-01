/**
 * modelRouter.js - Google Gemini Model Router
 *
 * HEAVY USE CASES (Vision/OCR, Multi-page PO Documents, Complex Agent Decisions):
 * - Key: process.env.GEMINI_PAID_API_KEY || process.env.GEMINI_API_KEY
 * - Model: gemini-2.5-flash
 *
 * NORMAL USE CASES (Intent Classification, Query Routing, Field Extractions, FAQ):
 * - Key: process.env.GEMINI_PAID_API_KEY || process.env.GEMINI_API_KEY
 * - Model: gemini-3.1-flash-lite
 */

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const GEMINI_API_KEY =
  process.env.GEMINI_PAID_API_KEY ||
  process.env.GEMINI_API_KEY;

/**
 * Heavy use case model for Image Processing, OCR, PDFs, & Complex Reasoning.
 * Powered by gemini-2.5-flash.
 */
function getPaidHighAccuracyModel(tools = null) {
  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: GEMINI_API_KEY,
    temperature: 0.1,
    maxRetries: 2,
  });

  return tools ? model.bindTools(tools) : model;
}

/**
 * Normal use case model for Simple Tasks (Intent routing, greetings, query classification, standard extractions).
 * Powered by gemini-3.1-flash-lite.
 */
function getLightweightModel(tools = null) {
  const model = new ChatGoogleGenerativeAI({
    model: 'gemini-3.1-flash-lite',
    apiKey: GEMINI_API_KEY,
    temperature: 0.1,
    maxRetries: 2,
  });

  return tools ? model.bindTools(tools) : model;
}

function getModel(tools = null) {
  return getLightweightModel(tools);
}

/**
 * Invoke model with automatic routing:
 * - If isPaidTask === true (heavy tasks: images, OCR, PDFs, complex reasoning), uses gemini-2.5-flash
 * - If isPaidTask === false (normal tasks: intent classification, query routing), uses gemini-3.1-flash-lite
 */
async function invokeWithFallback(messages, tools = null, isPaidTask = false) {
  if (isPaidTask) {
    try {
      const heavyModel = getPaidHighAccuracyModel(tools);
      return await heavyModel.invoke(messages);
    } catch (err) {
      console.warn(`[ModelRouter] Heavy model (gemini-2.5-flash) invocation error: ${err.message}. Retrying...`);
      const retryModel = getPaidHighAccuracyModel(tools);
      return await retryModel.invoke(messages);
    }
  }

  // Normal use case (gemini-3.1-flash-lite) with fallback to gemini-2.5-flash
  try {
    const normalModel = getLightweightModel(tools);
    return await normalModel.invoke(messages);
  } catch (err) {
    console.warn(`[ModelRouter] Normal model (gemini-3.1-flash-lite) warning: ${err.message}. Falling back to gemini-2.5-flash.`);
    const fallbackModel = getPaidHighAccuracyModel(tools);
    return await fallbackModel.invoke(messages);
  }
}

module.exports = {
  getModel,
  getPaidHighAccuracyModel,
  getLightweightModel,
  invokeWithFallback,
};
