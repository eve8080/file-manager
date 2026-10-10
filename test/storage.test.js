import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { PREVIEW_TEXT_BYTES } from '../src/preview.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { FakeS3Client, TEST_SIGNER } from './helpers/fake-s3-client.js';

const drivers = {
  memory: (initial) => createMemoryStorage(initial),
  s3: (initial) => createS3Storage({ bucket: 'test-bucket', client: new FakeS3Client(initial), signingClient: TEST_SIGNER }),
  's3 (2-item pages)': (initial) =>
    createS3Storage({ bucket: 'test-bucket', client: new FakeS3Client(initial, { pageSize: 2 }), signingClient: TEST_SIGNER }),
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

    // ---- M2: files ----

    it('deletes a file and nothing else', async () => {
      const storage = make(SAMPLE);
      await storage.deleteFile('a/one.txt');
      assert.deepEqual((await storage.list('a/')).files.map((f) => f.name), ['two.txt']);
      assert.deepEqual((await storage.list('ab/')).files.map((f) => f.name), ['keep.txt']);
    });

    it('rejects deleting a missing file with NOT_FOUND, even where a folder of that name exists', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.deleteFile('a/missing.txt'), { status: 404, code: 'NOT_FOUND' });
      await assert.rejects(storage.deleteFile('empty'), { status: 404, code: 'NOT_FOUND' });
      assert.deepEqual(await storage.list('empty/'), { folders: [], files: [] }, 'the folder is untouched');
    });

    it('moves (renames) a file, keeping its content', async () => {
      const storage = make(SAMPLE);
      await storage.moveFile('a/two.txt', 'a/renamed.txt');
      assert.deepEqual((await storage.list('a/')).files.map((f) => [f.name, f.size]), [['one.txt', 1], ['renamed.txt', 2]]);
      await storage.moveFile('a/renamed.txt', 'new-folder/moved.txt'); // the destination folder need not exist
      assert.deepEqual((await storage.list('new-folder/')).files.map((f) => [f.name, f.size]), [['moved.txt', 2]]);
      assert.deepEqual((await storage.list('a/')).files.map((f) => f.name), ['one.txt']);
    });

    it('refuses to move a missing file (NOT_FOUND) or onto an existing file (FILE_EXISTS)', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.moveFile('a/missing.txt', 'a/x.txt'), { status: 404, code: 'NOT_FOUND' });
      await assert.rejects(storage.moveFile('a/one.txt', 'a/two.txt'), { status: 409, code: 'FILE_EXISTS' });
      await assert.rejects(storage.moveFile('a/one.txt', 'a/one.txt'), { status: 409, code: 'FILE_EXISTS' });
      assert.deepEqual((await storage.list('a/')).files.map((f) => [f.name, f.size]), [['one.txt', 1], ['two.txt', 2]]);
      await assert.rejects(storage.list('a/x.txt/'), { code: 'NOT_FOUND' });
    });

    it('upload: stores a stream of unknown size and reports its size', async () => {
      const storage = make(SAMPLE);
      assert.deepEqual(await storage.putFile('a/new.txt', Readable.from([Buffer.from('he'), Buffer.from('llo')])), { size: 5 });
      assert.deepEqual(await storage.putFile('a/empty.txt', Readable.from([])), { size: 0 });
      assert.deepEqual(
        (await storage.list('a/')).files.map((f) => [f.name, f.size]),
        [['empty.txt', 0], ['new.txt', 5], ['one.txt', 1], ['two.txt', 2]],
      );
    });

    it('upload: refuses to overwrite an existing file (FILE_EXISTS) and keeps the original', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.putFile('a/two.txt', Readable.from([Buffer.from('replaced!')])), { status: 409, code: 'FILE_EXISTS' });
      assert.deepEqual((await storage.list('a/')).files.map((f) => [f.name, f.size]), [['one.txt', 1], ['two.txt', 2]]);
    });

    it('upload: a stream that fails partway stores nothing', async () => {
      const storage = make(SAMPLE);
      const failing = new Readable({ read() {} });
      failing.push(Buffer.from('partial'));
      setImmediate(() => failing.destroy(new Error('client went away')));
      await assert.rejects(storage.putFile('a/broken.txt', failing), { message: 'client went away' });
      assert.deepEqual((await storage.list('a/')).files.map((f) => f.name), ['one.txt', 'two.txt']);
    });

    // File/folder name collisions (follow-up 1): a file may not get the visible name of a folder, and no
    // part of a file's path may be an existing file.
    const FOLDER_CONFLICT = { status: 409, code: 'NAME_CONFLICT', message: 'A folder with that name already exists' };
    const PATH_CONFLICT = { status: 409, code: 'NAME_CONFLICT', message: 'Part of that path is a file, not a folder' };
    const bodyOf = (text) => Readable.from([Buffer.from(text)]);

    it('collision: upload/move onto a folder name (marker or implicit folder) is NAME_CONFLICT; nothing changes', async () => {
      const storage = make(SAMPLE);
      for (const key of ['empty', 'implicit', 'a/sub']) {
        await assert.rejects(storage.putFile(key, bodyOf('x')), FOLDER_CONFLICT, key);
      }
      await assert.rejects(storage.moveFile('readme.txt', 'ab'), FOLDER_CONFLICT);
      assert.deepEqual((await storage.list('')).files.map((f) => f.name), ['readme.txt']);
      assert.deepEqual((await storage.list('a/')).files.map((f) => f.name), ['one.txt', 'two.txt']);
    });

    it('collision: upload/move through a path whose part is a file is NAME_CONFLICT', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.putFile('readme.txt/x.txt', bodyOf('x')), PATH_CONFLICT);
      await assert.rejects(storage.moveFile('a/one.txt', 'a/two.txt/deeper/x.txt'), PATH_CONFLICT);
      await assert.rejects(storage.list('readme.txt/'), { code: 'NOT_FOUND' });
      assert.deepEqual((await storage.list('a/')).files.map((f) => f.name), ['one.txt', 'two.txt']);
    });

    it('collision: similar names are not conflicts, and an existing file is still FILE_EXISTS', async () => {
      const storage = make(SAMPLE);
      assert.deepEqual(await storage.putFile('abc', bodyOf('1')), { size: 1 }); // folder "ab/" is a different name
      assert.deepEqual(await storage.putFile('a.txt', bodyOf('1')), { size: 1 }); // folder "a/" is a different name
      await storage.moveFile('a/one.txt', 'a/sub2.txt');
      await storage.moveFile('a/sub2.txt', 'brand/new/place.txt'); // new implicit folders are fine
      await assert.rejects(storage.putFile('readme.txt', bodyOf('x')), { status: 409, code: 'FILE_EXISTS' });
      await assert.rejects(storage.moveFile('a/two.txt', 'readme.txt'), { status: 409, code: 'FILE_EXISTS' });
      assert.deepEqual((await storage.list('brand/new/')).files.map((f) => f.name), ['place.txt']);
    });

    it('download: a missing file (or a folder name) is NOT_FOUND', async () => {
      const storage = make(SAMPLE);
      await assert.rejects(storage.getDownload('a/missing.txt'), { status: 404, code: 'NOT_FOUND' });
      await assert.rejects(storage.getDownload('empty'), { status: 404, code: 'NOT_FOUND' });
    });

    it('download: memory gives the bytes; S3 gives a presigned GET URL valid for exactly 5 minutes', async () => {
      const download = await make(SAMPLE).getDownload('a/two.txt');
      if (name === 'memory') {
        assert.deepEqual(download, { body: Buffer.from('22') });
        return;
      }
      const url = new URL(download.url);
      assert.deepEqual(Object.keys(download), ['url']);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'test-bucket.s3.us-east-1.amazonaws.com');
      assert.equal(url.pathname, '/a/two.txt');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
      assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
      assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
      assert.equal(url.searchParams.get('response-content-disposition'), `attachment; filename="two.txt"; filename*=UTF-8''two.txt`);
    });

    // ---- M3: preview ----

    it('preview text: a small text file is returned whole, not truncated', async () => {
      assert.deepEqual(await make(SAMPLE).getPreview('a/two.txt'), { kind: 'text', text: '22', truncated: false });
      assert.deepEqual(await make({ 'e.txt': '' }).getPreview('e.txt'), { kind: 'text', text: '', truncated: false });
    });

    it('preview text: HTML is returned as the raw characters, unchanged', async () => {
      const html = '<script>window.pwned = 1</script><img src=x onerror="alert(1)">&amp; "quotes"';
      assert.deepEqual(await make({ 'page.html': html }).getPreview('page.html'), { kind: 'text', text: html, truncated: false });
    });

    it('preview text: exactly 1 MiB is whole; one byte more is truncated to the first 1 MiB', async () => {
      const exact = 'a'.repeat(PREVIEW_TEXT_BYTES);
      assert.deepEqual(await make({ 'x.txt': exact }).getPreview('x.txt'), { kind: 'text', text: exact, truncated: false });
      const over = await make({ 'x.txt': `${exact}b` }).getPreview('x.txt');
      assert.equal(over.truncated, true);
      assert.equal(over.text, exact);
    });

    it('preview text: a multi-byte character cut by the 1 MiB limit is dropped, not shown broken', async () => {
      const body = `${'a'.repeat(PREVIEW_TEXT_BYTES - 1)}é and more`; // "é" is 2 bytes and straddles the limit
      const preview = await make({ 'x.txt': body }).getPreview('x.txt');
      assert.equal(preview.truncated, true);
      assert.equal(preview.text, 'a'.repeat(PREVIEW_TEXT_BYTES - 1));
      assert.ok(!preview.text.includes('�'));
      assert.equal((await make({ 'u.txt': 'Été 🌍 ok' }).getPreview('u.txt')).text, 'Été 🌍 ok');
    });

    it('preview image/pdf: memory gives the bytes and a fixed content type; S3 a presigned inline GET URL valid for exactly 5 minutes', async () => {
      const storage = make({ 'pics/Été 1.PNG': 'png-bytes', 'docs/r.pdf': 'pdf-bytes', 'p.webp': 'w' });
      for (const [key, kind, contentType, bytes] of [
        ['pics/Été 1.PNG', 'image', 'image/png', 'png-bytes'],
        ['docs/r.pdf', 'pdf', 'application/pdf', 'pdf-bytes'],
        ['p.webp', 'image', 'image/webp', 'w'],
      ]) {
        const preview = await storage.getPreview(key);
        if (name === 'memory') {
          assert.deepEqual(preview, { kind, contentType, body: Buffer.from(bytes) }, key);
          continue;
        }
        assert.deepEqual(Object.keys(preview).sort(), ['contentType', 'kind', 'url'], key);
        assert.equal(preview.kind, kind);
        assert.equal(preview.contentType, contentType);
        const url = new URL(preview.url);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.hostname, 'test-bucket.s3.us-east-1.amazonaws.com');
        assert.equal(decodeURIComponent(url.pathname), `/${key}`);
        assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
        assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
        // The type comes from the extension (uploads store no content type), and the browser shows it inline.
        assert.equal(url.searchParams.get('response-content-type'), contentType);
        assert.match(url.searchParams.get('response-content-disposition'), /^inline; filename="/);
      }
    });

    it('preview: other types are kind "none" (download only), with nothing else', async () => {
      const storage = make({ 'a.zip': 'zip', 'Makefile': 'all:', 'x.svgz': 's' });
      for (const key of ['a.zip', 'Makefile', 'x.svgz']) assert.deepEqual(await storage.getPreview(key), { kind: 'none' }, key);
    });

    it('preview: a missing file, or a folder name, is NOT_FOUND (whatever its kind)', async () => {
      const storage = make(SAMPLE);
      for (const key of ['a/missing.txt', 'a/missing.png', 'a/missing.pdf', 'a/missing.zip', 'a/missing.jpg', 'a/missing.JPEG', 'empty', 'a/sub']) {
        await assert.rejects(storage.getPreview(key), { status: 404, code: 'NOT_FOUND' }, key);
      }
    });

    // ---- M4: JPEG previews are normalised by the app, so the storage hands out neither a URL nor bytes ----

    it('preview jpeg: only { kind, contentType } - no presigned URL and no bytes (the app serves a converted copy)', async () => {
      const storage = make({ 'p/IMG_0001.jpg': 'jpeg-bytes', 'p/B.JPEG': 'x', 'p/c.png': 'png' });
      for (const key of ['p/IMG_0001.jpg', 'p/B.JPEG']) {
        assert.deepEqual(await storage.getPreview(key), { kind: 'image', contentType: 'image/jpeg' }, key);
      }
      const png = await storage.getPreview('p/c.png');
      assert.ok(png.url !== undefined || png.body !== undefined, 'other images still get a presigned URL / their bytes');
    });

    it('readPreviewSource: the exact bytes of the stored file (all byte values), or an empty buffer', async () => {
      const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const big = Buffer.alloc(200_000, 7); // several stream chunks
      const storage = make({ 'p/all.jpg': all, 'p/big.jpg': big, 'p/empty.jpg': '' });
      const limit = 1_000_000;
      assert.deepEqual(await storage.readPreviewSource('p/all.jpg', limit), all);
      assert.deepEqual(await storage.readPreviewSource('p/big.jpg', limit), big);
      const empty = await storage.readPreviewSource('p/empty.jpg', limit);
      assert.ok(Buffer.isBuffer(empty));
      assert.equal(empty.length, 0);
    });

    it('readPreviewSource: a file of exactly the limit is read; one byte more is PREVIEW_TOO_LARGE (413)', async () => {
      const storage = make({ 'p/exact.jpg': Buffer.alloc(1000, 1), 'p/over.jpg': Buffer.alloc(1001, 1) });
      assert.equal((await storage.readPreviewSource('p/exact.jpg', 1000)).length, 1000);
      await assert.rejects(storage.readPreviewSource('p/over.jpg', 1000), { status: 413, code: 'PREVIEW_TOO_LARGE' });
    });

    it('readPreviewSource: a missing file, or a folder name, is NOT_FOUND', async () => {
      const storage = make(SAMPLE);
      for (const key of ['a/missing.jpg', 'empty', 'a/sub']) {
        await assert.rejects(storage.readPreviewSource(key, 1000), { status: 404, code: 'NOT_FOUND' }, key);
      }
    });

    it('readPreviewSource never changes the stored file or the listing', async () => {
      const storage = make({ 'p/x.jpg': 'original' });
      const before = await storage.list('p/');
      await storage.readPreviewSource('p/x.jpg', 100);
      await storage.getPreview('p/x.jpg');
      assert.deepEqual(await storage.list('p/'), before);
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

  // ---- M2: uploads of unknown size stream into S3 multipart uploads ----
  const PART = 64; // tiny parts for tests; the fake enforces the same minimum, like S3's 5 MiB
  const streamingS3 = (initial = {}) => {
    const client = new FakeS3Client(initial, { minPartSize: PART });
    return { client, storage: createS3Storage({ bucket: 'b', client, partSize: PART }) };
  };
  const bytes = (n, fill = 'x') => Buffer.alloc(n, fill);
  const called = (client, name) => client.calls.filter((c) => c === name).length;

  it('upload: a stream larger than one part goes up as a multipart upload in parts of exactly partSize', async () => {
    const { client, storage } = streamingS3();
    const data = Buffer.concat([bytes(100, 'a'), bytes(100, 'b'), bytes(30, 'c')]); // 230 bytes, odd chunking
    const chunks = [data.subarray(0, 7), data.subarray(7, 150), data.subarray(150)];
    assert.deepEqual(await storage.putFile('big.bin', Readable.from(chunks)), { size: 230 });
    assert.ok(client.objects.get('big.bin').body.equals(data), 'bytes preserved');
    assert.equal(called(client, 'PutObjectCommand'), 0);
    assert.equal(called(client, 'CreateMultipartUploadCommand'), 1);
    const parts = client.inputs.filter((c) => c.name === 'UploadPartCommand').map((c) => c.input);
    assert.deepEqual(parts.map((p) => [p.PartNumber, p.Body.length]), [[1, 64], [2, 64], [3, 64], [4, 38]]);
    const complete = client.inputs.find((c) => c.name === 'CompleteMultipartUploadCommand').input;
    assert.equal(complete.IfNoneMatch, '*', 'never overwrites');
    assert.equal(client.uploads.size, 0, 'no multipart upload left open');
  });

  it('upload: parts are sent while the stream is still arriving (streamed, not buffered)', async () => {
    const { client, storage } = streamingS3();
    const source = new Readable({ read() {} });
    const done = storage.putFile('live.bin', source);
    source.push(bytes(PART + 10));
    const deadline = Date.now() + 2000;
    while (called(client, 'UploadPartCommand') === 0) {
      assert.ok(Date.now() < deadline, 'the first part must be uploaded before the stream ends');
      await new Promise((r) => setTimeout(r, 5));
    }
    source.push(bytes(20));
    source.push(null);
    assert.deepEqual(await done, { size: PART + 30 });
  });

  it('upload: a stream that fits in one part is a single conditional PutObject with a known length', async () => {
    const { client, storage } = streamingS3();
    assert.deepEqual(await storage.putFile('small.txt', Readable.from([bytes(PART)])), { size: PART });
    const put = client.inputs.find((c) => c.name === 'PutObjectCommand').input;
    assert.equal(put.ContentLength, PART);
    assert.equal(put.IfNoneMatch, '*');
    assert.equal(called(client, 'CreateMultipartUploadCommand'), 0);
  });

  // Abort-on-failure: no multipart upload may be left open, and no object may appear.
  const assertCleanedUp = (client, key) => {
    assert.equal(called(client, 'AbortMultipartUploadCommand'), 1, 'aborted once');
    assert.equal(client.uploads.size, 0, 'no multipart upload left open');
    assert.ok(!client.objects.has(key), 'no object written');
  };

  it('upload cleanup: a stream error after parts were sent aborts the multipart upload', async () => {
    const { client, storage } = streamingS3();
    const source = new Readable({ read() {} });
    const done = storage.putFile('cut.bin', source);
    source.push(bytes(PART * 2 + 1));
    while (called(client, 'UploadPartCommand') < 2) await new Promise((r) => setTimeout(r, 5));
    source.destroy(new Error('Unexpected end of form'));
    await assert.rejects(done, { message: 'Unexpected end of form' });
    assertCleanedUp(client, 'cut.bin');
  });

  it('upload cleanup: a failed UploadPart aborts and reports the S3 error', async () => {
    const { client, storage } = streamingS3();
    client.failNext('UploadPartCommand', { name: 'SlowDown', status: 503 });
    await assert.rejects(storage.putFile('p.bin', Readable.from([bytes(PART * 3)])), { name: 'SlowDown' });
    assertCleanedUp(client, 'p.bin');
  });

  it('upload cleanup: a failed CompleteMultipartUpload aborts', async () => {
    const { client, storage } = streamingS3();
    client.failNext('CompleteMultipartUploadCommand', { name: 'InternalError', status: 500 });
    await assert.rejects(storage.putFile('c.bin', Readable.from([bytes(PART * 2)])), { name: 'InternalError' });
    assertCleanedUp(client, 'c.bin');
  });

  it('upload cleanup: losing the race to another writer (412 on Complete) is FILE_EXISTS and keeps their file', async () => {
    const { client, storage } = streamingS3();
    const source = new Readable({ read() {} });
    const done = storage.putFile('race.bin', source);
    source.push(bytes(PART + 1));
    while (called(client, 'UploadPartCommand') < 1) await new Promise((r) => setTimeout(r, 5));
    client.put('race.bin', 'theirs'); // another writer finishes first
    source.push(null);
    await assert.rejects(done, { status: 409, code: 'FILE_EXISTS' });
    assert.equal(called(client, 'AbortMultipartUploadCommand'), 1);
    assert.equal(client.uploads.size, 0);
    assert.equal(client.body('race.bin'), 'theirs');
  });

  it('upload cleanup: if the abort itself fails, the original error is still reported (and logged)', async () => {
    const { client, storage } = streamingS3();
    client.failNext('UploadPartCommand', { name: 'SlowDown', status: 503 });
    client.failNext('AbortMultipartUploadCommand', { name: 'InternalError', status: 500 });
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    await assert.rejects(storage.putFile('a.bin', Readable.from([bytes(PART * 3)])), { name: 'SlowDown' });
    assert.match(logged.join('\n'), /Could not abort multipart upload upload-1 for a\.bin/);
  });

  it('upload: a small upload that loses the race (412 on PutObject) is FILE_EXISTS', async () => {
    const { client, storage } = streamingS3();
    client.failNext('PutObjectCommand', { name: 'PreconditionFailed', status: 412 });
    await assert.rejects(storage.putFile('s.txt', Readable.from([bytes(3)])), { status: 409, code: 'FILE_EXISTS' });
  });

  // ---- M3: preview ----

  it('preview: a text file costs one HEAD and one GET ranged to the first 1 MiB; an empty file or an image no GET', async () => {
    const client = new FakeS3Client({ 'big.txt': 'x'.repeat(PREVIEW_TEXT_BYTES + 10), 'e.txt': '', 'p.png': 'p' });
    const storage = createS3Storage({ bucket: 'b', client, signingClient: TEST_SIGNER });
    const big = await storage.getPreview('big.txt');
    assert.deepEqual([big.text.length, big.truncated], [PREVIEW_TEXT_BYTES, true]);
    assert.deepEqual(client.calls, ['HeadObjectCommand', 'GetObjectCommand']);
    assert.equal(client.inputs[1].input.Range, 'bytes=0-1048575');
    client.calls.length = 0;
    await storage.getPreview('e.txt');
    await storage.getPreview('p.png'); // presigning is local; TEST_SIGNER refuses to send anything
    assert.deepEqual(client.calls, ['HeadObjectCommand', 'HeadObjectCommand']);
  });

  it('preview: a file deleted between the HEAD and the GET is NOT_FOUND, not a storage error', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('GetObjectCommand', { name: 'NoSuchKey', status: 404 });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).getPreview('a.txt'), { status: 404, code: 'NOT_FOUND' });
  });

  it('preview: S3 failures reach the caller as the SDK error (the API turns them into fixed reasons)', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A', 'p.png': 'p' });
    const storage = createS3Storage({ bucket: 'b', client, signingClient: TEST_SIGNER });
    client.failNext('HeadObjectCommand', { name: 'AccessDenied', status: 403 });
    await assert.rejects(storage.getPreview('p.png'), { name: 'AccessDenied' });
    client.failNext('HeadObjectCommand', { name: 'NoSuchBucket', status: 404 }); // a missing bucket is not a missing file
    await assert.rejects(storage.getPreview('a.txt'), { name: 'NoSuchBucket' });
    client.failNext('GetObjectCommand', { name: 'SlowDown', status: 503 });
    await assert.rejects(storage.getPreview('a.txt'), { name: 'SlowDown' });
  });

  // ---- M4: normalised JPEG previews on S3 ----

  it('preview jpeg: costs one HEAD only - no GET of the photo and no presigning', async () => {
    const client = new FakeS3Client({ 'IMG_0001.jpg': 'jpeg-bytes' });
    const storage = createS3Storage({ bucket: 'b', client }); // no signing client: any presign attempt would fail loudly
    assert.deepEqual(await storage.getPreview('IMG_0001.jpg'), { kind: 'image', contentType: 'image/jpeg' });
    assert.deepEqual(client.calls, ['HeadObjectCommand']);
  });

  it('readPreviewSource: exactly one unranged GET, nothing written, and the whole body read', async () => {
    const photo = Buffer.alloc(150_000, 9);
    const client = new FakeS3Client({ 'p/IMG_0001.jpg': photo });
    const storage = createS3Storage({ bucket: 'b', client });
    assert.deepEqual(await storage.readPreviewSource('p/IMG_0001.jpg', 1_000_000), photo);
    assert.deepEqual(client.calls, ['GetObjectCommand']);
    assert.deepEqual(client.inputs[0].input, { Bucket: 'b', Key: 'p/IMG_0001.jpg' }, 'no Range, no overrides');
    assert.deepEqual(client.objects.get('p/IMG_0001.jpg').body, photo, 'the stored original is untouched');
  });

  it('readPreviewSource: a file over the limit is refused from the GET headers - its body is destroyed unread', async () => {
    const client = new FakeS3Client({ 'big.jpg': Buffer.alloc(300_000, 1) });
    const storage = createS3Storage({ bucket: 'b', client });
    await assert.rejects(storage.readPreviewSource('big.jpg', 299_999), { status: 413, code: 'PREVIEW_TOO_LARGE' });
    assert.equal(client.lastBody.destroyed, true);
    assert.equal(client.lastBody.readableDidRead, false, 'not a byte was read');
    assert.deepEqual(client.calls, ['GetObjectCommand']);
  });

  it('readPreviewSource: a body longer than its declared length still stops at the limit (never buffers past it)', async () => {
    class LyingClient extends FakeS3Client {
      async send(command) {
        const result = await super.send(command);
        return result.Body ? { ...result, ContentLength: 10 } : result;
      }
    }
    const client = new LyingClient({ 'liar.jpg': Buffer.alloc(300_000, 1) });
    const storage = createS3Storage({ bucket: 'b', client });
    await assert.rejects(storage.readPreviewSource('liar.jpg', 100_000), { status: 413, code: 'PREVIEW_TOO_LARGE' });
    assert.equal(client.lastBody.destroyed, true);
  });

  it('readPreviewSource: NoSuchKey is NOT_FOUND; other S3 failures reach the caller as the SDK error', async () => {
    const client = new FakeS3Client({ 'a.jpg': 'A' });
    const storage = createS3Storage({ bucket: 'b', client });
    await assert.rejects(storage.readPreviewSource('missing.jpg', 100), { status: 404, code: 'NOT_FOUND' });
    client.failNext('GetObjectCommand', { name: 'AccessDenied', status: 403 });
    await assert.rejects(storage.readPreviewSource('a.jpg', 100), { name: 'AccessDenied' });
    client.failNext('GetObjectCommand', { name: 'NoSuchBucket', status: 404 });
    await assert.rejects(storage.readPreviewSource('a.jpg', 100), { name: 'NoSuchBucket' });
  });

  // ---- M2: move is copy-then-delete on S3 ----

  it('move: a failed copy never deletes the source', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('CopyObjectCommand', { name: 'AccessDenied', status: 403 });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).moveFile('a.txt', 'b.txt'), { name: 'AccessDenied' });
    assert.ok(!client.calls.includes('DeleteObjectCommand'), 'no delete attempted');
    assert.deepEqual([...client.objects.keys()], ['a.txt']);
  });

  it('move: copy succeeded but the source could not be deleted → MOVE_INCOMPLETE, both copies kept', async () => {
    const client = new FakeS3Client({ 'a.txt': 'A' });
    client.failNext('DeleteObjectCommand', { name: 'AccessDenied', status: 403, message: 'raw detail' });
    await assert.rejects(createS3Storage({ bucket: 'b', client }).moveFile('a.txt', 'b.txt'), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'MOVE_INCOMPLETE');
      assert.deepEqual(err.details, { from: 'a.txt', to: 'b.txt', copied: true, sourceDeleted: false, reason: 'ACCESS_DENIED' });
      assert.ok(!JSON.stringify(err.details).includes('raw detail'));
      return true;
    });
    assert.deepEqual([client.body('a.txt'), client.body('b.txt')], ['A', 'A']);
  });

  it('move: CopySource is URL-encoded per segment (spaces, #, ?, %, non-ASCII)', async () => {
    const from = 'dir one/ré #1?%.txt';
    const client = new FakeS3Client({ [from]: 'X' });
    await createS3Storage({ bucket: 'b', client }).moveFile(from, 'dir one/ok.txt');
    const copy = client.inputs.find((c) => c.name === 'CopyObjectCommand').input;
    assert.equal(copy.CopySource, 'b/dir%20one/r%C3%A9%20%231%3F%25.txt');
    assert.deepEqual([...client.objects.keys()], ['dir one/ok.txt']);
    assert.equal(client.body('dir one/ok.txt'), 'X');
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
