import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachmentDisposition, inlineDisposition } from './disposition.js';
import { badRequest, toPublicError } from './errors.js';
import { folderName, parseFileKey, parseFolderPath, parsePrefix } from './paths.js';
import { previewKind } from './preview.js';
import { receiveUploads } from './upload.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// An upload request may carry the per-file limit's worth of data plus this much multipart framing
// (boundaries and part headers), so a single file of exactly the limit always fits (decision D22).
const UPLOAD_FRAMING_BYTES = 64 * 1024;

// `maxUploadBytes` limits each uploaded file and, plus UPLOAD_FRAMING_BYTES, each upload request
// (MAX_UPLOAD_MB from the config, default 100 MB).
export function createApp({ storage, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(securityHeaders);
  app.use(express.json({ limit: '10kb' }));

  const api = express.Router();
  api.use(sameOriginWrites);

  api.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  api.get('/list', async (req, res) => {
    const prefix = parsePrefix(queryParam(req, 'prefix'));
    const { folders, files } = await storage.list(prefix);
    res.json({
      prefix,
      folders: folders.map((name) => ({ name, path: `${prefix}${name}/` })),
      files,
    });
  });

  api.post('/folders', async (req, res) => {
    const prefix = parseFolderPath(req.body?.path);
    await storage.createFolder(prefix);
    res.status(201).json({ path: prefix });
  });

  api.delete('/folders', async (req, res) => {
    const prefix = parseFolderPath(queryParam(req, 'path'));
    const recursive = parseBoolean(queryParam(req, 'recursive'), 'recursive');
    requireRecursiveConfirmation(prefix, recursive, queryParam(req, 'confirm'));
    const deleted = await storage.deleteFolder(prefix, { recursive });
    res.json({ path: prefix, deleted });
  });

  api.post('/files', async (req, res) => {
    const prefix = parsePrefix(queryParam(req, 'prefix'));
    const limits = { maxFileBytes: maxUploadBytes, maxRequestBytes: maxUploadBytes + UPLOAD_FRAMING_BYTES };
    let received;
    try {
      received = await receiveUploads(req, { prefix, storage, ...limits });
    } catch (err) {
      if (['REQUEST_TOO_LARGE', 'MALFORMED_UPLOAD'].includes(err.code)) res.set('Connection', 'close'); // body left unread
      throw err;
    }
    if (received.stopped) res.set('Connection', 'close');
    sendUploadResults(res, received);
  });

  // S3: 302 to a 5-minute presigned URL. Memory/demo: the bytes themselves, so tests never touch AWS.
  api.get('/files/download', async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    const download = await storage.getDownload(key);
    res.set('Cache-Control', 'no-store');
    if (download.url) return res.redirect(302, download.url);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': attachmentDisposition(key.split('/').pop()),
    });
    res.send(download.body);
  });

  // { kind: 'text', text, truncated } | { kind: 'image'|'pdf', url } | { kind: 'none' }. S3's url is a
  // 5-minute presigned inline GET; memory/demo gets a same-origin URL (below) so tests never touch AWS.
  api.get('/files/preview', async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    const { kind, text, truncated, url } = await storage.getPreview(key);
    res.set('Cache-Control', 'no-store');
    if (kind === 'text') return res.json({ kind, text, truncated });
    if (kind === 'none') return res.json({ kind });
    res.json({ kind, url: url ?? `/api/files/preview/content?key=${encodeURIComponent(key)}` });
  });

  // An image/PDF preview's bytes, inline, typed by extension (with nosniff, never as HTML). Memory/demo
  // serves them; S3 redirects to its presigned URL. Its own CSP lets only this app frame it (PDF viewer).
  api.get('/files/preview/content', async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    if (!['image', 'pdf'].includes(previewKind(key).kind)) throw badRequest('Only images and PDFs have preview content');
    const { contentType, url, body } = await storage.getPreview(key);
    res.set('Cache-Control', 'no-store');
    if (url) return res.redirect(302, url);
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': inlineDisposition(key.split('/').pop()),
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
    });
    res.send(body);
  });

  api.post('/files/move', async (req, res) => {
    const from = parseFileKey(req.body?.from);
    const to = parseFileKey(req.body?.to);
    await storage.moveFile(from, to);
    res.json({ from, to });
  });

  api.delete('/files', async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    await storage.deleteFile(key);
    res.json({ key });
  });

  api.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Unknown API endpoint');
  });

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR));
  app.use(errorHandler);
  return app;
}

// Express's "simple" query parser keeps `name[x]=v` as a literal key, so `req.query[name]` would be
// undefined and the parameter's default (root, non-recursive) would be used silently. Reject it instead.
function queryParam(req, name) {
  if (Object.keys(req.query).some((key) => key.startsWith(`${name}[`))) {
    throw badRequest(`${name} must be a single value`);
  }
  return req.query[name];
}

function parseBoolean(value, name) {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw badRequest(`${name} must be "true" or "false"`);
}

// A recursive delete must repeat the folder's exact name in `confirm`, so a wrong path or a
// careless client (UI or AI agent) cannot wipe a folder's contents by accident.
function requireRecursiveConfirmation(prefix, recursive, confirm) {
  if (!recursive) {
    if (confirm !== undefined) throw badRequest('confirm is only used with recursive=true');
    return;
  }
  if (confirm === undefined || confirm === '') {
    throw badRequest('Recursive delete requires confirm=<folder name>', 'CONFIRMATION_REQUIRED');
  }
  if (confirm !== folderName(prefix)) {
    throw badRequest('confirm does not match the folder name', 'CONFIRMATION_MISMATCH');
  }
}

// The API has no login, so a malicious web page must not be able to reach it through
// DNS rebinding (attacker.example resolving to 127.0.0.1). Rebinding needs a domain name
// in the Host header, so only IP literals and "localhost" are accepted.
export function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname.startsWith('[') || // IPv6 literal
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  );
}

function hostGuard(req, res, next) {
  if (isAllowedHost(req.headers.host)) return next();
  sendError(res, 403, 'FORBIDDEN_HOST', 'Open this app by IP address or localhost');
}

// A multipart upload is a CORS "simple request", which a browser sends cross-site without a preflight,
// so any web page could otherwise write into the bucket through the user's browser. Browsers always send
// Origin on cross-site writes, so a write with a foreign (or "null") Origin is refused. The UI is
// same-origin; the AI agent sends no Origin.
function sameOriginWrites(req, res, next) {
  const origin = req.headers.origin;
  if (req.method === 'GET' || req.method === 'HEAD' || origin === undefined) return next();
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    host = undefined; // e.g. "null" from a sandboxed frame or file:// page
  }
  if (host !== undefined && host === req.headers.host) return next();
  sendError(res, 403, 'FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed');
}

// Image and PDF previews from real S3 load from presigned URLs on the bucket's amazonaws.com host
// (decision D24), so images and frames may also come from there; scripts and everything else stay same-origin.
const S3_PREVIEW_SOURCE = 'https://*.amazonaws.com';

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      `default-src 'self'; img-src 'self' ${S3_PREVIEW_SOURCE}; frame-src 'self' ${S3_PREVIEW_SOURCE}; ` +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}

function sendError(res, status, code, message, details) {
  res.status(status).json({ error: details === undefined ? { code, message } : { code, message, details } });
}

// Express recognises error handlers by their 4-argument signature, so `next` must stay.
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
  if (err.type === 'entity.too.large') return sendError(res, 413, 'TOO_LARGE', 'Request body too large');
  // Storage errors: clients get a fixed classification, never the SDK's name or message.
  const { status, code, message, details } = toPublicError(err);
  sendError(res, status, code, message, details);
}

// One result per uploaded file. All stored → 201 { files }. Otherwise an error listing every file:
// UPLOAD_FAILED (none stored) or UPLOAD_INCOMPLETE (some stored), with the failures' common status
// if they share one, else 502 if any is a server/storage failure, else 400. If reading stopped early
// (`stopped`: a malformed or cut-off body, or the request limit), that counts as a failure even if every
// file before it was stored, and is reported as `details.malformed` or `details.requestTooLarge`.
function sendUploadResults(res, { results, stopped }) {
  const files = results.map(({ name, key, ok, size, error }) =>
    ok ? { name, key, ok, size } : { name, ...(key === undefined ? {} : { key }), ok: false, error: toPublicError(error) },
  );
  const failures = files.filter((f) => !f.ok);
  if (failures.length === 0 && !stopped) return res.status(201).json({ files });
  const statuses = new Set(failures.map((f) => f.error.status));
  if (stopped) statuses.add(stopped.status);
  const status = statuses.size === 1 ? [...statuses][0] : [...statuses].some((s) => s >= 500) ? 502 : 400;
  for (const f of failures) delete f.error.status;
  const uploaded = files.length - failures.length;
  sendError(
    res,
    status,
    uploaded === 0 ? 'UPLOAD_FAILED' : 'UPLOAD_INCOMPLETE',
    `${failures.length} of ${files.length} files could not be uploaded.`,
    {
      uploaded,
      failed: failures.length,
      files,
      ...(stopped && {
        [stopped.code === 'MALFORMED_UPLOAD' ? 'malformed' : 'requestTooLarge']: { code: stopped.code, message: stopped.message },
      }),
    },
  );
}
