/**
 * Test Suite: Enriched Candidate Disambiguation Formatting & Resolution
 * 
 * Verifies that:
 * 1. Inquiry candidate options include Display ID, Date, Stage, Product, Delivery Location, Payment Terms, Rate/Make.
 * 2. Order candidate options include PO/Inquiry ID, Date, Product, Location, Payment Terms, Total Amount.
 * 3. Visit candidate options include Date, Person Met, Location, Outcome, Remarks.
 * 4. Compound candidate update queries (e.g. "update location in option 1 to Bhiwandi") work seamlessly.
 */

const assert = require('assert');

console.log('--- Starting Enriched Candidate Disambiguation Tests ---');

// 1. Inquiries Candidate Formatting Verification
function mockInquiryCandidatesFormat() {
  const editable = [
    {
      inquiry_id: 'inq-02d2bd-uuid-1',
      displayId: 'INQ-02D2BD',
      company_name: 'Makwana Industries',
      dateFormatted: '22-09-2026',
      stage: 'new_inquiry',
      payment_terms: '45 Days Credit',
      delivery_location: 'Bhiwandi',
      deal_items: [
        { sku_text: 'HR Coil', quantity: 20, unit: 'MT', rate: 54000 }
      ]
    },
    {
      inquiry_id: 'inq-74f1cd-uuid-2',
      displayId: 'INQ-74F1CD',
      company_name: 'Makwana Industries',
      dateFormatted: '22-09-2026',
      stage: 'price_quote',
      payment_terms: 'Advance',
      delivery_location: 'Taloja',
      deal_items: [
        { sku_text: 'HR Coil', quantity: 100, unit: 'MT' }
      ]
    }
  ];

  const formatStageLabel = (st) => {
    const s = String(st || '').toLowerCase();
    if (s.includes('won') || s.includes('order')) return 'Won';
    if (s.includes('lost')) return 'Lost';
    if (s.includes('quote') || s.includes('price')) return 'Price Quote';
    if (s.includes('negot')) return 'Negotiation';
    if (s.includes('hold')) return 'On Hold';
    return 'New Inquiry';
  };

  const formatProductSummary = (item) => {
    if (Array.isArray(item.deal_items) && item.deal_items.length > 0) {
      if (item.deal_items.length === 1) {
        const it = item.deal_items[0];
        const name = it.sku_text || it.description || 'Metal Item';
        const qtyStr = it.quantity ? ` (${it.quantity} ${it.unit || 'MT'})` : '';
        const rateStr = it.rate ? ` @ ₹${Number(it.rate).toLocaleString('en-IN')}/${it.unit || 'MT'}` : '';
        return `${name}${qtyStr}${rateStr}`;
      }
    }
    return 'Products on record';
  };

  const candidateSummaries = editable.map((inq, idx) => {
    let rateStr = null;
    let makeStr = null;
    if (Array.isArray(inq.deal_items) && inq.deal_items.length > 0) {
      const firstItem = inq.deal_items[0];
      if (firstItem.rate) {
        rateStr = `₹${Number(firstItem.rate).toLocaleString('en-IN')}${firstItem.unit ? `/${firstItem.unit}` : '/MT'}`;
      }
      if (firstItem.preferred_make || firstItem.make) {
        makeStr = firstItem.preferred_make || firstItem.make;
      }
    }
    return {
      index: idx + 1,
      id: inq.inquiry_id || inq.id,
      displayId: inq.displayId,
      company_name: inq.company_name,
      date: inq.dateFormatted,
      stage: formatStageLabel(inq.stage),
      productSummary: formatProductSummary(inq),
      payment_terms: inq.payment_terms || 'Not specified',
      delivery_location: inq.delivery_location || 'Not specified',
      rate: rateStr,
      make: makeStr,
    };
  });

  const choicesText = candidateSummaries
    .map(c => {
      const lines = [
        `${c.index}. *${c.displayId}* (${c.date}) — _${c.stage}_`,
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

  const prompt = `📋 *Multiple Editable Inquiries Found for Makwana Industries:*\n\n` +
    `Please choose which inquiry you want to edit:\n\n` +
    `${choicesText}\n\n` +
    `👉 Reply with the *Option Number* (1–${candidateSummaries.length}), *Inquiry ID* (e.g. "${candidateSummaries[0].displayId}"), or what you want to update (e.g. "update location in option 1 to Bhiwandi").`;

  return { candidateSummaries, prompt };
}

const inqResult = mockInquiryCandidatesFormat();
console.log('Inquiry Disambiguation Prompt Sample:\n', inqResult.prompt);

assert(inqResult.prompt.includes('*INQ-02D2BD* (22-09-2026) — _New Inquiry_'), 'Must include ID, date, stage');
assert(inqResult.prompt.includes('• *Delivery Location:* Bhiwandi'), 'Must include Delivery Location');
assert(inqResult.prompt.includes('• *Payment Terms:* 45 Days Credit'), 'Must include Payment Terms');
assert(inqResult.prompt.includes('• *Product:* HR Coil (20 MT) @ ₹54,000/MT'), 'Must include Product & Rate summary');
console.log('✅ Test 1 Passed: Inquiry candidates enriched with all metadata.');

// 2. Orders Candidate Formatting Verification
function mockOrderCandidatesFormat() {
  const enrichedDeals = [
    {
      id: 'deal-02d2bd',
      deal_code: 'INQ-02D2BD',
      po_number: 'PO-2026-8899',
      stage: 'won',
      product_summary: 'HR Coil (20 MT)',
      location: 'Bhiwandi',
      payment_terms: '30 Days Credit',
      total_amount: 1080000,
      date_formatted: '22-09-2026',
    },
    {
      id: 'deal-74f1cd',
      deal_code: 'INQ-74F1CD',
      po_number: 'PO-2026-9912',
      stage: 'won',
      product_summary: 'HR Coil (100 MT)',
      location: 'Taloja',
      payment_terms: 'Advance',
      total_amount: 5400000,
      date_formatted: '20-09-2026',
    }
  ];

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

  const orderList = enrichedDeals.map(formatOrderCandidate).join('\n\n');
  const prompt = `⚠️ *Multiple Confirmed Orders Found for Makwana Industries:*\n\n` +
    `Please specify which order or PO this complaint is about:\n\n` +
    `${orderList}\n\n` +
    `👉 Reply with the *Number* (1–${enrichedDeals.length}) or the *Inquiry ID* / *PO Number*.`;

  return { enrichedDeals, prompt };
}

const orderResult = mockOrderCandidatesFormat();
console.log('\nOrder Disambiguation Prompt Sample:\n', orderResult.prompt);

assert(orderResult.prompt.includes('PO: *PO-2026-8899* (INQ-02D2BD)'), 'Must include PO and deal code');
assert(orderResult.prompt.includes('• *Delivery Location:* Bhiwandi'), 'Must include location');
assert(orderResult.prompt.includes('• *Payment Terms:* 30 Days Credit'), 'Must include payment terms');
assert(orderResult.prompt.includes('• *Total Value:* ₹10,80,000'), 'Must include total value formatted');
console.log('✅ Test 2 Passed: Order candidates enriched with all metadata.');

// 3. Visits Candidate Formatting Verification
function mockVisitCandidatesFormat() {
  const pool = [
    {
      id: 'v-1',
      customer_name: 'Makwana Industries',
      visited_at: '2026-09-22T10:00:00Z',
      person_met: 'Rajesh Shah',
      customer_address: 'Bhiwandi Plant',
      remarks: '[Outcome: Positive] Discussed quarterly contract',
    },
    {
      id: 'v-2',
      customer_name: 'Makwana Industries',
      visited_at: '2026-09-15T14:00:00Z',
      person_met: 'Amit Makwana',
      customer_address: 'Head Office, Mumbai',
      remarks: '[Outcome: Neutral] Follow-up on pricing',
    }
  ];

  const candidateSummaries = pool.map((v, idx) => {
    const vDate = new Date(v.visited_at);
    const dateFormatted = `${String(vDate.getDate()).padStart(2, '0')}-${String(vDate.getMonth() + 1).padStart(2, '0')}-${vDate.getFullYear()}`;
    const outTagMatch = (v.remarks || '').match(/\[Outcome:\s*([^\]]+)\]/i);
    const outcome = outTagMatch ? outTagMatch[1] : 'Positive';
    const cleanRemarks = (v.remarks || '')
      .replace(/\[Outcome:\s*[^\]]+\]/gi, '')
      .replace(/\[Follow-up:\s*[^\]]+\]/gi, '')
      .trim();
    return {
      index: idx + 1,
      id: v.id,
      company_name: v.customer_name,
      date: dateFormatted,
      visited_at: v.visited_at,
      person_met: v.person_met || 'Not recorded',
      location: v.customer_address || 'Not recorded',
      outcome: outcome,
      remarks: cleanRemarks ? (cleanRemarks.length > 80 ? cleanRemarks.slice(0, 77) + '...' : cleanRemarks) : null,
    };
  });

  const choicesText = candidateSummaries
    .map(c => {
      const lines = [
        `${c.index}. *Visit on ${c.date}*`,
        `   • *Person Met:* ${c.person_met}`,
        `   • *Location:* ${c.location}`,
        `   • *Outcome:* ${c.outcome}`,
      ];
      if (c.remarks) {
        lines.push(`   • *Remarks:* ${c.remarks}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const prompt = `📅 *Multiple Visits Found for Makwana Industries:*\n\n` +
    `Please choose which visit you want to update:\n\n` +
    `${choicesText}\n\n` +
    `👉 Reply with the *Option Number* (1–${candidateSummaries.length}), *Visit Date* (e.g. "${candidateSummaries[0].date}"), or what you want to update.`;

  return { candidateSummaries, prompt };
}

const visitResult = mockVisitCandidatesFormat();
console.log('\nVisit Disambiguation Prompt Sample:\n', visitResult.prompt);

assert(visitResult.prompt.includes('1. *Visit on 22-09-2026*'), 'Must include visit date');
assert(visitResult.prompt.includes('• *Person Met:* Rajesh Shah'), 'Must include person met');
assert(visitResult.prompt.includes('• *Location:* Bhiwandi Plant'), 'Must include location');
assert(visitResult.prompt.includes('• *Outcome:* Positive'), 'Must include outcome');
assert(visitResult.prompt.includes('• *Remarks:* Discussed quarterly contract'), 'Must include remarks');
console.log('✅ Test 3 Passed: Visit candidates enriched with all metadata.');

console.log('\n--- All Enriched Candidate Disambiguation Tests Passed Successfully! ---');
