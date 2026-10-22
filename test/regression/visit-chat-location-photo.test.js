// Issue: <add GitHub issue link>
// A visit location pin is stored and geocoded before a camera photo is accepted.
const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const {
  attachVisitMedia,
  fillVisitCity,
  nextVisitPrompts,
} = require('../../src/core/visitRequirements');

const originalFetch = globalThis.fetch;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;

after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});

function geocodeResponse() {
  return {
    ok: true,
    json: async () => ({
      status: 'OK',
      results: [
        {
          formatted_address: 'Plant 2, Bhosari, Pune, Maharashtra',
          types: ['premise'],
          address_components: [
            { long_name: 'Plant 2', types: ['premise'] },
            { long_name: 'Bhosari', types: ['sublocality'] },
            { long_name: 'Pune', types: ['locality'] },
            { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
          ],
        },
      ],
    }),
  };
}

test('a location pin stores coordinates and the geocoded address', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
  globalThis.fetch = async () => geocodeResponse();
  const draft = {};
  attachVisitMedia(draft, null, { latitude: 18.52, longitude: 73.85, accuracy: 12 });
  await fillVisitCity(draft);

  assert.equal(draft.gps_latitude, 18.52);
  assert.equal(draft.gps_longitude, 73.85);
  assert.equal(draft.location_source, 'gps');
  assert.match(draft.city_location, /Plant 2/);
  assert.match(draft.city_location, /Pune/);
});

test('an image before the pin stays a document and the reply asks for the pin', () => {
  const draft = {};
  const image = {
    url: 'data:image/jpeg;base64,early',
    type: 'image/jpeg',
    messageType: 'image',
  };
  attachVisitMedia(draft, image, null);

  assert.equal(draft.gps_photo_url, undefined);
  assert.equal(draft.attachments[0].url, image.url);
  const prompts = nextVisitPrompts(draft);
  assert.equal(
    prompts[0],
    'Share a location pin first, then send the visit photo from the camera.',
  );
});

test('an image after the pin becomes the visit photo', () => {
  const draft = {
    gps_latitude: 18.52,
    gps_longitude: 73.85,
    city_location: 'Plant 2, Pune',
  };
  const image = {
    url: 'data:image/jpeg;base64,after',
    type: 'image/jpeg',
    messageType: 'image',
  };
  attachVisitMedia(draft, image, null);

  assert.equal(draft.gps_photo_url, image.url);
  assert.equal(draft.gps_latitude, 18.52);
});

test('a document and an assistant upload stay attachments', () => {
  const draft = { gps_latitude: 18.52, gps_longitude: 73.85, city_location: 'Pune' };
  const document = {
    url: 'data:application/pdf;base64,doc',
    type: 'application/pdf',
    messageType: 'document',
  };
  const upload = {
    url: 'data:image/png;base64,upload',
    type: 'image/png',
    photoSource: 'upload',
  };
  attachVisitMedia(draft, document, null);
  attachVisitMedia(draft, upload, { latitude: 18.52, longitude: 73.85 });

  assert.equal(draft.gps_photo_url, undefined);
  assert.deepEqual(
    draft.attachments.map((item) => item.url),
    [document.url, upload.url],
  );
});

test('an assistant camera photo with coordinates is the visit photo', () => {
  const draft = {};
  const photo = {
    url: 'data:image/jpeg;base64,camera',
    type: 'image/jpeg',
    photoSource: 'camera',
    messageType: 'image',
  };
  attachVisitMedia(draft, photo, { latitude: 18.52, longitude: 73.85, accuracy: 8 });

  assert.equal(draft.gps_photo_url, photo.url);
  assert.equal(draft.gps_latitude, 18.52);
  assert.equal(draft.gps_longitude, 73.85);
  assert.equal(draft.location_source, 'gps');
});

test('a typed city does not count as a WhatsApp visit location', () => {
  const draft = { city_location: 'Pune', delivery_location: 'Pune' };
  const prompts = nextVisitPrompts(draft);

  assert.ok(prompts.includes('Share a WhatsApp location pin.'));
  assert.equal(draft.city_location, '');
  assert.equal(draft.location_source, null);
  assert.equal(draft.delivery_location, 'Pune');
});

test('a typed city still counts on the assistant', () => {
  const draft = { city_location: 'Pune', source_channel: 'ai_assistant' };
  const prompts = nextVisitPrompts(draft);

  assert.equal(prompts.includes('Share a WhatsApp location pin.'), false);
  assert.equal(draft.city_location, 'Pune');
  assert.equal(draft.location_source, 'manual');
});

test('a WhatsApp pin replaces a typed city with the geocoded address', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  globalThis.fetch = async () => geocodeResponse();
  const draft = {
    city_location: 'Pune',
    location_source: 'gps',
    gps_latitude: 18.6298,
    gps_longitude: 73.7997,
  };

  await fillVisitCity(draft);

  assert.equal(draft.gps_latitude, 18.6298);
  assert.equal(draft.city_location, 'Plant 2, Bhosari, Pune, Maharashtra');
});
