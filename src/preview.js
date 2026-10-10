// What kind of preview a file gets, decided by its extension only (never by its content or a stored
// content type). Images and PDFs get a fixed content type, so a file is never served as HTML or SVG.
// Text is shown in the UI strictly as text; anything else offers download only.

// Text previews show at most this many bytes of the file (decision D24).
export const PREVIEW_TEXT_BYTES = 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'env', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'py', 'rb', 'sh', 'sql', 'svg',
]);

const MEDIA_TYPES = {
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
  png: { kind: 'image', contentType: 'image/png' },
  gif: { kind: 'image', contentType: 'image/gif' },
  webp: { kind: 'image', contentType: 'image/webp' },
  pdf: { kind: 'pdf', contentType: 'application/pdf' },
};

// A text preview from the file's first bytes (at least min(size, PREVIEW_TEXT_BYTES) of them) and its
// full size. UTF-8; invalid bytes become U+FFFD. When the file is cut, a character split by the limit is
// dropped (the streaming decoder keeps an incomplete trailing sequence instead of emitting U+FFFD).
export function textPreview(firstBytes, size) {
  const truncated = size > PREVIEW_TEXT_BYTES;
  const bytes = firstBytes.subarray(0, PREVIEW_TEXT_BYTES);
  return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes, { stream: truncated }), truncated };
}

// True for .jpg/.jpeg: their previews are not served as stored but converted on demand (src/jpeg-preview.js),
// because an original with HDR gain-map/MPF data can fail to display on iPhone Safari (decision D25).
export function needsNormalizing(key) {
  return previewKind(key).contentType === 'image/jpeg';
}

// 'a/b.PNG' ->{ kind: 'image', contentType: 'image/png' }; { kind: 'text' }; { kind: 'none' }.
export function previewKind(key) {
  const name = key.split('/').pop();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { kind: 'none' }; // no extension, or a dot file such as ".png"
  const extension = name.slice(dot + 1).toLowerCase();
  if (Object.hasOwn(MEDIA_TYPES, extension)) return { ...MEDIA_TYPES[extension] };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text' };
  return { kind: 'none' };
}
