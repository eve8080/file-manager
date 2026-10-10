import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PREVIEW_MAX_EDGE, createLimiter, normalizeJpeg } from '../src/jpeg-preview.js';
import { centrePixel, jpegFixture, jpegHeaderSegments } from './helpers/jpeg-fixtures.js';
import { solidPng } from './helpers/fixtures.js';

const near = (actual, expected, tolerance = 4) =>
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${actual} is not within ${tolerance} of ${expected}`);
const hasSecondImage = (jpeg) => jpeg.indexOf(Buffer.from([0xff, 0xd8]), 2) !== -1; // 0xFFD8 cannot occur inside scan data

describe('the fixtures themselves (synthetic, like an iPhone photo)', () => {
  it('a gain-map fixture has EXIF, XMP, MPF, a Display P3 profile and a second image; sharp reads a gain map in it', async () => {
    const jpeg = await jpegFixture({ width: 300, height: 200, p3: true, orientation: 6, gainMap: true });
    const idents = jpegHeaderSegments(jpeg).map((s) => s.ident);
    for (const wanted of ['Exif', 'MPF', 'ICC_PROFILE', 'http://ns.adobe.com/xap/1.0/']) assert.ok(idents.includes(wanted), wanted);
    assert.equal(hasSecondImage(jpeg), true);
    const metadata = await sharp(jpeg).metadata();
    assert.ok(metadata.gainMap, 'sharp sees an HDR gain map');
    assert.equal(metadata.orientation, 6);
  });

  it('a P3 fixture really is P3: without its profile the pixel numbers are not the sRGB colour', async () => {
    const p3 = await jpegFixture({ p3: true, color: [200, 100, 50] });
    assert.ok((await sharp(p3).metadata()).icc);
    const bare = Buffer.concat([p3.subarray(0, 2), ...stripIcc(p3.subarray(2))]);
    const { data } = await sharp(bare).raw().toBuffer({ resolveWithObject: true });
    assert.notDeepEqual([...data.subarray(0, 3)], [200, 100, 50]);
  });
});

function stripIcc(rest) {
  const kept = [];
  let at = 0;
  while (rest[at] === 0xff && rest[at + 1] !== 0xda) {
    const length = rest.readUInt16BE(at + 2);
    const segment = rest.subarray(at, at + 2 + length);
    if (!(rest[at + 1] === 0xe2 && segment.toString('latin1', 4, 15) === 'ICC_PROFILE')) kept.push(segment);
    at += 2 + length;
  }
  kept.push(rest.subarray(at));
  return kept;
}

describe('normalizeJpeg (M4)', () => {
  it('the longest edge is limited to 2048 px, keeping the aspect ratio', async () => {
    assert.equal(PREVIEW_MAX_EDGE, 2048);
    for (const [w, h, expected] of [
      [3000, 2000, [2048, 1365]],
      [2000, 3000, [1365, 2048]],
      [4000, 4000, [2048, 2048]],
    ]) {
      const out = await sharp(await normalizeJpeg(await jpegFixture({ width: w, height: h }))).metadata();
      assert.deepEqual([out.format, out.width, out.height], ['jpeg', ...expected], `${w}x${h}`);
    }
  });

  it('a picture within 2048 px is never enlarged', async () => {
    for (const [w, h] of [[64, 48], [2048, 1000], [1000, 2048]]) {
      const out = await sharp(await normalizeJpeg(await jpegFixture({ width: w, height: h }))).metadata();
      assert.deepEqual([out.width, out.height], [w, h]);
    }
  });

  it('applies the EXIF orientation to the pixels and drops the tag', async () => {
    const out = await sharp(await normalizeJpeg(await jpegFixture({ width: 300, height: 200, orientation: 6 }))).metadata();
    assert.deepEqual([out.width, out.height, out.orientation], [200, 300, undefined]);
  });

  it('Display P3 pixels are converted to sRGB and the profile is not carried over', async () => {
    const p3 = await jpegFixture({ p3: true, color: [200, 100, 50] });
    const out = await normalizeJpeg(p3);
    const metadata = await sharp(out).metadata();
    assert.equal(metadata.space, 'srgb');
    assert.equal(metadata.icc, undefined);
    assert.ok(!jpegHeaderSegments(out).some((s) => s.ident === 'ICC_PROFILE'));
    // The file's own numbers are P3 (187,106,63); the preview must show the same colour in sRGB numbers.
    near(await centrePixel(out), [200, 100, 50]);
  });

  it('a CMYK JPEG becomes a 3-channel sRGB JPEG', async () => {
    const cmyk = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c86432' } }).toColourspace('cmyk').jpeg().toBuffer();
    assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');
    const metadata = await sharp(await normalizeJpeg(cmyk)).metadata();
    assert.deepEqual([metadata.space, metadata.channels], ['srgb', 3]);
  });

  it('strips EXIF, XMP, MPF, the colour profile, the gain map and the second image; the result is one plain baseline JPEG', async () => {
    const original = await jpegFixture({ width: 3000, height: 2000, p3: true, orientation: 6, gainMap: true });
    const out = await normalizeJpeg(original);
    assert.deepEqual(
      jpegHeaderSegments(out).filter((s) => ['APP1', 'APP2', 'APP13', 'APP14', 'COM'].includes(s.name)),
      [],
      'no EXIF / XMP / MPF / ICC / comment segments',
    );
    const text = out.toString('latin1');
    for (const forbidden of ['hdrgm', 'MPF', 'Exif', 'xmpmeta', 'ICC_PROFILE']) assert.ok(!text.includes(forbidden), forbidden);
    assert.equal(hasSecondImage(out), false, 'the gain-map image is gone');
    assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9], 'ends at the end of the single image');
    const metadata = await sharp(out).metadata();
    assert.deepEqual([metadata.gainMap, metadata.isProgressive, metadata.exif, metadata.xmp], [undefined, false, undefined, undefined]);
    assert.ok(out.length < original.length);
  });

  it('a recognised HDR gain map does not change the colours of the preview', async () => {
    const out = await normalizeJpeg(await jpegFixture({ width: 600, height: 400, p3: true, gainMap: true, color: [200, 100, 50] }));
    near(await centrePixel(out), [200, 100, 50]);
  });

  it('a JPEG with harmless decoder warnings (stray bytes between segments, which browsers ignore) is still converted', async () => {
    const good = await jpegFixture({ width: 600, height: 400, p3: true });
    const segmentEnd = (n) => jpegHeaderSegments(good).slice(0, n).reduce((at, segment) => at + 2 + segment.length, 2);
    const withStrayBytes = (at, bytes) => Buffer.concat([good.subarray(0, at), Buffer.from(bytes), good.subarray(at)]);
    const variants = {
      'two stray bytes after the first segment': withStrayBytes(segmentEnd(1), [0x11, 0x22]),
      'three stray bytes after the third segment': withStrayBytes(segmentEnd(3), [0x00, 0x01, 0x02]),
    };
    for (const [label, bytes] of Object.entries(variants)) {
      const out = await sharp(await normalizeJpeg(bytes)).metadata();
      assert.deepEqual([out.format, out.width, out.height], ['jpeg', 600, 400], label);
    }
  });

  it('input that is not a decodable JPEG fails with one fixed public error and never leaks sharp/libvips text', async () => {
    const good = await jpegFixture({ width: 600, height: 400 });
    const inputs = {
      'plain text': Buffer.from('not really a jpeg'),
      empty: Buffer.alloc(0),
      'truncated JPEG': good.subarray(0, 300),
      'JPEG missing its tail': good.subarray(0, good.length - 200),
      'a PNG named .jpg': solidPng(8, 8),
      'an SVG named .jpg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'),
    };
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args);
    try {
      for (const [label, bytes] of Object.entries(inputs)) {
        await assert.rejects(normalizeJpeg(bytes), (err) => {
          assert.equal(err.status, 422, label);
          assert.equal(err.code, 'PREVIEW_FAILED', label);
          assert.equal(err.message, 'This image could not be converted for preview. Download it to open it in another app.', label);
          assert.equal(err.details, undefined, label);
          assert.ok(!/vips|sharp|jpeg image|buffer/i.test(`${err.message}${err.stack ?? ''}`.replace(/normalizeJpeg|jpeg-preview/gi, '')), label);
          return true;
        });
      }
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.length >= 1, 'the raw decoder error is logged server-side');
  });

  it('a picture over the pixel limit is refused before it is decoded', async () => {
    const big = await jpegFixture({ width: 300, height: 200 });
    await assert.rejects(quiet(() => normalizeJpeg(big, { maxPixels: 59_999 })), { status: 422, code: 'PREVIEW_FAILED' });
    assert.ok((await normalizeJpeg(big, { maxPixels: 60_000 })).length > 0, 'exactly the limit is allowed');
  });
});

async function quiet(fn) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = originalError;
  }
}

describe('createLimiter (M4: bounds simultaneous conversions)', () => {
  it('runs at most N tasks at once, starts the rest in order as slots free up, and returns each result', async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let peak = 0;
    const started = [];
    const gates = [];
    const task = (n) => () => {
      started.push(n);
      running += 1;
      peak = Math.max(peak, running);
      return new Promise((resolve) => gates.push(() => { running -= 1; resolve(n * 10); }));
    };
    const results = [1, 2, 3, 4, 5].map((n) => limiter.run(task(n)));
    await tick();
    assert.deepEqual(started, [1, 2]);
    gates.shift()();
    await tick();
    assert.deepEqual(started, [1, 2, 3]);
    while (gates.length) {
      gates.shift()();
      await tick();
    }
    assert.deepEqual(await Promise.all(results), [10, 20, 30, 40, 50]);
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
  });

  it('a failing task frees its slot and rejects only its own caller', async () => {
    const limiter = createLimiter(1);
    const failing = limiter.run(async () => { throw new Error('boom'); });
    const after = limiter.run(async () => 'ok');
    await assert.rejects(failing, { message: 'boom' });
    assert.equal(await after, 'ok');
  });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
