// Browser regression tests: drive the real UI in headless Chrome against the app with in-memory
// (or fake-S3) storage. Skipped, with a reason, when no Chrome/Chromium is found.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { createS3Storage } from '../src/storage/s3.js';
import { findChrome, launchChrome } from './helpers/chrome.js';
import { FakeS3Client } from './helpers/fake-s3-client.js';

const chromePath = findChrome();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('browser UI', { skip: chromePath ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  let storage;
  let listDelays; // prefix -> ms, to make chosen list requests slow
  let mutationDelay; // ms added to every createFolder/deleteFolder call
  let dialogs; // every alert/confirm/prompt the page opened: { type, message }
  let listCalls; // every prefix the server was asked to list, in order
  let failNextLists; // number of upcoming list calls that fail with a simulated S3 outage (502)
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
