import sharp from 'sharp';
import { previewFailed } from './errors.js';

// JPEG previews are converted on demand (decision D25): the original is never changed or stored again.
// A photo from an iPhone can carry an HDR gain map (MPF/XMP) and a Display P3 profile, and some of those
// fail to display in iPhone Safari. The preview is a plain baseline JPEG instead: rotated by its EXIF
// orientation, at most PREVIEW_MAX_EDGE px on its longest side (never enlarged), in sRGB, with no metadata
// and no gain map (sharp drops all of these unless asked to keep them).

export const PREVIEW_MAX_EDGE = 2048;
const JPEG_QUALITY = 85;
// Refuse pictures over this many pixels before decoding them (a decompression bomb is small on disk).
// 128 MP is well above any phone camera (48 MP) and about 11,300 px square.
const MAX_INPUT_PIXELS = 128_000_000;
const CONVERSION_TIMEOUT_SECONDS = 30;
// sharp's default (`failOn: 'warning'`) also rejects files with harmless decoder warnings (stray bytes between
// segments) that every browser displays. 'error' still rejects cut-off and corrupt data.
// At most this many conversions run at once, and a request holds its source in memory only while it has
// a slot (up to MAX_UPLOAD_MB each): the peak is a few times MAX_UPLOAD_MB however many previews are asked for.
export const MAX_CONCURRENT_CONVERSIONS = 2;

sharp.cache(false); // don't keep decoded pictures between requests

// The preview JPEG for `bytes`. Anything that is not a decodable JPEG (corrupt, cut off, over the pixel limit,
// a different format with a .jpg name) is the fixed PREVIEW_FAILED error; the decoder's own message, which
// names libvips internals, is only logged.
export async function normalizeJpeg(bytes, { maxPixels = MAX_INPUT_PIXELS } = {}) {
  try {
    // Only JPEG goes to the decoder: a file named .jpg that is really an SVG or another format is refused.
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw new Error('not a JPEG (no SOI marker)');
    return await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' })
      .rotate()
      .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .jpeg({ quality: JPEG_QUALITY })
      .timeout({ seconds: CONVERSION_TIMEOUT_SECONDS })
      .toBuffer();
  } catch (err) {
    console.error('JPEG preview conversion failed:', err);
    throw previewFailed();
  }
}

// Runs at most `limit` tasks at once; the others wait their turn in order. A task's failure frees its slot
// and rejects only its own caller.
export function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  const startNext = () => {
    while (active < limit && waiting.length > 0) {
      active += 1;
      waiting.shift()();
    }
  };
  return {
    run: (task) =>
      new Promise((resolve, reject) => {
        waiting.push(() => {
          (async () => task())()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              startNext();
            });
        });
        startNext();
      }),
  };
}
