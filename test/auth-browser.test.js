// Browser login (AUTH_MODE=cognito, Phase A) end to end in headless Chrome: the real UI and the real
// oidc-client-ts browser build against a local fake Cognito login (test/helpers/fake-oidc.js), real aws-jwt-verify
// on the server with an offline fixture JWKS, memory storage. No real Google/Cognito, no network: the test Chrome
// resolves no host names. This is not evidence of real provider, MFA, account-linking or phone behaviour.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { invalidToken } from '../src/errors.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import {
  GOOGLE_CLIENT,
  NATIVE_CLIENT,
  OWNER_EMAIL,
  OWNER_SUB,
  STRANGER_SUB,
  authSettings,
  createSigningKey,
  offlineJwksCache,
} from './helpers/auth-fixtures.js';
import { findChrome, launchChrome } from './helpers/chrome.js';
import { startFakeOidc } from './helpers/fake-oidc.js';
import { minimalPdf } from './helpers/fixtures.js';
import { jpegFixture } from './helpers/jpeg-fixtures.js';

const chromePath = findChrome();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('browser login (AUTH_MODE=cognito)', { skip: chromePath ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  const key = createSigningKey();
  let storage;
  let storageCalls; // storage methods the server ran, in order
  let principals; // every principal the server accepted
  let failNextAuth; // the next token check fails with 401, as if the token had expired
  let listDelayMs;
  let previewDelayMs; // a JPEG's source read
  let uploadDelayMs;
  let downloadDelayMs;
  let previewOverride; // when set, answers getPreview (e.g. a URL the browser must not send the token to)
  let server;
  let origin;
  let fake;
  let chrome;
  let page;
  let requests; // every URL the browser requested
  let dir;

  before(async () => {
    server = http.createServer();
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    fake = await startFakeOidc({ appOrigin: origin, clients: { native: NATIVE_CLIENT, google: GOOGLE_CLIENT }, key });
    const auth = createAuth(authSettings(origin), { jwksCache: offlineJwksCache([key]).jwksCache, providerOrigin: fake.origin });
    const checkedAuth = {
      ...auth,
      async verifyToken(token) {
        if (failNextAuth) {
          failNextAuth = false;
          throw invalidToken();
        }
        const principal = await auth.verifyToken(token);
        principals.push(principal);
        return principal;
      },
    };
    const proxy = new Proxy(
      {},
      {
        get: (_, method) =>
          async (...args) => {
            storageCalls.push(method);
            if (method === 'list' && listDelayMs) await sleep(listDelayMs);
            if (method === 'readPreviewSource' && previewDelayMs) await sleep(previewDelayMs);
            if (method === 'putFile' && uploadDelayMs) await sleep(uploadDelayMs);
            if (method === 'getDownload' && downloadDelayMs) await sleep(downloadDelayMs);
            if (method === 'getPreview' && previewOverride) return previewOverride(...args);
            return storage[method](...args);
          },
      },
    );
    server.on('request', createApp({ storage: proxy, auth: checkedAuth }));
    dir = mkdtempSync(path.join(tmpdir(), 'file-manager-auth-'));
    chrome = await launchChrome(chromePath);
    page = chrome.page;
    await page.send('Network.enable');
    page.listeners.add((msg) => {
      if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
    });
    await page.setViewport(375, 740);
  });

  after(async () => {
    await chrome?.close();
    server?.close();
    await fake?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    storage = createMemoryStorage({ 'readme.txt': 'hello', 'docs/': '', 'docs/notes.txt': 'notes' });
    storageCalls = [];
    principals = [];
    failNextAuth = false;
    listDelayMs = 0;
    previewDelayMs = 0;
    uploadDelayMs = 0;
    downloadDelayMs = 0;
    previewOverride = undefined;
    requests = [];
    fake.reset();
    page.errors.length = 0;
    page.onDialog = () => ({ accept: true });
    await page.setViewport(375, 740);
    // A fresh tab state: no storage of this origin left from an earlier test.
    await page.goto('about:blank');
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.resetNavigationHistory');
  });

  afterEach(() => {
    assert.deepEqual(page.errors, [], 'no uncaught page errors');
  });

  const ui = () =>
    page.evaluate(`({
      chooser: !document.getElementById('login').hidden,
      main: !document.querySelector('main').hidden,
      account: !document.getElementById('account').hidden,
      message: document.getElementById('login-message').textContent,
      buttons: [...document.querySelectorAll('#login button')].map((b) => [b.textContent, b.disabled]),
      names: [...document.querySelectorAll('#listing .name')].map((n) => n.lastChild.textContent),
      status: document.getElementById('status').textContent,
      search: location.search,
    })`);

  const waitChooser = () => page.waitFor(`!document.getElementById('login').hidden && document.querySelector('main').hidden`, { message: 'login chooser shown' });

  describe('the sign-in chooser', () => {
    it('shows both methods before any file data is requested, with 44 px targets at 375 and 1280 px', async () => {
      await page.goto(`${origin}/`);
      await waitChooser();
      const s = await ui();
      assert.deepEqual(s.buttons, [['Continue with Google', false], ['Email + password', false]]);
      assert.equal(s.account, false);
      assert.equal(s.message, '');
      assert.deepEqual(storageCalls, [], 'nothing private was requested');
      assert.equal(await page.evaluate(`document.getElementById('login').getAttribute('aria-labelledby')`), 'login-title');
      for (const [width, height] of [[375, 740], [1280, 800]]) {
        await page.setViewport(width, height);
        const boxes = await page.evaluate(`[...document.querySelectorAll('#login button')].map((b) => {
          const r = b.getBoundingClientRect();
          return [r.width, r.height, r.right <= innerWidth];
        })`);
        for (const [w, h, inside] of boxes) {
          assert.ok(w >= 44 && h >= 44, `${width}px: ${w}x${h}`);
          assert.ok(inside, `${width}px: inside the viewport`);
        }
      }
    });
  });

  describe('the sign-in library cannot be loaded', () => {
    // The vendor script answers 404 (e.g. a broken install or a proxy blocking it). The page must say so where the user
    // looks - the login area - at phone and desktop width, offer no way in, and show or request nothing private.
    // 404, or 200 with a script that is not the library (wrong file, a proxy page served as JavaScript).
    const failures = [
      ['404', 404, 'text/plain', 'not found'],
      ['200 but not the library', 200, 'text/javascript', '/* not the sign-in library */'],
    ];
    for (const [failure, responseCode, contentType, body] of failures)
    for (const [width, height] of [[375, 740], [1280, 800]]) {
      it(`${failure}, ${width}px: a visible, accessible, fixed error in the login area; no file UI, no data, no token`, async () => {
        await page.setViewport(width, height);
        await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/vendor/oidc-client-ts.min.js', requestStage: 'Request' }] });
        const answer404 = (msg) => {
          if (msg.method !== 'Fetch.requestPaused') return;
          page
            .send('Fetch.fulfillRequest', {
              requestId: msg.params.requestId,
              responseCode,
              responseHeaders: [{ name: 'Content-Type', value: contentType }],
              body: Buffer.from(body).toString('base64'),
            })
            .catch(() => {});
        };
        page.listeners.add(answer404);
        try {
          await page.goto(`${origin}/`);
          // Settles either way: the fixed error lands in the login area (or, before the fix, in the hidden status line).
          await page.waitFor(`document.getElementById('login-message').textContent !== '' || document.getElementById('status').textContent !== ''`, {
            message: 'the page reacted to the failed library load',
          });
          const s = await page.evaluate(`(() => {
            const m = document.getElementById('login-message');
            const r = m.getBoundingClientRect();
            return {
              chooser: !document.getElementById('login').hidden,
              main: !document.querySelector('main').hidden,
              account: !document.getElementById('account').hidden,
              message: m.textContent,
              role: m.getAttribute('role'),
              visible: getComputedStyle(m).display !== 'none' && r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
              buttonsDisabled: [...document.querySelectorAll('#login button')].map((b) => b.disabled),
              library: typeof window.oidc,
              session: Object.keys(sessionStorage),
              local: Object.keys(localStorage),
            };
          })()`);
          assert.deepEqual(s, {
            chooser: true,
            main: false,
            account: false,
            message: 'Could not load the sign-in library. Reload to try again.',
            role: 'alert',
            visible: true,
            buttonsDisabled: [true, true],
            library: 'undefined',
            session: [],
            local: [],
          });
          assert.deepEqual(storageCalls, [], 'no file data was requested');
          assert.deepEqual(principals, [], 'no token reached the server');
          assert.deepEqual(fake.authorizations, [], 'no sign-in was started');
        } finally {
          page.listeners.delete(answer404);
          await page.send('Fetch.disable');
        }
      });
    }
  });

  const waitSignedIn = () =>
    page.waitFor(
      `!document.querySelector('main').hidden && !document.getElementById('account').hidden &&
       document.getElementById('status').textContent === '' && document.querySelectorAll('#listing .row').length > 0`,
      { message: 'signed in and the folder loaded' },
    );

  async function signIn(button = 'login-email') {
    await page.goto(`${origin}/`);
    await waitChooser();
    await page.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
  }

  const googleRequests = () => requests.filter((u) => /google|gstatic/.test(new URL(u).hostname));

  // Everything the page keeps outside its JavaScript memory: none of it may contain a token.
  const persisted = () =>
    page.evaluate(`(async () => ({
      local: Object.fromEntries(Object.entries(localStorage)),
      session: Object.fromEntries(Object.entries(sessionStorage)),
      cookie: document.cookie,
      databases: (await indexedDB.databases()).map((d) => d.name),
      html: document.documentElement.outerHTML,
      url: location.href,
      globals: Object.keys(window).filter((k) => typeof window[k] === 'string').map((k) => window[k]),
    }))()`);

  function assertNoTokens(snapshot, tokens) {
    const text = JSON.stringify(snapshot);
    for (const [name, value] of Object.entries(tokens)) {
      if (typeof value !== 'string' || name === 'token_type') continue;
      for (const part of value.split('.')) assert.equal(text.includes(part), false, `${name} found outside memory`);
    }
  }

  describe('signing in', () => {
    it('Email + password: the native client with identity_provider=COGNITO and PKCE, no Google request at all, token only in memory', async () => {
      await page.goto(`${origin}/`);
      await waitChooser();
      await page.evaluate(`sessionStorage.setItem('other-app', 'keep'); localStorage.setItem('other-app', 'keep')`);
      await page.evaluate(`document.getElementById('login-email').click()`);
      await waitSignedIn();

      assert.equal(fake.authorizations.length, 1);
      const authorize = fake.authorizations[0];
      assert.equal(authorize.client_id, NATIVE_CLIENT);
      assert.equal(authorize.identity_provider, 'COGNITO');
      assert.equal(authorize.code_challenge_method, 'S256');
      assert.equal(authorize.redirect_uri, `${origin}/`);
      assert.ok(authorize.state && authorize.nonce);
      assert.equal(fake.tokenRequests.length, 1);
      assert.equal(fake.tokenRequests[0].client_id, NATIVE_CLIENT);
      assert.ok(fake.tokenRequests[0].code_verifier, 'PKCE verifier sent');
      assert.equal(fake.tokenRequests[0].client_secret, undefined, 'public client: no secret');

      assert.deepEqual(googleRequests(), [], 'the email path never contacts Google');
      assert.deepEqual([...new Set(requests.map((u) => new URL(u).origin))].sort(), [origin, fake.origin].sort());
      assert.ok(requests.includes(`${origin}/vendor/oidc-client-ts.min.js`), 'the library comes from this origin');

      const s = await ui();
      assert.equal(s.search, '', 'the code and state are gone from the address bar');
      assert.equal(await page.evaluate('location.href'), `${origin}/#/`);
      assert.deepEqual(s.names, ['docs', 'readme.txt']);
      assert.ok(principals.length > 0 && principals.every((p) => p.role === 'owner' && p.sub === OWNER_SUB));

      const snapshot = await persisted();
      assert.deepEqual(snapshot.local, { 'other-app': 'keep' }, 'localStorage: only the unrelated entry');
      assert.deepEqual(snapshot.session, { 'other-app': 'keep' }, 'sessionStorage: the login transaction is cleaned up, the rest kept');
      assert.equal(snapshot.cookie, '');
      assert.deepEqual(snapshot.databases, []);
      assertNoTokens(snapshot, fake.issued[0]);
    });

    it('while a login is in flight, only its transaction is stored, in sessionStorage under the app prefix', async () => {
      await page.goto(`${origin}/`);
      await waitChooser();
      // Every storage write the page makes from now on is mirrored to the console, which outlives the navigation.
      await page.evaluate(`(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          console.debug('storage-write', JSON.stringify([this === localStorage ? 'local' : 'session', k, v]));
          return set.call(this, k, v);
        };
      })()`);
      const writes = [];
      const listener = (msg) => {
        const args = msg.params?.args;
        if (msg.method === 'Runtime.consoleAPICalled' && args?.[0]?.value === 'storage-write') writes.push(JSON.parse(args[1].value));
      };
      page.listeners.add(listener);
      try {
        fake.behaviour.authorize = 'hold';
        await page.evaluate(`document.getElementById('login-email').click()`);
        await page.waitFor(`location.href.startsWith(${JSON.stringify(fake.origin)})`);
      } finally {
        page.listeners.delete(listener);
      }
      const { state, nonce } = fake.authorizations[0];
      assert.deepEqual(writes.map(([area, k]) => [area, k]), [['session', `fm.oidc.native.${state}`]], 'one write: the transaction, in sessionStorage');
      const transaction = JSON.parse(writes[0][2]);
      assert.equal(transaction.client_id, NATIVE_CLIENT);
      assert.ok(transaction.code_verifier, 'the PKCE verifier stays in this tab');
      assert.equal(transaction.nonce, nonce);
      assert.doesNotMatch(JSON.stringify(transaction), /token/, 'no token in the transaction');
    });

    it('Continue with Google: the Google client with identity_provider=Google; it and Email + password are the same owner; a reload returns to the chooser', async () => {
      await signIn('login-google');
      await waitSignedIn();
      assert.deepEqual(
        [fake.authorizations[0].client_id, fake.authorizations[0].identity_provider],
        [GOOGLE_CLIENT, 'Google'],
      );
      assert.ok(principals.length > 0 && principals.every((p) => p.role === 'owner' && p.sub === OWNER_SUB));

      // Tokens are in memory only, so a reload shows the chooser - and starts no login on its own.
      await page.goto(`${origin}/`);
      await waitChooser();
      await sleep(300);
      assert.equal(fake.authorizations.length, 1, 'no automatic redirect to the provider');
      assert.equal((await ui()).message, '');

      principals = [];
      await page.evaluate(`document.getElementById('login-email').click()`);
      await waitSignedIn();
      assert.equal(fake.authorizations[1].client_id, NATIVE_CLIENT);
      assert.ok(principals.length > 0 && principals.every((p) => p.role === 'owner' && p.sub === OWNER_SUB), 'the same owner sub');
    });

    it('an unapproved Google account - even with the owner email - gets no access; its refresh token is revoked', async () => {
      fake.behaviour.sub = STRANGER_SUB;
      fake.behaviour.email = OWNER_EMAIL;
      await signIn('login-google');
      await page.waitFor(`document.getElementById('login-message').textContent !== ''`);
      const s = await ui();
      assert.deepEqual([s.chooser, s.main, s.account], [true, false, false]);
      assert.equal(s.message, 'This account is not allowed to use this file manager. Choose another sign-in method or account.');
      assert.deepEqual(s.buttons, [['Continue with Google', false], ['Email + password', false]]);
      assert.equal(storageCalls.includes('list'), false, 'no file data');
      assert.deepEqual(fake.revocations.map((r) => [r.token, r.token_type_hint, r.client_id]), [
        [fake.issued[0].refresh_token, 'refresh_token', GOOGLE_CLIENT],
      ]);
      assertNoTokens(await persisted(), fake.issued[0]);
    });
  });

  const transactionKeys = () => page.evaluate(`Object.keys(sessionStorage).filter((k) => k.startsWith('fm.oidc.'))`);

  // `neverSignedIn`: no file data was ever requested in this test (a session that ended is checked by privateState()).
  async function expectChooserMessage(message, { neverSignedIn = true } = {}) {
    await page.waitFor(`document.getElementById('login-message').textContent !== ''`, { message: 'a chooser message' });
    const s = await ui();
    assert.equal(s.message, message);
    assert.deepEqual([s.chooser, s.main, s.account, s.search], [true, false, false, '']);
    assert.deepEqual(s.buttons, [['Continue with Google', false], ['Email + password', false]], 'both methods offered again');
    assert.deepEqual(await transactionKeys(), [], 'no login transaction left');
    if (neverSignedIn) assert.equal(storageCalls.includes('list'), false, 'no file data');
  }

  describe('failed, cancelled and forged sign-ins return to the chooser', () => {
    it('cancelled at the provider: a clear message, then the other method works', async () => {
      fake.behaviour.authorize = 'cancel';
      await signIn('login-google');
      await expectChooserMessage('Sign-in was cancelled. Choose a sign-in method.');
      assert.equal(fake.tokenRequests.length, 0);
      fake.behaviour.authorize = 'approve';
      await page.evaluate(`document.getElementById('login-email').click()`);
      await waitSignedIn();
    });

    it('a code the provider does not accept: the exchange fails and nothing is signed in', async () => {
      fake.behaviour.authorize = 'badcode';
      await signIn('login-email');
      await expectChooserMessage('Sign-in did not complete. Try again, or choose the other method.');
      assert.equal(fake.tokenRequests.length, 1);
      assert.equal(fake.issued.length, 0);
    });

    for (const idToken of ['badnonce', 'missing']) {
      it(`an ID token ${idToken === 'badnonce' ? 'whose nonce is not this login\'s' : 'that is missing'} is refused: no session, no file data`, async () => {
        fake.behaviour.idToken = idToken;
        await signIn('login-email');
        await expectChooserMessage('Sign-in did not complete. Try again, or choose the other method.');
        assert.equal(fake.issued.length, 1, 'the provider answered');
        assert.equal(principals.length, 0, 'the server never saw the token');
        assertNoTokens(await persisted(), fake.issued[0]);
      });
    }

    it('a forged callback (state this tab never created) is refused without contacting the provider', async () => {
      await page.goto(`${origin}/?code=forged-code&state=forged-state#/docs/`);
      await expectChooserMessage('This sign-in link has expired or was already used. Choose a sign-in method.');
      assert.equal(fake.tokenRequests.length, 0);
    });

    it('a replayed callback is refused: its state was used up', async () => {
      await signIn('login-email');
      await waitSignedIn();
      const callback = fake.redirects.at(-1);
      assert.match(callback, /\?code=.*&state=/);
      storageCalls = [];
      await page.goto(callback);
      await expectChooserMessage('This sign-in link has expired or was already used. Choose a sign-in method.');
      assert.equal(fake.tokenRequests.length, 1, 'the code was not sent again');
    });

    it('a used code with a fresh, valid state is refused by the provider (single-use code)', async () => {
      await signIn('login-email');
      await waitSignedIn();
      const usedCode = new URL(fake.redirects.at(-1)).searchParams.get('code');
      fake.behaviour.authorize = 'hold';
      await page.goto(`${origin}/`);
      await waitChooser();
      await page.evaluate(`document.getElementById('login-email').click()`);
      await page.waitFor(`location.href.startsWith(${JSON.stringify(fake.origin)})`);
      const freshState = fake.authorizations.at(-1).state;
      storageCalls = [];
      await page.goto(`${origin}/?code=${usedCode}&state=${freshState}`);
      await expectChooserMessage('Sign-in did not complete. Try again, or choose the other method.');
      assert.equal(fake.tokenRequests.length, 2);
      assert.equal(fake.issued.length, 1, 'no second set of tokens');
    });

    it('Google blocked by the network: Back returns to the chooser, and Email + password still works', async () => {
      fake.behaviour.authorize = 'google-blocked';
      await signIn('login-google');
      await page.waitFor(`true`);
      const deadline = Date.now() + 5000;
      while (!requests.some((u) => u.startsWith('https://accounts.google.com/')) && Date.now() < deadline) await sleep(25);
      assert.ok(requests.some((u) => u.startsWith('https://accounts.google.com/')), 'the Google page was requested (and failed)');
      await sleep(300);
      const { currentIndex, entries } = await page.send('Page.getNavigationHistory');
      const app = entries.slice(0, currentIndex).findLast((e) => e.url.startsWith(origin));
      await page.send('Page.navigateToHistoryEntry', { entryId: app.id });
      await waitChooser();
      await page.waitFor(`!document.getElementById('login-email').disabled`, { message: 'Email + password usable after Back' });
      assert.equal(fake.authorizations.length, 1, 'no automatic retry');

      requests = [];
      fake.behaviour.authorize = 'approve';
      await page.evaluate(`document.getElementById('login-email').click()`);
      await waitSignedIn();
      assert.deepEqual(googleRequests(), [], 'the email path made no Google request');
    });
  });

  // Records link clicks instead of following them, so a test can inspect (and fetch) what would be downloaded.
  const captureLinkClicks = () =>
    page.evaluate(`(() => {
      window.__clicks = [];
      HTMLAnchorElement.prototype.click = function () { window.__clicks.push({ href: this.href, download: this.download }); };
    })()`);
  const clickRowAction = (fileName, selector) =>
    page.evaluate(`[...document.querySelectorAll('#listing .row.file')]
      .find((r) => r.querySelector('.name').lastChild.textContent === ${JSON.stringify(fileName)})
      .querySelector(${JSON.stringify(selector)}).click()`);
  const previewState = () =>
    page.evaluate(`({
      state: document.getElementById('preview').dataset.state,
      message: document.getElementById('preview-message').textContent,
      img: document.querySelector('#preview-body img')?.getAttribute('src') ?? null,
      natural: document.querySelector('#preview-body img') ? [document.querySelector('#preview-body img').naturalWidth, document.querySelector('#preview-body img').naturalHeight] : null,
      frame: document.querySelector('#preview-body iframe')?.getAttribute('src') ?? null,
      text: document.querySelector('#preview-body pre')?.textContent ?? null,
    })`);
  // The page CSP does not let it fetch() blob: URLs (connect-src), so blob contents and revocations are observed
  // by wrapping URL.createObjectURL / URL.revokeObjectURL in the page.
  const watchObjectUrls = () =>
    page.evaluate(`(() => {
      window.__blobs = {};
      window.__revoked = [];
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); window.__blobs[url] = blob; return url; };
      URL.revokeObjectURL = (url) => { window.__revoked.push(url); revoke(url); };
    })()`);
  const blobText = (url) => page.evaluate(`window.__blobs[${JSON.stringify(url)}].text()`);
  const revoked = () => page.evaluate('window.__revoked');

  describe('signed in: files with the token', () => {
    it('Sign out and the Download buttons are at least 44x44 and inside the viewport at 375 and 1280 px', async () => {
      await signIn();
      await waitSignedIn();
      await page.evaluate(`document.querySelector('#listing .row.file button[aria-label^="Preview"]').click()`);
      await page.waitFor(`document.getElementById('preview').dataset.state === 'ready'`);
      for (const [width, height] of [[375, 740], [1280, 800]]) {
        await page.setViewport(width, height);
        const boxes = await page.evaluate(`[document.getElementById('sign-out'), document.getElementById('preview-download'), ...document.querySelectorAll('#listing .download')]
          .map((b) => { const r = b.getBoundingClientRect(); return [b.id || b.getAttribute('aria-label'), b.tagName, r.width, r.height, r.right <= innerWidth]; })`);
        assert.equal(boxes.length, 3);
        for (const [name, tag, w, h, inside] of boxes) {
          assert.equal(tag, 'BUTTON', `${name} is a button`);
          assert.ok(w >= 44 && h >= 44, `${width}px ${name}: ${w}x${h}`);
          assert.ok(inside, `${width}px ${name}: inside the viewport`);
        }
      }
      await page.evaluate(`document.getElementById('preview-close').click()`);
    });

    it('upload, rename and delete send the token; no private link without it is in the page', async () => {
      await signIn();
      await waitSignedIn();
      writeFileSync(path.join(dir, 'up.txt'), 'uploaded');
      const { root } = await page.send('DOM.getDocument');
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload-input' });
      await page.send('DOM.setFileInputFiles', { nodeId, files: [path.join(dir, 'up.txt')] });
      await page.waitFor(`document.getElementById('status').textContent === 'Uploaded "up.txt".'`);
      assert.equal((await storage.getDownload('up.txt')).body.toString(), 'uploaded');

      page.onDialog = ({ type }) => (type === 'prompt' ? { accept: true, promptText: 'renamed.txt' } : { accept: true });
      await clickRowAction('up.txt', 'button[aria-label^="Rename"]');
      await page.waitFor(`document.getElementById('status').textContent === 'Renamed "up.txt" to "renamed.txt".'`);
      await clickRowAction('renamed.txt', 'button.danger');
      await page.waitFor(`document.getElementById('status').textContent === 'Deleted file "renamed.txt".'`);
      assert.deepEqual((await storage.list('')).files.map((f) => f.name), ['readme.txt']);
      assert.ok(storageCalls.includes('putFile') && storageCalls.includes('moveFile') && storageCalls.includes('deleteFile'));

      const links = await page.evaluate(`[...document.querySelectorAll('[href], [src]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src'))`);
      assert.deepEqual(links.filter((l) => l.includes('/api/')), [], 'no /api link that would be opened without the token');
    });

    it('the token is only ever sent to this app: a preview URL on another host (even protocol-relative) is not fetched with it', async () => {
      const foreignHost = new URL(fake.origin).host;
      for (const url of [`//${foreignHost}/steal.png`, `${fake.origin}/steal.png`, `/\\${foreignHost}/steal.png`]) {
        previewOverride = async () => ({ kind: 'image', contentType: 'image/png', url });
        await signIn();
        await waitSignedIn();
        fake.others.length = 0;
        await clickRowAction('readme.txt', 'button[aria-label^="Preview"]');
        await sleep(500);
        const leaked = fake.others.filter((r) => r.token || /x-app-authorization/i.test(r.preflightHeaders ?? ''));
        assert.deepEqual(leaked, [], `${url}: no request carried or asked to carry the token`);
        await page.evaluate(`document.getElementById('preview-close').click()`);
      }
    });

    it('download: an authorized fetch; memory bytes become a blob download, an S3 { url } is opened as given', async () => {
      await signIn();
      await waitSignedIn();
      await captureLinkClicks();
      await watchObjectUrls();
      await clickRowAction('readme.txt', '.download');
      await page.waitFor('window.__clicks.length === 1');
      const [memory] = await page.evaluate('window.__clicks');
      assert.match(memory.href, /^blob:/);
      assert.equal(memory.download, 'readme.txt');
      assert.equal(await blobText(memory.href), 'hello');

      const presigned = 'https://example-bucket.s3.ap-east-1.amazonaws.com/readme.txt?X-Amz-Signature=placeholder';
      const memoryDownload = storage.getDownload;
      storage.getDownload = async () => ({ url: presigned });
      try {
        await clickRowAction('readme.txt', '.download');
        await page.waitFor('window.__clicks.length === 2');
      } finally {
        storage.getDownload = memoryDownload;
      }
      assert.deepEqual((await page.evaluate('window.__clicks'))[1], { href: presigned, download: '' });
    });

    it('previews: a converted JPEG and a PDF are fetched with the token and shown as blob: URLs, revoked on Close', async () => {
      storage.putObject('docs/photo.jpg', await jpegFixture({ width: 3000, height: 2000 }));
      storage.putObject('docs/paper.pdf', minimalPdf());
      await signIn();
      await waitSignedIn();
      await page.evaluate(`location.hash = '#/docs/'`);
      await page.waitFor(`document.querySelectorAll('#listing .row.file').length === 3 && document.getElementById('status').textContent === ''`);
      await watchObjectUrls();

      await clickRowAction('photo.jpg', 'button[aria-label^="Preview"]');
      await page.waitFor(`document.getElementById('preview').dataset.state === 'ready'`, { timeout: 15000 });
      const jpeg = await previewState();
      assert.match(jpeg.img, /^blob:/);
      assert.deepEqual(jpeg.natural, [2048, 1365], 'the converted picture, displayed under the page CSP');
      assert.deepEqual(await revoked(), []);
      await page.evaluate(`document.getElementById('preview-close').click()`);
      assert.deepEqual(await revoked(), [jpeg.img], 'revoked on Close');

      await clickRowAction('paper.pdf', 'button[aria-label^="Preview"]');
      await page.waitFor(`document.querySelector('#preview-body iframe')`);
      const pdf = await previewState();
      assert.match(pdf.frame, /^blob:/);
      assert.match(await blobText(pdf.frame), /^%PDF-/);
      assert.equal(await page.evaluate(`document.querySelector('#preview-body a.open-pdf').getAttribute('href')`), pdf.frame);
      await page.evaluate(`document.getElementById('preview-close').click()`);
      assert.deepEqual(await revoked(), [jpeg.img, pdf.frame], 'revoked on Close');

      await clickRowAction('notes.txt', 'button[aria-label^="Preview"]');
      await page.waitFor(`document.querySelector('#preview-body pre')`);
      assert.equal((await previewState()).text, 'notes');

      await captureLinkClicks();
      await page.evaluate(`document.getElementById('preview-download').click()`);
      await page.waitFor('window.__clicks.length === 1');
      assert.equal((await page.evaluate('window.__clicks'))[0].download, 'notes.txt', 'the dialog Download uses the token too');
    });
  });

  // Everything private the page could still show after the session ended.
  const privateState = () =>
    page.evaluate(`({
      rows: document.querySelectorAll('#listing > *').length,
      crumbs: document.getElementById('breadcrumbs').children.length,
      uploads: document.getElementById('uploads').children.length,
      previewOpen: document.getElementById('preview').open,
      previewBody: document.getElementById('preview-body').children.length,
      status: document.getElementById('status').textContent,
      text: document.body.innerText,
    })`);

  // Waits until the server ran `method` on storage (so that request's token was already accepted).
  async function waitStorageCall(method) {
    const deadline = Date.now() + 5000;
    while (!storageCalls.includes(method) && Date.now() < deadline) await sleep(10);
    assert.ok(storageCalls.includes(method), `${method} started`);
  }

  function assertNothingPrivate(s) {
    assert.deepEqual([s.rows, s.crumbs, s.uploads, s.previewOpen, s.previewBody, s.status], [0, 0, 0, false, 0, '']);
    for (const name of ['readme.txt', 'docs', 'notes.txt', 'photo.jpg', 'slow-1.txt']) assert.equal(s.text.includes(name), false, name);
  }

  describe('the session ends without signing out', () => {
    it('a 401 from the API (expired or revoked token) returns to the chooser and clears every file detail', async () => {
      await signIn();
      await waitSignedIn();
      failNextAuth = true;
      await page.evaluate(`location.hash = '#/docs/'`);
      await expectChooserMessage('Your session has ended. Sign in again.', { neverSignedIn: false });
      assertNothingPrivate(await privateState());
      // Signed out: navigating does not ask the server for anything.
      storageCalls = [];
      await page.evaluate(`location.hash = '#/'`);
      await sleep(300);
      assert.deepEqual(storageCalls, []);
    });

    it('the access token expiring (no automatic renewal) returns to the chooser by itself', async () => {
      fake.behaviour.expiresIn = 2;
      await signIn();
      await waitSignedIn();
      await page.waitFor(`document.getElementById('login-message').textContent !== ''`, { timeout: 6000 });
      const s = await ui();
      assert.equal(s.message, 'Your session has ended. Sign in again.');
      assert.equal(fake.tokenRequests.length, 1, 'no refresh attempted');
      assertNothingPrivate(await privateState());
    });

    // Ends the session the way an expired token does: the next request's token check fails (here a folder create).
    const expireByNextRequest = async () => {
      failNextAuth = true;
      await page.evaluate(`(() => {
        document.getElementById('new-folder-name').value = 'x';
        document.getElementById('new-folder-form').requestSubmit();
      })()`);
      await expectChooserMessage('Your session has ended. Sign in again.', { neverSignedIn: false });
    };
    it('a slow folder load that finishes after the session ended shows nothing', async () => {
      await signIn();
      await waitSignedIn();
      listDelayMs = 800;
      storageCalls = [];
      await page.evaluate(`location.hash = '#/docs/'`);
      await waitStorageCall('list'); // its token was accepted; the folder is on its way
      await expireByNextRequest();
      await sleep(1200); // past the slow response
      assertNothingPrivate(await privateState());
    });

    it('a download whose response arrives after the session ended leaves no blob of the file and opens nothing', async () => {
      await signIn();
      await waitSignedIn();
      await captureLinkClicks();
      await watchObjectUrls();
      downloadDelayMs = 800;
      storageCalls = [];
      await clickRowAction('readme.txt', '.download');
      await waitStorageCall('getDownload'); // its token was accepted; the bytes are on their way
      await expireByNextRequest();
      await sleep(1200); // past the slow download
      assert.deepEqual(await page.evaluate('Object.keys(window.__blobs)'), [], 'no blob: URL holds the file after the session ended');
      assert.deepEqual(await page.evaluate('window.__clicks'), [], 'nothing was opened');
      assertNothingPrivate(await privateState());
    });

    it('a slow JPEG preview and a running multi-file upload stop when the session ends', async () => {
      storage.putObject('docs/photo.jpg', await jpegFixture({ width: 40, height: 30 }));
      await signIn();
      await waitSignedIn();
      await page.evaluate(`location.hash = '#/docs/'`);
      await page.waitFor(`document.querySelectorAll('#listing .row.file').length === 2 && document.getElementById('status').textContent === ''`);
      await watchObjectUrls();
      previewDelayMs = 800;
      uploadDelayMs = 800;
      storageCalls = [];
      await clickRowAction('photo.jpg', 'button[aria-label^="Preview"]');
      await waitStorageCall('readPreviewSource');
      for (const n of [1, 2]) writeFileSync(path.join(dir, `slow-${n}.txt`), 'x');
      const { root } = await page.send('DOM.getDocument');
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload-input' });
      await page.send('DOM.setFileInputFiles', { nodeId, files: [path.join(dir, 'slow-1.txt'), path.join(dir, 'slow-2.txt')] });
      await waitStorageCall('putFile');
      await expireByNextRequest();
      await sleep(1200); // past the slow preview and the first upload
      assertNothingPrivate(await privateState());
      assert.deepEqual(await page.evaluate('Object.keys(window.__blobs)'), [], 'no preview picture was created');
      assert.equal((await storage.list('docs/')).files.some((f) => f.name === 'slow-2.txt'), false, 'the second upload never started');
    });
  });

  describe('signing out', () => {
    const signOutCalls = () => fake.sequence.filter((s) => s === 'POST /oauth2/revoke' || s === 'GET /logout');

    async function signOutAndReturn() {
      await page.evaluate(`document.getElementById('sign-out').click()`);
      await page.waitFor(`location.href === ${JSON.stringify(`${origin}/`)} && !document.getElementById('login').hidden && document.getElementById('login-message').textContent === ''`, {
        message: 'back at the chooser after /logout',
      });
    }

    for (const button of ['login-email', 'login-google']) {
      it(`${button === 'login-email' ? 'Email + password' : 'Google'}: revokes the refresh token (only), then Cognito /logout without any token in the URL`, async () => {
        await signIn(button);
        await waitSignedIn();
        const clientId = button === 'login-email' ? NATIVE_CLIENT : GOOGLE_CLIENT;
        await signOutAndReturn();
        assert.deepEqual(signOutCalls(), ['POST /oauth2/revoke', 'GET /logout'], 'revoke first, then /logout');
        assert.deepEqual(fake.revocations.map((r) => [r.token, r.token_type_hint, r.client_id]), [[fake.issued[0].refresh_token, 'refresh_token', clientId]]);
        assert.deepEqual(fake.logouts, [{ client_id: clientId, logout_uri: `${origin}/` }], 'no id_token_hint or other token');
        const s = await ui();
        assert.deepEqual([s.chooser, s.main, s.account], [true, false, false]);
        assertNoTokens(await persisted(), fake.issued[0]);
        assert.deepEqual(await transactionKeys(), []);
      });
    }

    it('a failed revocation still clears the session and still calls /logout', async () => {
      fake.behaviour.revoke = 'fail';
      await signIn();
      await waitSignedIn();
      await signOutAndReturn();
      assert.deepEqual(signOutCalls(), ['POST /oauth2/revoke', 'GET /logout']);
      assertNoTokens(await persisted(), fake.issued[0]);
    });

    it('while signing out nothing private is shown, no new sign-in can start, and a slow folder load is ignored', async () => {
      await signIn();
      await waitSignedIn();
      fake.behaviour.revokeDelayMs = 1500;
      listDelayMs = 600;
      storageCalls = [];
      await page.evaluate(`location.hash = '#/docs/'`);
      await waitStorageCall('list');
      await page.evaluate(`document.getElementById('sign-out').click()`);
      await sleep(900); // the folder answered; the revocation has not
      const s = await ui();
      assert.deepEqual([s.chooser, s.main, s.account, s.message], [true, false, false, 'Signing out…']);
      assert.deepEqual(s.buttons, [['Continue with Google', true], ['Email + password', true]]);
      assertNothingPrivate(await privateState());
      await page.waitFor(`location.href === ${JSON.stringify(`${origin}/`)} && document.getElementById('login-message').textContent === ''`, { timeout: 6000 });
      assert.equal(fake.logouts.length, 1);
    });
  });
});
