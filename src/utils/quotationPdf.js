const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { ENLIGHT_LOGO_BASE64 } = require('./logoBase64');
const { calculateLineItem, convertLineItemToMt, resolvePlaceOfSupply: resolvePlaceOfSupplyEngine } = require('./pricingEngine');

function quotationQtyMtLabel(item) {
  const mt = Number(convertLineItemToMt(item));
  if (!mt || isNaN(mt)) return '- MT';
  const rounded = Math.round(mt * 1000) / 1000;
  const formatted =
    rounded < 0.01
      ? rounded.toFixed(3)
      : rounded.toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 3,
        });
  return `${formatted} MT`;
}

function getCompanyLogoBuffer() {
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
    'd:/Enlight sales/assets/logo.png',
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p);
      } catch {}
    }
  }
  if (ENLIGHT_LOGO_BASE64) {
    try {
      return Buffer.from(ENLIGHT_LOGO_BASE64, 'base64');
    } catch {}
  }
  return null;
}

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
    'd:/Enlight sales/assets/logo.png',
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

function resolvePlaceOfSupply(address = '', details = {}) {
  return resolvePlaceOfSupplyEngine({
    deliveryLocation: address,
    customerState: details?.placeOfSupply || details?.place_of_supply || details?.customerState || details?.customer_state,
    customerGstin: details?.customerGstin || details?.customer_gst || details?.gstin,
    customerAddress: details?.customerAddress || details?.address,
  }).label;
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

      const compName = (details.companyName || customerName || 'Valued Customer').toUpperCase();
      const rawAddress = (details.deliveryLocation || details.delivery_location || details.customerAddress || details.address || '').trim();

      const billToAddress = (details.customerAddress || details.address || rawAddress).trim();
      const shipToAddress = (details.deliveryLocation || details.delivery_location || details.customerAddress || rawAddress).trim();

      const billToLines = cleanAddressLines(billToAddress, compName);
      const shipToLines = cleanAddressLines(shipToAddress, compName);
      const customerGstin = details.customerGstin || details.customer_gst || details.gstin || '';
      const posInfo = resolvePlaceOfSupplyEngine({
        deliveryLocation: rawAddress,
        customerState: details.placeOfSupply || details.place_of_supply || details.customerState || details.customer_state,
        customerGstin,
        customerAddress: billToAddress,
      });
      const placeOfSupply = posInfo.label;
      const isInterState = posInfo.isInterState;
      const paymentTerms = details.paymentTerms || details.payment_terms || '30 Days Credit';

      // ================= PAGE 1 =================
      const logoBuffer = getCompanyLogoBuffer();
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, leftX, 40, { width: 140 });
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

      const placeY = currY;
      doc.fillColor('#1E293B').font(fontBold).fontSize(8.5).text('Place Of Supply: ', leftX, placeY, { continued: true })
        .font(fontRegular).fillColor('#475569').text(placeOfSupply);
      currY = placeY + 16;

      const rightBoxX = 395;
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Order Date :', rightBoxX, placeY, { width: 75, lineBreak: false });
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(todayDate, rightBoxX + 75, placeY, {
        width: 85,
        align: 'right',
        lineBreak: false,
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

      const validPricedSrc = rawLineItems.filter(
        item => Number(item.rate || item.unitPrice || 0) > 0
      );
      const effectiveSrc = validPricedSrc.length > 0 ? validPricedSrc : rawLineItems;

      const lineItems = effectiveSrc.map(item => {
        const calc = calculateLineItem(item, { isInterState });
        const qty = Number(calc.quantity || 0);
        const rate = Number(calc.rate || 0);
        const baseAmount = Number(calc.amount || (qty * rate));
        const cgstRate = isInterState ? 0 : Number(calc.cgst_rate !== undefined ? calc.cgst_rate : 9);
        const sgstRate = isInterState ? 0 : Number(calc.sgst_rate !== undefined ? calc.sgst_rate : 9);
        const igstRate = isInterState ? Number(calc.igst_rate !== undefined ? calc.igst_rate : 18) : 0;
        const cgstAmount = isInterState ? 0 : (calc.cgst_amount !== undefined ? Number(calc.cgst_amount) : Math.round(baseAmount * (cgstRate / 100) * 100) / 100);
        const sgstAmount = isInterState ? 0 : (calc.sgst_amount !== undefined ? Number(calc.sgst_amount) : Math.round(baseAmount * (sgstRate / 100) * 100) / 100);
        const igstAmount = isInterState ? (calc.igst_amount !== undefined && Number(calc.igst_amount) > 0 ? Number(calc.igst_amount) : Math.round(baseAmount * (igstRate / 100) * 100) / 100) : 0;
        const totalGst = calc.total_gst !== undefined ? Number(calc.total_gst) : (isInterState ? igstAmount : Math.round((cgstAmount + sgstAmount) * 100) / 100);
        const finalAmount = calc.final_amount !== undefined ? Number(calc.final_amount) : Math.round((baseAmount + totalGst) * 100) / 100;

        return {
          sku_text: (item.sku_text || item.description || item.productType || 'HR - COIL / SHEET').toUpperCase(),
          dimensions: item.dimensions || undefined,
          hsn_code: item.hsn_code || item.hsn || detectHsnCode(item.sku_text || item.description || '', item.dimensions),
          quantity: qty,
          unit: calc.unit || 'MT',
          converted_mt: item.converted_mt,
          weight_mt: item.weight_mt,
          qty_mt_label: quotationQtyMtLabel(item),
          rate: rate,
          amount: baseAmount,
          cgst_rate: cgstRate,
          cgst_amount: cgstAmount,
          sgst_rate: sgstRate,
          sgst_amount: sgstAmount,
          igst_rate: igstRate,
          igst_amount: igstAmount,
          is_inter_state: isInterState,
          total_gst: totalGst,
          final_amount: finalAmount,
        };
      });

      const computedSubtotal = lineItems.reduce((s, i) => s + (Number(i.amount) || 0), 0) || Number(details.totalAmount || 0);
      const totalTonnageMt = lineItems.reduce((s, i) => s + (i.unit === 'MT' ? i.quantity : 0), 0);
      const formattedTonnage = totalTonnageMt > 0 ? `${formatIndianCurrency(totalTonnageMt, false)} MT` : `${lineItems.length} items`;

      const cgstVal = isInterState ? 0 : (lineItems.reduce((s, i) => s + (Number(i.cgst_amount) || 0), 0) || Math.round(computedSubtotal * 0.09 * 100) / 100);
      const sgstVal = isInterState ? 0 : (lineItems.reduce((s, i) => s + (Number(i.sgst_amount) || 0), 0) || Math.round(computedSubtotal * 0.09 * 100) / 100);
      const igstVal = isInterState ? (lineItems.reduce((s, i) => s + (Number(i.igst_amount) || 0), 0) || Math.round(computedSubtotal * 0.18 * 100) / 100) : 0;
      const exactTot = computedSubtotal + cgstVal + sgstVal + igstVal;
      const grandTot = Math.round(exactTot);
      const roundingVal = Math.round((grandTot - exactTot) * 100) / 100;

      const drawItemHeader = (headerY) => {
        doc.rect(leftX, headerY, contentWidth, 24).fill('#525E6F');
        doc.fillColor('#FFFFFF').font(fontBold).fontSize(7.5);
        doc.text('#', 40, headerY + 8, { width: 18, align: 'center', lineBreak: false });
        doc.text('Item & Description', 62, headerY + 8, { width: 175, lineBreak: false });
        doc.text('HSN/SAC', 240, headerY + 8, { width: 46, align: 'center', lineBreak: false });
        doc.text('Qty', 289, headerY + 8, { width: 48, align: 'center', lineBreak: false });
        doc.text('Rate', 340, headerY + 8, { width: 48, align: 'right', lineBreak: false });
        if (isInterState) {
          doc.text('IGST (18%)', 392, headerY + 8, { width: 100, align: 'right', lineBreak: false });
        } else {
          doc.text('CGST (9%)', 392, headerY + 8, { width: 48, align: 'right', lineBreak: false });
          doc.text('SGST (9%)', 444, headerY + 8, { width: 48, align: 'right', lineBreak: false });
        }
        doc.text('Amount', 496, headerY + 8, { width: 51.28, align: 'right', lineBreak: false });
        return headerY + 24;
      };

      const tableY = currY + 14;
      let rowY = drawItemHeader(tableY);
      lineItems.forEach((item, idx) => {
        doc.font(fontBold).fontSize(8);
        const skuH = doc.heightOfString(item.sku_text, { width: 175 });
        const dimH = item.dimensions
          ? doc.font(fontRegular).fontSize(7).heightOfString(item.dimensions, { width: 175 }) + 3
          : 0;
        const rowH = Math.max(32, skuH + dimH + 16);

        if (rowY + rowH > doc.page.maxY()) {
          doc.addPage();
          rowY = drawItemHeader(doc.page.margins.top);
        }

        doc.rect(leftX, rowY, contentWidth, rowH).fill('#FFFFFF');

        // Index
        doc.fillColor('#64748B').font(fontRegular).fontSize(7.5).text(String(idx + 1), 40, rowY + 8, {
          width: 18,
          align: 'center',
        });

        // SKU title
        doc.fillColor('#0F172A').font(fontBold).fontSize(8).text(item.sku_text, 62, rowY + 8, { width: 175 });

        // Dimensions
        if (item.dimensions) {
          doc.fillColor('#64748B').font(fontRegular).fontSize(7).text(item.dimensions, 62, rowY + 8 + skuH + 2, { width: 175 });
        }

        // HSN/SAC
        doc.fillColor('#475569').font(fontRegular).fontSize(7.5).text(item.hsn_code, 240, rowY + 8, {
          width: 46,
          align: 'center',
        });

        // Qty
        doc.fillColor('#0F172A').font(fontRegular).fontSize(7.5).text(
          item.qty_mt_label,
          289,
          rowY + 8,
          { width: 48, align: 'center' }
        );

        // Rate
        doc.fillColor('#475569').font(fontRegular).fontSize(7.5).text(
          formatIndianCurrency(item.rate, true),
          340,
          rowY + 8,
          { width: 48, align: 'right' }
        );

        if (isInterState) {
          // IGST (18%)
          doc.fillColor('#475569').font(fontRegular).fontSize(7.5).text(
            formatIndianCurrency(item.igst_amount, true),
            392,
            rowY + 8,
            { width: 100, align: 'right' }
          );
        } else {
          // CGST (9%)
          doc.fillColor('#475569').font(fontRegular).fontSize(7.5).text(
            formatIndianCurrency(item.cgst_amount, true),
            392,
            rowY + 8,
            { width: 48, align: 'right' }
          );

          // SGST (9%)
          doc.fillColor('#475569').font(fontRegular).fontSize(7.5).text(
            formatIndianCurrency(item.sgst_amount, true),
            444,
            rowY + 8,
            { width: 48, align: 'right' }
          );
        }

        // Amount (Base + 18% GST)
        doc.fillColor('#0F172A').font(fontBold).fontSize(7.5).text(
          formatIndianCurrency(item.final_amount, true),
          496,
          rowY + 8,
          { width: 51.28, align: 'right' }
        );

        // Divider
        doc.moveTo(leftX, rowY + rowH).lineTo(rightEdge, rowY + rowH).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
        rowY += rowH;
      });

      // 4. Financial Totals & Summary Block
      if (rowY + 90 > doc.page.maxY()) {
        doc.addPage();
        rowY = doc.page.margins.top;
      }
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

      let taxNextY = summaryY + 14;
      if (isInterState) {
        // IGST18 (18%)
        doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('IGST18 (18%)', sumX, taxNextY);
        doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(igstVal, true), sumX, taxNextY, {
          width: sumW,
          align: 'right',
        });
        taxNextY += 14;
      } else {
        // CGST9 (9%)
        doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('CGST9 (9%)', sumX, taxNextY);
        doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(cgstVal, true), sumX, taxNextY, {
          width: sumW,
          align: 'right',
        });
        taxNextY += 14;

        // SGST9 (9%)
        doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('SGST9 (9%)', sumX, taxNextY);
        doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(sgstVal, true), sumX, taxNextY, {
          width: sumW,
          align: 'right',
        });
        taxNextY += 14;
      }

      // Rounding
      doc.fillColor('#475569').font(fontRegular).fontSize(8.5).text('Rounding', sumX, taxNextY);
      doc.fillColor('#0F172A').font(fontRegular).fontSize(8.5).text(formatIndianCurrency(roundingVal, true), sumX, taxNextY, {
        width: sumW,
        align: 'right',
      });

      // Total
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Total', sumX, taxNextY + 16);
      doc.fillColor('#0F172A').font(fontBold).fontSize(10.5).text(
        `Rs. ${formatIndianCurrency(grandTot, true)}`,
        sumX,
        taxNextY + 16,
        { width: sumW, align: 'right' }
      );

      // ================= PAGE 2 =================
      doc.addPage();

      doc.moveTo(leftX, 40).lineTo(rightEdge, 40).strokeColor('#E2E8F0').lineWidth(0.75).stroke();

      // Notes & Bank Details
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Notes', leftX, 55);
      doc.fillColor('#334155').font(fontRegular).fontSize(8.5).text('Bank Details: -', leftX, 72);

      doc.fillColor('#475569').font(fontRegular).fontSize(8.5);
      doc.text('Bank Name: Kotak Mahindra Bank', leftX, 86);
      doc.text('IFSC Code: KKBK0001792', leftX, 99);
      doc.text('Account Number: 2500112233', leftX, 112);
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
      doc.fillColor('#0F172A').font(fontBold).fontSize(10).text('Authorized Signature', leftX, 310, { lineBreak: false });

      const signatureName = String(
        details.senderName || details.salespersonName || details.salesperson_name || '',
      ).trim();
      if (
        signatureName &&
        signatureName !== 'Sales Operations Team' &&
        signatureName !== 'Sales Team'
      ) {
        doc.fillColor('#0F172A').font(fontRegular).fontSize(10).text(signatureName, leftX, 328, { lineBreak: false });
        doc.moveTo(leftX, 372).lineTo(leftX + 160, 372).strokeColor('#0F172A').lineWidth(0.8).stroke();
      }

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
