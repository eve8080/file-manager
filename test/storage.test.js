import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { FakeS3Client } from './helpers/fake-s3-client.js';

const drivers = {
  memory: (initial) => createMemoryStorage(initial),
  s3: (initial) => createS3Storage({ bucket: 'test-bucket', client: new FakeS3Client(initial) }),
  's3 (2-item pages)': (initial) =>
    createS3Storage({ bucket: 'test-bucket', client: new FakeS3Client(initial, { pageSize: 2 }) }),
};

const SAMPLE = {
  'readme.txt': 'hello',
  'a/': '',
  'a/one.txt': '1',
  'a/two.txt': '22',
  'a/sub/deep.txt': 'x',
  'ab/keep.txt': 'keep',
  'implicit/only-child.txt': 'no marker for this folder',
  'empty/': '',
};

// The same behaviour is required of every storage driver.
for (const [name, make] of Object.entries(drivers)) {
  describe(`storage contract: ${name}`, () => {
    it('lists an empty bucket root', async () => {
      assert.deepEqual(await make({}).list(''), { folders: [], files: [] });
    });

    it('lists folders and files at the root', async () => {
      const result = await make(SAMPLE).list('');
      assert.deepEqual(result.folders, ['a', 'ab', 'empty', 'implicit']);
      assert.deepEqual(result.files.map((f) => f.name), ['readme.txt']);
      assert.equal(result.files[0].key, 'readme.txt');
      assert.equal(result.files[0].size, 5);
      assert.ok(!Number.isNaN(Date.parse(result.files[0].modified)));
    });

    it('lists a nested folder and hides its marker', async () => {
      const result = await make(SAMPLE).list('a/');
      assert.deepEqual(result.folders, ['sub']);
      assert.deepEqual(result.files.map((f) => f.key), ['a/one.txt', 'a/two.txt']);
      assert.deepEqual(result.files.map((f) => f.name), ['one.txt', 'two.txt']);
    });

    it('lists a folder that only exists implicitly (no marker)', async () => {
      const result = await make(SAMPLE).list('implicit/');
      assert.deepEqual(result.files.map((f) => f.name), ['only-child.txt']);
    });

    it('lists an empty folder (marker only)', async () => {
      assert.deepEqual(await make(SAMPLE).list('empty/'), { folders: [], files: [] });
    });

    it('rejects listing a missing folder with NOT_FOUND', async () => {
      await assert.rejects(make(SAMPLE).list('missing/'), { status: 404, code: 'NOT_FOUND' });
    });

    it('creates a folder that then appears in its parent', async () => {
      const storage = make(SAMPLE);
      await storage.createFolder('a/new/');
      assert.deepEqual((await storage.list('a/')).folders, ['new', 'sub']);
      assert.deepEqual(await storage.list('a/new/'), { folders: [], files: [] });
    });

    it('refuses to create an existing folder (marker or implicit)', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.createFolder('a/'), { status: 409, code: 'FOLDER_EXISTS' });
      await assert.rejects(storage.createFolder('implicit/'), { status: 409, code: 'FOLDER_EXISTS' });
    });

    it('deletes an empty folder', async () => {
      const storage = make(SAMPLE);
      assert.equal(await storage.deleteFolder('empty/'), 1);
      assert.ok(!(await storage.list('')).folders.includes('empty'));
    });

    it('refuses to delete a non-empty folder without recursive, deleting nothing', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.deleteFolder('a/'), { status: 409, code: 'FOLDER_NOT_EMPTY' });
      assert.equal((await storage.list('a/')).files.length, 2);
    });

    it('deletes a folder recursively without touching sibling prefixes', async () => {
      const storage = make(SAMPLE);
      assert.equal(await storage.deleteFolder('a/', { recursive: true }), 4);
      await assert.rejects(storage.list('a/'), { code: 'NOT_FOUND' });
      assert.deepEqual((await storage.list('ab/')).files.map((f) => f.name), ['keep.txt']);
      assert.deepEqual((await storage.list('')).folders, ['ab', 'empty', 'implicit']);
    });

    it('rejects deleting a missing folder with NOT_FOUND', async () => {
      await assert.rejects(make(SAMPLE).deleteFolder('missing/'), { status: 404, code: 'NOT_FOUND' });
    });
  });
}

describe('s3 driver specifics', () => {
  // The driver logs raw S3 failures server-side; keep test output clean.
  let originalError;
  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('never passes raw S3 error codes through in partial-delete details', async () => {
    const client = new FakeS3Client(SAMPLE, { failDeleteKeys: ['a/two.txt'], failDeleteCode: '<b>NewS3Code</b>' });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).deleteFolder('a/', { recursive: true }), (err) => {
      assert.deepEqual(err.details.failed, [{ key: 'a/two.txt', reason: 'UNKNOWN' }]);
      assert.ok(!JSON.stringify(err.details).includes('NewS3Code'));
      return true;
    });
  });

  it('deletes more than 1000 objects in batches', async () => {
    const initial = {};
    for (let i = 0; i < 2500; i += 1) initial[`big/file-${i}.txt`] = 'x';
    const client = new FakeS3Client(initial, { pageSize: 1000 });
    const storage = createS3Storage({ bucket: 'b', client });

    assert.equal(await storage.deleteFolder('big/', { recursive: true }), 2500);
    assert.equal(client.calls.filter((c) => c === 'DeleteObjectsCommand').length, 3);
    assert.equal(client.objects.size, 0);
  });

  // 2500 keys sort as big/0000 .. big/2499, so batches are [0000-0999], [1000-1999], [2000-2499].
  const bigFolder = () => {
    const initial = {};
    for (let i = 0; i < 2500; i += 1) initial[`big/${String(i).padStart(4, '0')}`] = 'x';
    return initial;
  };
  const range = (from, to) =>
    Array.from({ length: to - from }, (_, i) => `big/${String(from + i).padStart(4, '0')}`);

  it('reports per-object failures as DELETE_INCOMPLETE and stops before later batches', async () => {
    const client = new FakeS3Client(bigFolder(), { failDeleteKeys: ['big/0500'] });
    const storage = createS3Storage({ bucket: 'b', client });

    await assert.rejects(storage.deleteFolder('big/', { recursive: true }), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'DELETE_INCOMPLETE');
      assert.deepEqual(err.details, {
        path: 'big/',
        requested: 2500,
        deleted: 999,
        failedCount: 1,
        failed: [{ key: 'big/0500', reason: 'ACCESS_DENIED' }],
        unknown: 0,
        notAttempted: 1500,
      });
      return true;
    });
    assert.equal(client.deleteCalls, 1, 'later batches must not be attempted');
    assert.deepEqual([...client.objects.keys()].sort(), ['big/0500', ...range(1000, 2500)]);
  });

  it('decides a non-recursive delete with one bounded listing (marker plus one child)', async () => {
    const client = new FakeS3Client({ 'big/': '', ...bigFolder() }, { pageSize: 1000 });
    const listInputs = [];
    const send = client.send.bind(client);
    client.send = (command) => {
      if (command instanceof ListObjectsV2Command) listInputs.push(command.input);
      return send(command);
    };
    await assert.rejects(createS3Storage({ bucket: 'b', client }).deleteFolder('big/'), { code: 'FOLDER_NOT_EMPTY' });
    assert.equal(listInputs.length, 1, 'one listing request, not the whole prefix');
    assert.ok(listInputs[0].MaxKeys <= 2, `MaxKeys ${listInputs[0].MaxKeys}`);
    assert.equal(client.deleteCalls, 0);
    assert.equal(client.objects.size, 2501);
  });

  it('follows a short truncated page before deciding a non-recursive delete (marker first, child later)', async () => {
    // S3 may return fewer keys than MaxKeys with IsTruncated set; pageSize 1 forces exactly that.
    const client = new FakeS3Client({ 'x/': '', 'x/child.txt': 'c' }, { pageSize: 1 });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).deleteFolder('x/'), { code: 'FOLDER_NOT_EMPTY' });
    assert.equal(client.deleteCalls, 0, 'nothing deleted');
    assert.deepEqual([...client.objects.keys()].sort(), ['x/', 'x/child.txt']);
    assert.equal(client.calls.filter((c) => c === 'ListObjectsV2Command').length, 2, 'stops once a child is seen');
  });

  it('reports a failure in a later batch with the earlier batches counted as deleted', async () => {
    const client = new FakeS3Client(bigFolder(), { failDeleteKeys: ['big/1001', 'big/1002'] });
    const storage = createS3Storage({ bucket: 'b', client });

    await assert.rejects(storage.deleteFolder('big/', { recursive: true }), (err) => {
      assert.equal(err.details.deleted, 1998);
      assert.equal(err.details.failedCount, 2);
      assert.equal(err.details.notAttempted, 500);
      return true;
    });
    assert.deepEqual([...client.objects.keys()].sort(), ['big/1001', 'big/1002', ...range(2000, 2500)]);
  });

  it('caps the reported failure list at 20 but keeps the full count', async () => {
    const failing = range(0, 30);
    const client = new FakeS3Client(bigFolder(), { failDeleteKeys: failing });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).deleteFolder('big/', { recursive: true }), (err) => {
      assert.equal(err.details.failedCount, 30);
      assert.equal(err.details.failed.length, 20);
      assert.equal(err.details.deleted, 970);
      return true;
    });
  });

  it('reports a failed DeleteObjects request as unknown outcome, not as deleted', async () => {
    const client = new FakeS3Client(bigFolder(), { throwOnDeleteCall: 2 });
    const storage = createS3Storage({ bucket: 'b', client });
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(storage.deleteFolder('big/', { recursive: true }), (err) => {
        assert.equal(err.code, 'DELETE_INCOMPLETE');
        assert.deepEqual(err.details, {
          path: 'big/',
          requested: 2500,
          deleted: 1000,
          failedCount: 0,
          failed: [],
          unknown: 1000,
          notAttempted: 500,
          reason: 'NETWORK',
        });
        return true;
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(client.deleteCalls, 2);
    assert.deepEqual([...client.objects.keys()].sort(), range(1000, 2500));
  });

  it('reports a failure of the only batch as DELETE_INCOMPLETE too', async () => {
    const client = new FakeS3Client(SAMPLE, { failDeleteKeys: ['a/two.txt'] });
    const storage = createS3Storage({ bucket: 'b', client });
    await assert.rejects(storage.deleteFolder('a/', { recursive: true }), (err) => {
      assert.equal(err.details.deleted, 3);
      assert.deepEqual(err.details.failed, [{ key: 'a/two.txt', reason: 'ACCESS_DENIED' }]);
      assert.equal(err.details.notAttempted, 0);
      return true;
    });
    assert.deepEqual([...client.objects.keys()].filter((k) => k.startsWith('a/')), ['a/two.txt']);
  });

  it('paginates listings with many entries', async () => {
    const initial = {};
    for (let i = 0; i < 7; i += 1) initial[`f${i}/x.txt`] = 'x';
    for (let i = 0; i < 5; i += 1) initial[`file${i}.txt`] = 'x';
    const client = new FakeS3Client(initial, { pageSize: 3 });
    const result = await createS3Storage({ bucket: 'b', client }).list('');
    assert.equal(result.folders.length, 7);
    assert.equal(result.files.length, 5);
    assert.ok(client.calls.filter((c) => c === 'ListObjectsV2Command').length >= 4);
  });
});
