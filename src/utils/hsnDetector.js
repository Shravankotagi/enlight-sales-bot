/**
 * Steel Products & Dimensions Master HSN Code Detection Catalog
 *
 * Source: Official Product Catalog
 * Categories: Flat Steel, Structural Steel, Pipes and Tubes, Value Added Products
 */

const MASTER_PRODUCTS_CATALOG = [
  // Flat Steel
  { category: 'Flat Steel', product_name: 'HR Coil', dimensions: '1.60 mm – <3.00 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083940', min_thickness_mm: 1.60, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'HR Coil', dimensions: '3.00 mm – <4.75 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083840', min_thickness_mm: 3.00, max_thickness_mm: 4.74 },
  { category: 'Flat Steel', product_name: 'HR Coil', dimensions: '4.75 mm – <10.00 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083740', min_thickness_mm: 4.75, max_thickness_mm: 9.99 },
  { category: 'Flat Steel', product_name: 'HR Coil', dimensions: '10.00 mm and above; Width 1250/1500/2000/2500 mm', hsn_code: '72083740', min_thickness_mm: 10.00, max_thickness_mm: 999.0 },
  { category: 'Flat Steel', product_name: 'HR Sheet', dimensions: '1.60 mm – <3.00 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083930', min_thickness_mm: 1.60, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'HR Sheet', dimensions: '3.00 mm – <4.75 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083830', min_thickness_mm: 3.00, max_thickness_mm: 4.74 },
  { category: 'Flat Steel', product_name: 'HR Sheet', dimensions: '4.75 mm – <12.00 mm; Width 1250/1500/2000/2500 mm', hsn_code: '72083730', min_thickness_mm: 4.75, max_thickness_mm: 11.99 },
  { category: 'Flat Steel', product_name: 'HR Plate', dimensions: '14.00 mm and above; Width 1250/1500/2000/2500 mm', hsn_code: '72085110', min_thickness_mm: 12.00, max_thickness_mm: 999.0 },
  { category: 'Flat Steel', product_name: 'HRPO Coil', dimensions: '1.60 mm – <3.00 mm; Width 1250/1500 mm', hsn_code: '72083940', min_thickness_mm: 1.60, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'HRPO Coil', dimensions: '3.00 mm – <4.75 mm; Width 1250/1500 mm', hsn_code: '72083840', min_thickness_mm: 3.00, max_thickness_mm: 4.74 },
  { category: 'Flat Steel', product_name: 'HRPO Coil', dimensions: '4.75 mm – 12.00 mm; Width 1250/1500 mm', hsn_code: '72082590', min_thickness_mm: 4.75, max_thickness_mm: 12.00 },
  { category: 'Flat Steel', product_name: 'HRPO Sheet', dimensions: '1.60 mm – <3.00 mm; Width 1250/1500 mm', hsn_code: '72082590', min_thickness_mm: 1.60, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'HRPO Sheet', dimensions: '3.00 mm – <4.75 mm; Width 1250/1500 mm', hsn_code: '72082590', min_thickness_mm: 3.00, max_thickness_mm: 4.74 },
  { category: 'Flat Steel', product_name: 'HRPO Sheet', dimensions: '4.75 mm – 12.00 mm; Width 1250/1500 mm', hsn_code: '72082590', min_thickness_mm: 4.75, max_thickness_mm: 12.00 },
  { category: 'Flat Steel', product_name: 'CR Coil', dimensions: '0.30 mm – <0.50 mm; Width 1250/1500 mm', hsn_code: '72091890', min_thickness_mm: 0.30, max_thickness_mm: 0.49 },
  { category: 'Flat Steel', product_name: 'CR Coil', dimensions: '0.50 mm – 1.00 mm; Width 1250/1500 mm', hsn_code: '72091790', min_thickness_mm: 0.50, max_thickness_mm: 1.00 },
  { category: 'Flat Steel', product_name: 'CR Coil', dimensions: '>1.00 mm – <3.00 mm; Width 1250/1500 mm', hsn_code: '72091690', min_thickness_mm: 1.01, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'CR Sheet', dimensions: '0.30 mm – <0.50 mm; Width 1250/1500 mm', hsn_code: '72092820', min_thickness_mm: 0.30, max_thickness_mm: 0.49 },
  { category: 'Flat Steel', product_name: 'CR Sheet', dimensions: '0.50 mm – 1.00 mm; Width 1250/1500 mm', hsn_code: '72092720', min_thickness_mm: 0.50, max_thickness_mm: 1.00 },
  { category: 'Flat Steel', product_name: 'CR Sheet', dimensions: '>1.00 mm – <3.00 mm; Width 1250/1500 mm', hsn_code: '72092620', min_thickness_mm: 1.01, max_thickness_mm: 2.99 },
  { category: 'Flat Steel', product_name: 'GP Coil', dimensions: '0.30 mm – 3.00 mm; Width 900/1220/1250/1500 mm', hsn_code: '72104900', min_thickness_mm: 0.30, max_thickness_mm: 3.00 },
  { category: 'Flat Steel', product_name: 'GP Sheet', dimensions: '0.30 mm – 3.00 mm; Width 900/1220/1250/1500 mm', hsn_code: '72104900', min_thickness_mm: 0.30, max_thickness_mm: 3.00 },
  { category: 'Flat Steel', product_name: 'Galvalume Coil', dimensions: '0.30 mm – 3.00 mm; Width ≥600 mm', hsn_code: '72106100', min_thickness_mm: 0.30, max_thickness_mm: 3.00 },
  { category: 'Flat Steel', product_name: 'Galvalume Sheet', dimensions: '0.30 mm – 3.00 mm; Width ≥600 mm', hsn_code: '72106100', min_thickness_mm: 0.30, max_thickness_mm: 3.00 },
  { category: 'Flat Steel', product_name: 'Chequered Coil', dimensions: '1.60 mm – 12.00 mm; Width 1250/1500 mm', hsn_code: '72081000', min_thickness_mm: 1.60, max_thickness_mm: 12.00 },
  { category: 'Flat Steel', product_name: 'Chequered Sheet', dimensions: '1.60 mm – 12.00 mm; Width 1250/1500 mm', hsn_code: '72081000', min_thickness_mm: 1.60, max_thickness_mm: 12.00 },

  // Structural Steel
  { category: 'Structural Steel', product_name: 'MS Round Bar', dimensions: '6 mm – 75 mm', hsn_code: '72149990' },
  { category: 'Structural Steel', product_name: 'MS Flat Bar', dimensions: '12×3 mm – 300×25 mm', hsn_code: '72111410' },
  { category: 'Structural Steel', product_name: 'MS Square Bar', dimensions: '6 mm – 100 mm', hsn_code: '72149990' },
  { category: 'Structural Steel', product_name: 'TMT Bar', dimensions: '8 mm – 40 mm', hsn_code: '72142090' },
  { category: 'Structural Steel', product_name: 'MS Angle', dimensions: 'L or T sections, height <80 mm', hsn_code: '72162100', max_thickness_mm: 79.99 },
  { category: 'Structural Steel', product_name: 'MS Angle', dimensions: 'L or T sections, height ≥80 mm', hsn_code: '72162200', min_thickness_mm: 80.00 },
  { category: 'Structural Steel', product_name: 'MS Channel', dimensions: '70×35 mm – 400×100 mm', hsn_code: '72163100' },
  { category: 'Structural Steel', product_name: 'MS Beam', dimensions: 'height ≥ 80 mm', hsn_code: '72163200', min_thickness_mm: 80.00 },

  // Pipes and Tubes
  { category: 'Pipes and Tubes', product_name: 'MS Round Pipe', dimensions: 'NB 15–400 mm; OD 21.3–406.4 mm; Thickness 1–25 mm', hsn_code: '73063090' },
  { category: 'Pipes and Tubes', product_name: 'MS Square Pipe', dimensions: 'Thickness 1–25 mm', hsn_code: '73063090' },
  { category: 'Pipes and Tubes', product_name: 'MS Rectangular Tube', dimensions: 'Thickness 1–25 mm', hsn_code: '73063090' },

  // Value Added Products
  { category: 'Value Added Products', product_name: 'Slotted Angle', dimensions: '30×30 mm; Thickness 1.2–3 mm; Length 1.8–3 m', hsn_code: '72169930' },
  { category: 'Value Added Products', product_name: 'Slotted Angle', dimensions: '40×40 mm; Thickness 1.2–3 mm; Length 1.8–3 m', hsn_code: '72169930' },
  { category: 'Value Added Products', product_name: 'Slotted Angle', dimensions: '50×50 mm; Thickness 1.2–3 mm; Length 1.8–3 m', hsn_code: '72169930' },
  { category: 'Value Added Products', product_name: 'Slotted Angle', dimensions: '60×60 mm; Thickness 1.2–3 mm; Length 1.8–3 m', hsn_code: '72169930' },
  { category: 'Value Added Products', product_name: 'Solar Mounting Structure', dimensions: 'C Channel / Z Purlin / Hat Section; Ground/Roof/Elevated', hsn_code: '73089090' },
  { category: 'Value Added Products', product_name: 'Cable Tray – Perforated', dimensions: 'Width 50–1200 mm', hsn_code: '73089090' },
  { category: 'Value Added Products', product_name: 'Cable Tray – Ladder', dimensions: 'Width 50–1200 mm', hsn_code: '73089090' },
  { category: 'Value Added Products', product_name: 'GI Earthing Strip', dimensions: 'Hot-Dip Galvanized Steel Strip; Width <600 mm', hsn_code: '73082019' },
];

function extractThickness(str) {
  if (!str || typeof str !== 'string') return null;
  if (/>1(?:\.0+)?\s*mm/i.test(str)) return 1.5;
  const m = str.match(/(\d+(?:\.\d+)?)\s*(?:mm|thk|thick|gauge|g\b)/i) ||
            str.match(/\b(\d+(?:\.\d+)?)\s*x\s*\d+/i) ||
            str.match(/x\s*(\d+(?:\.\d+)?)$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

function extractHeight(str) {
  if (!str || typeof str !== 'string') return null;
  if (/<80\s*mm/i.test(str)) return 50;
  if (/(?:>=|≥|above)\s*80\s*mm/i.test(str)) return 100;
  const m = str.match(/(?:isa\s*|angle\s*)?(\d+)\s*x\s*(\d+)/i) ||
            str.match(/(\d+)\s*mm/i);
  if (m) return parseFloat(m[1]);
  return null;
}

function detectHsnCode(productName, dimensions) {
  const pName = (productName || '').toLowerCase().trim();
  const dStr = (dimensions || '').toLowerCase().trim();
  const combined = `${pName} ${dStr}`.trim();
  if (!combined) return '72083840';

  const t = extractThickness(dimensions) || extractThickness(productName);

  // --- Priority 1: Value Added Products ---
  if (/\b(?:gi\s*)?earthing\s*strip\b|\bearthing\b/i.test(combined) || (/\bearthing\b/i.test(pName))) {
    return '73082019';
  }

  if (/\bsolar\s*(?:mounting)?\s*structure\b|\bsolar\b|\bz\s*purlin\b|\bhat\s*section\b/i.test(combined) || /\bsolar\b/i.test(pName)) {
    return '73089090';
  }

  if (/\bcable\s*tray\b/i.test(combined)) {
    return '73089090';
  }

  if (/\bslotted\s*angle\b/i.test(combined) || /\bslotted\b/i.test(pName)) {
    return '72169930';
  }

  // --- Priority 2: Pipes and Tubes ---
  if (/\bsquare\s*(?:pipe|tube|tubing)\b|\bshs\b/i.test(combined) || /\bsquare\s*pipe\b/i.test(pName)) {
    return '73063090';
  }

  if (/\brectangular\s*(?:pipe|tube|tubing)\b|\brhs\b|\bbox\s*(?:pipe|section)\b/i.test(combined) || /\brectangular\s*(?:pipe|tube)\b/i.test(pName)) {
    return '73063090';
  }

  if (/\bround\s*pipe\b|\berw\s*pipe\b|\bseamless\s*pipe\b|\bms\s*pipe\b|\bpipe\b|\btube\b/i.test(combined)) {
    return '73063090';
  }

  // --- Priority 3: Structural Steel ---
  if (/\bround\s*bar\b|\bms\s*round\s*bar\b|\bbright\s*bar\b|\bround\s*rod\b|\bms\s*rod\b/i.test(combined)) {
    return '72149990';
  }

  if (/\bflat\s*bar\b|\bms\s*flat\s*bar\b|\bms\s*flat\b|\bflats\b|\bpatti\b|\bflat\b/i.test(combined) || /\bflat\b/i.test(pName)) {
    return '72111410';
  }

  if (/\bsquare\s*bar\b|\bms\s*square\s*bar\b|\bsq\s*bar\b|\bsquare\s*rod\b/i.test(combined)) {
    return '72149990';
  }

  if (/\btmt\b|\brebar\b|\breinforcement\b|\bfe\s*500\b|\bfe\s*550\b|\bfe\s*500d\b|\bfe\s*550d\b|\bsariya\b/i.test(combined)) {
    return '72142090';
  }

  if (/\bangle\b|\bisa\b|\bl-angle\b/i.test(combined)) {
    const h = extractHeight(dimensions) || extractHeight(productName);
    if (h !== null && h >= 80) return '72162200';
    return '72162100';
  }

  if (/\bchannel\b|\bismc\b|\bisjc\b|\bispc\b|\bc-channel\b|\bu-channel\b/i.test(combined)) {
    return '72163100';
  }

  if (/\bbeam\b|\bismb\b|\bisnb\b|\bjoist\b|\bi-beam\b|\bh-beam\b|\bnpb\b|\bwfb\b|\buc\s*column\b|\bub\s*beam\b/i.test(combined)) {
    return '72163200';
  }

  // --- Priority 4: Flat Steel ---
  if (/\bchequered\s*coil\b|\bcheckered\s*coil\b/i.test(combined)) {
    return '72081000';
  }

  if (/\bchequered\b|\bcheckered\b/i.test(combined)) {
    return '72081000';
  }

  if (/\bgalvalume\s*coil\b|\bgl\s*coil\b/i.test(combined)) {
    return '72106100';
  }

  if (/\bgalvalume\s*sheet\b|\bgalvalume\b|\bgl\s*sheet\b/i.test(combined)) {
    return '72106100';
  }

  if (/\bgp\s*coil\b|\bgalvanized\s*plain\s*coil\b|\bgi\s*coil\b/i.test(combined)) {
    return '72104900';
  }

  if (/\bgp\s*sheet\b|\bgalvanized\s*plain\s*sheet\b|\bgi\s*sheet\b|\bgalvanized\b|\bgalvanised\b/i.test(combined)) {
    return '72104900';
  }

  // HRPO
  if (/\bhrpo\s*coil\b|\bpickled\s*(?:&|and)\s*oiled\s*coil\b/i.test(combined)) {
    if (t !== null) {
      if (t >= 1.60 && t < 3.00) return '72083940';
      if (t >= 3.00 && t < 4.75) return '72083840';
      if (t >= 4.75) return '72082590';
    }
    return '72082590';
  }

  if (/\bhrpo\s*sheet\b|\bpickled\s*(?:&|and)\s*oiled\s*sheet\b/i.test(combined)) {
    return '72082590';
  }

  if (/\bhrpo\b/i.test(combined)) {
    if (t !== null && t < 3.00) return '72083940';
    if (t !== null && t < 4.75) return '72083840';
    return '72082590';
  }

  // CR Coil
  if (/\bcr\s*coil\b|\bcold\s*rolled\s*coil\b|\bcrca\s*coil\b/i.test(combined) || (/\bcr\b|\bcold\s*rolled\b/i.test(pName) && /\bcoil\b/i.test(pName))) {
    if (t !== null) {
      if (t < 0.50) return '72091890';
      if (t <= 1.00) return '72091790';
      return '72091690';
    }
    return '72091790';
  }

  // CR Sheet
  if (/\bcr\s*sheet\b|\bcold\s*rolled\s*sheet\b|\bcrca\s*sheet\b|\bcr\b|\bcrca\b|\bcold\s*rolled\b/i.test(combined)) {
    if (t !== null) {
      if (t < 0.50) return '72092820';
      if (t <= 1.00) return '72092720';
      return '72092620';
    }
    return '72092720';
  }

  // HR Plate
  if (/\bhr\s*plate\b|\bhot\s*rolled\s*plate\b|\bms\s*plate\b|\bplate\b/i.test(combined)) {
    if (t !== null && t < 12.00) return '72083730';
    return '72085110';
  }

  // HR Sheet
  if (/\bhr\s*sheet\b|\bhot\s*rolled\s*sheet\b|\bms\s*sheet\b/i.test(combined)) {
    if (t !== null) {
      if (t < 3.00) return '72083930';
      if (t < 4.75) return '72083830';
      return '72083730';
    }
    return '72083830';
  }

  // HR Coil / Hot Rolled Coil
  if (/\bhr\s*coil\b|\bhot\s*rolled\s*coil\b|\bhr\b|\bhot\s*rolled\b/i.test(combined)) {
    if (t !== null) {
      if (t < 3.00) return '72083940';
      if (t < 4.75) return '72083840';
      return '72083740';
    }
    return '72083840';
  }

  // Stainless Steel
  if (/\bstainless\b|\bss\s*(?:sheet|coil|plate|pipe|bar|304|316)\b/i.test(combined)) {
    return '72193390';
  }

  // Unknown product -> leave blank
  return '';
}

// Map short forms & full forms to official master product name and resolve HSN
function normalizeProductToCatalog(productName, dimensions = null) {
  if (!productName || typeof productName !== 'string') {
    return { isValid: false, catalogName: null, category: null, hsnCode: null };
  }

  const p = productName.toLowerCase().trim();
  const d = (dimensions || '').toLowerCase().trim();
  const combined = `${p} ${d}`.trim();
  const t = extractThickness(dimensions) || extractThickness(productName);
  const h = extractHeight(dimensions) || extractHeight(productName);

  // 1. Value Added Products
  if (/\b(?:gi\s*)?earthing\s*strip\b|\bearthing\s*patti\b|\bearthing\s*strip\b/i.test(combined) || /\bearthing\b/i.test(p)) {
    return { isValid: true, catalogName: 'GI Earthing Strip', category: 'Value Added Products', hsnCode: '73082019' };
  }
  if (/\bcable\s*tray\s*(?:–|-)?\s*ladder\b|\bladder\s*(?:cable\s*)?tray\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Cable Tray – Ladder', category: 'Value Added Products', hsnCode: '73089090' };
  }
  if (/\bcable\s*tray\s*(?:–|-)?\s*perforated\b|\bperforated\s*(?:cable\s*)?tray\b|\bcable\s*tray\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Cable Tray – Perforated', category: 'Value Added Products', hsnCode: '73089090' };
  }
  if (/\bsolar\s*(?:mounting)?\s*structure\b|\bsolar\b|\bz\s*purlin\b|\bhat\s*section\b|\bc\s*purlin\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Solar Mounting Structure', category: 'Value Added Products', hsnCode: '73089090' };
  }
  if (/\bslotted\s*angle\b|\bslotted\s*rack\b|\bslotted\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Slotted Angle', category: 'Value Added Products', hsnCode: '72169930' };
  }

  // 2. Pipes and Tubes (Round, Square, Rectangular)
  if (/\brectangular\s*(?:pipe|tube|tubing)\b|\brhs\b/i.test(combined) || (/\brectangular\b/i.test(p) && /\b(?:pipe|tube)\b/i.test(combined))) {
    return { isValid: true, catalogName: 'MS Rectangular Tube', category: 'Pipes and Tubes', hsnCode: '73063090' };
  }
  if (/\bsquare\s*(?:pipe|tube|tubing)\b|\bshs\b|\bbox\s*(?:pipe|tube|section)\b/i.test(combined) || (/\bsquare\b/i.test(p) && /\b(?:pipe|tube)\b/i.test(combined))) {
    return { isValid: true, catalogName: 'MS Square Pipe', category: 'Pipes and Tubes', hsnCode: '73063090' };
  }
  if (/\b(?:round\s*pipe|erw\s*pipe|seamless\s*pipe|ms\s*pipe|gi\s*pipe|round\s*tube|ms\s*tube|pipe|tube)\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Round Pipe', category: 'Pipes and Tubes', hsnCode: '73063090' };
  }

  // 3. Structural Steel (Round Bar, Flat Bar, Square Bar, TMT Bar, Angle, Channel, Beam)
  if (/\btmt\b|\brebar\b|\breinforcement\b|\bfe\s*500\b|\bfe\s*550\b|\bfe\s*500d\b|\bfe\s*550d\b|\bsariya\b/i.test(combined)) {
    return { isValid: true, catalogName: 'TMT Bar', category: 'Structural Steel', hsnCode: '72142090' };
  }
  if (/\bround\s*bar\b|\bbright\s*bar\b|\bround\s*rod\b|\bms\s*round\b|\bms\s*rod\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Round Bar', category: 'Structural Steel', hsnCode: '72149990' };
  }
  if (/\bflat\s*bar\b|\bms\s*flat\b|\bflats\b|\bpatti\b|\bms\s*patti\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Flat Bar', category: 'Structural Steel', hsnCode: '72111410' };
  }
  if (/\bsquare\s*bar\b|\bsq\s*bar\b|\bms\s*sq\s*bar\b|\bsquare\s*rod\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Square Bar', category: 'Structural Steel', hsnCode: '72149990' };
  }
  if (/\bangle\b|\bisa\b|\bl-angle\b|\bequal\s*angle\b|\bpatra\s*angle\b/i.test(combined)) {
    const code = h !== null && h >= 80 ? '72162200' : '72162100';
    return { isValid: true, catalogName: 'MS Angle', category: 'Structural Steel', hsnCode: code };
  }
  if (/\bchannel\b|\bismc\b|\bisjc\b|\bispc\b|\bc-channel\b|\bu-channel\b|\bgate\s*channel\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Channel', category: 'Structural Steel', hsnCode: '72163100' };
  }
  if (/\bbeam\b|\bismb\b|\bisnb\b|\bjoist\b|\bi-beam\b|\bh-beam\b|\bnpb\b|\bwfb\b|\buc\s*column\b|\bub\s*beam\b|\bgirder\b/i.test(combined)) {
    return { isValid: true, catalogName: 'MS Beam', category: 'Structural Steel', hsnCode: '72163200' };
  }

  // 4. Flat Steel (HR, CR, GP, Galvalume, Chequered)
  // Chequered
  if (/\bchequered\s*coil\b|\bcheckered\s*coil\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Chequered Coil', category: 'Flat Steel', hsnCode: '72081000' };
  }
  if (/\bchequered\b|\bcheckered\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Chequered Sheet', category: 'Flat Steel', hsnCode: '72081000' };
  }

  // Galvalume
  if (/\bgalvalume\s*coil\b|\bgl\s*coil\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Galvalume Coil', category: 'Flat Steel', hsnCode: '72106100' };
  }
  if (/\bgalvalume\b|\bgl\s*sheet\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Galvalume Sheet', category: 'Flat Steel', hsnCode: '72106100' };
  }

  // Galvanized Plain (GP / GI)
  if (/\bgp\s*coil\b|\bgalvanized\s*plain\s*coil\b|\bgi\s*coil\b|\bgalvanized\s*coil\b/i.test(combined)) {
    return { isValid: true, catalogName: 'GP Coil', category: 'Flat Steel', hsnCode: '72104900' };
  }
  if (/\bgp\s*sheet\b|\bgalvanized\s*plain\s*sheet\b|\bgi\s*sheet\b|\bgalvanized\s*sheet\b|\bgp\b|\bgi\s*patra\b|\bgp\s*patra\b/i.test(combined)) {
    return { isValid: true, catalogName: 'GP Sheet', category: 'Flat Steel', hsnCode: '72104900' };
  }

  // HRPO
  if (/\bhrpo\s*coil\b|\bpickled\s*(?:&|and)\s*oiled\s*coil\b/i.test(combined)) {
    let code = '72082590';
    if (t !== null && t < 3.00) code = '72083940';
    else if (t !== null && t < 4.75) code = '72083840';
    return { isValid: true, catalogName: 'HRPO Coil', category: 'Flat Steel', hsnCode: code };
  }
  if (/\bhrpo\s*sheet\b|\bpickled\s*(?:&|and)\s*oiled\s*sheet\b|\bhrpo\b/i.test(combined)) {
    return { isValid: true, catalogName: 'HRPO Sheet', category: 'Flat Steel', hsnCode: '72082590' };
  }

  // CR (Cold Rolled)
  if (/\bcr\s*coil\b|\bcold\s*rolled\s*coil\b|\bcrca\s*coil\b|\bcr\s*slit\b/i.test(combined) || (/\bcr\b|\bcold\s*rolled\b|\bcrca\b/i.test(p) && /\bcoil\b/i.test(combined))) {
    let code = '72091790';
    if (t !== null && t < 0.50) code = '72091890';
    else if (t !== null && t <= 1.00) code = '72091790';
    else if (t !== null && t > 1.00) code = '72091690';
    return { isValid: true, catalogName: 'CR Coil', category: 'Flat Steel', hsnCode: code };
  }
  if (/\bcr\s*sheet\b|\bcold\s*rolled\s*sheet\b|\bcrca\s*sheet\b|\bcr\b|\bcrca\b|\bcold\s*rolled\b/i.test(combined)) {
    let code = '72092720';
    if (t !== null && t < 0.50) code = '72092820';
    else if (t !== null && t <= 1.00) code = '72092720';
    else if (t !== null && t > 1.00) code = '72092620';
    return { isValid: true, catalogName: 'CR Sheet', category: 'Flat Steel', hsnCode: code };
  }

  // HR Plate (14mm+)
  if (/\bhr\s*plate\b|\bhot\s*rolled\s*plate\b|\bms\s*plate\b|\bplate\b/i.test(combined)) {
    if (t !== null && t < 12.00) {
      return { isValid: true, catalogName: 'HR Sheet', category: 'Flat Steel', hsnCode: '72083730' };
    }
    return { isValid: true, catalogName: 'HR Plate', category: 'Flat Steel', hsnCode: '72085110' };
  }

  // HR Sheet
  if (/\bhr\s*sheet\b|\bhot\s*rolled\s*sheet\b|\bms\s*sheet\b/i.test(combined)) {
    let code = '72083830';
    if (t !== null && t < 3.00) code = '72083930';
    else if (t !== null && t < 4.75) code = '72083830';
    else if (t !== null && t <= 12.00) code = '72083730';
    return { isValid: true, catalogName: 'HR Sheet', category: 'Flat Steel', hsnCode: code };
  }

  // HR Coil
  if (/\bhr\s*coil\b|\bhot\s*rolled\s*coil\b|\bhr\b|\bhot\s*rolled\b/i.test(combined)) {
    let code = '72083840';
    if (t !== null && t < 3.00) code = '72083940';
    else if (t !== null && t < 4.75) code = '72083840';
    else if (t !== null) code = '72083740';
    return { isValid: true, catalogName: 'HR Coil', category: 'Flat Steel', hsnCode: code };
  }

  // Stainless Steel
  if (/\bstainless\b|\bss\s*(?:sheet|coil|plate|pipe|bar|304|316)\b/i.test(combined)) {
    return { isValid: true, catalogName: 'Stainless Steel', category: 'Specialty Steel', hsnCode: '72193390' };
  }

  // Generic / Unrecognized
  return { isValid: false, catalogName: null, category: null, hsnCode: null };
}

function isValidCatalogProduct(productName) {
  return normalizeProductToCatalog(productName).isValid;
}

function getUnknownProductClarificationMessage(invalidProductName) {
  return `⚠️ *Unrecognized Product: "${invalidProductName}"*\n\n` +
    `Please verify the product name. We supply standard steel products across these categories:\n\n` +
    `📋 *Flat Steel:* HR Coil, HR Sheet, HR Plate, HRPO Coil, HRPO Sheet, CR Coil, CR Sheet, GP Coil, GP Sheet, Galvalume Coil/Sheet, Chequered Coil/Sheet\n` +
    `🏗️ *Structural Steel:* MS Round Bar, MS Flat Bar, MS Square Bar, TMT Bar, MS Angle, MS Channel, MS Beam\n` +
    `🔘 *Pipes & Tubes:* MS Round Pipe, MS Square Pipe, MS Rectangular Tube\n` +
    `⚡ *Value Added:* Slotted Angle, Solar Mounting Structure, Cable Tray (Perforated/Ladder), GI Earthing Strip\n\n` +
    `Please reply with the matching product name.`;
}

module.exports = {
  detectHsnCode,
  normalizeProductToCatalog,
  isValidCatalogProduct,
  getUnknownProductClarificationMessage,
  MASTER_PRODUCTS_CATALOG,
};
