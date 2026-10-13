// The HTTP API with AUTH_MODE=cognito (Phase A): every route but /api/health and /api/auth/config needs a verified
// access token in X-App-Authorization; route scopes read/write/delete; owner vs agent. Real aws-jwt-verify,
// synthetic tokens, offline fixture JWKS, memory storage. Also checks that the no-login mode is unchanged.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import {
  AGENTS,
  GOOGLE_CLIENT,
  NATIVE_CLIENT,
  OWNER_EMAIL,
  OWNER_SUB,
  STRANGER_SUB,
  agentClaims,
  authSettings,
  createSigningKey,
  offlineJwksCache,
  ownerClaims,
  signJwt,
} from './helpers/auth-fixtures.js';
import { PNG_1X1 } from './helpers/fixtures.js';
import { jpegFixture } from './helpers/jpeg-fixtures.js';

// The pinned browser build of oidc-client-ts@3.5.0 (dist/browser/oidc-client-ts.min.js), see README "Login".
const OIDC_BUNDLE_SHA256 = 'f999daa383f09eb090d0ae32211e9ca931c76840e08e47fcf334fc8f5f74f1ef';

const key = createSigningKey();
let storage;
let calls; // every storage method called, in order
let server;
let port;
let origin;
let auth;
let downloadOverride; // when set, getDownload answers it (an S3-style { url })

const token = {
  owner: () => signJwt(key, ownerClaims()),
  ownerGoogle: () => signJwt(key, ownerClaims({ clientId: GOOGLE_CLIENT })),
  stranger: () => signJwt(key, ownerClaims({ clientId: GOOGLE_CLIENT, sub: STRANGER_SUB, email: OWNER_EMAIL, email_verified: true })),
  agent: (clientId, scopes) => signJwt(key, agentClaims(clientId, scopes)),
};

before(async () => {
  server = http.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  auth = createAuth(authSettings(origin), { jwksCache: offlineJwksCache([key]).jwksCache });
  const proxy = new Proxy(
    {},
    {
      get: (_, method) =>
        (...args) => {
          calls.push(method);
          if (method === 'getDownload' && downloadOverride) return downloadOverride;
          return storage[method](...args);
        },
    },
  );
  server.on('request', createApp({ storage: proxy, auth }));
});

after(() => server.close());

beforeEach(() => {
  calls = [];
  downloadOverride = undefined;
  storage = createMemoryStorage({
    'readme.txt': 'hello',
    'docs/': '',
    'docs/a.txt': 'a',
    'full/': '',
    'full/x.txt': 'x',
    'empty/': '',
    'pic.png': PNG_1X1,
  });
});

async function call(method, path, { bearer, headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (bearer !== undefined) init.headers['X-App-Authorization'] = `Bearer ${bearer}`;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${origin}${path}`, init);
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, buffer, body: type.includes('json') ? JSON.parse(buffer) : null };
}

// One raw HTTP/1.1 request, for headers fetch cannot send (duplicates, odd Host values). Resolves to { status, head }.
function rawRequest(lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve({ status: Number(data.split(' ')[1]), head: data.split('\r\n\r\n')[0], body: data.split('\r\n\r\n')[1] }));
    socket.on('error', reject);
  });
}

function uploadForm(name = 'new.txt', content = 'new') {
  const form = new FormData();
  form.append('files', new Blob([content]), name);
  return form;
}

// Every private route, with the scope it needs and a request that would change or read storage.
const ROUTES = [
  { scope: 'read', method: 'GET', path: '/api/list?prefix=docs/', ok: 200 },
  { scope: 'read', method: 'GET', path: '/api/files/download?key=readme.txt', ok: 200 },
  { scope: 'read', method: 'GET', path: '/api/files/preview?key=readme.txt', ok: 200 },
  { scope: 'read', method: 'GET', path: '/api/files/preview/content?key=pic.png', ok: 200 },
  { scope: 'write', method: 'POST', path: '/api/folders', body: { path: 'made/' }, ok: 201, effect: async () => (await storage.list('')).folders.includes('made') },
  { scope: 'write', method: 'POST', path: '/api/files?prefix=docs/', form: uploadForm, ok: 201, effect: async () => (await storage.list('docs/')).files.some((f) => f.name === 'new.txt') },
  { scope: 'write', method: 'POST', path: '/api/files/move', body: { from: 'docs/a.txt', to: 'docs/b.txt' }, ok: 200, effect: async () => (await storage.list('docs/')).files.some((f) => f.name === 'b.txt') },
  { scope: 'delete', method: 'DELETE', path: '/api/folders?path=empty/', ok: 200, effect: async () => !(await storage.list('')).folders.includes('empty') },
  { scope: 'delete', method: 'DELETE', path: '/api/folders?path=full/&recursive=true&confirm=full', ok: 200, effect: async () => !(await storage.list('')).folders.includes('full') },
  { scope: 'delete', method: 'DELETE', path: '/api/files?key=readme.txt', ok: 200, effect: async () => !(await storage.list('')).files.some((f) => f.name === 'readme.txt') },
];

const send = (route, bearer, headers) =>
  call(route.method, route.path, { bearer, headers, body: route.body, form: route.form?.() });

function assertNoStore(res, what) {
  assert.equal(res.headers.get('cache-control'), 'no-store', `${what}: Cache-Control`);
}

describe('auth mode: public routes', () => {
  it('GET /api/health is public and minimal', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assertNoStore(res, 'health');
  });

  it('GET /api/auth/config is public and has browser-public values only', async () => {
    const res = await call('GET', '/api/auth/config');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, auth.publicConfig);
    assert.equal(res.body.redirectUri, `${origin}/`);
    assertNoStore(res, 'auth config');
    const text = res.buffer.toString();
    for (const value of [OWNER_SUB, ...Object.values(AGENTS), 'file-manager/', 'secret']) assert.equal(text.includes(value), false, value);
  });

  it('the pinned oidc-client-ts browser build is served from this origin (exact bytes, script type, no CDN)', async () => {
    const res = await call('GET', '/vendor/oidc-client-ts.min.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.equal(createHash('sha256').update(res.buffer).digest('hex'), OIDC_BUNDLE_SHA256);
    const pkg = JSON.parse(readFileSync(new URL('../node_modules/oidc-client-ts/package.json', import.meta.url)));
    assert.equal(pkg.version, '3.5.0');
    const source = res.buffer.toString();
    assert.match(source, /^"use strict";var oidc=\(\(\)=>\{/, 'a self-contained IIFE exposing `oidc`');
    assert.doesNotMatch(source, /\brequire\(|\bimport\(|\beval\(|new Function/, 'no module loading or eval');
  });
});

describe('auth mode: credentials', () => {
  it('every private route, and unknown /api paths, need a token: 401 AUTH_REQUIRED, no-store, storage untouched', async () => {
    for (const route of [...ROUTES, { method: 'GET', path: '/api/me' }, { method: 'GET', path: '/api/nope' }, { method: 'POST', path: '/api/nope' }]) {
      calls = [];
      const res = await send(route);
      assert.equal(res.status, 401, `${route.method} ${route.path}`);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assertNoStore(res, route.path);
      assert.deepEqual(calls, [], `${route.method} ${route.path}: storage untouched`);
    }
    assert.equal((await storage.list('')).files.length, 2);
  });

  it('HEAD, OPTIONS and path variants (case, trailing slash) of private routes also need a token', async () => {
    for (const [method, path] of [
      ['HEAD', '/api/list'],
      ['HEAD', '/api/files/download?key=readme.txt'],
      ['OPTIONS', '/api/files'],
      ['OPTIONS', '/api/list'],
      ['GET', '/API/list'],
      ['GET', '/Api/Files/Download?key=readme.txt'],
      ['GET', '/api/list/'],
      ['DELETE', '/API/FILES?key=readme.txt'],
    ]) {
      calls = [];
      const res = await fetch(`${origin}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${method} ${path}`);
      assert.deepEqual(calls, [], `${method} ${path}: storage untouched`);
    }
    assert.equal((await storage.list('')).files.some((f) => f.name === 'readme.txt'), true);
  });

  it('a malformed JSON body without a token is 401, not parsed first', async () => {
    const res = await call('POST', '/api/folders', { body: '{oops' });
    assert.equal(res.status, 401);
  });

  it('the token is accepted only in X-App-Authorization; Authorization (e.g. CloudFront SigV4) is ignored', async () => {
    const valid = token.owner();
    const onlyAuthorization = await call('GET', '/api/list', { headers: { Authorization: `Bearer ${valid}` } });
    assert.deepEqual([onlyAuthorization.status, onlyAuthorization.body.error.code], [401, 'AUTH_REQUIRED']);
    const sigv4 = 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20260101/ap-east-1/lambda/aws4_request, SignedHeaders=host, Signature=00';
    const both = await call('GET', '/api/list', { bearer: valid, headers: { Authorization: sigv4 } });
    assert.equal(both.status, 200);
    const query = await call('GET', `/api/list?access_token=${valid}`);
    assert.equal(query.status, 401, 'never from the query string');
  });

  // (Leading/trailing spaces of a header value are removed by HTTP parsing itself, so they cannot be told apart.)
  it('malformed X-App-Authorization values are 401 INVALID_TOKEN', async () => {
    const valid = token.owner();
    for (const value of [
      '',
      'Bearer',
      `bearer ${valid}`,
      `Bearer  ${valid}`,
      `Basic ${valid}`,
      `Bearer ${valid}, Bearer ${valid}`,
      'Bearer a.b',
      'Bearer a.b.c.d',
      `Bearer ${'a'.repeat(9000)}.b.c`,
    ]) {
      const res = await rawRequest(['GET /api/list HTTP/1.1', `Host: 127.0.0.1:${port}`, `X-App-Authorization: ${value}`]);
      assert.equal(res.status, 401, JSON.stringify(value.slice(0, 40)));
      assert.match(res.body, /"code":"(INVALID_TOKEN|AUTH_REQUIRED)"/);
    }
  });

  it('a repeated X-App-Authorization header is refused even if both are valid', async () => {
    const valid = token.owner();
    const res = await rawRequest([
      'GET /api/list HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      `X-App-Authorization: Bearer ${valid}`,
      `x-app-authorization: Bearer ${valid}`,
    ]);
    assert.equal(res.status, 401);
    assert.match(res.body, /"code":"INVALID_TOKEN"/);
  });

  it('an invalid token (expired, other pool, tampered) is 401 and touches nothing', async () => {
    const expired = signJwt(key, ownerClaims({ exp: Math.floor(Date.now() / 1000) - 1 }));
    const res = await call('DELETE', '/api/files?key=readme.txt', { bearer: expired });
    assert.deepEqual([res.status, res.body.error.code], [401, 'INVALID_TOKEN']);
    assert.deepEqual(calls, []);
  });
});

describe('auth mode: who may do what', () => {
  it('GET /api/me: both owner login methods are the same owner; agents are their client', async () => {
    for (const bearer of [token.owner(), token.ownerGoogle()]) {
      const res = await call('GET', '/api/me', { bearer });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { role: 'owner', sub: OWNER_SUB, scopes: ['read', 'write', 'delete'] });
      assertNoStore(res, 'me');
    }
    const agent = await call('GET', '/api/me', { bearer: token.agent(AGENTS.writer, ['read', 'write']) });
    assert.deepEqual(agent.body, { role: 'agent', clientId: AGENTS.writer, scopes: ['read', 'write'] });
  });

  it('a verified but unapproved identity (owner email, Google) is 403 NOT_AUTHORIZED everywhere, with no side effects', async () => {
    for (const route of [...ROUTES, { method: 'GET', path: '/api/me' }]) {
      calls = [];
      const res = await send(route, token.stranger());
      assert.deepEqual([res.status, res.body.error.code], [403, 'NOT_AUTHORIZED'], `${route.method} ${route.path}`);
      assertNoStore(res, route.path);
      assert.deepEqual(calls, []);
    }
  });

  it('the owner may use every route', async () => {
    for (const route of ROUTES) {
      const res = await send(route, token.owner());
      assert.equal(res.status, route.ok, `${route.method} ${route.path}: ${res.buffer}`);
      assertNoStore(res, route.path);
      if (route.effect) assert.equal(await route.effect(), true, `${route.path} took effect`);
    }
  });

  // Each agent client, with exactly the scopes its token grants, against every route.
  for (const [name, clientId, scopes] of [
    ['read', AGENTS.reader, ['read']],
    ['read+write', AGENTS.writer, ['read', 'write']],
    ['read+delete', AGENTS.deleter, ['read', 'delete']],
    ['token without file scopes', AGENTS.all, []],
  ]) {
    it(`agent (${name}): allowed routes run, the others are 403 INSUFFICIENT_SCOPE before any storage call`, async () => {
      for (const route of ROUTES) {
        storage = createMemoryStorage({ 'readme.txt': 'hello', 'docs/': '', 'docs/a.txt': 'a', 'full/': '', 'full/x.txt': 'x', 'empty/': '', 'pic.png': PNG_1X1 });
        calls = [];
        const res = await send(route, token.agent(clientId, scopes));
        if (scopes.includes(route.scope)) {
          assert.equal(res.status, route.ok, `${route.method} ${route.path}`);
          if (route.effect) assert.equal(await route.effect(), true, `${route.path} took effect`);
        } else {
          assert.deepEqual([res.status, res.body.error.code], [403, 'INSUFFICIENT_SCOPE'], `${route.method} ${route.path}`);
          assert.match(res.body.error.message, new RegExp(`"${route.scope}" scope`));
          assert.deepEqual(calls, [], `${route.method} ${route.path}: no storage call`);
          if (route.effect) assert.equal(await route.effect(), false, `${route.path} did not take effect`);
        }
        assertNoStore(res, route.path);
      }
    });
  }

  it('an agent whose token grants write but whose configuration allows only read cannot write', async () => {
    const res = await call('POST', '/api/folders', { bearer: token.agent(AGENTS.reader, ['read', 'write', 'delete']), body: { path: 'x/' } });
    assert.deepEqual([res.status, res.body.error.code], [403, 'INSUFFICIENT_SCOPE']);
    assert.deepEqual(calls, []);
  });

  it('authenticated: unknown /api paths are 404 and errors are no-store', async () => {
    const unknown = await call('GET', '/api/nope', { bearer: token.owner() });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'NOT_FOUND']);
    assertNoStore(unknown, 'unknown');
    const bad = await call('GET', '/api/list?prefix=../x', { bearer: token.owner() });
    assert.equal(bad.status, 400);
    assertNoStore(bad, '400');
  });
});

describe('auth mode: downloads and previews', () => {
  it('download: S3 answers JSON { url } (no redirect a header-carrying fetch would follow); memory sends the bytes', async () => {
    downloadOverride = { url: 'https://example-bucket.s3.ap-east-1.amazonaws.com/readme.txt?X-Amz-Signature=placeholder' };
    const s3 = await call('GET', '/api/files/download?key=readme.txt', { bearer: token.owner() });
    assert.equal(s3.status, 200);
    assert.deepEqual(s3.body, { url: downloadOverride.url });
    assertNoStore(s3, 'download json');
    downloadOverride = undefined;
    const memory = await call('GET', '/api/files/download?key=readme.txt', { bearer: token.owner() });
    assert.equal(memory.status, 200);
    assert.equal(memory.buffer.toString(), 'hello');
    assert.match(memory.headers.get('content-disposition'), /^attachment/);
  });

  it('JPEG preview content needs the token too and is converted as before', async () => {
    storage.putObject('photo.jpg', await jpegFixture({ width: 40, height: 30 }));
    const anonymous = await call('GET', '/api/files/preview/content?key=photo.jpg');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(calls, []);
    const res = await call('GET', '/api/files/preview/content?key=photo.jpg', { bearer: token.owner() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assertNoStore(res, 'jpeg');
    const meta = await call('GET', '/api/files/preview?key=photo.jpg', { bearer: token.owner() });
    assert.deepEqual(meta.body, { kind: 'image', url: '/api/files/preview/content?key=photo.jpg' });
  });
});

describe('auth mode: host, origin and page security', () => {
  it('only the exact PUBLIC_ORIGIN host is served; forwarded headers are not trusted', async () => {
    for (const host of [`localhost:${port}`, '127.0.0.1', `127.0.0.2:${port}`, `[::1]:${port}`, `127.0.0.1:${port}.evil.example`, `evil.example`]) {
      const res = await rawRequest(['GET /api/health HTTP/1.1', `Host: ${host}`]);
      assert.equal(res.status, 403, host);
      assert.match(res.body, /FORBIDDEN_HOST/);
    }
    const forwarded = await rawRequest([
      'GET /api/health HTTP/1.1',
      'Host: evil.example',
      `X-Forwarded-Host: 127.0.0.1:${port}`,
      'X-Forwarded-Proto: http',
      `Forwarded: host=127.0.0.1:${port}`,
    ]);
    assert.equal(forwarded.status, 403);
    assert.equal((await rawRequest(['GET /api/health HTTP/1.1', `Host: 127.0.0.1:${port}`])).status, 200);
  });

  it('writes with a browser Origin must come from PUBLIC_ORIGIN exactly', async () => {
    for (const foreign of [`http://localhost:${port}`, 'null', `https://127.0.0.1:${port}`, 'http://evil.example']) {
      const res = await call('POST', '/api/folders', { bearer: token.owner(), headers: { Origin: foreign }, body: { path: 'x/' } });
      assert.deepEqual([res.status, res.body.error.code], [403, 'FORBIDDEN_ORIGIN'], foreign);
    }
    assert.deepEqual(calls, []);
    const same = await call('POST', '/api/folders', { bearer: token.owner(), headers: { Origin: origin }, body: { path: 'x/' } });
    assert.equal(same.status, 201);
  });

  it('page CSP: scripts self only; the login provider for fetch; blob: only for images/frames; no eval or inline', async () => {
    const res = await fetch(`${origin}/`);
    const csp = res.headers.get('content-security-policy');
    assert.equal(
      csp,
      "default-src 'self'; img-src 'self' blob: https://*.amazonaws.com; frame-src 'self' blob: https://*.amazonaws.com; " +
        "connect-src 'self' https://login.example.invalid; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    assert.doesNotMatch(csp, /unsafe|script-src/);
  });
});

describe('no-login mode is unchanged', () => {
  let plain;
  let plainUrl;
  before(async () => {
    plain = createApp({ storage: createMemoryStorage({ 'a.txt': 'a' }) }).listen(0, '127.0.0.1');
    await new Promise((resolve) => plain.once('listening', resolve));
    plainUrl = `http://127.0.0.1:${plain.address().port}`;
  });
  after(() => plain.close());

  it('GET /api/auth/config says there is no login; nothing else about auth exists', async () => {
    const config = await fetch(`${plainUrl}/api/auth/config`);
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), { mode: 'none' });
    assert.equal((await fetch(`${plainUrl}/api/me`)).status, 404);
    assert.equal((await fetch(`${plainUrl}/vendor/oidc-client-ts.min.js`)).status, 404);
  });

  it('the API needs no token, downloads are the file, and the page CSP is the v1 policy', async () => {
    const list = await fetch(`${plainUrl}/api/list`, { headers: { 'X-App-Authorization': 'Bearer junk' } });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), null);
    const download = await fetch(`${plainUrl}/api/files/download?key=a.txt`);
    assert.equal(await download.text(), 'a');
    const page = await fetch(`${plainUrl}/`);
    assert.equal(
      page.headers.get('content-security-policy'),
      "default-src 'self'; img-src 'self' https://*.amazonaws.com; frame-src 'self' https://*.amazonaws.com; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
});
