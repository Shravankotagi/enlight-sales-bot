require('dotenv').config();
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');

// Mock formatForWeb matching webChat.js
function formatForWeb(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;

  // 1. Remove all emojis (strict zero emoji rule)
  out = out.replace(
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{200D}\u{FE0F}]/gu,
    ''
  );
  out = out.replace(/[ \t]{2,}/g, ' ');

  // 2. Convert mid-sentence / inline Unicode bullets to separate line items
  out = out.replace(/([^\n])\s*[•⁃◦▪▫►◆]\s+/g, '$1\n- ');

  // 3. Normalize list bullets at start of line (•, ⁃, ◦, ▪, ▫, *, +, –, —) to standard Markdown "- "
  out = out.replace(/^(\s*)[•⁃◦▪▫►◆–—*+]\s+/gm, '$1- ');

  // 4. Normalize WhatsApp-style bold labels in list items ("- *Field:*") to standard Markdown ("- **Field:**")
  out = out.replace(/^([ \t]*-\s*)\*([^*:\n]+:)\*/gm, '$1**$2**');

  // 5. Normalize standalone WhatsApp-style bold title lines ("*Title*") to Markdown bold ("**Title**")
  out = out.replace(/^([ \t]*)\*([^*\n]+)\*([ \t]*)$/gm, '$1**$2**$3');

  // 6. Ensure blank line before list blocks if preceded by regular text
  out = out.replace(/([^\n\-\*\+\d])\n([ \t]*[-*+]\s+)/g, '$1\n\n$2');
  out = out.replace(/([^\n\-\*\+\d])\n([ \t]*\d+\.\s+)/g, '$1\n\n$2');

  // 7. Ensure blank line after list blocks if followed by regular paragraph
  out = out.replace(/(\n[ \t]*[-*+]\s+[^\n]+)\n([^\n\s\-*+\d])/g, '$1\n\n$2');
  out = out.replace(/(\n[ \t]*\d+\.\s+[^\n]+)\n([^\n\s\-*+\d])/g, '$1\n\n$2');

  // 8. Clean up 3+ blank lines to 2
  out = out.replace(/\n{3,}/g, '\n\n');

  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

async function runTests() {
  console.log('--- TEST 1: User Screenshot Inline Bullet Formatting ---');
  const rawScreenshotText = `Log Customer Complaint
Please provide the following details:
• Customer / Company: * • Linked Order / Ref: (optional, auto-linked if customer has active orders) • Product / Material: (e.g. 12 MT MS angle) • Complaint Type: (optional: Quality Defect / Physical Damage / Quantity Shortage / Delivery Delay / Billing Mismatch / Specification Mismatch / Other) • Description: * (e.g. 12 MT MS angle with bending damage and edge cuts) • Corrective Action: (optional)
Example: "Shree Balaji Pre-Engineered Buildings received 12 MT MS angle with bending damage and edge cuts during truck unloading"`;

  const formatted1 = formatForWeb(rawScreenshotText);
  console.log('Formatted Output 1:\n' + formatted1);
  assert(formatted1.includes('- Customer / Company: *'), 'Must contain "- Customer / Company: *"');
  assert(formatted1.includes('- Linked Order / Ref:'), 'Must contain "- Linked Order / Ref:"');
  assert(formatted1.includes('- Product / Material:'), 'Must contain "- Product / Material:"');
  assert(formatted1.includes('- Description: *'), 'Must contain "- Description: *"');
  console.log('✅ TEST 1 PASSED!\n');

  console.log('--- TEST 2: catalogFlow handleCatalogFlow("8") for Complaint ---');
  const catalogRes = await handleCatalogFlow('8', '9619226169');
  console.log('Catalog Flow Raw Reply:\n' + catalogRes.reply);
  const formatted2 = formatForWeb(catalogRes.reply);
  console.log('Formatted Output 2:\n' + formatted2);
  assert(formatted2.includes('- **Customer / Company:** *'), 'Must contain standard markdown "- **Customer / Company:** *"');
  assert(formatted2.includes('- **Product / Material:**'), 'Must contain standard markdown "- **Product / Material:**"');
  assert(formatted2.includes('- **Description:** *'), 'Must contain standard markdown "- **Description:** *"');
  console.log('✅ TEST 2 PASSED!\n');

  console.log('--- TEST 3: catalogFlow Menu ("menu") ---');
  const menuRes = await handleCatalogFlow('menu', '9619226169');
  const formatted3 = formatForWeb(menuRes.reply);
  console.log('Formatted Menu Output:\n' + formatted3);
  assert(formatted3.includes('1. **Log New Inquiry**'), 'Must contain numbered markdown item "1. **Log New Inquiry**"');
  assert(formatted3.includes('8. **Log Customer Complaint**'), 'Must contain numbered markdown item "8. **Log Customer Complaint**"');
  console.log('✅ TEST 3 PASSED!\n');

  console.log('ALL TESTS PASSED SUCCESSFULLY! 🎉');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
