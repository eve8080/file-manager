import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AppError, STORAGE_REASONS, badRequest, classifyStorageError, isStorageError } from './errors.js';
import { folderName, parseFolderPath, parsePrefix } from './paths.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ storage }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(securityHeaders);
  app.use(express.json({ limit: '10kb' }));

  const api = express.Router();

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

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  if (err instanceof AppError) return sendError(res, err.status, err.code, err.message, err.details);
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
  if (err.type === 'entity.too.large') return sendError(res, 413, 'TOO_LARGE', 'Request body too large');

  console.error(err); // full details stay server-side
  // Storage errors: clients get a fixed classification, never the SDK's name or message.
  if (isStorageError(err)) {
    const reason = classifyStorageError(err);
    return sendError(res, 502, 'STORAGE_ERROR', STORAGE_REASONS[reason], { reason });
  }
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
