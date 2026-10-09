import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, isAllowedHost } from '../src/app.js';
import { STORAGE_REASONS } from '../src/errors.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { FakeS3Client } from './helpers/fake-s3-client.js';

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

async function call(method, path, body) {
  const res = await fetch(baseUrl + path, {
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
