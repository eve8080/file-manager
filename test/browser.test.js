// Browser regression tests: drive the real UI in headless Chrome against the app with in-memory
// (or fake-S3) storage. Skipped, with a reason, when no Chrome/Chromium is found.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { PREVIEW_TEXT_BYTES } from '../src/preview.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { findChrome, launchChrome } from './helpers/chrome.js';
import { FakeS3Client, TEST_SIGNER } from './helpers/fake-s3-client.js';
import { PNG_1X1, minimalPdf, solidPng } from './helpers/fixtures.js';

const chromePath = findChrome();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('browser UI', { skip: chromePath ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  let storage;
  let listDelays; // prefix -> ms, to make chosen list requests slow
  let mutationDelay; // ms added to every createFolder/deleteFolder call
  let dialogs; // every alert/confirm/prompt the page opened: { type, message }
  let listCalls; // every prefix the server was asked to list, in order
  let failNextLists; // number of upcoming list calls that fail with a simulated S3 outage (502)
  let previewDelays; // key -> ms, to make chosen preview requests slow
  let failNextPreviews; // number of upcoming preview calls that fail with a simulated S3 outage (502)
  let server;
  let baseUrl;
  let chrome;
  let page;

  before(async () => {
    const proxy = {
      list: async (prefix) => {
        listCalls.push(prefix);
        if (listDelays.has(prefix)) await sleep(listDelays.get(prefix));
        if (failNextLists > 0) {
          failNextLists -= 1;
          throw Object.assign(new Error('simulated outage'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
        }
        return storage.list(prefix);
      },
      createFolder: async (...args) => {
        await sleep(mutationDelay);
        return storage.createFolder(...args);
      },
      deleteFolder: async (...args) => {
        await sleep(mutationDelay);
        return storage.deleteFolder(...args);
      },
      // M2 file operations; mutations get the same optional delay.
      getDownload: (...args) => storage.getDownload(...args),
      deleteFile: async (...args) => {
        await sleep(mutationDelay);
        return storage.deleteFile(...args);
      },
      moveFile: async (...args) => {
        await sleep(mutationDelay);
        return storage.moveFile(...args);
      },
      putFile: async (...args) => {
        await sleep(mutationDelay);
        return storage.putFile(...args);
      },
      // M3: previews can be slowed per key, or made to fail like an S3 outage.
      getPreview: async (key) => {
        if (previewDelays.has(key)) await sleep(previewDelays.get(key));
        if (failNextPreviews > 0) {
          failNextPreviews -= 1;
          throw Object.assign(new Error('simulated outage'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
        }
        return storage.getPreview(key);
      },
    };
    server = createApp({ storage: proxy }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    chrome = await launchChrome(chromePath);
    page = chrome.page;
    await page.setViewport(375, 740); // phone-sized
  });

  after(async () => {
    await chrome?.close();
    server?.close();
    if (chrome) assert.equal(existsSync(chrome.userDataDir), false, 'Chrome profile removed');
  });

  // Tests set `answer` to choose dialog responses; every dialog is recorded in `dialogs`.
  let answer;
  beforeEach(() => {
    listDelays = new Map();
    listCalls = [];
    failNextLists = 0;
    previewDelays = new Map();
    failNextPreviews = 0;
    mutationDelay = 0;
    dialogs = [];
    answer = () => ({ accept: true });
    page.errors.length = 0;
    page.onDialog = (params) => {
      dialogs.push({ type: params.type, message: params.message });
      return answer(params);
    };
  });

  // Fresh document and history each time (a hash-only navigation would not reload the page, and the
  // tab's history would otherwise accumulate across tests).
  async function open(hash) {
    await page.goto('about:blank');
    await page.send('Page.resetNavigationHistory');
    await page.goto(`${baseUrl}/${hash}`);
  }

  const state = () =>
    page.evaluate(`({
      hash: location.hash,
      prefix: document.getElementById('listing').dataset.prefix,
      here: document.querySelector('.breadcrumbs [aria-current="page"]')?.textContent ?? 'Home',
      names: [...document.querySelectorAll('#listing .name')].map((n) => n.lastChild.textContent), // skip icon
      status: document.getElementById('status').textContent,
      statusIsError: document.getElementById('status').classList.contains('error'),
    })`);

  const waitLoaded = (prefix) =>
    page.waitFor(
      `document.getElementById('listing').dataset.prefix === ${JSON.stringify(prefix)} &&
       document.getElementById('status').textContent !== 'Loading…'`,
      { message: `listing of "${prefix}" loaded` },
    );

  describe('finding 1: stale list responses', () => {
    beforeEach(() => {
      storage = createMemoryStorage({
        'slow/': '',
        'slow/s.txt': 's',
        'fast/': '',
        'fast/f.txt': 'f',
      });
    });

    it('a slow earlier response cannot overwrite the folder in the URL', async () => {
      listDelays.set('slow/', 400);
      await open('#/');
      await waitLoaded('');

      await page.evaluate(`(async () => {
        location.hash = '#/slow/';
        await new Promise((r) => setTimeout(r, 30));
        location.hash = '#/fast/';
      })()`);
      await waitLoaded('fast/');
      await sleep(700); // well past the slow response

      const s = await state();
      assert.equal(s.hash, '#/fast/');
      assert.equal(s.prefix, 'fast/');
      assert.equal(s.here, 'fast');
      assert.deepEqual(s.names, ['f.txt']);
      assert.equal(s.statusIsError, false);

      // current.prefix must match the URL: a new folder is created where the user is looking.
      await page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = 'made-here';
        document.getElementById('new-folder-form').requestSubmit();
      })()`);
      await page.waitFor(`document.getElementById('status').textContent === 'Created folder "made-here".'`);
      assert.deepEqual((await storage.list('fast/')).folders, ['made-here']);
      assert.deepEqual((await storage.list('slow/')).folders, []);

      // Back button returns to the slow folder and loads it correctly.
      await page.evaluate('history.back()');
      await page.waitFor(`location.hash === '#/slow/'`);
      await waitLoaded('slow/');
      assert.deepEqual((await state()).names, ['s.txt']);
      assert.deepEqual(page.errors, []);
    });

    it('a slow earlier error (404) is not shown for the current folder', async () => {
      listDelays.set('missing/', 400);
      await open('#/');
      await waitLoaded('');
      await page.evaluate(`(async () => {
        location.hash = '#/missing/';
        await new Promise((r) => setTimeout(r, 30));
        location.hash = '#/fast/';
      })()`);
      await waitLoaded('fast/');
      await sleep(700);

      const s = await state();
      assert.equal(s.prefix, 'fast/');
      assert.deepEqual(s.names, ['f.txt']);
      assert.equal(s.status, '');
      assert.equal(s.statusIsError, false);
    });

    it('many rapid navigations settle on the last folder', async () => {
      listDelays.set('slow/', 300);
      listDelays.set('', 200);
      await open('#/fast/');
      await waitLoaded('fast/');
      await page.evaluate(`(async () => {
        for (const h of ['#/slow/', '#/', '#/slow/', '#/', '#/fast/', '#/slow/', '#/fast/']) {
          location.hash = h;
          await new Promise((r) => setTimeout(r, 15));
        }
      })()`);
      await waitLoaded('fast/');
      await sleep(600);
      const s = await state();
      assert.equal(s.hash, '#/fast/');
      assert.equal(s.prefix, 'fast/');
      assert.deepEqual(s.names, ['f.txt']);
    });
  });

  describe('finding 2: recursive delete confirmation from the UI', () => {
    beforeEach(() => {
      storage = createMemoryStorage({ 'docs/': '', 'docs/a.txt': 'a', 'keep/': '' });
    });

    const clickDelete = (name) =>
      page.evaluate(`document.querySelector('button[aria-label="Delete folder ${name}"]').click()`);

    it('deletes a non-empty folder when the typed name matches (server confirm accepted)', async () => {
      answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'docs' } : { accept: true });
      await open('#/');
      await waitLoaded('');
      await clickDelete('docs');
      await page.waitFor(`document.getElementById('status').textContent === 'Deleted folder "docs".'`);
      assert.deepEqual((await storage.list('')).folders, ['keep']);
      assert.deepEqual((await state()).names, ['keep']);
    });

    it('keeps the folder when the typed name does not match', async () => {
      answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'Docs' } : { accept: true });
      await open('#/');
      await waitLoaded('');
      await clickDelete('docs');
      await page.waitFor(`document.getElementById('status').textContent === 'Delete cancelled.'`);
      assert.deepEqual((await storage.list('docs/')).files.map((f) => f.name), ['a.txt']);
    });

    it('keeps the folder when the first confirmation is declined', async () => {
      answer = () => ({ accept: false });
      await open('#/');
      await waitLoaded('');
      await clickDelete('docs');
      await sleep(200);
      assert.deepEqual((await storage.list('')).folders, ['docs', 'keep']);
    });
  });

  describe('finding 3: partial S3 delete shown in the UI', () => {
    it('reports the partial delete and shows what remains', async () => {
      storage = createS3Storage({
        bucket: 'test',
        client: new FakeS3Client(
          { 'big/': '', 'big/a.txt': 'a', 'big/b.txt': 'b' },
          { failDeleteKeys: ['big/b.txt'] },
        ),
      });
      answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'big' } : { accept: true });
      await open('#/');
      await waitLoaded('');
      await page.evaluate(`document.querySelector('button[aria-label="Delete folder big"]').click()`);
      await page.waitFor(`document.getElementById('status').textContent.includes('stopped partway')`);

      const s = await state();
      assert.equal(s.statusIsError, true);
      assert.match(s.status, /2 deleted, 1 may remain/);
      assert.deepEqual(s.names, ['big']); // the folder is still listed because b.txt remains

      await open('#/big/');
      await waitLoaded('big/');
      assert.deepEqual((await state()).names, ['b.txt']);
    });
  });

  describe('review 2, finding 1: stale create/delete completions', () => {
    beforeEach(() => {
      storage = createMemoryStorage({
        'here/': '',
        'here/sub/': '',
        'here/full/': '',
        'here/full/x.txt': 'x',
        'other/': '',
        'other/o.txt': 'o',
      });
      mutationDelay = 400;
    });

    const NOT_FOUND = 'This folder does not exist.';
    const navigate = (hash) => page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    const startCreate = (name) =>
      page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = ${JSON.stringify(name)};
        document.getElementById('new-folder-form').requestSubmit();
      })()`);
    const clickDelete = (name) =>
      page.evaluate(`document.querySelector('button[aria-label="Delete folder ${name}"]').click()`);

    // Navigates away while a mutation is in flight, then waits well past its completion.
    async function navigateDuringMutation(hash, expectedPrefix) {
      await sleep(50);
      await navigate(hash);
      await waitLoaded(expectedPrefix);
      await sleep(700);
      return state();
    }

    it('a delayed create does not overwrite the status of an existing folder navigated to', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await startCreate('made');
      const s = await navigateDuringMutation('#/other/', 'other/');
      assert.equal(s.hash, '#/other/');
      assert.equal(s.prefix, 'other/');
      assert.deepEqual(s.names, ['o.txt']);
      assert.equal(s.status, '');
      assert.equal(s.statusIsError, false);
      assert.deepEqual((await storage.list('here/')).folders, ['full', 'made', 'sub'], 'created where it started');
      assert.deepEqual((await storage.list('other/')).folders, []);
    });

    it('a delayed create success does not replace a missing-folder error', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await startCreate('made');
      const s = await navigateDuringMutation('#/missing/', 'missing/');
      assert.equal(s.status, NOT_FOUND);
      assert.equal(s.statusIsError, true);
      assert.deepEqual(s.names, []);
    });

    it('a delayed create failure (409) does not replace a missing-folder error', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await startCreate('sub'); // already exists
      const s = await navigateDuringMutation('#/missing/', 'missing/');
      assert.equal(s.status, NOT_FOUND);
    });

    it('a delayed delete success does not replace a missing-folder error', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await clickDelete('sub');
      const s = await navigateDuringMutation('#/missing/', 'missing/');
      assert.equal(s.status, NOT_FOUND);
      assert.equal(s.statusIsError, true);
      assert.deepEqual((await storage.list('here/')).folders, ['full'], 'the delete itself completed');
    });

    it('a delayed "not empty" reply never prompts about a folder the user has left', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await clickDelete('full');
      const s = await navigateDuringMutation('#/other/', 'other/');
      assert.deepEqual(dialogs.map((d) => d.type), ['confirm'], 'no prompt after navigating away');
      assert.equal(s.status, '');
      assert.deepEqual((await storage.list('here/full/')).files.map((f) => f.name), ['x.txt'], 'nothing deleted');
    });

    it('a delayed recursive delete completion does not replace a missing-folder error', async () => {
      let prompted = false;
      answer = ({ type }) => {
        if (type === 'prompt') prompted = true;
        return type === 'prompt' ? { accept: true, promptText: 'full' } : { accept: true };
      };
      await open('#/here/');
      await waitLoaded('here/');
      await clickDelete('full');
      while (!prompted) await sleep(20); // the recursive DELETE is now in flight
      const s = await navigateDuringMutation('#/missing/', 'missing/');
      assert.equal(s.status, NOT_FOUND);
      assert.deepEqual((await storage.list('here/')).folders, ['sub'], 'the recursive delete completed');
    });

    it('a delayed partial delete is reported in an alert, not in the new folder\'s status', async () => {
      storage = createS3Storage({
        bucket: 'test',
        client: new FakeS3Client(
          { 'here/': '', 'here/big/': '', 'here/big/a.txt': 'a', 'here/big/b.txt': 'b', 'other/': '', 'other/o.txt': 'o' },
          { failDeleteKeys: ['here/big/b.txt'] },
        ),
      });
      let prompted = false;
      answer = ({ type }) => {
        if (type === 'prompt') prompted = true;
        return type === 'prompt' ? { accept: true, promptText: 'big' } : { accept: true };
      };
      const originalError = console.error;
      console.error = () => {}; // the S3 driver logs the simulated failure
      try {
        await open('#/here/');
        await waitLoaded('here/');
        await clickDelete('big');
        while (!prompted) await sleep(20);
        const s = await navigateDuringMutation('#/other/', 'other/');
        assert.equal(s.status, '');
        assert.deepEqual(s.names, ['o.txt']);
        const alerts = dialogs.filter((d) => d.type === 'alert');
        assert.equal(alerts.length, 1);
        assert.match(alerts[0].message, /Delete of "big" stopped partway: 2 deleted, 1 may remain/);
      } finally {
        console.error = originalError;
      }
    });

    it('without navigation, create and delete still report their result', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await startCreate('made');
      await page.waitFor(`document.getElementById('status').textContent === 'Created folder "made".'`, { timeout: 3000 });
      await clickDelete('made');
      await page.waitFor(`document.getElementById('status').textContent === 'Deleted folder "made".'`, { timeout: 3000 });
      assert.deepEqual(page.errors, []);
    });
  });

  describe('finding 4: touch targets on a phone-sized screen', () => {
    it('breadcrumbs, folder links and delete buttons are at least 44x44 CSS px', async () => {
      storage = createMemoryStorage({ 'a/': '', 'a/b/': '', 'a/b/c/': '', 'a/b/d/x.txt': 'x', 'a/b/y.txt': 'y' });
      await open('#/a/b/');
      await waitLoaded('a/b/');
      const targets = await page.evaluate(`[...document.querySelectorAll(
        '.breadcrumbs a, .breadcrumbs .here, .row.folder a.name, .row.folder button'
      )].map((el) => {
        const r = el.getBoundingClientRect();
        return { what: el.className + ' ' + el.textContent, width: r.width, height: r.height };
      })`);
      assert.equal(targets.length, 3 + 2 + 2); // Home, a, b; folder links c, d; their delete buttons
      for (const t of targets) {
        assert.ok(t.width >= 44 && t.height >= 44, `${t.what}: ${t.width}x${t.height}`);
      }
      const overflow = await page.evaluate('document.documentElement.scrollWidth > window.innerWidth');
      assert.equal(overflow, false, 'no horizontal scrolling at 375px');
    });
  });

  describe('M1 closure: N2 invalid hashes are canonicalised', () => {
    beforeEach(() => {
      storage = createMemoryStorage({ 'docs/': '', 'docs/a.txt': 'a', 'top.txt': 't' });
    });

    it('an undecodable hash is replaced by the root URL, without a loop or an extra history entry', async () => {
      await open('#/%E0%A4%A/');
      await waitLoaded('');
      await sleep(300); // a navigation loop would keep listing
      const s = await state();
      assert.equal(s.hash, '#/');
      assert.equal(s.prefix, '');
      assert.deepEqual(s.names, ['docs', 'top.txt']);
      assert.equal(s.statusIsError, false);
      assert.deepEqual(listCalls, ['']);
      assert.equal(await page.evaluate('history.length'), 2, 'about:blank + this page; replaced, not pushed');

      // Creating a folder from this screen goes to the root, matching the URL.
      await page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = 'made';
        document.getElementById('new-folder-form').requestSubmit();
      })()`);
      await page.waitFor(`document.getElementById('status').textContent === 'Created folder "made".'`);
      assert.deepEqual((await storage.list('')).folders, ['docs', 'made']);
      assert.equal((await state()).hash, '#/');
    });

    it('an undecodable hash reached by navigation is canonicalised too', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      await page.evaluate(`location.hash = '#/docs/%ZZ/'`);
      await page.waitFor(`location.hash === '#/'`);
      await waitLoaded('');
      await sleep(300);
      assert.deepEqual(listCalls, ['docs/', '']);
      assert.deepEqual((await state()).names, ['docs', 'top.txt']);
    });

    it('a valid but non-canonical hash is normalised in place', async () => {
      await open('#/docs');
      await waitLoaded('docs/');
      assert.equal((await state()).hash, '#/docs/');
      assert.deepEqual(listCalls, ['docs/']);
    });
  });

  describe('M1 closure: N3 a failed reload after create/delete is not hidden', () => {
    const UNAVAILABLE = 'S3 is temporarily unavailable.';
    let originalError;
    beforeEach(() => {
      storage = createMemoryStorage({ 'here/': '', 'here/sub/': '', 'here/full/': '', 'here/full/x.txt': 'x' });
      originalError = console.error;
      console.error = () => {}; // the server logs the simulated outage
    });
    afterEach(() => {
      console.error = originalError;
    });

    it('create: reports success and the reload error together, as an error', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      failNextLists = 1;
      await page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = 'made';
        document.getElementById('new-folder-form').requestSubmit();
      })()`);
      await page.waitFor(`document.getElementById('status').textContent.includes('could not be reloaded')`);
      const s = await state();
      assert.equal(s.status, `Created folder "made", but the folder could not be reloaded: ${UNAVAILABLE}`);
      assert.equal(s.statusIsError, true);
      assert.deepEqual((await storage.list('here/')).folders, ['full', 'made', 'sub']);
    });

    it('delete: reports success and the reload error together, as an error', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      failNextLists = 1;
      await page.evaluate(`document.querySelector('button[aria-label="Delete folder sub"]').click()`);
      await page.waitFor(`document.getElementById('status').textContent.includes('could not be reloaded')`);
      const s = await state();
      assert.equal(s.status, `Deleted folder "sub", but the folder could not be reloaded: ${UNAVAILABLE}`);
      assert.equal(s.statusIsError, true);
    });

    it('partial delete: the partial-delete message keeps the reload error too', async () => {
      storage = createS3Storage({
        bucket: 'test',
        client: new FakeS3Client(
          { 'here/': '', 'here/big/': '', 'here/big/a.txt': 'a', 'here/big/b.txt': 'b' },
          { failDeleteKeys: ['here/big/b.txt'] },
        ),
      });
      answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'big' } : { accept: true });
      await open('#/here/');
      await waitLoaded('here/');
      failNextLists = 1;
      await page.evaluate(`document.querySelector('button[aria-label="Delete folder big"]').click()`);
      await page.waitFor(`document.getElementById('status').textContent.includes('stopped partway')`);
      const s = await state();
      assert.match(s.status, /^Delete of "big" stopped partway: 2 deleted, 1 may remain\./);
      assert.match(s.status, new RegExp(`The folder could not be reloaded: ${UNAVAILABLE.replace('.', '\\.')}$`));
      assert.equal(s.statusIsError, true);
    });
  });

  describe('M1 closure (D19): overlapping mutations in the same folder', () => {
    beforeEach(() => {
      storage = createMemoryStorage({ 'here/': '', 'other/': '' });
    });

    const startCreate = (name) =>
      page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = ${JSON.stringify(name)};
        document.getElementById('new-folder-form').requestSubmit();
      })()`);

    it('a success whose reload was superseded by a newer reload is still reported', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      mutationDelay = 300;
      listDelays.set('here/', 300); // the first reload is still running when the second one starts
      await startCreate('one');
      await sleep(100);
      await startCreate('two');
      await page.waitFor(`document.getElementById('status').textContent.includes('Created')`, { timeout: 3000 });
      await sleep(700); // let every reload settle
      const s = await state();
      assert.equal(s.status, 'Created folder "one". Created folder "two".');
      assert.equal(s.statusIsError, false);
      assert.deepEqual(s.names, ['one', 'two']);
    });

    it('a success whose reload was superseded by a partial delete\'s reload is reported with it', async () => {
      storage = createS3Storage({
        bucket: 'test',
        client: new FakeS3Client(
          { 'here/': '', 'here/big/': '', 'here/big/a.txt': 'a', 'here/big/b.txt': 'b' },
          { failDeleteKeys: ['here/big/b.txt'] },
        ),
      });
      answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'big' } : { accept: true });
      const originalError = console.error;
      console.error = () => {}; // the S3 driver logs the simulated failure
      try {
        await open('#/here/');
        await waitLoaded('here/');
        mutationDelay = 300;
        listDelays.set('here/', 600); // the create's reload is still running when the delete's starts
        await startCreate('one');
        await sleep(100);
        await page.evaluate(`document.querySelector('button[aria-label="Delete folder big"]').click()`);
        await page.waitFor(`document.getElementById('status').textContent.includes('stopped partway')`, { timeout: 5000 });
        await sleep(900);
        const s = await state();
        assert.match(s.status, /^Created folder "one"\. Delete of "big" stopped partway: 2 deleted, 1 may remain\./);
        assert.equal(s.statusIsError, true);
      } finally {
        console.error = originalError;
      }
    });

    // Blocker 2: a partial delete whose own reload is superseded by a later success's reload.
    describe('a partial-delete warning is never replaced by a later success', () => {
      let originalError;
      beforeEach(() => {
        storage = createS3Storage({
          bucket: 'test',
          client: new FakeS3Client(
            { 'here/': '', 'here/big/': '', 'here/big/a.txt': 'a', 'here/big/b.txt': 'b', 'other/': '' },
            { failDeleteKeys: ['here/big/b.txt'] },
          ),
        });
        answer = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'big' } : { accept: true });
        originalError = console.error;
        console.error = () => {}; // the S3 driver logs the simulated failure
      });
      afterEach(() => {
        console.error = originalError;
      });

      // Starts the partial delete, waits until its reload is running, then starts a create whose
      // reload supersedes it.
      async function partialDeleteThenCreate() {
        await open('#/here/');
        await waitLoaded('here/');
        mutationDelay = 300;
        listDelays.set('here/', 600);
        await page.evaluate(`document.querySelector('button[aria-label="Delete folder big"]').click()`);
        while (listCalls.length < 2) await sleep(10); // the partial delete's reload has started
        await startCreate('one');
      }

      it('in the same folder: the final status keeps the warning, as an error', async () => {
        await partialDeleteThenCreate();
        await page.waitFor(`document.getElementById('status').textContent.includes('Created folder "one"')`, { timeout: 5000 });
        await sleep(900);
        const s = await state();
        assert.match(s.status, /Delete of "big" stopped partway: 2 deleted, 1 may remain\./);
        assert.match(s.status, /Created folder "one"\./);
        assert.equal(s.statusIsError, true);
      });

      it('after navigating away: the warning is alerted, not shown in the new folder (D16)', async () => {
        await partialDeleteThenCreate();
        await sleep(450); // the create has finished and its reload superseded the delete's
        await page.evaluate(`location.hash = '#/other/'`);
        await waitLoaded('other/');
        await sleep(900);
        const s = await state();
        assert.equal(s.status, '');
        const alerts = dialogs.filter((d) => d.type === 'alert');
        assert.equal(alerts.length, 1);
        assert.match(alerts[0].message, /Delete of "big" stopped partway: 2 deleted, 1 may remain/);
      });
    });

    it('a success whose reload was cut short by navigation is not reported in the next folder (D16)', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      listDelays.set('here/', 400);
      await startCreate('one');
      await page.waitFor(`document.getElementById('status').textContent === 'Loading…'`); // its reload is running
      await page.evaluate(`location.hash = '#/other/'`);
      await waitLoaded('other/');
      await startCreate('two');
      await page.waitFor(`document.getElementById('status').textContent.includes('Created')`, { timeout: 3000 });
      await sleep(600);
      assert.equal((await state()).status, 'Created folder "two".');
    });
  });

  describe('M2: file-row actions', () => {
    const HOSTILE = '<img src=x onerror=alert(1)>.txt';
    beforeEach(() => {
      storage = createMemoryStorage({
        'docs/': '',
        'docs/report final 2026.pdf': 'pdf-bytes',
        [`docs/${HOSTILE}`]: 'h',
        'docs/sub/': '',
      });
    });

    const fileRows = () =>
      page.evaluate(`[...document.querySelectorAll('#listing .row.file')].map((row) => ({
        name: row.querySelector('.name').lastChild.textContent,
        download: row.querySelector('a.download')?.getAttribute('href'),
        downloadLabel: row.querySelector('a.download')?.getAttribute('aria-label'),
        buttons: [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
      }))`);

    it('each file row has Download, Rename and Delete; names are text, never HTML', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      const rows = await fileRows();
      assert.deepEqual(rows, [
        {
          name: HOSTILE,
          download: `/api/files/download?key=${encodeURIComponent(`docs/${HOSTILE}`)}`,
          downloadLabel: `Download ${HOSTILE}`,
          buttons: [`Preview ${HOSTILE}`, `Rename file ${HOSTILE}`, `Delete file ${HOSTILE}`],
        },
        {
          name: 'report final 2026.pdf',
          download: `/api/files/download?key=${encodeURIComponent('docs/report final 2026.pdf')}`,
          downloadLabel: 'Download report final 2026.pdf',
          buttons: ['Preview report final 2026.pdf', 'Rename file report final 2026.pdf', 'Delete file report final 2026.pdf'],
        },
      ]);
      assert.equal(await page.evaluate(`document.querySelectorAll('#listing img').length`), 0, 'no injected element');
      // The link really downloads the file (memory driver: the bytes, as an attachment).
      const fetched = await page.evaluate(`fetch(${JSON.stringify(rows[1].download)}).then(async (r) => [r.status, r.headers.get('content-disposition'), await r.text()])`);
      assert.deepEqual(fetched, [200, `attachment; filename="report final 2026.pdf"; filename*=UTF-8''report%20final%202026.pdf`, 'pdf-bytes']);
      assert.deepEqual(page.errors, []);
    });

    const click = (label) => page.evaluate(`document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}).click()`);
    const statusIs = (text) => page.waitFor(`document.getElementById('status').textContent === ${JSON.stringify(text)}`, { timeout: 3000 });

    it('delete: asks first; declining keeps the file and sends nothing', async () => {
      answer = () => ({ accept: false });
      await open('#/docs/');
      await waitLoaded('docs/');
      await click('Delete file report final 2026.pdf');
      await sleep(200);
      assert.deepEqual(dialogs, [{ type: 'confirm', message: 'Delete file "report final 2026.pdf"?' }]);
      assert.ok((await storage.list('docs/')).files.some((f) => f.name === 'report final 2026.pdf'));
    });

    it('delete: confirmed → deleted, reported, and the listing reloaded', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      await click('Delete file report final 2026.pdf');
      await statusIs('Deleted file "report final 2026.pdf".');
      assert.deepEqual((await state()).names, ['sub', HOSTILE]);
      assert.deepEqual((await storage.list('docs/')).files.map((f) => f.name), [HOSTILE]);
    });

    it('delete: a failure (already gone) is shown as an error', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      await storage.deleteFile('docs/report final 2026.pdf'); // removed elsewhere meanwhile
      await click('Delete file report final 2026.pdf');
      await statusIs('File not found');
      assert.equal((await state()).statusIsError, true);
    });

    it('delete: finishing after navigation never changes the new folder\'s status (D16)', async () => {
      storage.putObject('other/o.txt', 'o');
      mutationDelay = 400;
      await open('#/docs/');
      await waitLoaded('docs/');
      await click('Delete file report final 2026.pdf');
      await sleep(50);
      await page.evaluate(`location.hash = '#/other/'`);
      await waitLoaded('other/');
      await sleep(700);
      const s = await state();
      assert.equal(s.status, '');
      assert.deepEqual(s.names, ['o.txt']);
      assert.deepEqual((await storage.list('docs/')).files.map((f) => f.name), [HOSTILE], 'the delete itself completed');
    });

    const answerPrompt = (text) => {
      answer = ({ type }) => (type === 'prompt' ? (text === null ? { accept: false } : { accept: true, promptText: text }) : { accept: true });
    };

    it('rename: the prompt starts with the full key; cancel or no change sends nothing', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      const defaults = [];
      for (const text of [null, 'docs/report final 2026.pdf']) {
        answerPrompt(text);
        const reply = answer;
        answer = (params) => {
          defaults.push(params.defaultPrompt); // the CDP dialog event carries the prompt's pre-filled text
          return reply(params);
        };
        await click('Rename file report final 2026.pdf');
        await sleep(150);
      }
      assert.deepEqual(dialogs.map((d) => d.type), ['prompt', 'prompt']);
      assert.match(dialogs[0].message, /New name or path for "report final 2026\.pdf"/);
      assert.deepEqual(defaults, ['docs/report final 2026.pdf', 'docs/report final 2026.pdf']);
      assert.ok((await storage.list('docs/')).files.some((f) => f.name === 'report final 2026.pdf'));
      assert.equal((await state()).status, '');
    });

    it('rename: renames in place and moves to another folder', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      answerPrompt('docs/renamed.pdf');
      await click('Rename file report final 2026.pdf');
      await statusIs('Renamed "report final 2026.pdf" to "docs/renamed.pdf".');
      assert.deepEqual((await state()).names, ['sub', HOSTILE, 'renamed.pdf']);
      answerPrompt('docs/sub/moved.pdf');
      await click('Rename file renamed.pdf');
      await statusIs('Renamed "renamed.pdf" to "docs/sub/moved.pdf".');
      assert.deepEqual((await storage.list('docs/sub/')).files.map((f) => f.name), ['moved.pdf']);
      assert.deepEqual((await state()).names, ['sub', HOSTILE]);
    });

    it('rename: an existing destination is reported (409) and nothing changes', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      answerPrompt(`docs/${HOSTILE}`);
      await click('Rename file report final 2026.pdf');
      await statusIs('A file with that name already exists');
      assert.equal((await state()).statusIsError, true);
      assert.equal((await storage.list('docs/')).files.length, 2);
    });

    it('rename: an S3 partial move (copied, original not removed) is reported as an error', async () => {
      const client = new FakeS3Client({ 'docs/': '', 'docs/a.txt': 'a' });
      client.failNext('DeleteObjectCommand', { name: 'AccessDenied', status: 403 });
      storage = createS3Storage({ bucket: 'test', client });
      const originalError = console.error;
      console.error = () => {};
      try {
        await open('#/docs/');
        await waitLoaded('docs/');
        answerPrompt('docs/b.txt');
        await click('Rename file a.txt');
        await page.waitFor(`document.getElementById('status').textContent.includes('both names')`, { timeout: 3000 });
        const s = await state();
        assert.equal(s.status, 'The file was copied to the new name, but the original could not be removed. It now exists under both names.');
        assert.equal(s.statusIsError, true);
      } finally {
        console.error = originalError;
      }
    });

    it('rename: onto a folder\'s name is refused with a clear error; nothing changes', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      answerPrompt('docs/sub');
      await click('Rename file report final 2026.pdf');
      await statusIs('A folder with that name already exists');
      assert.equal((await state()).statusIsError, true);
      assert.ok((await storage.list('docs/')).files.some((f) => f.name === 'report final 2026.pdf'));
    });

    it('rename: finishing after navigation never changes the new folder\'s status (D16)', async () => {
      storage.putObject('other/o.txt', 'o');
      mutationDelay = 400;
      await open('#/docs/');
      await waitLoaded('docs/');
      answerPrompt('docs/late.pdf');
      await click('Rename file report final 2026.pdf');
      await sleep(50);
      await page.evaluate(`location.hash = '#/other/'`);
      await waitLoaded('other/');
      await sleep(700);
      assert.equal((await state()).status, '');
      assert.ok((await storage.list('docs/')).files.some((f) => f.name === 'late.pdf'), 'the move itself completed');
    });

    for (const [label, width] of [['phone', 375], ['desktop', 1280]]) {
      it(`file-row actions are at least 44x44 CSS px with no horizontal scrolling (${label}, ${width}px)`, async () => {
        await page.setViewport(width, 800);
        try {
          await open('#/docs/');
          await waitLoaded('docs/');
          const targets = await page.evaluate(`[...document.querySelectorAll('#listing .row.file a.download, #listing .row.file button')]
            .map((el) => { const r = el.getBoundingClientRect(); return { what: el.getAttribute('aria-label'), width: r.width, height: r.height }; })`);
          assert.equal(targets.length, 8); // per file: Preview (M3), Download, Rename, Delete
          for (const t of targets) assert.ok(t.width >= 44 && t.height >= 44, `${t.what}: ${t.width}x${t.height}`);
          assert.equal(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), false);
        } finally {
          await page.setViewport(375, 740);
        }
      });
    }
  });

  describe('M2: uploads', () => {
    let dir; // real files on disk for Chrome's file input; removed afterwards
    before(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'file-manager-upload-test-'));
      writeFileSync(path.join(dir, 'one.txt'), 'first');
      writeFileSync(path.join(dir, 'clash'), 'named like a folder');
      writeFileSync(path.join(dir, 'three.txt'), 'third');
      writeFileSync(path.join(dir, 'existing.txt'), 'clashes with here/existing.txt');
      writeFileSync(path.join(dir, 'two words.txt'), 'second');
      writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    beforeEach(() => {
      storage = createMemoryStorage({ 'here/': '', 'here/existing.txt': 'e', 'other/': '', 'other/o.txt': 'o' });
    });

    async function pickFiles(...names) {
      const { root } = await page.send('DOM.getDocument');
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload-input' });
      await page.send('DOM.setFileInputFiles', { nodeId, files: names.map((n) => path.join(dir, n)) });
    }
    const uploadItems = () =>
      page.evaluate(`[...document.querySelectorAll('#uploads li')].map((li) => ({
        name: li.querySelector('.name').textContent,
        progress: li.querySelector('progress').value,
        result: li.querySelector('.result').textContent,
        state: li.dataset.state,
      }))`);
    const statusIs = (text, timeout = 5000) =>
      page.waitFor(`document.getElementById('status').textContent === ${JSON.stringify(text)}`, { timeout });

    it('several files: each is uploaded into the current folder with its own progress and result', async () => {
      await open('#/here/');
      await waitLoaded('here/');
      await pickFiles('one.txt', 'two words.txt');
      await statusIs('Uploaded 2 files.');
      assert.deepEqual(await uploadItems(), [
        { name: 'one.txt', progress: 100, result: 'Uploaded', state: 'ok' },
        { name: 'two words.txt', progress: 100, result: 'Uploaded', state: 'ok' },
      ]);
      assert.deepEqual((await state()).names, ['existing.txt', 'one.txt', 'two words.txt']);
      assert.equal(await (await storage.getDownload('here/two words.txt')).body.toString(), 'second');
      assert.deepEqual(page.errors, []);
    });

    it('a partial failure is reported per file and never as overall success', async () => {
      storage.putObject('here/one.txt', 'already here');
      await open('#/here/');
      await waitLoaded('here/');
      await pickFiles('one.txt', 'two words.txt');
      await statusIs('Uploaded 1 of 2 files; 1 failed (see the list below).');
      assert.equal((await state()).statusIsError, true);
      assert.deepEqual((await uploadItems()).map(({ name, result, state }) => ({ name, result, state })), [
        { name: 'one.txt', result: 'A file with that name already exists', state: 'error' },
        { name: 'two words.txt', result: 'Uploaded', state: 'ok' },
      ]);
      assert.equal((await storage.getDownload('here/one.txt')).body.toString(), 'already here', 'not overwritten');
    });

    it('a file with the name of a folder here is refused per file; nothing is stored', async () => {
      storage.putObject('here/clash/', '');
      await open('#/here/');
      await waitLoaded('here/');
      await pickFiles('clash', 'one.txt');
      await statusIs('Uploaded 1 of 2 files; 1 failed (see the list below).');
      assert.deepEqual((await uploadItems()).map(({ name, result, state }) => ({ name, result, state })), [
        { name: 'clash', result: 'A folder with that name already exists', state: 'error' },
        { name: 'one.txt', result: 'Uploaded', state: 'ok' },
      ]);
      assert.deepEqual((await storage.list('here/')).files.map((f) => f.name), ['existing.txt', 'one.txt']);
    });

    // Follow-up 4: no upload into a folder that failed to load (it would create a missing folder implicitly).
    describe('upload needs a loaded folder', () => {
      const uploadState = () =>
        page.evaluate(`({
          disabled: document.getElementById('upload-input').disabled,
          labelDisabled: document.querySelector('label.upload').getAttribute('aria-disabled'),
        })`);
      const ENABLED = { disabled: false, labelDisabled: 'false' };
      const DISABLED = { disabled: true, labelDisabled: 'true' };
      // Even if files reach the input (e.g. a forced change event), nothing may be uploaded.
      async function forceUpload(name) {
        await pickFiles(name).catch(() => {}); // CDP may refuse a disabled input
        await page.evaluate(`document.getElementById('upload-input').dispatchEvent(new Event('change'))`);
        await sleep(300);
      }

      it('a missing folder (404): upload is disabled, and a forced change uploads nothing and creates no folder', async () => {
        await open('#/missing/');
        await waitLoaded('missing/');
        assert.equal((await state()).status, 'This folder does not exist.');
        assert.deepEqual(await uploadState(), DISABLED);
        await forceUpload('one.txt');
        assert.deepEqual(await uploadItems(), []);
        await assert.rejects(storage.list('missing/'), { code: 'NOT_FOUND' });
        assert.equal((await state()).status, 'This folder does not exist.', 'the load error stays visible');
      });

      it('a failed load (502) also disables upload; a later successful load restores it', async () => {
        failNextLists = 1;
        const originalError = console.error;
        console.error = () => {};
        try {
          await open('#/here/');
          await waitLoaded('here/');
          assert.equal((await state()).statusIsError, true);
          assert.deepEqual(await uploadState(), DISABLED);
          await page.evaluate(`location.hash = '#/other/'`);
          await waitLoaded('other/');
          assert.deepEqual(await uploadState(), ENABLED);
          await pickFiles('one.txt');
          await page.waitFor(`document.getElementById('status').textContent === 'Uploaded "one.txt".'`, { timeout: 5000 });
        } finally {
          console.error = originalError;
        }
      });

      it('upload is disabled while a folder is loading', async () => {
        listDelays.set('other/', 400);
        await open('#/here/');
        await waitLoaded('here/');
        await page.evaluate(`location.hash = '#/other/'`);
        await sleep(100);
        assert.deepEqual(await uploadState(), DISABLED);
        await waitLoaded('other/');
        assert.deepEqual(await uploadState(), ENABLED);
      });

      it('a late successful load of a folder the user left cannot enable upload for a missing folder', async () => {
        listDelays.set('here/', 400);
        await open('#/');
        await waitLoaded('');
        await page.evaluate(`(async () => {
          location.hash = '#/here/';
          await new Promise((r) => setTimeout(r, 30));
          location.hash = '#/missing/';
        })()`);
        await waitLoaded('missing/');
        await sleep(600); // past the slow here/ response
        assert.deepEqual(await uploadState(), DISABLED);
      });

      it('a late failed load of a folder the user left cannot disable upload for a loaded folder', async () => {
        listDelays.set('missing/', 400);
        await open('#/');
        await waitLoaded('');
        await page.evaluate(`(async () => {
          location.hash = '#/missing/';
          await new Promise((r) => setTimeout(r, 30));
          location.hash = '#/here/';
        })()`);
        await waitLoaded('here/');
        await sleep(600); // past the slow 404
        assert.deepEqual(await uploadState(), ENABLED);
      });
    });

    // Follow-up 3: a second upload must not hide the first one's rows, progress or results.
    describe('overlapping uploads', () => {
      const names = async () => (await uploadItems()).map((i) => i.name);
      const settled = () => page.waitFor(`[...document.querySelectorAll('#uploads li')].every((li) => li.dataset.state !== 'uploading')`, { timeout: 8000 });

      it('starting a second upload keeps the first one\'s rows; both finish with their own results', async () => {
        mutationDelay = 400;
        await open('#/here/');
        await waitLoaded('here/');
        await pickFiles('one.txt', 'two words.txt'); // batch A: about 800 ms
        await sleep(100);
        await pickFiles('three.txt'); // batch B starts while A is uploading
        await sleep(50);
        assert.deepEqual(await names(), ['one.txt', 'two words.txt', 'three.txt'], 'A\'s rows are still shown');
        assert.equal((await uploadItems())[1].state, 'uploading', 'A is still in progress, and visible');
        await settled();
        assert.deepEqual((await uploadItems()).map(({ name, result, state }) => [name, result, state]), [
          ['one.txt', 'Uploaded', 'ok'],
          ['two words.txt', 'Uploaded', 'ok'],
          ['three.txt', 'Uploaded', 'ok'],
        ]);
        await sleep(300);
        assert.deepEqual((await state()).names, ['existing.txt', 'one.txt', 'three.txt', 'two words.txt']);
      });

      it('a partial failure in the first upload stays listed (its status still points at a real row)', async () => {
        mutationDelay = 400;
        await open('#/here/');
        await waitLoaded('here/');
        await pickFiles('one.txt', 'existing.txt'); // batch A; existing.txt already exists → fails
        await sleep(100);
        await pickFiles('three.txt'); // batch B
        await settled();
        await page.waitFor(`document.getElementById('status').textContent.includes('Uploaded 1 of 2 files; 1 failed (see the list below).')`, { timeout: 5000 });
        const items = await uploadItems();
        assert.deepEqual(items.find((i) => i.name === 'existing.txt'), {
          name: 'existing.txt', progress: 100, result: 'A file with that name already exists', state: 'error', // progress = bytes sent
        });
        assert.equal(items.length, 3);
      });

      it('both finishing after navigation: the new folder\'s status is untouched (D16); the list keeps every result', async () => {
        mutationDelay = 400;
        await open('#/here/');
        await waitLoaded('here/');
        await pickFiles('one.txt', 'existing.txt');
        await sleep(100);
        await pickFiles('three.txt');
        await page.evaluate(`location.hash = '#/other/'`);
        await waitLoaded('other/');
        await settled();
        await sleep(400);
        const s = await state();
        assert.equal(s.status, '');
        assert.deepEqual(s.names, ['o.txt']);
        assert.deepEqual((await uploadItems()).map((i) => [i.name, i.state]), [['one.txt', 'ok'], ['existing.txt', 'error'], ['three.txt', 'ok']]);
        assert.deepEqual((await storage.list('here/')).files.map((f) => f.name), ['existing.txt', 'one.txt', 'three.txt']);
      });
    });

    it('progress is shown while a file is still being sent', async () => {
      mutationDelay = 600; // the server holds off reading, so the browser's send progress is visible
      await open('#/here/');
      await waitLoaded('here/');
      await pickFiles('big.bin');
      const seen = new Set();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const [item] = await uploadItems();
        if (item) seen.add(item.progress);
        if (item?.state === 'ok') break;
        await sleep(20);
      }
      assert.ok([...seen].some((v) => v > 0 && v < 100), `an intermediate progress value was shown: ${[...seen]}`);
      assert.deepEqual((await uploadItems())[0], { name: 'big.bin', progress: 100, result: 'Uploaded', state: 'ok' });
    });

    it('an upload finishing after navigation never changes the new folder\'s status (D16); its list keeps the result', async () => {
      mutationDelay = 400;
      await open('#/here/');
      await waitLoaded('here/');
      await pickFiles('one.txt');
      await sleep(50);
      await page.evaluate(`location.hash = '#/other/'`);
      await waitLoaded('other/');
      await sleep(800);
      const s = await state();
      assert.equal(s.status, '');
      assert.deepEqual(s.names, ['o.txt']);
      assert.deepEqual((await storage.list('here/')).files.map((f) => f.name), ['existing.txt', 'one.txt'], 'stored where it started');
      assert.deepEqual((await uploadItems()).map((i) => i.state), ['ok']);
    });

    for (const [label, width] of [['phone', 375], ['desktop', 1280]]) {
      it(`the upload control is at least 44x44 CSS px (${label}, ${width}px)`, async () => {
        await page.setViewport(width, 800);
        try {
          await open('#/');
          await waitLoaded('');
          const r = await page.evaluate(`(() => { const r = document.querySelector('label.upload').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
          assert.ok(r.width >= 44 && r.height >= 44, `${r.width}x${r.height}`);
          assert.equal(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), false);
        } finally {
          await page.setViewport(375, 740);
        }
      });
    }
  });

  describe('M3: preview', () => {
    const HOSTILE_NAME = '<img src=x onerror="window.__xssName=1">.html';
    const HOSTILE_HTML = '<script>window.__xss = 1</script><img src=x onerror="window.__xss = 2"><b>bold</b> &amp; <iframe src="/"></iframe>';
    beforeEach(() => {
      storage = createMemoryStorage({
        'docs/': '',
        'docs/notes.txt': 'Hello\n  indented\tand tabbed\nÉté 🌍',
        [`docs/${HOSTILE_NAME}`]: HOSTILE_HTML,
        'other/': '',
        'other/o.txt': 'o',
      });
    });

    // Matched by exact label (a hostile name's quotes would break an attribute selector).
    const clickPreview = (name) =>
      page.evaluate(`[...document.querySelectorAll('#listing button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Preview ${name}`)}).click()`);
    const previewState = () =>
      page.evaluate(`(() => {
        const dialog = document.getElementById('preview');
        const body = document.getElementById('preview-body');
        const message = document.getElementById('preview-message');
        return {
          open: dialog.open,
          state: dialog.dataset.state ?? null,
          title: document.getElementById('preview-title').textContent,
          message: message.textContent,
          messageIsError: message.classList.contains('error'),
          text: body.querySelector('pre')?.textContent ?? null,
          img: body.querySelector('img')?.getAttribute('src') ?? null,
          frame: body.querySelector('iframe')?.getAttribute('src') ?? null,
          download: document.getElementById('preview-download').getAttribute('href'),
          downloadLabel: document.getElementById('preview-download').getAttribute('aria-label'),
        };
      })()`);
    const previewSettled = () =>
      page.waitFor(`document.getElementById('preview').open && document.getElementById('preview').dataset.state !== 'loading'`, {
        message: 'preview settled',
      });
    const downloadHref = (key) => `/api/files/download?key=${encodeURIComponent(key)}`;

    it('text: Preview opens a dialog with the exact text, the file name and a Download link', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview('notes.txt');
      await previewSettled();
      assert.deepEqual(await previewState(), {
        open: true,
        state: 'ready',
        title: 'notes.txt',
        message: '',
        messageIsError: false,
        text: 'Hello\n  indented\tand tabbed\nÉté 🌍',
        img: null,
        frame: null,
        download: downloadHref('docs/notes.txt'),
        downloadLabel: 'Download notes.txt',
      });
      // Closing returns to the listing, unchanged.
      await page.evaluate(`document.getElementById('preview-close').click()`);
      assert.equal((await previewState()).open, false);
      assert.equal((await state()).status, '');
      assert.deepEqual(page.errors, []);
    });

    it('HTML content and a hostile file name are shown as text, never as markup or script', async () => {
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview(HOSTILE_NAME);
      await previewSettled();
      const s = await previewState();
      assert.equal(s.text, HOSTILE_HTML);
      assert.equal(s.title, HOSTILE_NAME);
      const injected = await page.evaluate(`({
        elements: document.querySelectorAll('#preview script, #preview img, #preview b, #preview iframe').length,
        xss: window.__xss ?? null,
        xssName: window.__xssName ?? null,
      })`);
      assert.deepEqual(injected, { elements: 0, xss: null, xssName: null });
      assert.deepEqual(dialogs, []);
      assert.deepEqual(page.errors, []);
    });

    const TRUNCATED_NOTICE = 'This file is larger than 1 MB, so only the first 1 MB is shown. Download it to see all of it.';

    it('text over 1 MiB: the first 1 MiB is shown with a visible notice; exactly 1 MiB has none', async () => {
      storage.putObject('docs/exact.txt', 'e'.repeat(PREVIEW_TEXT_BYTES));
      storage.putObject('docs/big.log', `${'b'.repeat(PREVIEW_TEXT_BYTES)}TAIL`);
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview('big.log');
      await previewSettled();
      let s = await previewState();
      assert.equal(s.message, TRUNCATED_NOTICE);
      assert.equal(s.messageIsError, false);
      assert.equal(s.text.length, PREVIEW_TEXT_BYTES);
      assert.ok(!s.text.includes('TAIL'));
      assert.equal(s.download, downloadHref('docs/big.log'), 'the whole file stays downloadable');
      const visible = await page.evaluate(`(() => { const r = document.getElementById('preview-message').getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; })()`);
      assert.equal(visible, true, 'the notice is on screen');

      await clickPreviewInDialogFor('exact.txt');
      s = await previewState();
      assert.equal(s.message, '');
      assert.equal(s.text.length, PREVIEW_TEXT_BYTES);
    });

    // Closes the open preview and opens another file's.
    async function clickPreviewInDialogFor(name) {
      await page.evaluate(`document.getElementById('preview-close').click()`);
      await clickPreview(name);
      await previewSettled();
    }

    const contentUrl = (key) => `/api/files/preview/content?key=${encodeURIComponent(key)}`;

    it('image: shown as an <img> from the preview URL, with the file name as its alt text', async () => {
      storage.putObject('docs/Pixel 1.PNG', PNG_1X1);
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview('Pixel 1.PNG');
      await previewSettled();
      const s = await previewState();
      assert.equal(s.img, contentUrl('docs/Pixel 1.PNG'));
      assert.deepEqual([s.message, s.text, s.frame, s.download], ['', null, null, downloadHref('docs/Pixel 1.PNG')]);
      await page.waitFor(`document.querySelector('#preview-body img').complete`);
      const img = await page.evaluate(`(() => { const i = document.querySelector('#preview-body img'); return { alt: i.alt, width: i.naturalWidth, height: i.naturalHeight }; })()`);
      assert.deepEqual(img, { alt: 'Pixel 1.PNG', width: 1, height: 1 }, 'the image really loaded (CSP allowed it)');
    });

    it('image that cannot be decoded: an error in the dialog, Download still offered', async () => {
      storage.putObject('docs/fake.jpg', 'not really a jpeg');
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview('fake.jpg');
      await page.waitFor(`document.getElementById('preview-message').classList.contains('error')`, { message: 'image error shown' });
      const s = await previewState();
      assert.equal(s.message, 'This image could not be displayed. Download it to open it in another app.');
      assert.equal(s.messageIsError, true);
      assert.equal(s.download, downloadHref('docs/fake.jpg'));
      assert.equal((await state()).status, '', 'the folder status is untouched');
    });

    it('PDF: shown in a frame that Chrome\'s PDF viewer renders, plus an "open in a new tab" link', async () => {
      storage.putObject('docs/Report 2026.pdf', minimalPdf());
      await open('#/docs/');
      await waitLoaded('docs/');
      const pdfViewerLoaded = async () =>
        (await page.send('Target.getTargets')).targetInfos.some((t) => t.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));
      assert.equal(await pdfViewerLoaded(), false, 'no PDF viewer before the preview');
      await clickPreview('Report 2026.pdf');
      await previewSettled();
      const s = await previewState();
      assert.equal(s.frame, contentUrl('docs/Report 2026.pdf'));
      assert.deepEqual([s.message, s.text, s.img], ['', null, null]);
      const extras = await page.evaluate(`(() => {
        const frame = document.querySelector('#preview-body iframe');
        const link = document.querySelector('#preview-body a.open-pdf');
        return { title: frame.title, href: link?.getAttribute('href'), target: link?.target, rel: link?.rel, text: link?.textContent };
      })()`);
      assert.deepEqual(extras, {
        title: 'PDF preview of Report 2026.pdf',
        href: contentUrl('docs/Report 2026.pdf'),
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Open the PDF in a new tab',
      });
      // Chrome's PDF viewer is an extension frame; its appearance means the PDF was not blocked (CSP, framing).
      const deadline = Date.now() + 5000;
      let viewer = false;
      while (!viewer && Date.now() < deadline) {
        viewer = await pdfViewerLoaded();
        if (!viewer) await sleep(100);
      }
      assert.ok(viewer, 'Chrome\'s PDF viewer loaded the file');
    });

    it('errors: a file removed meanwhile, or an S3 outage, is shown in the dialog only; the folder status is untouched', async () => {
      const originalError = console.error;
      console.error = () => {}; // the server logs the simulated outage
      try {
        await open('#/docs/');
        await waitLoaded('docs/');
        await storage.deleteFile('docs/notes.txt'); // removed elsewhere after the listing loaded
        await clickPreview('notes.txt');
        await previewSettled();
        let s = await previewState();
        assert.deepEqual([s.state, s.message, s.messageIsError, s.text], ['error', 'This file no longer exists.', true, null]);

        failNextPreviews = 1;
        await clickPreviewInDialogFor(HOSTILE_NAME);
        s = await previewState();
        assert.deepEqual([s.state, s.message, s.messageIsError, s.text], ['error', 'S3 is temporarily unavailable.', true, null]);
        assert.equal(s.download, downloadHref(`docs/${HOSTILE_NAME}`), 'Download is still offered');
        assert.deepEqual([(await state()).status, (await state()).statusIsError], ['', false]);
        assert.deepEqual(page.errors, []);
      } finally {
        console.error = originalError;
      }
    });

    // Stale responses: like folder loads, only the preview on screen may render. A late response never
    // reappears after the dialog was closed, the user navigated, or another file's preview was opened.
    describe('stale preview responses', () => {
      const SLOW = 500;
      const closed = async () => {
        const s = await previewState();
        const children = await page.evaluate(`document.getElementById('preview-body').childElementCount`);
        return { open: s.open, children, message: s.message };
      };

      it('navigating while a preview loads closes it; the late response is ignored; the new folder is untouched', async () => {
        previewDelays.set('docs/notes.txt', SLOW);
        await open('#/docs/');
        await waitLoaded('docs/');
        await clickPreview('notes.txt');
        await sleep(50);
        await page.evaluate(`location.hash = '#/other/'`);
        await waitLoaded('other/');
        assert.equal((await previewState()).open, false, 'closed on navigation');
        await sleep(SLOW + 300);
        assert.deepEqual(await closed(), { open: false, children: 0, message: '' });
        const s = await state();
        assert.deepEqual([s.prefix, s.names, s.status], ['other/', ['o.txt'], '']);
        assert.deepEqual(page.errors, []);
      });

      it('the back button (e.g. on a phone) while a preview loads closes it too', async () => {
        previewDelays.set('other/o.txt', SLOW);
        await open('#/docs/');
        await waitLoaded('docs/');
        await page.evaluate(`location.hash = '#/other/'`);
        await waitLoaded('other/');
        await clickPreview('o.txt');
        await sleep(50);
        await page.evaluate('history.back()');
        await waitLoaded('docs/');
        await sleep(SLOW + 300);
        assert.deepEqual(await closed(), { open: false, children: 0, message: '' });
      });

      it('closing while a preview loads: the late response does not fill the closed dialog', async () => {
        previewDelays.set('docs/notes.txt', SLOW);
        await open('#/docs/');
        await waitLoaded('docs/');
        await clickPreview('notes.txt');
        await sleep(50);
        await page.evaluate(`document.getElementById('preview-close').click()`);
        await sleep(SLOW + 300);
        assert.deepEqual(await closed(), { open: false, children: 0, message: '' });
      });

      it('Escape closes the dialog and discards its late response too', async () => {
        previewDelays.set('docs/notes.txt', SLOW);
        await open('#/docs/');
        await waitLoaded('docs/');
        await clickPreview('notes.txt');
        await sleep(50);
        for (const type of ['keyDown', 'keyUp']) {
          await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        }
        await page.waitFor(`!document.getElementById('preview').open`, { message: 'Escape closed the dialog' });
        await sleep(SLOW + 300);
        assert.deepEqual(await closed(), { open: false, children: 0, message: '' });
      });

      it('a slow preview of one file never replaces the preview of the file opened after it', async () => {
        previewDelays.set('docs/notes.txt', SLOW);
        await open('#/docs/');
        await waitLoaded('docs/');
        await clickPreview('notes.txt');
        await sleep(50);
        await clickPreviewInDialogFor(HOSTILE_NAME);
        await sleep(SLOW + 300);
        const s = await previewState();
        assert.deepEqual([s.title, s.text, s.message, s.download], [HOSTILE_NAME, HOSTILE_HTML, '', downloadHref(`docs/${HOSTILE_NAME}`)]);
        assert.equal(await page.evaluate(`document.querySelectorAll('#preview-body pre').length`), 1);
      });

      it('a late image error from a closed preview does not mark the next preview as failed', async () => {
        storage.putObject('docs/fake.jpg', 'not really a jpeg');
        previewDelays.set('docs/fake.jpg', 300); // both the JSON and the image bytes are slow
        await open('#/docs/');
        await waitLoaded('docs/');
        await clickPreview('fake.jpg');
        await page.waitFor(`document.querySelector('#preview-body img')`, { message: 'image element added' });
        await clickPreviewInDialogFor('notes.txt'); // the old image is still loading
        await sleep(600); // past the old image's failure
        const s = await previewState();
        assert.deepEqual([s.title, s.message, s.messageIsError], ['notes.txt', '', false]);
      });
    });

    for (const [label, width] of [['phone', 375], ['desktop', 1280]]) {
      it(`usable on a ${label} (${width}px): the dialog fits, long text wraps, wide images and PDFs scale, controls ≥ 44×44`, async () => {
        const longName = `${'very-long-file-name-'.repeat(8)}.txt`;
        storage.putObject(`docs/${longName}`, `${'x'.repeat(4000)}\n${'word '.repeat(800)}`);
        storage.putObject('docs/wide.png', solidPng(3000, 20));
        storage.putObject('docs/doc.pdf', minimalPdf());
        await page.setViewport(width, 800);
        try {
          await open('#/docs/');
          await waitLoaded('docs/');
          const layout = () =>
            page.evaluate(`(() => {
              const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
              const body = document.getElementById('preview-body');
              const media = body.querySelector('pre, img, iframe');
              return {
                dialog: box(document.getElementById('preview')),
                controls: ['preview-close', 'preview-download'].map((id) => box(document.getElementById(id))),
                title: box(document.getElementById('preview-title')),
                media: media && box(media),
                preOverflows: body.querySelector('pre') ? body.querySelector('pre').scrollWidth > body.querySelector('pre').clientWidth : null,
                pageScrolls: document.documentElement.scrollWidth > innerWidth,
                viewport: innerWidth,
              };
            })()`);
          const fits = (b, what, viewport) => assert.ok(b.left >= 0 && b.right <= viewport + 0.5, `${what} fits: ${b.left}..${b.right} of ${viewport}`);

          await clickPreview(longName);
          await previewSettled();
          let l = await layout();
          fits(l.dialog, 'dialog', l.viewport);
          fits(l.title, 'long title', l.viewport);
          fits(l.media, 'text', l.viewport);
          assert.equal(l.preOverflows, false, 'long lines wrap');
          assert.equal(l.pageScrolls, false, 'no horizontal page scrolling');
          for (const c of l.controls) assert.ok(c.width >= 44 && c.height >= 44, `control ${c.width}x${c.height}`);

          for (const name of ['wide.png', 'doc.pdf']) {
            await clickPreviewInDialogFor(name);
            if (name === 'wide.png') await page.waitFor(`document.querySelector('#preview-body img').complete`);
            l = await layout();
            fits(l.media, name, l.viewport);
            assert.ok(l.media.width > 0 && l.media.height > 0, `${name} is visible`);
            assert.equal(l.pageScrolls, false, `${name}: no horizontal page scrolling`);
          }
          const openPdf = await page.evaluate(`(() => { const r = document.querySelector('#preview-body a.open-pdf').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
          assert.ok(openPdf.width >= 44 && openPdf.height >= 44, `open-PDF link ${openPdf.width}x${openPdf.height}`);
        } finally {
          await page.setViewport(375, 740);
        }
      });
    }

    // Real S3 driver (fake client): the dialog uses the presigned amazonaws.com URL, and the page CSP lets
    // it load. Chrome resolves no host names (test/helpers/chrome.js) and every amazonaws.com request is
    // intercepted here and answered from the fake bucket, so nothing reaches the network.
    it('S3: image and PDF previews load from presigned amazonaws.com URLs (intercepted locally)', async () => {
      const client = new FakeS3Client({ 'pics/': '', 'pics/p.png': PNG_1X1, 'pics/d.pdf': minimalPdf() });
      storage = createS3Storage({ bucket: 'test-bucket', client, signingClient: TEST_SIGNER });
      const intercepted = [];
      const onPaused = (msg) => {
        if (msg.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = msg.params;
        const url = new URL(request.url);
        if (url.hostname === '127.0.0.1') return void page.send('Fetch.continueRequest', { requestId }).catch(() => {});
        intercepted.push(request.url);
        const object = url.hostname === 'test-bucket.s3.us-east-1.amazonaws.com' && client.objects.get(decodeURIComponent(url.pathname.slice(1)));
        if (!object) return void page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: url.searchParams.get('response-content-type') }],
          body: object.body.toString('base64'),
        }).catch(() => {});
      };
      page.listeners.add(onPaused);
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      try {
        await open('#/pics/');
        await waitLoaded('pics/');
        await clickPreview('p.png');
        await previewSettled();
        const src = (await previewState()).img;
        assert.equal(new URL(src).hostname, 'test-bucket.s3.us-east-1.amazonaws.com');
        assert.equal(new URL(src).searchParams.get('X-Amz-Expires'), '300');
        await page.waitFor(`document.querySelector('#preview-body img').complete`);
        assert.equal(await page.evaluate(`document.querySelector('#preview-body img').naturalWidth`), 1, 'the S3 image loaded (CSP allowed it)');
        assert.equal(intercepted.length, 1);

        await clickPreviewInDialogFor('d.pdf');
        const frame = (await previewState()).frame;
        assert.equal(new URL(frame).searchParams.get('response-content-type'), 'application/pdf');
        await page.waitFor(`document.querySelector('#preview-body iframe')`);
        const deadline = Date.now() + 5000;
        while (!intercepted.some((u) => u.startsWith('https://test-bucket.s3.us-east-1.amazonaws.com/pics/d.pdf'))) {
          assert.ok(Date.now() < deadline, `the PDF frame requested its presigned URL (CSP frame-src allowed it): ${intercepted}`);
          await sleep(50);
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await page.send('Fetch.disable');
        page.listeners.delete(onPaused);
      }
    });

    it('other types: no preview, a clear message, and Download', async () => {
      storage.putObject('docs/archive.zip', 'PK');
      await open('#/docs/');
      await waitLoaded('docs/');
      await clickPreview('archive.zip');
      await previewSettled();
      const s = await previewState();
      assert.equal(s.message, 'No preview is available for this type of file. Use Download to get it.');
      assert.equal(s.messageIsError, false);
      assert.deepEqual([s.text, s.img, s.frame], [null, null, null]);
      assert.equal(s.download, downloadHref('docs/archive.zip'));
      assert.equal(await page.evaluate(`document.getElementById('preview-body').childElementCount`), 0);
    });
  });

  describe('M1 closure: N4 sorting and toolbar touch targets', () => {
    beforeEach(() => {
      storage = createMemoryStorage();
      for (const folder of ['Zeta/', 'alpha/', 'beta2/', 'beta10/']) storage.putObject(folder);
      storage.putObject('b.txt', 'x'.repeat(300), new Date('2026-01-02T00:00:00Z'));
      storage.putObject('a10.txt', 'x'.repeat(10), new Date('2026-01-03T00:00:00Z'));
      storage.putObject('a2.txt', 'x'.repeat(2000), new Date('2026-01-01T00:00:00Z'));
    });

    // Folders always come first; they are ordered by name (descending only for "Name Z–A").
    const FOLDERS_AZ = ['alpha', 'beta2', 'beta10', 'Zeta'];
    const expected = {
      'name-asc': [...FOLDERS_AZ, 'a2.txt', 'a10.txt', 'b.txt'],
      'name-desc': [...FOLDERS_AZ.toReversed(), 'b.txt', 'a10.txt', 'a2.txt'],
      'modified-desc': [...FOLDERS_AZ, 'a10.txt', 'b.txt', 'a2.txt'],
      'modified-asc': [...FOLDERS_AZ, 'a2.txt', 'b.txt', 'a10.txt'],
      'size-desc': [...FOLDERS_AZ, 'a2.txt', 'b.txt', 'a10.txt'],
      'size-asc': [...FOLDERS_AZ, 'a10.txt', 'b.txt', 'a2.txt'],
    };

    it('all six sort orders, with folders first', async () => {
      await open('#/');
      await waitLoaded('');
      const options = await page.evaluate(`[...document.getElementById('sort').options].map((o) => o.value)`);
      assert.deepEqual(options.toSorted(), Object.keys(expected).toSorted(), 'the UI offers exactly these six orders');
      for (const [order, names] of Object.entries(expected)) {
        const rows = await page.evaluate(`(() => {
          const select = document.getElementById('sort');
          select.value = ${JSON.stringify(order)};
          select.dispatchEvent(new Event('change'));
          return [...document.querySelectorAll('#listing .row')].map((r) => ({
            name: r.querySelector('.name').lastChild.textContent,
            folder: r.classList.contains('folder'),
          }));
        })()`);
        assert.deepEqual(rows.map((r) => r.name), names, order);
        assert.deepEqual(rows.map((r) => r.folder), [true, true, true, true, false, false, false], `${order}: folders first`);
      }
    });

    for (const [label, width] of [['phone', 375], ['desktop', 1280]]) {
      it(`toolbar controls are at least 44x44 CSS px (${label}, ${width}px)`, async () => {
        await page.setViewport(width, 800);
        try {
          await open('#/');
          await waitLoaded('');
          const controls = await page.evaluate(`[
            '#new-folder-name', '#new-folder-form button[type="submit"]', '#sort',
          ].map((selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { selector, width: r.width, height: r.height };
          })`);
          for (const c of controls) {
            assert.ok(c.width >= 44 && c.height >= 44, `${c.selector}: ${c.width}x${c.height}`);
          }
        } finally {
          await page.setViewport(375, 740);
        }
      });
    }
  });
});
