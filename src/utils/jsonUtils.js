/**
 * jsonUtils.js - Resilient JSON Parser for LLM Outputs
 *
 * Prevents SyntaxError crashes across all agent modules when LLMs
 * return JSON wrapped in markdown codeblocks, XML tags, or conversational text.
 */

function safeParseJSON(rawText, fallback = null) {
  if (!rawText || typeof rawText !== 'string') return fallback;

  const text = rawText.trim();

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // ignore
  }

  // Strip markdown codeblocks
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // ignore
  }

  // Extract first { to last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const sub = text.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(sub);
    } catch (err) {
      try {
        const sanitized = sub.replace(/'/g, '"');
        return JSON.parse(sanitized);
      } catch (err2) {
        // ignore
      }
    }
  }

  // Extract first [ to last ]
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const subArr = text.substring(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(subArr);
    } catch (err) {
      // ignore
    }
  }

  return fallback;
}

module.exports = { safeParseJSON };
