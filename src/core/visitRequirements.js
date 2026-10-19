const crypto = require('crypto');

const VISIT_BRANDS = ['TATA', 'JSW', 'AM/NS India', 'SAIL', 'NMDC', 'Apollo', 'Others'];
const VISIT_PAYMENT_TERMS = ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', 'LC', 'BG', 'PDC'];
const VISIT_CUSTOMER_TYPES = ['OEM', 'Fabricator', 'EPC', 'Manufacturer', 'Trader'];
const VISIT_TYPES = ['First Visit', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Regular Visit'];
const VISIT_OUTCOMES = ['Positive', 'Neutral', 'Negative'];
const VISIT_PROBABILITIES = ['Hot', 'Warm', 'Cold'];

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = 10 * 60 * 1000;

const BRAND_ALIASES = {
  tata: 'TATA',
  jsw: 'JSW',
  'am/ns india': 'AM/NS India',
  'amns india': 'AM/NS India',
  amns: 'AM/NS India',
  sail: 'SAIL',
  nmdc: 'NMDC',
  apollo: 'Apollo',
  others: 'Others',
  other: 'Others',
};

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashVisitSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function last10(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function canonical(list, value) {
  const raw = text(value).toLowerCase();
  return list.find((item) => item.toLowerCase() === raw) || '';
}

function canonicalBrand(value) {
  const raw = text(value).toLowerCase();
  return BRAND_ALIASES[raw] || canonical(VISIT_BRANDS, value);
}

function canonicalPayment(value) {
  const raw = text(value).toLowerCase();
  const direct = canonical(VISIT_PAYMENT_TERMS, value);
  if (direct) return direct;
  if (/\bimmediate\b/.test(raw)) return 'Immediate';
  if (/\badvance\b/.test(raw)) return 'Advance';
  if (/\b30\b/.test(raw)) return '30 Days';
  if (/\b45\b/.test(raw)) return '45 Days';
  if (/\b60\b/.test(raw)) return '60 Days';
  if (/\blc\b/.test(raw)) return 'LC';
  if (/\bbg\b/.test(raw)) return 'BG';
  if (/\bpdc\b/.test(raw)) return 'PDC';
  return '';
}

function canonicalOutcome(value) {
  const raw = text(value).toLowerCase().replace(/[_-]+/g, ' ');
  if (raw === 'positive') return 'Positive';
  if (raw === 'neutral') return 'Neutral';
  if (raw === 'negative') return 'Negative';
  return '';
}

function cityFromNominatim(body) {
  const address = body?.address || {};
  return (
    address.city ||
    address.town ||
    address.city_district ||
    address.municipality ||
    address.suburb ||
    address.village ||
    address.county ||
    ''
  );
}

function firstText(values) {
  return values.map(text).find(Boolean) || '';
}

function addressFromNominatim(body) {
  const address = body?.address || {};
  const building = firstText([
    body?.namedetails?.name,
    body?.name,
    address.building,
    address.house_name,
    address.amenity,
    address.shop,
    address.office,
    address.tourism,
  ]);
  const street = firstText([
    address.road,
    address.pedestrian,
    address.footway,
    address.street,
    address.residential,
  ]);
  const locality = firstText([
    address.city,
    address.town,
    address.city_district,
    address.municipality,
    address.village,
    address.county,
  ]);
  const parts = [
    building,
    address.house_number,
    street,
    address.suburb || address.neighbourhood,
    locality,
    address.state,
    address.postcode,
  ]
    .map(text)
    .filter(Boolean);
  const composed = [...new Set(parts)].join(', ');
  if (building || street) return composed;
  return text(body?.display_name) || composed;
}

function googleComponent(result, type) {
  const match = (result?.address_components || []).find(
    (part) => Array.isArray(part?.types) && part.types.includes(type),
  );
  return text(match?.long_name);
}

function googleResultRank(result) {
  const types = Array.isArray(result?.types) ? result.types : [];
  const has = (type) => types.includes(type);
  let rank = 0;
  if (has('premise') || has('subpremise') || has('street_address')) rank = 3;
  else if (has('establishment') || has('point_of_interest')) rank = 2;
  else if (has('route')) rank = 1;
  else if (googleComponent(result, 'premise') || googleComponent(result, 'subpremise')) rank = 3;
  else if (googleComponent(result, 'route')) rank = 1;
  if (result?.geometry?.location_type === 'ROOFTOP') rank += 0.5;
  return rank;
}

function selectGoogleGeocodeResult(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  let best = null;
  let bestRank = -1;
  for (const result of results) {
    const rank = googleResultRank(result);
    if (rank > bestRank) {
      best = result;
      bestRank = rank;
    }
  }
  return best;
}

function addressFromGoogleGeocode(body) {
  const result = selectGoogleGeocodeResult(body);
  if (!result) return '';
  const types = Array.isArray(result.types) ? result.types : [];
  const formatted = text(result.formatted_address);
  const premise = googleComponent(result, 'premise') || googleComponent(result, 'subpremise');
  const streetNumber = googleComponent(result, 'street_number');
  const route = googleComponent(result, 'route');
  const firstSegment = formatted.split(',')[0]?.trim() || '';
  const isPlace = types.includes('establishment') || types.includes('point_of_interest');
  const building =
    premise ||
    (isPlace && firstSegment && firstSegment !== route && firstSegment !== streetNumber
      ? firstSegment
      : '');
  const street = [streetNumber, route].filter(Boolean).join(' ');
  if (!building && !street) return formatted;
  const area =
    googleComponent(result, 'sublocality_level_1') ||
    googleComponent(result, 'sublocality') ||
    googleComponent(result, 'neighborhood');
  const parts = [
    building,
    street,
    area,
    googleComponent(result, 'locality'),
    googleComponent(result, 'administrative_area_level_1'),
    googleComponent(result, 'postal_code'),
  ]
    .map(text)
    .filter(Boolean);
  const unique = parts.filter(
    (part, index) => parts.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index,
  );
  return unique.join(', ') || formatted;
}

function cityFromGoogleGeocode(body) {
  const result = selectGoogleGeocodeResult(body);
  if (!result) return '';
  return googleComponent(result, 'locality');
}

function readDraft(draft) {
  const source = draft || {};
  const brands = (Array.isArray(source.preferred_make)
    ? source.preferred_make
    : text(source.preferred_make).split(/,| and /))
    .map(canonicalBrand)
    .filter(Boolean);
  const uniqueBrands = [...new Set(brands)];
  const phone = last10(source.contact_phone || source.contact_no || source.phone);
  const email = text(source.email).toLowerCase();
  const latitude = finiteNumber(source.gps_latitude ?? source.visit_latitude);
  const longitude = finiteNumber(source.gps_longitude ?? source.visit_longitude);
  const followDate = text(source.follow_up_date || source.followup_date);
  const action = text(source.followup_action || source.follow_up_action);
  const dateInAction = action.match(/\b(\d{1,2}-\d{1,2}-\d{4})\b/);
  return {
    company: text(source.company_name || source.customer_name),
    person: text(source.person_met),
    designation: text(source.designation),
    phone,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    city: text(source.city_location || source.city || source.location),
    visitDate: text(source.visit_date || source.visit_date_display),
    customerType: canonical(VISIT_CUSTOMER_TYPES, source.customer_type),
    visitType: canonical(VISIT_TYPES, source.visit_type),
    outcome: canonicalOutcome(source.visit_outcome || source.outcome),
    probability: canonical(VISIT_PROBABILITIES, source.customer_probability),
    product: text(source.product_details),
    consumption: text(source.monthly_consumption),
    requirement: text(source.current_requirement),
    nextPurchase: text(source.next_purchase_expected),
    delivery: text(source.delivery_location),
    brands: uniqueBrands,
    brandOther: text(source.preferred_make_other),
    payment: canonicalPayment(source.payment_terms),
    followAction: action,
    followDate: followDate || (dateInAction ? dateInAction[1] : ''),
    remarks: text(source.meeting_remarks || source.remarks),
    photo: text(source.gps_photo_url),
    latitude,
    longitude,
    token: text(source.verification_token),
  };
}

function writeDraft(draft, view) {
  if (!draft) return;
  if (view.company) draft.company_name = draft.company_name || draft.customer_name || view.company;
  if (view.phone) {
    draft.contact_phone = view.phone;
    draft.contact_no = view.phone;
  }
  if (view.email) draft.email = view.email;
  if (view.customerType) draft.customer_type = view.customerType;
  if (view.visitType) draft.visit_type = view.visitType;
  if (view.outcome) draft.visit_outcome = view.outcome;
  if (view.probability) draft.customer_probability = view.probability;
  if (view.brands.length) draft.preferred_make = view.brands.join(', ');
  if (view.brandOther) draft.preferred_make_other = view.brandOther;
  if (view.payment) draft.payment_terms = view.payment;
  if (view.followDate) draft.follow_up_date = view.followDate;
  if (view.city) {
    draft.city_location = view.city;
    draft.city = view.city;
  }
  if (view.latitude != null && view.longitude != null) {
    draft.location_source = 'gps';
    draft.visit_latitude = view.latitude;
    draft.visit_longitude = view.longitude;
  } else if (view.city) {
    draft.location_source = 'manual';
    draft.visit_latitude = null;
    draft.visit_longitude = null;
  }
}

function nextVisitPrompts(draft) {
  const view = readDraft(draft);
  writeDraft(draft, view);
  const prompts = [
    !view.company && 'Customer / Company Name',
    !view.person && 'Person Met',
    !view.designation && 'Designation',
    !view.phone && 'Contact Phone (10-digit mobile number)',
    !view.email && 'Email',
    !view.visitDate && 'Visit Date (e.g. 10-09-2026)',
    !view.customerType && `Customer Type: ${VISIT_CUSTOMER_TYPES.join(', ')}`,
    !view.visitType && `Visit Type: ${VISIT_TYPES.join(', ')}`,
    !view.outcome && `Visit Outcome: ${VISIT_OUTCOMES.join(', ')}`,
    !view.probability && `Customer Probability: ${VISIT_PROBABILITIES.join(', ')}`,
    !view.product && 'Product Details',
    !view.consumption && 'Monthly Consumption',
    !view.requirement && 'Current Requirement',
    !view.nextPurchase && 'Next Purchase Expected',
    !view.delivery && 'Delivery Location',
    view.brands.length === 0 && `Preferred Brand: ${VISIT_BRANDS.join(', ')}`,
    view.brands.includes('Others') && !view.brandOther && 'Other brand',
    !view.payment && `Payment Terms: ${VISIT_PAYMENT_TERMS.join(', ')}`,
    !view.followAction && 'Follow-up Action',
    !view.followDate && 'Follow-up Date (e.g. 20-10-2026)',
    !view.remarks && 'Meeting Remarks',
    !view.photo && 'Visit photo from the camera',
  ].filter(Boolean);
  if (!view.city && view.latitude != null) {
    prompts.push('City could not be read from the location. Type the city.');
  } else if (!view.city) {
    prompts.push('Location pin or city. Share a location pin, or type the city if GPS is unavailable.');
  }
  return prompts;
}

function assertReadyToSave(draft) {
  const prompts = nextVisitPrompts(draft);
  if (prompts.length > 0) return { ok: false, prompts, message: '' };
  if (!readDraft(draft).token) {
    return { ok: false, prompts: [], message: 'Enter the visit code sent to the customer.' };
  }
  return { ok: true, prompts: [], message: '' };
}

function followUpDateForRow(value) {
  const raw = text(value);
  const dmy = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return raw;
}

function visitRowColumns(draft) {
  const view = readDraft(draft);
  writeDraft(draft, view);
  return {
    email: view.email,
    designation: view.designation,
    customer_type: view.customerType,
    visit_type: view.visitType,
    outcome: view.outcome.toLowerCase(),
    customer_probability: view.probability,
    product_details: view.product,
    monthly_consumption: view.consumption,
    current_requirement: view.requirement,
    next_purchase_expected: view.nextPurchase,
    delivery_location: view.delivery,
    preferred_make: view.brands.join(', '),
    preferred_make_other: view.brands.includes('Others') ? view.brandOther : null,
    payment_terms: view.payment,
    follow_up_action: view.followAction,
    follow_up_date: followUpDateForRow(view.followDate),
    phone_verified: true,
    phone_verified_at: new Date().toISOString(),
    location_source: view.latitude != null ? 'gps' : 'manual',
    visit_latitude: view.latitude,
    visit_longitude: view.longitude,
    gps_photo_url: view.photo,
    gps_latitude: view.latitude,
    gps_longitude: view.longitude,
  };
}

function visitCodeMessage(otp) {
  return [
    'Enlight Metals – Customer Visits',
    '',
    `Your visit verification code is: *${otp}*`,
    '',
    'This code expires in 5 minutes. Do not share it with anyone.',
  ].join('\n');
}

async function defaultSendVisitCode(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    const error = new Error('WhatsApp is not configured for visit codes.');
    error.code = 'WHATSAPP_NOT_CONFIGURED';
    throw error;
  }
  const axios = require('axios');
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    },
  );
}

async function listVisitCodes(supabase, phone) {
  const { data, error } = await supabase
    .from('visit_phone_verifications')
    .select('*')
    .eq('phone', phone);
  if (error) throw new Error('Unable to send the visit code right now.');
  return data || [];
}

async function patchVisitCode(supabase, id, patch) {
  const { error } = await supabase.from('visit_phone_verifications').update(patch).eq('id', id);
  if (error) throw new Error('Unable to send the visit code right now.');
}

async function requestVisitCode(supabase, rawPhone, send = defaultSendVisitCode) {
  const phone = last10(rawPhone);
  if (!phone) return { ok: false, message: 'Enter a valid 10-digit mobile number.' };
  const rows = await listVisitCodes(supabase, phone);
  const newest = [...rows].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];
  if (newest && Date.now() - new Date(newest.created_at).getTime() < OTP_RESEND_MS) {
    return { ok: false, message: 'Wait 60 seconds before requesting another code.' };
  }
  const now = new Date();
  for (const row of rows) {
    if (!row.consumed_at) await patchVisitCode(supabase, row.id, { consumed_at: now.toISOString() });
  }
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const id = crypto.randomUUID();
  const { error } = await supabase.from('visit_phone_verifications').insert({
    id,
    phone,
    otp_hash: hashVisitSecret(otp),
    expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
    attempts: 0,
    locked: false,
    created_at: now.toISOString(),
  });
  if (error) return { ok: false, message: 'Unable to send the visit code right now.' };
  try {
    await send(`91${phone}`, visitCodeMessage(otp));
  } catch (err) {
    await patchVisitCode(supabase, id, {
      consumed_at: now.toISOString(),
      created_at: new Date(Date.now() - OTP_RESEND_MS - 1000).toISOString(),
    });
    const message = err?.code === 'WHATSAPP_NOT_CONFIGURED'
      ? 'WhatsApp is not configured for visit codes.'
      : 'The visit code could not be sent on WhatsApp. Try again.';
    console.warn(`Visit code WhatsApp send failed for ****${phone.slice(-4)}`);
    return { ok: false, message };
  }
  console.log(`Visit code sent to ****${phone.slice(-4)}`);
  return {
    ok: true,
    message: 'Code sent to the customer WhatsApp number. Reply with the 6-digit code. It expires in 5 minutes.',
  };
}

async function verifyVisitCode(supabase, rawPhone, rawOtp) {
  const phone = last10(rawPhone);
  const otp = text(rawOtp);
  const rows = await listVisitCodes(supabase, phone);
  const open = rows
    .filter((row) => !row.consumed_at)
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];
  if (!open) return { ok: false, message: 'Request a visit code before entering it.' };
  if (open.locked || Number(open.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, message: 'This code is locked. Request a new one.' };
  }
  if (new Date(open.expires_at).getTime() <= Date.now()) {
    return { ok: false, message: 'This code has expired. Request a new one.' };
  }
  if (open.otp_hash !== hashVisitSecret(otp)) {
    const attempts = Number(open.attempts || 0) + 1;
    const locked = attempts >= OTP_MAX_ATTEMPTS;
    await patchVisitCode(supabase, open.id, { attempts, locked });
    return {
      ok: false,
      message: locked ? 'This code is locked. Request a new one.' : 'That code is incorrect.',
    };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const verifiedAt = new Date();
  await patchVisitCode(supabase, open.id, {
    verified_at: verifiedAt.toISOString(),
    verification_token_hash: hashVisitSecret(token),
    token_expires_at: new Date(verifiedAt.getTime() + TOKEN_TTL_MS).toISOString(),
  });
  return { ok: true, token, message: 'Phone verified.' };
}

async function consumeVisitCode(supabase, rawPhone, token) {
  const phone = last10(rawPhone);
  const rows = await listVisitCodes(supabase, phone);
  const tokenHash = hashVisitSecret(text(token));
  const match = rows.find((row) =>
    row.verification_token_hash === tokenHash &&
    !row.consumed_at &&
    row.verified_at &&
    String(row.phone) === phone &&
    (!row.token_expires_at || new Date(row.token_expires_at).getTime() > Date.now()));
  if (!match) return { ok: false, message: 'Verify the customer phone before saving the visit.' };
  await patchVisitCode(supabase, match.id, { consumed_at: new Date().toISOString() });
  return { ok: true, id: match.id };
}

async function releaseVisitCode(supabase, id) {
  if (!id) return;
  await patchVisitCode(supabase, id, { consumed_at: null });
}

async function fillVisitCity(draft) {
  const view = readDraft(draft);
  if (view.city || view.latitude == null || view.longitude == null) return draft;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return draft;
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${view.latitude},${view.longitude}`)}&key=${encodeURIComponent(key)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return draft;
    const body = await response.json();
    if (body?.status !== 'OK') return draft;
    const location = addressFromGoogleGeocode(body) || cityFromGoogleGeocode(body);
    if (location) {
      draft.city_location = location;
      draft.city = location;
    }
  } catch {
    // A typed city remains available when the lookup fails.
  }
  return draft;
}

function attachVisitMedia(draft, attachment, gps) {
  if (!draft) return draft;
  if (attachment && attachment.url) {
    const isPdf = String(attachment.type || '').includes('pdf');
    const previous = Array.isArray(draft.attachments) ? draft.attachments : [];
    if (!previous.some((item) => item && item.url === attachment.url)) {
      draft.attachments = [...previous, attachment];
    }
    if (!isPdf && !draft.gps_photo_url) draft.gps_photo_url = attachment.url;
  }
  if (gps && finiteNumber(gps.latitude) != null && finiteNumber(gps.longitude) != null && draft.gps_latitude == null) {
    draft.gps_latitude = gps.latitude;
    draft.gps_longitude = gps.longitude;
    draft.gps_accuracy = gps.accuracy ?? null;
  }
  return draft;
}

function promptsFromVisitState(state) {
  return nextVisitPrompts({
    company_name: state.customer_name,
    person_met: state.person_met,
    designation: state.designation,
    contact_phone: state.contact_no,
    email: state.email,
    city_location: state.city,
    visit_date: state.visit_date_display,
    customer_type: state.customer_type,
    visit_type: state.visit_type,
    visit_outcome: state.visit_outcome,
    customer_probability: state.customer_probability,
    product_details: state.product_details,
    monthly_consumption: state.monthly_consumption,
    current_requirement: state.current_requirement,
    next_purchase_expected: state.next_purchase_expected,
    delivery_location: state.delivery_location,
    preferred_make: state.preferred_make,
    preferred_make_other: state.preferred_make_other,
    payment_terms: state.payment_terms,
    followup_action: state.follow_up_action,
    follow_up_date: state.follow_up_date,
    meeting_remarks: state.remarks,
    gps_photo_url: state.gps_photo_url,
    gps_latitude: state.gps_latitude,
    gps_longitude: state.gps_longitude,
    verification_token: state.verification_token,
  });
}

module.exports = {
  VISIT_BRANDS,
  VISIT_PAYMENT_TERMS,
  nextVisitPrompts,
  assertReadyToSave,
  visitRowColumns,
  requestVisitCode,
  verifyVisitCode,
  consumeVisitCode,
  releaseVisitCode,
  fillVisitCity,
  addressFromNominatim,
  addressFromGoogleGeocode,
  attachVisitMedia,
  promptsFromVisitState,
  hashVisitSecret,
};
