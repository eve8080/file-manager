import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachmentDisposition, inlineDisposition } from './disposition.js';
import { authRequired, badRequest, insufficientScope, invalidToken, toPublicError } from './errors.js';
import { MAX_CONCURRENT_CONVERSIONS, createLimiter, normalizeJpeg } from './jpeg-preview.js';
import { folderName, parseFileKey, parseFolderPath, parsePrefix } from './paths.js';
import { needsNormalizing, previewKind } from './preview.js';
import { receiveUploads } from './upload.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// The login page's OIDC library: oidc-client-ts's own self-contained browser build (pinned version, served as
// installed from this origin; no CDN, no build step). See README "Login".
const OIDC_BUNDLE = path.join(
  path.dirname(createRequire(import.meta.url).resolve('oidc-client-ts/package.json')),
  'dist',
  'browser',
  'oidc-client-ts.min.js',
);
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// An upload request may carry the per-file limit's worth of data plus this much multipart framing
// (boundaries and part headers), so a single file of exactly the limit always fits (decision D22).
const UPLOAD_FRAMING_BYTES = 64 * 1024;

// `maxUploadBytes` limits each uploaded file and, plus UPLOAD_FRAMING_BYTES, each upload request
// (MAX_UPLOAD_MB from the config, default 100 MB). It also limits the size of a JPEG that is converted
// for preview (decision D25).
// `auth` (src/auth.js createAuth, AUTH_MODE=cognito) turns on login: only the exact PUBLIC_ORIGIN host is
// served, and every /api route except /health and /auth/config needs a verified access token in
// X-App-Authorization with the route's scope (read, write or delete). Without it the app is the v1 app (no login).
export function createApp({ storage, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, auth }) {
  const app = express();
  app.disable('x-powered-by');
  if (auth) app.use('/api', noStore); // also on the host guard's refusal
  app.use(auth ? exactHostGuard(new URL(auth.publicOrigin).host) : hostGuard);
  app.use(securityHeaders(auth));

  const api = express.Router();
  api.use(sameOriginWrites(auth?.publicOrigin));
  const jpegConversions = createLimiter(MAX_CONCURRENT_CONVERSIONS);
  // Route scopes; without login every route is open (v1).
  const may = (scope) => (auth ? requireScope(scope) : (req, res, next) => next());

  api.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  api.get('/auth/config', (req, res) => {
    res.json(auth ? auth.publicConfig : { mode: 'none' });
  });

  // Everything below needs a verified token in auth mode, including unknown paths (401 before 404), and
  // request bodies are only parsed after that.
  if (auth) api.use(authenticate(auth));
  api.use(express.json({ limit: '10kb' }));

  // { role: 'owner', sub, scopes } or { role: 'agent', clientId, scopes }
  if (auth) {
    api.get('/me', (req, res) => {
      res.json(req.principal);
    });
  }

  api.get('/list', may('read'), async (req, res) => {
    const prefix = parsePrefix(queryParam(req, 'prefix'));
    const { folders, files } = await storage.list(prefix);
    res.json({
      prefix,
      folders: folders.map((name) => ({ name, path: `${prefix}${name}/` })),
      files,
    });
  });

  api.post('/folders', may('write'), async (req, res) => {
    const prefix = parseFolderPath(req.body?.path);
    await storage.createFolder(prefix);
    res.status(201).json({ path: prefix });
  });

  api.delete('/folders', may('delete'), async (req, res) => {
    const prefix = parseFolderPath(queryParam(req, 'path'));
    const recursive = parseBoolean(queryParam(req, 'recursive'), 'recursive');
    requireRecursiveConfirmation(prefix, recursive, queryParam(req, 'confirm'));
    const deleted = await storage.deleteFolder(prefix, { recursive });
    res.json({ path: prefix, deleted });
  });

  api.post('/files', may('write'), async (req, res) => {
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
  // With login the browser fetches this with its token header, so S3's URL comes back as JSON { url } for the
  // page to open (a redirect would be followed by fetch itself); memory still sends the bytes, to that fetch only.
  api.get('/files/download', may('read'), async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    const download = await storage.getDownload(key);
    res.set('Cache-Control', 'no-store');
    if (download.url) return auth ? res.json({ url: download.url }) : res.redirect(302, download.url);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': attachmentDisposition(key.split('/').pop()),
    });
    res.send(download.body);
  });

  // { kind: 'text', text, truncated } | { kind: 'image'|'pdf', url } | { kind: 'none' }. S3's url is a
  // 5-minute presigned inline GET; memory/demo gets a same-origin URL (below) so tests never touch AWS.
  api.get('/files/preview', may('read'), async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    const { kind, text, truncated, url } = await storage.getPreview(key);
    res.set('Cache-Control', 'no-store');
    if (kind === 'text') return res.json({ kind, text, truncated });
    if (kind === 'none') return res.json({ kind });
    res.json({ kind, url: url ?? `/api/files/preview/content?key=${encodeURIComponent(key)}` });
  });

  // An image/PDF preview's bytes, inline, typed by extension (with nosniff, never as HTML). Memory/demo
  // serves them; S3 redirects to its presigned URL. Its own CSP lets only this app frame it (PDF viewer).
  // JPEGs (decision D25) are the exception: on both drivers the app reads the stored file and serves a
  // converted copy (src/jpeg-preview.js) - nothing is redirected, and nothing is written back.
  api.get('/files/preview/content', may('read'), async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    if (!['image', 'pdf'].includes(previewKind(key).kind)) throw badRequest('Only images and PDFs have preview content');
    let contentType;
    let body;
    if (needsNormalizing(key)) {
      contentType = 'image/jpeg';
      body = await jpegConversions.run(async () => normalizeJpeg(await storage.readPreviewSource(key, maxUploadBytes)));
    } else {
      const preview = await storage.getPreview(key);
      if (preview.url) return res.set('Cache-Control', 'no-store').redirect(302, preview.url);
      ({ contentType, body } = preview);
    }
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Disposition': inlineDisposition(key.split('/').pop()),
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'",
    });
    res.send(body);
  });

  api.post('/files/move', may('write'), async (req, res) => {
    const from = parseFileKey(req.body?.from);
    const to = parseFileKey(req.body?.to);
    await storage.moveFile(from, to);
    res.json({ from, to });
  });

  api.delete('/files', may('delete'), async (req, res) => {
    const key = parseFileKey(queryParam(req, 'key'));
    await storage.deleteFile(key);
    res.json({ key });
  });

  api.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Unknown API endpoint');
  });

  app.use('/api', api);
  if (auth) {
    app.get('/vendor/oidc-client-ts.min.js', (req, res) => {
      res.type('text/javascript').sendFile(OIDC_BUNDLE);
    });
  }
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

// With login, only the exact host of PUBLIC_ORIGIN is served. Forwarded headers (X-Forwarded-Host, Forwarded)
// are never consulted and Express's "trust proxy" stays off.
function exactHostGuard(expectedHost) {
  return (req, res, next) => {
    if (req.headers.host === expectedHost) return next();
    sendError(res, 403, 'FORBIDDEN_HOST', 'Open this app at its configured address (PUBLIC_ORIGIN)');
  };
}

// A multipart upload is a CORS "simple request", which a browser sends cross-site without a preflight,
// so any web page could otherwise write into the bucket through the user's browser. Browsers always send
// Origin on cross-site writes, so a write with a foreign (or "null") Origin is refused. The UI is
// same-origin; the AI agent sends no Origin. With login, the Origin must be PUBLIC_ORIGIN exactly.
function sameOriginWrites(publicOrigin) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (req.method === 'GET' || req.method === 'HEAD' || origin === undefined) return next();
    if (publicOrigin !== undefined) {
      if (origin === publicOrigin) return next();
      return sendError(res, 403, 'FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed');
    }
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined; // e.g. "null" from a sandboxed frame or file:// page
    }
    if (host !== undefined && host === req.headers.host) return next();
    sendError(res, 403, 'FORBIDDEN_ORIGIN', 'Cross-site requests are not allowed');
  };
}

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// ---- Login (AUTH_MODE=cognito) ----
// The app's token travels only in X-App-Authorization, so that `Authorization` stays free for an AWS origin
// signature in front of the app (CloudFront OAC, a later phase); `Authorization` is never read as an app token,
// nor is a token in the query string. Exactly one header, exactly "Bearer <JWS compact token>".
const TOKEN_HEADER = 'x-app-authorization';
const MAX_TOKEN_LENGTH = 8192;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;

function bearerToken(req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === TOKEN_HEADER) values.push(req.rawHeaders[i + 1]);
  }
  if (values.length === 0) throw authRequired();
  const match = values.length === 1 && values[0].length <= MAX_TOKEN_LENGTH + 7 ? BEARER.exec(values[0]) : null;
  if (!match) throw invalidToken();
  return match[1];
}

// Sets req.principal ({ role, sub|clientId, scopes }) or fails with 401/403/503 (see src/auth.js).
function authenticate(auth) {
  return async (req, res, next) => {
    req.principal = await auth.verifyToken(bearerToken(req));
    next();
  };
}

// Runs before the route touches storage or reads an upload body.
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.principal.scopes.includes(scope)) throw insufficientScope(scope);
    next();
  };
}

// Image and PDF previews from real S3 load from presigned URLs on the bucket's amazonaws.com host
// (decision D24), so images and frames may also come from there; scripts and everything else stay same-origin.
const S3_PREVIEW_SOURCE = 'https://*.amazonaws.com';

// With login the page also talks to the login provider (token and revocation endpoints; the sign-in pages are
// top-level navigations), and shows same-origin previews that were fetched with the token as blob: URLs.
function securityHeaders(auth) {
  const blob = auth ? 'blob: ' : '';
  const connect = auth ? `connect-src 'self' ${auth.providerOrigin}; ` : '';
  const policy =
    `default-src 'self'; img-src 'self' ${blob}${S3_PREVIEW_SOURCE}; frame-src 'self' ${blob}${S3_PREVIEW_SOURCE}; ${connect}` +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  };
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
  if (status === 401) res.set('WWW-Authenticate', 'Bearer');
  // A refused request's body (e.g. an upload) is not read; don't keep the connection for the rest of it.
  if ((status === 401 || status === 403) && (req.headers['content-length'] > 0 || req.headers['transfer-encoding'])) {
    res.set('Connection', 'close');
  }
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
