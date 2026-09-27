require('dotenv').config();
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { compressImageBuffer } = require('../src/utils/imageCompressor');
const { supabase, getPhoneVariants } = require('../src/supabase');
const sharp = require('sharp');

async function runTest() {
  console.log('=== TEST 1: Sharp Image Compression ===');
  const sampleImage = await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 3,
      background: { r: 200, g: 150, b: 100 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log('Original image buffer size:', sampleImage.length, 'bytes');
  const compressedResult = await compressImageBuffer(sampleImage, 'image/jpeg');
  console.log('Compressed image buffer size:', compressedResult.compressedSize, 'bytes');
  console.log('Compression achieved:', Math.round((1 - compressedResult.compressedSize / sampleImage.length) * 100) + '% reduction');

  console.log('\n=== TEST 2: Complaint Logging Flow - Select Option 8 & Submit Text Details ===');
  const testPhone = '918262937458';
  
  // Clean start: clear any previous session from DB
  const phoneVariants = getPhoneVariants(testPhone);
  await supabase.from('conversation_sessions').delete().in('salesperson_phone', phoneVariants);

  // 1. User selects option 8
  const menuSelectResult = await handleCatalogFlow('8', testPhone);
  console.log('Menu 8 Prompt:\n' + menuSelectResult.reply);

  // 2. User submits all complaint details with PO number
  const textInput = `Menon Industries, PO: PO-MEN-250926, Raised by: Rajesh Sharma, Product: HR Coil 2.5 mm, Challan: CH-9081, Description: 12 MT HR coil with bending damage and edge cuts`;
  const step1Result = await handleCatalogFlow(textInput, testPhone);
  console.log('\nStep 1 (Details submitted) Reply:\n' + step1Result.reply);
  console.log('Step 1 Interactive Type:', step1Result.interactiveType);
  console.log('Step 1 Interactive Buttons:', JSON.stringify(step1Result.interactiveButtons));

  if (!step1Result.reply.includes('Do you want to attach photos')) {
    console.error('FAILED: Step 1 did not prompt for photo attachment');
    process.exit(1);
  }

  console.log('\n=== TEST 3: Multi-Photo Batch Submission (3 photos in one shot) ===');
  // Simulate 3 distinct compressed image attachments
  const buf1 = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
  const buf2 = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 0, g: 255, b: 0 } } }).jpeg().toBuffer();
  const buf3 = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();

  const c1 = await compressImageBuffer(buf1, 'image/jpeg');
  const c2 = await compressImageBuffer(buf2, 'image/jpeg');
  const c3 = await compressImageBuffer(buf3, 'image/jpeg');

  const attachments = [
    {
      name: 'evidence-1.jpg',
      type: 'image',
      url: `data:image/jpeg;base64,${c1.buffer.toString('base64')}`,
      file_url: `data:image/jpeg;base64,${c1.buffer.toString('base64')}`,
      file_name: 'complaint_evidence_1.jpg',
      file_type: 'image/jpeg',
      file_size: c1.buffer.length,
      uploaded_at: new Date().toISOString(),
    },
    {
      name: 'evidence-2.jpg',
      type: 'image',
      url: `data:image/jpeg;base64,${c2.buffer.toString('base64')}`,
      file_url: `data:image/jpeg;base64,${c2.buffer.toString('base64')}`,
      file_name: 'complaint_evidence_2.jpg',
      file_type: 'image/jpeg',
      file_size: c2.buffer.length,
      uploaded_at: new Date().toISOString(),
    },
    {
      name: 'evidence-3.jpg',
      type: 'image',
      url: `data:image/jpeg;base64,${c3.buffer.toString('base64')}`,
      file_url: `data:image/jpeg;base64,${c3.buffer.toString('base64')}`,
      file_name: 'complaint_evidence_3.jpg',
      file_type: 'image/jpeg',
      file_size: c3.buffer.length,
      uploaded_at: new Date().toISOString(),
    },
  ];

  const step2Result = await handleCatalogFlow('Evidence attachment uploaded', testPhone, { attachments });
  console.log('Step 2 (3 Photos Uploaded) Confirmation Reply:\n' + step2Result.reply);
  console.log('Step 2 Interactive Type:', step2Result.interactiveType);
  console.log('Step 2 Interactive Buttons:', JSON.stringify(step2Result.interactiveButtons));

  if (!step2Result.reply.includes('• *Evidence:* 3 file(s) attached')) {
    console.error('FAILED: Confirmation card does not show 3 file(s) attached');
    process.exit(1);
  }

  console.log('\n=== TEST 4: Cancel and Test "No" path ===');
  // Cancel draft
  await handleCatalogFlow('cancel', testPhone);

  // Select Option 8 again
  await handleCatalogFlow('8', testPhone);

  // Submit details again
  await handleCatalogFlow(textInput, testPhone);

  // Send "No"
  const stepNoResult = await handleCatalogFlow('No', testPhone);
  console.log('Step "No" Confirmation Reply:\n' + stepNoResult.reply);
  console.log('Step "No" Interactive Type:', stepNoResult.interactiveType);
  console.log('Step "No" Interactive Buttons:', JSON.stringify(stepNoResult.interactiveButtons));

  if (stepNoResult.reply.includes('• *Evidence:*')) {
    console.error('FAILED: Evidence line should not appear when user chooses "No"');
    process.exit(1);
  }

  // Cancel draft to clean up test session
  await handleCatalogFlow('cancel', testPhone);
  await supabase.from('conversation_sessions').delete().in('salesperson_phone', phoneVariants);

  console.log('\nALL TESTS PASSED SUCCESSFULLY! ✅');
}

runTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
