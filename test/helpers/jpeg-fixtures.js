// Deterministic, synthetic JPEGs for the normalised-preview tests. Nothing here is a real photo.
import sharp from 'sharp';

const xmp = (body) =>
  Buffer.concat([
    Buffer.from('http://ns.adobe.com/xap/1.0/\0'),
    Buffer.from(
      `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${body}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    ),
  ]);

// Inserts APPn segments right after SOI.
function withSegments(jpeg, segments) {
  const parts = [jpeg.subarray(0, 2)];
  for (const { marker, data } of segments) {
    const header = Buffer.from([0xff, marker, 0, 0]);
    header.writeUInt16BE(data.length + 2, 2);
    parts.push(header, data);
  }
  parts.push(jpeg.subarray(2));
  return Buffer.concat(parts);
}

// An MPF (CIPA DC-007) APP2 payload for two images: the primary of `primarySize` bytes and a second at
// `secondOffset` (from the start of the file) of `secondSize` bytes. Offsets in MPF are relative to its TIFF header.
function mpfPayload({ primarySize, secondSize, secondOffset, tiffStart }) {
  const entries = 3;
  const ifdSize = 2 + entries * 12 + 4;
  const mpEntriesAt = 8 + ifdSize;
  const body = Buffer.alloc(mpEntriesAt + 32);
  body.write('MM\0*', 0, 'latin1');
  body.writeUInt32BE(8, 4);
  body.writeUInt16BE(entries, 8);
  const entry = (n, tag, type, count, value) => {
    const at = 10 + n * 12;
    body.writeUInt16BE(tag, at);
    body.writeUInt16BE(type, at + 2);
    body.writeUInt32BE(count, at + 4);
    if (Buffer.isBuffer(value)) value.copy(body, at + 8);
    else body.writeUInt32BE(value, at + 8);
  };
  entry(0, 0xb000, 7, 4, Buffer.from('0100')); // MPF version
  entry(1, 0xb001, 4, 1, 2); // number of images
  entry(2, 0xb002, 7, 32, mpEntriesAt); // MP entries
  body.writeUInt32BE(0, 10 + entries * 12); // no next IFD
  body.writeUInt32BE(0x20030000, mpEntriesAt); // primary image
  body.writeUInt32BE(primarySize, mpEntriesAt + 4);
  body.writeUInt32BE(0, mpEntriesAt + 8);
  body.writeUInt32BE(0x00000000, mpEntriesAt + 16); // gain map image
  body.writeUInt32BE(secondSize, mpEntriesAt + 20);
  body.writeUInt32BE(secondOffset - tiffStart, mpEntriesAt + 24);
  return Buffer.concat([Buffer.from('MPF\0'), body]);
}

// A JPEG of one flat colour, given as sRGB. Options:
//   p3          pixels are converted to Display P3 and the P3 profile is embedded (like an iPhone photo)
//   orientation EXIF orientation 1-8
//   gainMap     adds the structure of an iPhone/Ultra HDR photo: HDR gain-map XMP, an MPF index in APP2, and a
//               second (grey) JPEG appended after the primary image's EOI. Synthetic: not a decodable HDR image.
export async function jpegFixture({ width = 64, height = 48, color = [200, 100, 50], p3 = false, orientation, gainMap = false } = {}) {
  let image = sharp({ create: { width, height, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } });
  if (p3) image = image.withIccProfile('p3');
  if (orientation !== undefined) image = image.withMetadata({ orientation });
  let jpeg = await image.jpeg({ quality: 90 }).toBuffer();
  if (!gainMap) return jpeg;

  const mapJpeg = await sharp({ create: { width: Math.ceil(width / 2), height: Math.ceil(height / 2), channels: 3, background: '#808080' } })
    .toColourspace('b-w')
    .jpeg({ quality: 80 })
    .toBuffer();
  const mapWithXmp = withSegments(mapJpeg, [
    { marker: 0xe1, data: xmp('<rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2.2" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.2" hdrgm:BaseRenditionIsHDR="False"/>') },
  ]);
  const primaryXmp = xmp('<rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"/>');
  // Segment sizes are fixed, so the MPF offsets can be computed before writing it (a placeholder fixes its length).
  const probe = withSegments(jpeg, [
    { marker: 0xe1, data: primaryXmp },
    { marker: 0xe2, data: mpfPayload({ primarySize: 0, secondSize: 0, secondOffset: 0, tiffStart: 0 }) },
  ]);
  const secondOffset = probe.length;
  const apps = (tiffStart) => [
    { marker: 0xe1, data: primaryXmp },
    { marker: 0xe2, data: mpfPayload({ primarySize: probe.length, secondSize: mapWithXmp.length, secondOffset, tiffStart }) },
  ];
  // The MPF TIFF header starts 8 bytes into the APP2 segment (marker 2 + length 2 + "MPF\0" 4), after the XMP segment.
  const tiffStart = 2 + 4 + apps(0)[0].data.length + 8;
  jpeg = Buffer.concat([withSegments(jpeg, apps(tiffStart)), mapWithXmp]);
  return jpeg;
}

const MARKER_NAMES = { 0xe0: 'APP0', 0xe1: 'APP1', 0xe2: 'APP2', 0xed: 'APP13', 0xee: 'APP14', 0xfe: 'COM' };

// The header segments of a JPEG up to its first scan, in order: [{ name, ident, length }]. `ident` is the
// segment's leading text (e.g. "Exif", "MPF", "ICC_PROFILE", "http://ns.adobe.com/xap/1.0/", "JFIF").
export function jpegHeaderSegments(jpeg) {
  assertSoi(jpeg);
  const segments = [];
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) throw new Error(`Not a marker at ${at}`);
    const marker = jpeg[at + 1];
    if (marker === 0xda) break; // start of scan
    const length = jpeg.readUInt16BE(at + 2);
    const data = jpeg.subarray(at + 4, at + 2 + length);
    segments.push({ name: MARKER_NAMES[marker] ?? `0x${marker.toString(16)}`, ident: /^[\x20-\x7e]*/.exec(data.toString('latin1'))[0], length });
    at += 2 + length;
  }
  return segments;
}

function assertSoi(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
}

// Pixel [r, g, b] at the centre of a decoded image (sharp applies the embedded profile to nothing here: raw output).
export async function centrePixel(jpeg) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
