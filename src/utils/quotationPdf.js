const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function getCompanyLogoPath() {
  const possiblePaths = [
    path.join(process.cwd(), 'assets', 'logo.png'),
    path.join(process.cwd(), 'assets', 'logo.jpg'),
    path.join(process.cwd(), 'bot', 'assets', 'logo.png'),
    path.join(process.cwd(), 'backend', 'assets', 'logo.png'),
    path.join(__dirname, '../../assets/logo.png'),
    path.join(__dirname, '../../../assets/logo.png'),
    path.join(__dirname, '../../../backend/assets/logo.png'),
    'd:/Enlight sales/backend/assets/logo.png',
    'd:/Enlight sales/bot/assets/logo.png',
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getAssetFontPath(fontFilename) {
  const possiblePaths = [
    path.join(process.cwd(), 'assets', 'fonts', fontFilename),
    path.join(process.cwd(), 'backend', 'assets', 'fonts', fontFilename),
    path.join(__dirname, '../../assets/fonts', fontFilename),
    path.join(__dirname, '../../../assets/fonts', fontFilename),
    path.join(__dirname, '../../../backend/assets/fonts', fontFilename),
    `d:/Enlight sales/backend/assets/fonts/${fontFilename}`,
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectHsnCode(skuText = '', dimensions = '') {
  const text = `${skuText} ${dimensions}`.toLowerCase();
  if (text.includes('cr sheet') || text.includes('cold rolled')) return '72091690';
  if (text.includes('hr coil') || text.includes('hot rolled')) return '72083940';
  if (text.includes('ms plate') || text.includes('chequered') || text.includes('plate')) return '72085110';
  if (text.includes('tmt') || text.includes('bar')) return '72142090';
  if (text.includes('gi') || text.includes('galvanized')) return '72104900';
  if (text.includes('pipe') || text.includes('tube')) return '73066100';
  if (text.includes('beam') || text.includes('channel') || text.includes('angle') || text.includes('section')) return '72163100';
  return '72083940';
}

function formatIndianCurrency(num, includeDecimals = true) {
  if (num === null || num === undefined || isNaN(Number(num))) {
    return includeDecimals ? '0.00' : '0';
  }
  const n = Number(num);
  const isNegative = n < 0;
  const absNum = Math.abs(n);

  const parts = absNum.toFixed(2).split('.');
  const integerPart = parts[0];
  const decimalPart = parts[1];

  let lastThree = integerPart.substring(integerPart.length - 3);
  const otherNumbers = integerPart.substring(0, integerPart.length - 3);
  if (otherNumbers !== '') {
    lastThree = ',' + lastThree;
  }
  const formattedInt = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;

  const result = includeDecimals ? `${formattedInt}.${decimalPart}` : formattedInt;
  return isNegative ? `-${result}` : result;
}

function resolvePlaceOfSupply(address = '') {
  const lower = (address || '').toLowerCase();
  if (lower.includes('maharashtra') || lower.includes('pune') || lower.includes('mumbai') || lower.includes('nashik') || lower.includes('kolhapur') || lower.includes('nagpur') || lower.includes('aurangabad')) {
    return 'Maharashtra (27)';
  }
  if (lower.includes('gujarat') || lower.includes('ahmedabad') || lower.includes('surat')) return 'Gujarat (24)';
  if (lower.includes('karnataka') || lower.includes('bangalore') || lower.includes('bengaluru')) return 'Karnataka (29)';
  if (lower.includes('tamil nadu') || lower.includes('chennai')) return 'Tamil Nadu (33)';
  if (lower.includes('delhi')) return 'Delhi (07)';
  if (lower.includes('haryana') || lower.includes('gurgaon')) return 'Haryana (06)';
  if (lower.includes('uttar pradesh') || lower.includes('noida')) return 'Uttar Pradesh (09)';
  if (lower.includes('rajasthan') || lower.includes('jaipur')) return 'Rajasthan (08)';
  if (lower.includes('madhya pradesh') || lower.includes('indore')) return 'Madhya Pradesh (23)';
  if (lower.includes('west bengal') || lower.includes('kolkata')) return 'West Bengal (19)';
  if (lower.includes('telangana') || lower.includes('hyderabad')) return 'Telangana (36)';
  return 'Maharashtra (27)';
}

function cleanAddressLines(raw, company) {
  if (!raw || !raw.trim()) {
    return [company || 'Client Site', 'India'];
  }
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const cleaned = [];
  for (let part of parts) {
    if (part.toUpperCase() === (company || '').toUpperCase()) continue;
    if (company && part.toUpperCase().startsWith(company.toUpperCase())) {
      part = part.substring(company.length).trim().replace(/^[-,\s]+/, '');
    }
    if (part) cleaned.push(part);
  }
  return cleaned.length > 0 ? cleaned : [raw.trim()];
}

/**
 * Generates the official Enlight Metals Commercial Quotation PDF Buffer matching the dashboard format.
 */
function generateQuotationPdfBuffer(qRefNum, customerName, details = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Invoice - ${qRefNum}`,
          Author: 'Enlight Metals Private Limited',
          Subject: `Invoice for ${customerName}`,
        },
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });
      doc.on('error', (err) => reject(err));

      const notoSansPath = getAssetFontPath('NotoSans-Regular.ttf');
      const notoSansBoldPath = getAssetFontPath('NotoSans-Bold.ttf');
      let fontRegular = 'Helvetica';
      let fontBold = 'Helvetica-Bold';

      if (notoSansPath && notoSansBoldPath && fs.existsSync(notoSansPath) && fs.existsSync(notoSansBoldPath)) {
        try {
          doc.registerFont('NotoSans', notoSansPath);
          doc.registerFont('NotoSans-Bold', notoSansBoldPath);
          fontRegular = 'NotoSans';
          fontBold = 'NotoSans-Bold';
        } catch (fErr) {
          console.warn('Error registering NotoSans fonts in bot:', fErr.message);
        }
      }
      doc.font(fontRegular);

      const leftX = 40;
      const rightEdge = 555.28;
      const contentWidth = rightEdge - leftX;

      const todayDate = details.poDate || details.orderDate || new Date().toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });

      const salesperson = details.salespersonName || details.salesperson_name || details.salesperson || 'Sales Team';
      const compName = (details.companyName || customerName || 'Valued Customer').toUpperCase();
      const rawAddress = (details.deliveryLocation || details.delivery_location || details.customerAddress || details.address || '').trim();

      const billToAddress = (details.customerAddress || details.address || rawAddress).trim();
      const shipToAddress = (details.deliveryLocation || details.delivery_location || details.customerAddress || rawAddress).trim();

      const billToLines = cleanAddressLines(billToAddress, compName);
      const shipToLines = cleanAddressLines(shipToAddress, compName);
      const customerGstin = details.customerGstin || details.customer_gst || details.gstin || '';
      const placeOfSupply = resolvePlaceOfSupply(rawAddress);
      const paymentTerms = details.paymentTerms || details.payment_terms || '30 Days Credit';

      // ================= PAGE 1 =================
      const logoPath = getCompanyLogoPath();
      if (logoPath && fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, leftX, 40, { width: 140 });
        } catch {
          doc.fillColor('#0F172A').font(fontBold).fontSize(16).text('ENLIGHT METALS', leftX, 40);
        }
      } else {
        doc.fillColor('#0F172A').font(fontBold).fontSize(16).text('ENLIGHT METALS', leftX, 40);
      }

      let leftHeaderY = 86;
      doc.fillColor('#0F172A').font(fontBold).fontSize(9.5).text('Enlight Metals Private Limited', leftX, leftHeaderY);
      leftHeaderY += 14;

      doc.fillColor('#475569').font(fontRegular).fontSize(8);
      doc.text('606 Clover Hills Plaza', leftX, leftHeaderY);
      leftHeaderY += 12;
      doc.text('NIBM Road', leftX, leftHeaderY);
      leftHeaderY += 12;
      doc.text('Pune Maharashtra 411048', leftX, leftHeaderY);
      leftHeaderY += 12;
      doc.text('India', leftX, leftHeaderY);
      leftHeaderY += 12;

      doc.fillColor('#334155').font(fontRegular).fontSize(8).text('GSTIN 27AAICE5263E1ZN', leftX, leftHeaderY);
      leftHeaderY += 12;

      doc.fillColor('#475569').font(fontRegular).fontSize(8);
      doc.text('accounts@enlightmetals.com', leftX, leftHeaderY);
      leftHeaderY += 12;
      doc.text('https://enlightmetals.com/', leftX, leftHeaderY);
      leftHeaderY += 12;

      // 2. Bill To, Ship To & Supply Section (Left) / Order Date & Salesperson (Right)
      let currY = Math.max(leftHeaderY + 22, 205);

      // Bill To Block
      doc.fillColor('#1E293B').font(fontBold).fontSize(9).text('Bill To', leftX, currY);
      currY += 13;
      doc.fillColor('#0F172A').font(fontBold).fontSize(9).text(compName, leftX, currY);
      currY += 13;
      doc.fillColor('#475569').font(fontRegular).fontSize(8);
      for (const line of billToLines) {
        doc.text(line, leftX, currY);
        currY += 11.5;
      }
      if (customerGstin) {
        doc.text(`GSTIN ${customerGstin}`, leftX, currY);
        currY += 11.5;
      }

      currY += 12;

      // Ship To Block
      doc.fillColor('#1E293B').font(fontBold).fontSize(9).text('Ship To', leftX, currY);
      currY += 13;
      doc.fillColor('#0F172A').font(fontBold).fontSize(9).text(compName, leftX, currY);
      currY += 13;
      doc.fillColor('#475569').font(fontRegular).fontSize(8);
      for (const line of shipToLines) {
        doc.text(line, leftX, currY);
        currY += 11.5;
      }

      currY += 10;

      doc.fillColor('#1E293B').font(fontBold).fontSize(8.5).text('Place Of Supply: ', leftX, currY, { continued: true })
        .font(fontRegular).fillColor('#475569').text(placeOfSupply);
      currY += 16;

      // Right Column: Order Date & Sales Person
      const rightBoxX = 395;
      const metaRightY = currY - 34;
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Order Date :', rightBoxX, metaRightY, { width: 75 });
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(todayDate, rightBoxX + 75, metaRightY, {
        width: 85,
        align: 'right',
      });

      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Sales person :', rightBoxX, metaRightY + 16, { width: 75 });
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(salesperson, rightBoxX + 75, metaRightY + 16, {
        width: 85,
        align: 'right',
      });

      // 3. Line Items Table
      const rawLineItems = Array.isArray(details.lineItems) && details.lineItems.length > 0
        ? details.lineItems
        : Array.isArray(details.line_items) && details.line_items.length > 0
          ? details.line_items
          : [
              {
                sku_text: details.productType || 'HR - COIL / SHEET',
                dimensions: details.dimensions || details.thickness || undefined,
                quantity: Number(details.quantityTons || details.quantity || 0),
                unit: 'MT',
                rate: Number(details.unitPrice || details.rate || 0),
                amount: Number(details.totalAmount || details.amount || 0),
              },
            ];

      const lineItems = rawLineItems.map(item => ({
        sku_text: (item.sku_text || item.description || item.productType || 'HR - COIL / SHEET').toUpperCase(),
        dimensions: item.dimensions || undefined,
        hsn_code: item.hsn_code || item.hsn || detectHsnCode(item.sku_text || item.description || '', item.dimensions),
        quantity: Number(item.quantity || 0),
        unit: item.unit || 'MT',
        rate: Number(item.rate || item.unitPrice || 0),
        amount: Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || item.unitPrice || 0))),
      }));

      const computedSubtotal = lineItems.reduce((s, i) => s + (Number(i.amount) || 0), 0) || Number(details.totalAmount || 0);
      const totalTonnageMt = lineItems.reduce((s, i) => s + (i.unit === 'MT' ? i.quantity : 0), 0);
      const formattedTonnage = totalTonnageMt > 0 ? `${formatIndianCurrency(totalTonnageMt, false)} MT` : `${lineItems.length} items`;

      const cgstVal = Math.round(computedSubtotal * 0.09 * 100) / 100;
      const sgstVal = Math.round(computedSubtotal * 0.09 * 100) / 100;
      const exactTot = computedSubtotal + cgstVal + sgstVal;
      const grandTot = Math.round(exactTot);
      const roundingVal = Math.round((grandTot - exactTot) * 100) / 100;

      const tableY = currY + 14;
      doc.rect(leftX, tableY, contentWidth, 24).fill('#525E6F');
      doc.fillColor('#FFFFFF').font(fontBold).fontSize(8.5);
      doc.text('#', leftX, tableY + 7.5, { width: 26, align: 'center' });
      doc.text('Item & Description', 70, tableY + 7.5, { width: 205 });
      doc.text('HSN/SAC', 278, tableY + 7.5, { width: 62, align: 'center' });
      doc.text('Qty', 342, tableY + 7.5, { width: 68, align: 'right' });
      doc.text('Rate', 412, tableY + 7.5, { width: 65, align: 'right' });
      doc.text('Amount', 479, tableY + 7.5, { width: 76.28, align: 'right' });

      let rowY = tableY + 24;
      lineItems.forEach((item, idx) => {
        doc.font(fontBold).fontSize(8.5);
        const skuH = doc.heightOfString(item.sku_text, { width: 205 });
        const dimH = item.dimensions
          ? doc.font(fontRegular).fontSize(7.5).heightOfString(item.dimensions, { width: 205 }) + 3
          : 0;
        const rowH = Math.max(34, skuH + dimH + 18);

        doc.rect(leftX, rowY, contentWidth, rowH).fill('#FFFFFF');

        // Index
        doc.fillColor('#64748B').font(fontRegular).fontSize(8.5).text(String(idx + 1), leftX, rowY + 9, {
          width: 26,
          align: 'center',
        });

        // SKU title
        doc.fillColor('#0F172A').font(fontBold).fontSize(8.5).text(item.sku_text, 70, rowY + 9, { width: 205 });

        // Dimensions
        if (item.dimensions) {
          doc.fillColor('#64748B').font(fontRegular).fontSize(7.5).text(item.dimensions, 70, rowY + 9 + skuH + 3, { width: 205 });
        }

        // HSN/SAC
        doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text(item.hsn_code, 278, rowY + 9, {
          width: 62,
          align: 'center',
        });

        // Qty
        doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(
          `${formatIndianCurrency(item.quantity, false)} ${item.unit || 'MT'}`,
          342,
          rowY + 9,
          { width: 68, align: 'right' }
        );

        // Rate
        doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text(
          formatIndianCurrency(item.rate, true),
          412,
          rowY + 9,
          { width: 65, align: 'right' }
        );

        // Amount
        doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(
          formatIndianCurrency(item.amount, true),
          479,
          rowY + 9,
          { width: 76.28, align: 'right' }
        );

        // Divider
        doc.moveTo(leftX, rowY + rowH).lineTo(rightEdge, rowY + rowH).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
        rowY += rowH;
      });

      // 4. Financial Totals & Summary Block
      const summaryY = rowY + 22;
      doc.moveTo(leftX, rowY + 10).lineTo(rightEdge, rowY + 10).strokeColor('#E2E8F0').lineWidth(0.75).stroke();

      // Left Summary
      doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Items in Total ', leftX, summaryY, { continued: true })
        .font(fontBold).fillColor('#0F172A').text(formattedTonnage);

      if (paymentTerms) {
        doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Payment Terms : ', leftX, summaryY + 16, { continued: true })
          .font(fontRegular).fillColor('#0F172A').text(paymentTerms);
      }

      // Right Financial Breakdown
      const sumX = 350;
      const sumW = 205.28;

      // Sub Total
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Sub Total', sumX, summaryY);
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(computedSubtotal, true), sumX, summaryY, {
        width: sumW,
        align: 'right',
      });

      // CGST9 (9%)
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('CGST9 (9%)', sumX, summaryY + 14);
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(cgstVal, true), sumX, summaryY + 14, {
        width: sumW,
        align: 'right',
      });

      // SGST9 (9%)
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('SGST9 (9%)', sumX, summaryY + 28);
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(sgstVal, true), sumX, summaryY + 28, {
        width: sumW,
        align: 'right',
      });

      // Rounding
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Rounding', sumX, summaryY + 42);
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(roundingVal, true), sumX, summaryY + 42, {
        width: sumW,
        align: 'right',
      });

      // Total
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Total', sumX, summaryY + 58);
      doc.fillColor('#0F172A').font(fontBold).fontSize(10.5).text(
        `Rs. ${formatIndianCurrency(grandTot, true)}`,
        sumX,
        summaryY + 58,
        { width: sumW, align: 'right' }
      );

      // ================= PAGE 2 =================
      doc.addPage();

      doc.moveTo(leftX, 40).lineTo(rightEdge, 40).strokeColor('#E2E8F0').lineWidth(0.75).stroke();

      // Notes & Bank Details
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Notes', leftX, 55);
      doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Bank Details: -', leftX, 72);

      doc.fillColor('#475569').font(fontRegular).fontSize(8.5);
      doc.text('Bank Name: HDFC Bank', leftX, 86);
      doc.text('IFSC Code: HDFC0002454', leftX, 99);
      doc.text('Account Number: 50200107323747', leftX, 112);
      doc.text('Account Name: Enlight Metals Private Limited', leftX, 125);

      // Terms & Conditions
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Terms & Conditions', leftX, 150);
      doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Declaration:', leftX, 166);

      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text(
        'Certified that the particulars given above are true and correct and the amount indicated represents the price actually charged and there is no flow of additional consideration directly or indirectly from the buyer.',
        leftX,
        180,
        { width: contentWidth, lineGap: 2 }
      );

      doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Note:', leftX, 220);
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5);
      doc.text('1) Interest @24% p.a. will be charged if the payment is not made with stipulated date.', leftX, 234);
      doc.text('2) All disputes are Subject to Pune Jurisdiction only.', leftX, 248);

      // Authorized Signature
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Authorized Signature', leftX, 310);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateQuotationPdfBuffer,
  formatIndianCurrency,
  detectHsnCode,
};
