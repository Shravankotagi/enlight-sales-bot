const sharp = require('sharp');

/**
 * Compresses an image buffer using sharp:
 * - Resizes dimensions to max 1200x1200px (maintains aspect ratio, never enlarges)
 * - Auto-rotates based on EXIF orientation
 * - Encodes as JPEG with quality 75 and progressive rendering
 * - Reduces file size by 75-90% without visible loss for complaint evidence / documents
 * - Safely passes through non-image buffers (e.g. PDFs) or on compression errors
 *
 * @param {Buffer} buffer - Raw input buffer
 * @param {string} mimeType - e.g. 'image/jpeg', 'image/png', 'application/pdf'
 * @returns {Promise<{ buffer: Buffer, mimeType: string, isCompressed: boolean, originalSize?: number, compressedSize?: number }>}
 */
async function compressImageBuffer(buffer, mimeType = 'image/jpeg') {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { buffer, mimeType, isCompressed: false };
  }

  const cleanMime = (mimeType || '').toLowerCase();
  // Don't compress PDFs or non-image files
  if (cleanMime.includes('pdf') || (!cleanMime.startsWith('image/') && !cleanMime.includes('octet-stream'))) {
    return { buffer, mimeType, isCompressed: false };
  }

  try {
    const compressed = await sharp(buffer)
      .rotate() // Auto-orient based on EXIF orientation tag
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 75,
        progressive: true,
        mozjpeg: true,
      })
      .toBuffer();

    return {
      buffer: compressed,
      mimeType: 'image/jpeg',
      isCompressed: true,
      originalSize: buffer.length,
      compressedSize: compressed.length,
    };
  } catch (err) {
    console.warn('[ImageCompressor] Compression fallback notice:', err.message);
    return { buffer, mimeType, isCompressed: false };
  }
}

module.exports = {
  compressImageBuffer,
};
