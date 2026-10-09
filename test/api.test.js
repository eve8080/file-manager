import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, isAllowedHost } from '../src/app.js';
import { STORAGE_REASONS } from '../src/errors.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { FakeS3Client, TEST_SIGNER } from './helpers/fake-s3-client.js';

let storage;
let server;
let baseUrl;

before(async () => {
  // Route each request to the current test's storage.
  const proxy = new Proxy({}, { get: (_, method) => (...args) => storage[method](...args) });
  server = createApp({ storage: proxy }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  storage = createMemoryStorage({
    'readme.txt': 'hello',
    'docs/': '',
    'docs/a.txt': 'a',
    'docs/sub/b.txt': 'b',
    'empty/': '',
  });
});

// Runs fn with console.error captured (server-side logging is expected in error tests).
async function quietly(fn) {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await fn();
  } finally {
    console.error = originalError;
  }
  return logged;
}

// `raw` sends a prepared body with its own headers instead of JSON.
async function call(method, path, body, raw) {
  const res = await fetch(baseUrl + path, raw ? { method, ...raw } : {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });
});

describe('GET /api/list', () => {
  it('lists the root', async () => {
    const res = await call('GET', '/api/list');
    assert.equal(res.status, 200);
    assert.equal(res.body.prefix, '');
    assert.deepEqual(res.body.folders, [
      { name: 'docs', path: 'docs/' },
      { name: 'empty', path: 'empty/' },
    ]);
    assert.equal(res.body.files[0].name, 'readme.txt');
    assert.equal(res.body.files[0].size, 5);
  });

  it('lists a nested folder, with or without trailing slash', async () => {
    for (const prefix of ['docs', 'docs/']) {
      const res = await call('GET', `/api/list?prefix=${encodeURIComponent(prefix)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.prefix, 'docs/');
      assert.deepEqual(res.body.folders, [{ name: 'sub', path: 'docs/sub/' }]);
      assert.deepEqual(res.body.files.map((f) => f.key), ['docs/a.txt']);
    }
  });

  it('returns 404 for a missing folder', async () => {
    const res = await call('GET', '/api/list?prefix=nope/');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  for (const query of ['prefix=../etc', 'prefix=%2Fabs', 'prefix=a//b', 'prefix=a&prefix=b']) {
    it(`returns 400 for ${query}`, async () => {
      const res = await call('GET', `/api/list?${query}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'BAD_REQUEST');
    });
  }
});

describe('structured query values (D19)', () => {
  // Express's query parser keeps `name[x]` as a literal key, so without a check these would fall
  // back to the parameter's default (root listing, non-recursive delete) instead of failing.
  const requests = [
    ['GET', '/api/list?prefix[a]=b'],
    ['GET', '/api/list?prefix[]=docs'],
    ['DELETE', '/api/folders?path[a]=empty/'],
    ['DELETE', '/api/folders?path=empty/&recursive[a]=true'],
    ['DELETE', '/api/folders?path=docs/&recursive=true&confirm[a]=docs'],
  ];
  it('rejects them with 400, like repeated values, without touching storage', async () => {
    for (const [method, path] of requests) {
      const res = await call(method, path);
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.equal(res.body.error.code, 'BAD_REQUEST', `${method} ${path}`);
    }
    assert.equal((await call('GET', '/api/list?prefix=empty/')).status, 200);
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
  });
});

describe('POST /api/folders', () => {
  it('creates a folder', async () => {
    const res = await call('POST', '/api/folders', { path: 'docs/new' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { path: 'docs/new/' });
    const list = await call('GET', '/api/list?prefix=docs/');
    assert.deepEqual(list.body.folders.map((f) => f.name), ['new', 'sub']);
  });

  it('returns 409 when the folder exists', async () => {
    const res = await call('POST', '/api/folders', { path: 'docs/' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'FOLDER_EXISTS');
  });

  it('returns 400 for a missing or invalid path', async () => {
    assert.equal((await call('POST', '/api/folders', {})).status, 400);
    assert.equal((await call('POST', '/api/folders', { path: '../x' })).status, 400);
    assert.equal((await call('POST', '/api/folders', { path: 42 })).status, 400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await call('POST', '/api/folders', '{not json');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'Invalid JSON body');
  });
});

describe('DELETE /api/folders', () => {
  it('deletes an empty folder', async () => {
    const res = await call('DELETE', '/api/folders?path=empty/');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { path: 'empty/', deleted: 1 });
  });

  it('returns 409 for a non-empty folder unless recursive=true with confirmation', async () => {
    const refused = await call('DELETE', '/api/folders?path=docs/');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'FOLDER_NOT_EMPTY');

    const res = await call('DELETE', '/api/folders?path=docs/&recursive=true&confirm=docs');
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 3);
    assert.equal((await call('GET', '/api/list?prefix=docs/')).status, 404);
  });

  it('confirms a nested folder by its own name, not its full path', async () => {
    const wrong = await call('DELETE', '/api/folders?path=docs/sub/&recursive=true&confirm=docs%2Fsub');
    assert.equal(wrong.body.error.code, 'CONFIRMATION_MISMATCH');
    const res = await call('DELETE', '/api/folders?path=docs/sub/&recursive=true&confirm=sub');
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
  });

  // Every one of these must leave the folder untouched.
  const badConfirmations = [
    ['missing confirm', '', 'CONFIRMATION_REQUIRED'],
    ['empty confirm', '&confirm=', 'CONFIRMATION_REQUIRED'],
    ['wrong name', '&confirm=other', 'CONFIRMATION_MISMATCH'],
    ['different case', '&confirm=DOCS', 'CONFIRMATION_MISMATCH'],
    ['trailing space', '&confirm=docs%20', 'CONFIRMATION_MISMATCH'],
    ['trailing slash', '&confirm=docs%2F', 'CONFIRMATION_MISMATCH'],
    ['repeated param', '&confirm=docs&confirm=docs', 'CONFIRMATION_MISMATCH'],
  ];
  for (const [label, query, code] of badConfirmations) {
    it(`refuses recursive delete with ${label}`, async () => {
      const res = await call('DELETE', `/api/folders?path=docs/&recursive=true${query}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, code);
      const list = await call('GET', '/api/list?prefix=docs/');
      assert.deepEqual(list.body.files.map((f) => f.name), ['a.txt']);
      assert.deepEqual(list.body.folders.map((f) => f.name), ['sub']);
    });
  }

  it('requires confirmation for recursive delete even when the folder is empty', async () => {
    const res = await call('DELETE', '/api/folders?path=empty/&recursive=true');
    assert.equal(res.body.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await call('GET', '/api/list?prefix=empty/')).status, 200);
  });

  it('rejects confirm without recursive=true', async () => {
    const res = await call('DELETE', '/api/folders?path=empty/&confirm=empty');
    assert.equal(res.status, 400);
    assert.equal((await call('GET', '/api/list?prefix=empty/')).status, 200);
  });

  it('returns 404 for a missing folder and 400 for bad input', async () => {
    assert.equal((await call('DELETE', '/api/folders?path=nope/')).status, 404);
    assert.equal((await call('DELETE', '/api/folders?path=nope/&recursive=true&confirm=nope')).status, 404);
    assert.equal((await call('DELETE', '/api/folders')).status, 400);
    assert.equal((await call('DELETE', '/api/folders?path=docs/&recursive=yes')).status, 400);
  });

  it('returns 409 and keeps the marker when S3 returns the marker and a child on separate pages', async () => {
    const client = new FakeS3Client({ 'x/': '', 'x/child.txt': 'c' }, { pageSize: 1 });
    storage = createS3Storage({ bucket: 'test', client });
    const res = await call('DELETE', '/api/folders?path=x/');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'FOLDER_NOT_EMPTY');
    assert.deepEqual([...client.objects.keys()].sort(), ['x/', 'x/child.txt']);
  });

  it('returns a structured 502 DELETE_INCOMPLETE when S3 deletes only part of a folder', async () => {
    const client = new FakeS3Client(
      { 'docs/': '', 'docs/a.txt': 'a', 'docs/b.txt': 'b', 'docs/c.txt': 'c' },
      { failDeleteKeys: ['docs/b.txt'] },
    );
    storage = createS3Storage({ bucket: 'test', client });
    let res;
    const logged = await quietly(async () => {
      res = await call('DELETE', '/api/folders?path=docs/&recursive=true&confirm=docs');
    });
    assert.match(JSON.stringify(logged), /AccessDenied/, 'raw S3 code is logged server-side');
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'DELETE_INCOMPLETE');
    assert.match(res.body.error.message, /may already be deleted/);
    assert.deepEqual(res.body.error.details, {
      path: 'docs/',
      requested: 4,
      deleted: 3,
      failedCount: 1,
      failed: [{ key: 'docs/b.txt', reason: 'ACCESS_DENIED' }],
      unknown: 0,
      notAttempted: 0,
    });
    const list = await call('GET', '/api/list?prefix=docs/');
    assert.deepEqual(list.body.files.map((f) => f.name), ['b.txt']);
  });
});

describe('DELETE /api/files (M2)', () => {
  it('deletes exactly the given file', async () => {
    const res = await call('DELETE', '/api/files?key=docs/a.txt');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { key: 'docs/a.txt' });
    const list = await call('GET', '/api/list?prefix=docs/');
    assert.deepEqual(list.body.files, []);
    assert.deepEqual(list.body.folders.map((f) => f.name), ['sub']);
  });

  it('returns 404 for a missing file, including a folder name', async () => {
    for (const key of ['docs/nope.txt', 'docs']) {
      const res = await call('DELETE', `/api/files?key=${encodeURIComponent(key)}`);
      assert.equal(res.status, 404, key);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
  });

  for (const query of ['', 'key=', 'key=docs/', 'key=../a.txt', 'key=%2Fa.txt', 'key=a//b', 'key=a&key=b', 'key[a]=docs/a.txt']) {
    it(`returns 400 and deletes nothing for "${query}"`, async () => {
      const res = await call('DELETE', `/api/files?${query}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'BAD_REQUEST');
      assert.equal((await call('GET', '/api/list?prefix=docs/')).body.files.length, 1);
    });
  }

  it('maps an S3 failure to a fixed reason without leaking it', async () => {
    const client = new FakeS3Client({ 'f.txt': 'x' });
    client.failNext('DeleteObjectCommand', { name: 'AccessDenied', status: 403, message: 'secret internal detail' });
    storage = createS3Storage({ bucket: 'test', client });
    let res;
    await quietly(async () => {
      res = await call('DELETE', '/api/files?key=f.txt');
    });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body.error, { code: 'STORAGE_ERROR', message: STORAGE_REASONS.ACCESS_DENIED, details: { reason: 'ACCESS_DENIED' } });
    assert.equal(client.body('f.txt'), 'x');
  });
});

describe('POST /api/files/move (M2)', () => {
  it('renames and moves a file', async () => {
    let res = await call('POST', '/api/files/move', { from: 'docs/a.txt', to: 'docs/renamed.txt' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { from: 'docs/a.txt', to: 'docs/renamed.txt' });
    res = await call('POST', '/api/files/move', { from: 'docs/renamed.txt', to: 'moved.txt' });
    assert.equal(res.status, 200);
    assert.deepEqual((await call('GET', '/api/list')).body.files.map((f) => f.name), ['moved.txt', 'readme.txt']);
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files, []);
  });

  it('404 for a missing source, 409 FILE_EXISTS for an existing destination; nothing changes', async () => {
    let res = await call('POST', '/api/files/move', { from: 'docs/nope.txt', to: 'docs/x.txt' });
    assert.equal(res.status, 404);
    res = await call('POST', '/api/files/move', { from: 'docs/a.txt', to: 'readme.txt' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'FILE_EXISTS');
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
  });

  it('collision: a move onto a folder name, or through a file, is 409 NAME_CONFLICT; nothing changes', async () => {
    let res = await call('POST', '/api/files/move', { from: 'readme.txt', to: 'docs' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error, { code: 'NAME_CONFLICT', message: 'A folder with that name already exists' });
    res = await call('POST', '/api/files/move', { from: 'docs/a.txt', to: 'readme.txt/a.txt' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error, { code: 'NAME_CONFLICT', message: 'Part of that path is a file, not a folder' });
    assert.deepEqual((await call('GET', '/api/list')).body.files.map((f) => f.name), ['readme.txt']);
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
  });

  const badBodies = [
    {},
    { from: 'docs/a.txt' },
    { to: 'x.txt' },
    { from: ['docs/a.txt'], to: 'x.txt' },
    { from: 'docs/a.txt', to: 42 },
    { from: 'docs/a.txt', to: 'x/' },
    { from: 'docs/a.txt', to: '../x.txt' },
    { from: 'docs/', to: 'x.txt' },
    { from: 'docs/a.txt', to: 'a\u0000b' },
  ];
  for (const body of badBodies) {
    it(`returns 400 for ${JSON.stringify(body)}`, async () => {
      const res = await call('POST', '/api/files/move', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'BAD_REQUEST');
      assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
    });
  }

  it('reports a partial S3 move as 502 MOVE_INCOMPLETE with details', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('DeleteObjectCommand', { name: 'AccessDenied', status: 403, message: 'secret internal detail' });
    storage = createS3Storage({ bucket: 'test', client });
    let res;
    await quietly(async () => {
      res = await call('POST', '/api/files/move', { from: 'a.txt', to: 'b.txt' });
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'MOVE_INCOMPLETE');
    assert.deepEqual(res.body.error.details, { from: 'a.txt', to: 'b.txt', copied: true, sourceDeleted: false, reason: 'ACCESS_DENIED' });
    assert.ok(!JSON.stringify(res.body).includes('secret internal detail'));
  });

  it('a failed S3 copy is a fixed STORAGE_ERROR and keeps the source', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('CopyObjectCommand', { name: 'SlowDown', status: 503, message: 'secret internal detail' });
    storage = createS3Storage({ bucket: 'test', client });
    let res;
    await quietly(async () => {
      res = await call('POST', '/api/files/move', { from: 'a.txt', to: 'b.txt' });
    });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body.error, { code: 'STORAGE_ERROR', message: STORAGE_REASONS.THROTTLED, details: { reason: 'THROTTLED' } });
    assert.deepEqual([...client.objects.keys()], ['a.txt']);
  });
});

describe('GET /api/files/download (M2)', () => {
  const get = (query) => fetch(`${baseUrl}/api/files/download?${query}`, { redirect: 'manual' });

  it('S3: 302 redirect to a presigned GET URL that expires in exactly 5 minutes', async () => {
    storage = createS3Storage({ bucket: 'test', client: new FakeS3Client({ 'docs/report 1.pdf': 'pdf' }), signingClient: TEST_SIGNER });
    const res = await get(`key=${encodeURIComponent('docs/report 1.pdf')}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const url = new URL(res.headers.get('location'));
    assert.equal(url.hostname, 'test.s3.us-east-1.amazonaws.com');
    assert.equal(url.pathname, '/docs/report%201.pdf');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.match(url.searchParams.get('response-content-disposition'), /^attachment; /);
  });

  it('memory/demo: 200 with the file bytes as an attachment (no AWS)', async () => {
    const res = await get('key=docs/a.txt');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), 'a');
  });

  it('404 for a missing file; 400 for bad keys', async () => {
    assert.equal((await get('key=docs/nope.txt')).status, 404);
    for (const query of ['', 'key=docs/', 'key=../a', 'key=a&key=b', 'key[a]=docs/a.txt']) {
      const res = await get(query);
      assert.equal(res.status, 400, query);
      assert.equal((await res.json()).error.code, 'BAD_REQUEST');
    }
  });

  it('maps an S3 failure to a fixed reason', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('HeadObjectCommand', { name: 'NoSuchBucket', status: 404, message: 'secret internal detail' });
    storage = createS3Storage({ bucket: 'test', client, signingClient: TEST_SIGNER });
    let res;
    await quietly(async () => {
      res = await call('GET', '/api/files/download?key=a.txt');
    });
    // HeadObject's 404 for a missing bucket must not be mistaken for a missing file.
    assert.equal(res.status, 502);
    assert.deepEqual(res.body.error.details, { reason: 'BUCKET_NOT_FOUND' });
  });
});

describe('POST /api/files (M2 upload)', () => {
  // Uploads with the platform's own multipart encoder (FormData), like a browser.
  function upload(prefix, files, url = baseUrl) {
    const form = new FormData();
    for (const [name, content] of files) form.append('files', new Blob([content]), name);
    return fetch(`${url}/api/files?prefix=${encodeURIComponent(prefix)}`, { method: 'POST', body: form });
  }

  it('uploads several files in one request; each can be downloaded byte for byte', async () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 13, 10, 45, 45]);
    const res = await upload('docs/', [['one.txt', 'first'], ['Été 2026.bin', binary]]);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), {
      files: [
        { name: 'one.txt', key: 'docs/one.txt', ok: true, size: 5 },
        { name: 'Été 2026.bin', key: 'docs/Été 2026.bin', ok: true, size: 9 },
      ],
    });
    const download = await fetch(`${baseUrl}/api/files/download?key=${encodeURIComponent('docs/Été 2026.bin')}`);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(binary));
    assert.equal(await (await fetch(`${baseUrl}/api/files/download?key=docs/one.txt`)).text(), 'first');
  });

  // Raw multipart bodies, so tests control every byte (file names, truncation, malformed framing).
  const BOUNDARY = 'test-boundary-7MA4YWxk';
  // A raw control character is not allowed in a part header, so such names are sent RFC 5987-encoded
  // (`filename*=UTF-8''…`), as a client would; busboy decodes them before validation.
  const filePart = (filename, content, field = 'files') =>
    Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; ` +
        (/[\x00-\x1f]/.test(filename) ? `filename*=UTF-8''${encodeURIComponent(filename)}` : `filename="${filename}"`) +
        '\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.from(content),
      Buffer.from('\r\n'),
    ]);
  const fieldPart = (name, value) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const END = Buffer.from(`--${BOUNDARY}--\r\n`);
  const postRaw = (query, body, contentType = `multipart/form-data; boundary=${BOUNDARY}`) =>
    call('POST', `/api/files?${query}`, undefined, { body, headers: { 'Content-Type': contentType } });

  it('per file: an existing name is 409 FILE_EXISTS; the other files are still stored', async () => {
    const res = await postRaw('prefix=docs/', Buffer.concat([filePart('a.txt', 'NEW'), filePart('b.txt', 'B'), END]));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'UPLOAD_INCOMPLETE');
    assert.deepEqual(res.body.error.details.files, [
      { name: 'a.txt', key: 'docs/a.txt', ok: false, error: { code: 'FILE_EXISTS', message: 'A file with that name already exists' } },
      { name: 'b.txt', key: 'docs/b.txt', ok: true, size: 1 },
    ]);
    assert.equal(await (await fetch(`${baseUrl}/api/files/download?key=docs/a.txt`)).text(), 'a', 'not overwritten');
  });

  it('per file: invalid names are 400 and nothing is stored for them; an empty file input is ignored', async () => {
    const names = ['..', '.', ' x.txt', 'x.txt ', 'sub/x.txt', 'a\u0001b.txt', 'y'.repeat(1020)];
    const parts = names.map((n) => filePart(n, 'data'));
    const res = await postRaw('prefix=docs/', Buffer.concat([...parts, filePart('', ''), fieldPart('note', 'ignored'), filePart('good.txt', 'g'), END]));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UPLOAD_INCOMPLETE');
    const files = res.body.error.details.files;
    assert.deepEqual(files.map((f) => f.name), [...names, 'good.txt'], 'one result per named file, in order');
    for (const f of files.slice(0, -1)) {
      assert.equal(f.ok, false, f.name);
      assert.equal(f.error.code, 'BAD_REQUEST', f.name);
      assert.equal(f.key, undefined, `${f.name}: no key for an invalid name`);
    }
    assert.match(files.find((f) => f.name === 'sub/x.txt').error.message, /must not contain "\/"/);
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt', 'good.txt']);
    assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.folders.map((f) => f.name), ['sub'], 'no docs/sub/x.txt');
  });

  for (const [label, query, body, contentType] of [
    ['a JSON body', 'prefix=docs/', Buffer.from('{"a":1}'), 'application/json'],
    ['multipart without a boundary', 'prefix=docs/', END, 'multipart/form-data'],
    ['multipart with no files', 'prefix=docs/', Buffer.concat([fieldPart('note', 'x'), END]), undefined],
    ['a bad prefix', 'prefix=../x', Buffer.concat([filePart('a.txt', 'a'), END]), undefined],
    ['a structured prefix', 'prefix[a]=docs/', Buffer.concat([filePart('a.txt', 'a'), END]), undefined],
  ]) {
    it(`request level: ${label} → 400 BAD_REQUEST, nothing stored`, async () => {
      const res = await postRaw(query, body, contentType);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'BAD_REQUEST');
      assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
    });
  }

  describe('malformed or truncated multipart', () => {
    const MALFORMED = { code: 'MALFORMED_UPLOAD', message: 'The upload was malformed or cut off.' };
    const docsFiles = async () => (await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name);
    const rawHeader = (filename) =>
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n\r\n`);

    it('a malformed part header (raw control character) → 400 MALFORMED_UPLOAD; the server stays up', async () => {
      const res = await postRaw('prefix=docs/', Buffer.concat([rawHeader('a\u0001b.txt'), Buffer.from('x\r\n'), END]));
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.error, MALFORMED);
      assert.deepEqual(await docsFiles(), ['a.txt']);
      assert.equal((await call('GET', '/api/health')).status, 200);
    });

    it('a body that ends inside a file (no closing boundary) → 400; the partial file is not stored', async () => {
      const res = await postRaw('prefix=docs/', Buffer.concat([rawHeader('cut.txt'), Buffer.from('half of the da')]));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UPLOAD_FAILED');
      assert.deepEqual(res.body.error.details.files, [{ name: 'cut.txt', key: 'docs/cut.txt', ok: false, error: MALFORMED }]);
      assert.deepEqual(await docsFiles(), ['a.txt']);
    });

    it('cut off after one complete file: that file is reported stored, the cut one failed, and the request malformed', async () => {
      const res = await postRaw('prefix=docs/', Buffer.concat([filePart('whole.txt', 'W'), rawHeader('cut.txt'), Buffer.from('par')]));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UPLOAD_INCOMPLETE');
      assert.deepEqual(res.body.error.details, {
        uploaded: 1,
        failed: 1,
        files: [
          { name: 'whole.txt', key: 'docs/whole.txt', ok: true, size: 1 },
          { name: 'cut.txt', key: 'docs/cut.txt', ok: false, error: MALFORMED },
        ],
        malformed: MALFORMED,
      });
      assert.deepEqual(await docsFiles(), ['a.txt', 'whole.txt']);
    });

    it('malformed between files: the stored file is reported, and the request still fails as malformed', async () => {
      const res = await postRaw('prefix=docs/', Buffer.concat([filePart('whole.txt', 'W'), rawHeader('bad\u0001.txt'), END]));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UPLOAD_INCOMPLETE', 'never 201 for a malformed request');
      assert.deepEqual(res.body.error.details.files, [{ name: 'whole.txt', key: 'docs/whole.txt', ok: true, size: 1 }]);
      assert.deepEqual(res.body.error.details.malformed, MALFORMED);
    });

    it('S3: a body cut off mid-multipart-upload aborts it; nothing is left behind', async () => {
      const client = new FakeS3Client({}, { minPartSize: 64 });
      storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
      const res = await postRaw('prefix=', Buffer.concat([rawHeader('big.bin'), Buffer.alloc(100_000)]));
      assert.equal(res.status, 400);
      assert.ok(client.calls.includes('UploadPartCommand'), 'parts were streamed before the cut');
      assert.equal(client.calls.filter((c) => c === 'AbortMultipartUploadCommand').length, 1);
      assert.equal(client.uploads.size, 0);
      assert.equal(client.objects.size, 0);
    });
  });

  it('per file: an S3 failure is a fixed STORAGE_ERROR reason (raw details only in the server log); no upload left open', async () => {
    const client = new FakeS3Client({}, { minPartSize: 64 });
    client.failNext('UploadPartCommand', { name: 'AccessDenied', status: 403, message: 'secret internal detail' });
    storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
    let res;
    const logged = await quietly(async () => {
      res = await upload('', [['ok.txt', 'fine'], ['big.bin', Buffer.alloc(1000)]]);
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error.code, 'UPLOAD_INCOMPLETE');
    assert.deepEqual(body.error.details.files[1], {
      name: 'big.bin',
      key: 'big.bin',
      ok: false,
      error: { code: 'STORAGE_ERROR', message: STORAGE_REASONS.ACCESS_DENIED, details: { reason: 'ACCESS_DENIED' } },
    });
    assert.ok(!JSON.stringify(body).includes('secret internal detail'));
    assert.match(JSON.stringify(logged.map((args) => String(args[0]?.message ?? args[0]))), /secret internal detail/);
    assert.equal(client.uploads.size, 0);
    assert.deepEqual([...client.objects.keys()], ['ok.txt']);
  });

  // A multipart POST is a CORS "simple request": browsers send it cross-site without a preflight, so a
  // web page the user visits could upload into the bucket. Same-origin UI and the agent (no Origin) must work.
  it('collision: uploading a file with a folder\'s name is a per-file 409 NAME_CONFLICT; other files are stored', async () => {
    const res = await postRaw('prefix=', Buffer.concat([filePart('docs', 'x'), filePart('fine.txt', 'f'), END]));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details.files, [
      { name: 'docs', key: 'docs', ok: false, error: { code: 'NAME_CONFLICT', message: 'A folder with that name already exists' } },
      { name: 'fine.txt', key: 'fine.txt', ok: true, size: 1 },
    ]);
    assert.deepEqual((await call('GET', '/api/list')).body.files.map((f) => f.name), ['fine.txt', 'readme.txt']);
  });

  describe('cross-site requests', () => {
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:1']) {
      it(`an upload with Origin ${origin} is refused (403) and stores nothing`, async () => {
        const res = await call('POST', '/api/files?prefix=docs/', undefined, {
          body: Buffer.concat([filePart('x.txt', 'x'), END]),
          headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, Origin: origin },
        });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'FORBIDDEN_ORIGIN');
        assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
      });
    }

    it('same-origin uploads (the UI) and uploads without an Origin (the agent) work', async () => {
      const send = (name, headers) =>
        call('POST', '/api/files?prefix=docs/', undefined, {
          body: Buffer.concat([filePart(name, 'x'), END]),
          headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
        });
      assert.equal((await send('same.txt', { Origin: baseUrl })).status, 201);
      assert.equal((await send('agent.txt', {})).status, 201);
    });
  });

  describe('client abort', () => {
    // Sends the start of an upload, waits until `ready()` says the server is busy with it, then drops the connection.
    async function abortMidUpload(ready, bytes) {
      const req = http.request(`${baseUrl}/api/files?prefix=`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': 10_000_000 },
      });
      req.on('error', () => {}); // we destroy it ourselves
      req.write(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="gone.bin"\r\n\r\n`);
      req.write(Buffer.alloc(bytes));
      const deadline = Date.now() + 3000;
      while (!ready()) {
        assert.ok(Date.now() < deadline, 'server never started on the upload');
        await new Promise((r) => setTimeout(r, 5));
      }
      req.destroy();
    }
    const eventually = async (check, message) => {
      const deadline = Date.now() + 3000;
      while (!check()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    it('S3: aborts the multipart upload, stores nothing, and keeps serving', async () => {
      const client = new FakeS3Client({}, { minPartSize: 64 });
      storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
      await quietly(async () => {
        await abortMidUpload(() => client.calls.includes('UploadPartCommand'), 100_000);
        await eventually(() => client.calls.includes('AbortMultipartUploadCommand'), 'multipart upload aborted after the client left');
      });
      assert.equal(client.uploads.size, 0, 'no multipart upload left open');
      assert.equal(client.objects.size, 0);
      assert.equal((await call('GET', '/api/health')).status, 200);
    });

    it('memory: the partial file is not stored', async () => {
      let started = false;
      const real = storage;
      storage = { ...real, putFile: (...args) => { started = true; return real.putFile(...args); } };
      await quietly(async () => {
        await abortMidUpload(() => started, 1000);
        await new Promise((r) => setTimeout(r, 200));
      });
      storage = real;
      assert.deepEqual((await call('GET', '/api/list')).body.files.map((f) => f.name), ['readme.txt']);
    });
  });

  describe('size limit (maxUploadBytes = 1024)', () => {
    let limited;
    let limitedUrl;
    before(async () => {
      const proxy = new Proxy({}, { get: (_, method) => (...args) => storage[method](...args) });
      limited = createApp({ storage: proxy, maxUploadBytes: 1024 }).listen(0, '127.0.0.1');
      await new Promise((resolve) => limited.once('listening', resolve));
      limitedUrl = `http://127.0.0.1:${limited.address().port}`;
    });
    after(() => limited.close());

    // ---- Total request limit (follow-up 2): body ≤ maxUploadBytes + 64 KiB of multipart framing ----
    const REQUEST_LIMIT = 1024 + 64 * 1024; // 66560
    const REQUEST_TOO_LARGE = { code: 'REQUEST_TOO_LARGE', message: `The upload is larger than the request limit (${REQUEST_LIMIT} bytes).` };
    const docsNow = async () => (await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name);
    const postTo = (target, query, body, headers = {}) =>
      fetch(`${target}/api/files?${query}`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
    // A request with no Content-Length (chunked), written piece by piece. Resolves with the response, and
    // whether the server closed the connection before every piece was written.
    function sendChunked(target, query, pieces) {
      return new Promise((resolve) => {
        let response;
        let closedEarly = false;
        const req = http.request(`${target}/api/files?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Transfer-Encoding': 'chunked' },
        });
        req.on('response', (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            response = { status: res.statusCode, body: JSON.parse(text), connection: res.headers.connection };
          });
        });
        const finish = () => setTimeout(() => resolve({ ...response, closedEarly }), 100);
        req.on('error', () => {
          closedEarly = true;
        });
        req.on('close', finish);
        (async () => {
          for (const piece of pieces) {
            if (req.destroyed) {
              closedEarly = true;
              return;
            }
            if (!req.write(piece)) await new Promise((r) => req.once('drain', r).once('close', r));
          }
          req.end();
        })();
      });
    }

    it('request limit: a declared body of exactly the limit is accepted; one byte more is 413 before anything is stored', async () => {
      const bodyOfSize = (name, size) => {
        const base = Buffer.concat([filePart(name, Buffer.alloc(1000)), fieldPart('pad', ''), END]).length;
        return Buffer.concat([filePart(name, Buffer.alloc(1000)), fieldPart('pad', 'x'.repeat(size - base)), END]);
      };
      const exact = bodyOfSize('edge.bin', REQUEST_LIMIT);
      assert.equal(exact.length, REQUEST_LIMIT);
      assert.equal((await postTo(limitedUrl, 'prefix=docs/', exact)).status, 201);
      const over = await postTo(limitedUrl, 'prefix=docs/', bodyOfSize('over.bin', REQUEST_LIMIT + 1));
      assert.equal(over.status, 413);
      assert.deepEqual(over.body.error, REQUEST_TOO_LARGE);
      assert.deepEqual(await docsNow(), ['a.txt', 'edge.bin']);
    });

    it('request limit: many files each within the per-file limit but together over it → 413, nothing stored', async () => {
      const parts = Array.from({ length: 70 }, (_, i) => filePart(`f${i}.bin`, Buffer.alloc(1000)));
      const res = await postTo(limitedUrl, 'prefix=docs/', Buffer.concat([...parts, END]));
      assert.equal(res.status, 413);
      assert.deepEqual(res.body.error, REQUEST_TOO_LARGE);
      assert.deepEqual(await docsNow(), ['a.txt']);
    });

    it('request limit, streamed (no Content-Length): files before the limit are stored and reported; the one in flight fails and its S3 upload is aborted', async () => {
      const client = new FakeS3Client({ 'docs/': '' }, { minPartSize: 64 });
      storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
      const pieces = Array.from({ length: 70 }, (_, i) => filePart(`f${i}.bin`, Buffer.alloc(1000, i)));
      const res = await sendChunked(limitedUrl, 'prefix=docs/', [...pieces, END]);
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, 'UPLOAD_INCOMPLETE');
      assert.deepEqual(res.body.error.details.requestTooLarge, REQUEST_TOO_LARGE);
      const files = res.body.error.details.files;
      const last = files.at(-1);
      assert.equal(last.ok, false);
      assert.deepEqual(last.error, REQUEST_TOO_LARGE);
      const reportedOk = files.filter((f) => f.ok).map((f) => f.key).sort();
      assert.ok(reportedOk.length > 50 && reportedOk.length < 70, `${reportedOk.length} stored before the limit`);
      assert.deepEqual([...client.objects.keys()].filter((k) => k !== 'docs/').sort(), reportedOk, 'exactly the reported files are stored');
      assert.equal(client.uploads.size, 0, 'no multipart upload left open');
    });

    // After stopping, the server discards at most one more request limit's worth (a bounded "lingering
    // close", so a client still sending can finish and read the answer), then drops the connection.
    // [label, first bytes, answer, 16 KiB chunks that follow: enough to pass the 66,560-byte request limit
    // for "over the limit" (it stops there), a few for "malformed" (it stops at once)]
    for (const [label, head, status, followingChunks] of [
      ['over the limit', filePart('huge.bin', '').subarray(0, -2), 413, 5], // a file part whose data never ends
      ['malformed', Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="a\u0001b"\r\n\r\n`), 400, 2],
    ]) {
      it(`request limit, streamed: a body that keeps coming after the upload stopped (${label}) is cut off, not read to the end`, async () => {
        const flood = Array.from({ length: 200 }, () => Buffer.alloc(16 * 1024)); // 3.2 MB, far past the allowance
        const res = await sendChunked(limitedUrl, 'prefix=docs/', [head, ...flood]);
        assert.equal(res.closedEarly, true, 'the server closed the connection instead of reading 3.2 MB');
        assert.deepEqual(await docsNow(), ['a.txt']);
        assert.equal((await call('GET', '/api/health')).status, 200);
      });

      it(`request limit, streamed: a client still sending a little after the stop (${label}) gets the ${status} answer`, async () => {
        const extra = Array.from({ length: followingChunks }, () => Buffer.alloc(16 * 1024)); // within the allowance
        const res = await sendChunked(limitedUrl, 'prefix=docs/', [head, ...extra, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
        assert.equal(res.status, status);
        assert.equal(res.connection, 'close');
        assert.deepEqual(await docsNow(), ['a.txt']);
      });
    }

    for (const [label, declared] of [['declared (Content-Length)', true], ['streamed (chunked)', false]]) {
      it(`request limit: a client sending a body up to twice the limit still reads its 413 (${label})`, async () => {
        const body = Buffer.concat([filePart('big.bin', Buffer.alloc(2 * REQUEST_LIMIT - 300)), END]);
        assert.ok(body.length > REQUEST_LIMIT && body.length <= 2 * REQUEST_LIMIT);
        const res = await new Promise((resolve) => {
          const req = http.request(`${limitedUrl}/api/files?prefix=docs/`, {
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
              ...(declared ? { 'Content-Length': body.length } : { 'Transfer-Encoding': 'chunked' }),
            },
          });
          req.on('response', (r) => {
            let text = '';
            r.on('data', (c) => (text += c));
            r.on('end', () => resolve({ status: r.statusCode }));
          });
          req.on('error', (err) => resolve({ error: err.code }));
          for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096));
          req.end();
        });
        assert.deepEqual(res, { status: 413 });
        assert.deepEqual(await docsNow(), ['a.txt']);
      });
    }

    it('request limit: a malformed streamed body under the limit is still MALFORMED_UPLOAD', async () => {
      const res = await sendChunked(limitedUrl, 'prefix=docs/', [Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="a\u0001b"\r\n\r\nx\r\n`), END]);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'MALFORMED_UPLOAD');
    });

    it('request limit: a streamed upload under the limit whose client disconnects keeps only complete files; no S3 upload left open', async () => {
      const client = new FakeS3Client({ 'docs/': '' }, { minPartSize: 64 });
      storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
      await quietly(async () => {
        const req = http.request(`${limitedUrl}/api/files?prefix=docs/`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Transfer-Encoding': 'chunked' },
        });
        req.on('error', () => {});
        req.write(Buffer.concat([filePart('whole.bin', Buffer.alloc(500)), filePart('cut.bin', Buffer.alloc(900)).subarray(0, 400)]));
        const deadline = Date.now() + 3000;
        while (!client.calls.includes('UploadPartCommand') || !client.objects.has('docs/whole.bin')) {
          assert.ok(Date.now() < deadline, 'server never reached the second file');
          await new Promise((r) => setTimeout(r, 5));
        }
        req.destroy();
        const until = Date.now() + 3000;
        while (client.uploads.size > 0) {
          assert.ok(Date.now() < until, 'the in-flight multipart upload was aborted');
          await new Promise((r) => setTimeout(r, 10));
        }
      });
      assert.deepEqual([...client.objects.keys()].sort(), ['docs/', 'docs/whole.bin']);
    });

    it('a file over the limit → 413, reported per file, nothing stored', async () => {
      const res = await upload('docs/', [['big.bin', Buffer.alloc(1025)]], limitedUrl);
      assert.equal(res.status, 413);
      const { error } = await res.json();
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.message, '1 of 1 files could not be uploaded.');
      assert.deepEqual(error.details, {
        uploaded: 0,
        failed: 1,
        files: [{ name: 'big.bin', key: 'docs/big.bin', ok: false, error: { code: 'TOO_LARGE', message: 'File is larger than the upload limit (1024 bytes).' } }],
      });
      assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt']);
    });

    it('exactly at the limit is accepted', async () => {
      const res = await upload('docs/', [['edge.bin', Buffer.alloc(1024)]], limitedUrl);
      assert.equal(res.status, 201);
    });

    it('a mix of good and oversize files: the good ones are stored, the big one is not, each reported', async () => {
      const res = await upload('docs/', [['ok1.txt', 'a'], ['big.bin', Buffer.alloc(5000)], ['ok2.txt', 'b']], limitedUrl);
      assert.equal(res.status, 413);
      const { error } = await res.json();
      assert.equal(error.code, 'UPLOAD_INCOMPLETE');
      assert.deepEqual(error.details.files.map((f) => [f.name, f.ok, f.error?.code]), [
        ['ok1.txt', true, undefined],
        ['big.bin', false, 'TOO_LARGE'],
        ['ok2.txt', true, undefined],
      ]);
      assert.deepEqual([error.details.uploaded, error.details.failed], [2, 1]);
      assert.deepEqual((await call('GET', '/api/list?prefix=docs/')).body.files.map((f) => f.name), ['a.txt', 'ok1.txt', 'ok2.txt']);
    });

    it('S3: a file over the limit before S3 starts reading (during its existence check) is a 413, not a crash', async () => {
      const client = new FakeS3Client({}, { minPartSize: 64 });
      storage = createS3Storage({ bucket: 'test', client, partSize: 64 });
      const res = await upload('', [['big.bin', Buffer.alloc(2000)]], limitedUrl);
      assert.equal(res.status, 413);
      // Only the read-only pre-checks (existence, name collision) ran; nothing was written or started.
      assert.deepEqual(client.calls.filter((c) => !['HeadObjectCommand', 'ListObjectsV2Command'].includes(c)), [], 'nothing was uploaded');
      assert.equal(client.objects.size, 0);
      assert.equal((await call('GET', '/api/health')).status, 200, 'the server is still up');
    });

    // The limit must exceed the stream buffers (~16 KiB each) so that S3 is already mid-upload when it trips.
    it('S3: a file that goes over the limit mid-upload aborts its multipart upload; nothing is left behind', async () => {
      const client = new FakeS3Client({}, { minPartSize: 64 });
      const app = createApp({ storage: createS3Storage({ bucket: 'test', client, partSize: 64 }), maxUploadBytes: 100_000 });
      const server2 = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server2.once('listening', resolve));
      try {
        // Over the 100,000-byte file limit, under the 165,536-byte request limit (100,000 + 64 KiB framing).
        const res = await upload('', [['big.bin', Buffer.alloc(150_000)]], `http://127.0.0.1:${server2.address().port}`);
        assert.equal(res.status, 413);
        assert.ok(client.calls.includes('UploadPartCommand'), 'parts were streamed before the limit was hit');
        assert.equal(client.calls.filter((c) => c === 'AbortMultipartUploadCommand').length, 1);
        assert.equal(client.uploads.size, 0, 'no multipart upload left open');
        assert.equal(client.objects.size, 0);
      } finally {
        server2.close();
      }
    });
  });
});

describe('errors and hardening', () => {
  it('returns JSON 404 for unknown API routes', async () => {
    const res = await call('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  const failingList = (props) => ({
    list: async () => {
      throw Object.assign(new Error('secret internal detail'), props);
    },
  });

  // [error properties, expected public reason]
  const storageFailures = [
    [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'ACCESS_DENIED'],
    [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'BUCKET_NOT_FOUND'],
    [{ name: 'SlowDown', $metadata: { httpStatusCode: 503 } }, 'THROTTLED'],
    [{ name: 'CredentialsProviderError' }, 'CREDENTIALS_UNAVAILABLE'],
    [{ name: 'TimeoutError' }, 'NETWORK'],
    [{ name: 'Error', code: 'ECONNREFUSED' }, 'NETWORK'],
    [{ name: 'SomethingNew', $metadata: { httpStatusCode: 500 } }, 'UNAVAILABLE'],
    [{ name: 'SomethingNew', $metadata: { httpStatusCode: 403 } }, 'ACCESS_DENIED'],
    [{ name: '<img src=x onerror=alert(1)>', $metadata: { httpStatusCode: 400 } }, 'UNKNOWN'],
    [{ name: 'constructor', $metadata: {} }, 'UNKNOWN'],
  ];
  for (const [props, reason] of storageFailures) {
    it(`maps storage error ${JSON.stringify(props.name)}${props.code ? `/${props.code}` : ''} to ${reason}`, async () => {
      storage = failingList(props);
      let res;
      const logged = await quietly(async () => {
        res = await call('GET', '/api/list');
      });
      assert.equal(res.status, 502);
      assert.deepEqual(res.body.error, { code: 'STORAGE_ERROR', message: STORAGE_REASONS[reason], details: { reason } });
      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('secret internal detail'), 'SDK message not reflected');
      if (props.name !== 'Error') assert.ok(!body.includes(props.name), 'SDK name not reflected');
      assert.match(String(logged[0]?.[0]?.message), /secret internal detail/, 'details kept in server log');
    });
  }

  it('returns a generic 500 for non-storage errors', async () => {
    storage = failingList({ name: 'TypeError' });
    let res;
    await quietly(async () => {
      res = await call('GET', '/api/list');
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body.error, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('sets security headers and serves the UI', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>File Manager<\/title>/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('rejects requests with a domain-name Host header (DNS rebinding)', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/list`,
        { headers: { Host: 'attacker.example:3000' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('isAllowedHost', () => {
  it('allows IP literals and localhost', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '192.168.1.20:3000', '[::1]:3000', 'localhost']) {
      assert.ok(isAllowedHost(host), host);
    }
  });

  it('rejects domain names and missing hosts', () => {
    for (const host of ['attacker.example', 'evil.localhost', 'macbook.local:3000', '', undefined]) {
      assert.ok(!isAllowedHost(host), String(host));
    }
  });
});
