// `Content-Disposition: attachment` for a file name, so browsers save the file instead of rendering it.
// `filename` is an ASCII fallback (other characters, quotes and backslashes become "_"); `filename*`
// carries the exact UTF-8 name (RFC 6266 / RFC 8187).
export function attachmentDisposition(name) {
  return disposition('attachment', name);
}

// `Content-Disposition: inline`, for image/PDF previews (shown in the page, saved under the file's name).
export function inlineDisposition(name) {
  return disposition('inline', name);
}

function disposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
