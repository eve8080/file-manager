// Tiny headless-Chrome driver for browser regression tests, using the Chrome DevTools Protocol over
// Node's built-in WebSocket (no extra dependencies). Chrome runs with a throwaway profile, background
// networking disabled and no host name resolution. Set CHROME_PATH to use a specific Chrome/Chromium binary.
//
// Lifecycle guarantees (tested in test/chrome-helper.test.js with fake Chrome executables):
// - startup is bounded; on timeout or early failure the process group is killed and the profile removed
// - shutdown sends SIGTERM, escalates to SIGKILL after a timeout, then removes the profile
// - close() is idempotent; a process 'exit' hook kills Chrome if the test runner exits first
// - every CDP command, navigation and connection attempt has a timeout; when the WebSocket closes or
//   errors, all pending commands are rejected
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export const PROFILE_PREFIX = 'file-manager-chrome-';

const DEFAULTS = {
  startupTimeoutMs: 20_000,
  shutdownTimeoutMs: 5_000, // per stage: SIGTERM, then SIGKILL
  commandTimeoutMs: 10_000,
  navigationTimeoutMs: 10_000,
  profileParent: os.tmpdir(),
};

export function findChrome() {
  return CANDIDATES.find((candidate) => candidate && existsSync(candidate));
}

// Resolves true if `promise` settles within `ms`, false otherwise.
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Signals Chrome's whole process group (it is spawned detached), so helper processes go too.
// macOS can answer EPERM when one group member can't be signalled at that instant (e.g. a helper
// mid-startup), so the main process is also signalled directly. Missing processes are fine.
function signalGroup(pid, signal) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch (err) {
      if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
    }
  }
}

// Starts the Chrome process and waits for its DevTools endpoint. Returns { proc, userDataDir, browserWs, close }.
export async function startChromeProcess(executable, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const userDataDir = await mkdtemp(path.join(opts.profileParent, PROFILE_PREFIX));
  const proc = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      // No host name resolves, so the browser can only reach the local test server (127.0.0.1), never
      // the network (e.g. a presigned S3 URL that a test forgot to intercept).
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );

  const hasExited = () => proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null;
  const exited = new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.once('error', resolve); // e.g. ENOENT: the process never started
  });

  // Safety net: if the test runner exits without calling close(), still kill Chrome and its profile.
  const onRunnerExit = () => {
    if (proc.pid !== undefined) signalGroup(proc.pid, 'SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  };
  process.once('exit', onRunnerExit);

  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (proc.pid !== undefined) {
          if (!hasExited()) {
            signalGroup(proc.pid, 'SIGTERM');
            if (!(await settlesWithin(exited, opts.shutdownTimeoutMs))) {
              signalGroup(proc.pid, 'SIGKILL');
              if (!(await settlesWithin(exited, opts.shutdownTimeoutMs))) {
                throw new Error(`Chrome (pid ${proc.pid}) did not exit after SIGKILL`);
              }
            }
          }
          signalGroup(proc.pid, 'SIGKILL'); // sweep any helper processes left in the group
        }
      } finally {
        proc.stderr?.destroy();
        process.removeListener('exit', onRunnerExit);
        await rm(userDataDir, { recursive: true, force: true });
      }
    })());

  try {
    const browserWs = await new Promise((resolve, reject) => {
      let output = '';
      const cleanup = () => {
        clearTimeout(timer);
        proc.stderr.removeListener('data', onData);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
      };
      const onData = (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`Chrome exited early (code ${code}${signal ? `, signal ${signal}` : ''})`));
      };
      const onError = (err) => {
        cleanup();
        reject(new Error(`Chrome could not be started: ${err.message}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Chrome did not start within ${opts.startupTimeoutMs}ms`));
      }, opts.startupTimeoutMs);
      proc.stderr.on('data', onData);
      proc.once('exit', onExit);
      proc.once('error', onError);
    });
    return { proc, userDataDir, browserWs, close };
  } catch (err) {
    await close();
    Object.assign(err, { chromePid: proc.pid, userDataDir }); // lets tests verify the cleanup
    throw err;
  }
}

// Starts Chrome and connects to its first page. Returns { page, proc, userDataDir, close }.
export async function launchChrome(executable, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const chrome = await startChromeProcess(executable, opts);
  let page;
  try {
    const { host } = new URL(chrome.browserWs);
    const res = await fetch(`http://${host}/json/list`, { signal: AbortSignal.timeout(opts.commandTimeoutMs) });
    const pageTarget = (await res.json()).find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('Chrome has no page target');
    page = await Page.connect(pageTarget.webSocketDebuggerUrl, opts);
  } catch (err) {
    await chrome.close();
    throw err;
  }

  let closing;
  return {
    page,
    proc: chrome.proc,
    userDataDir: chrome.userDataDir,
    close: () =>
      (closing ??= (async () => {
        page.close();
        await chrome.close();
      })()),
  };
}

class Page {
  static async connect(url, opts) {
    const ws = new WebSocket(url);
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', () => reject(new Error('Could not connect to Chrome')), { once: true });
        }),
        opts.commandTimeoutMs,
        'connecting to Chrome',
      );
    } catch (err) {
      ws.close();
      throw err;
    }
    const page = new Page(ws, opts);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  constructor(ws, opts) {
    this.ws = ws;
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.listeners = new Set();
    this.closedReason = null;
    this.errors = []; // uncaught page exceptions
    // Answers alert()/confirm()/prompt(). Tests replace this: ({ type, message }) => ({ accept, promptText })
    this.onDialog = () => ({ accept: true });

    ws.addEventListener('message', ({ data }) => this.#onMessage(JSON.parse(data)));
    ws.addEventListener('close', () => this.#failAll('CDP connection closed'));
    ws.addEventListener('error', () => this.#failAll('CDP connection error'));
  }

  #onMessage(msg) {
    if (msg.id) {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // already timed out
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      this.send('Page.handleJavaScriptDialog', this.onDialog(msg.params)).catch(() => {});
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
    for (const listener of this.listeners) listener(msg);
  }

  #failAll(reason) {
    this.closedReason ??= reason;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(this.closedReason));
      this.pending.delete(id);
    }
  }

  send(method, params = {}, { timeoutMs = this.opts.commandTimeoutMs } = {}) {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms: CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  waitForEvent(method, timeoutMs) {
    let listener;
    const event = new Promise((resolve) => {
      listener = (msg) => {
        if (msg.method === method) resolve(msg.params);
      };
      this.listeners.add(listener);
    });
    return withTimeout(event, timeoutMs, `event ${method}`).finally(() => this.listeners.delete(listener));
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  }

  async goto(url, { timeoutMs = this.opts.navigationTimeoutMs } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    loaded.catch(() => {}); // observed below; avoid an unhandled rejection if navigate fails first
    await this.send('Page.navigate', { url }, { timeoutMs });
    await loaded;
  }

  // Evaluates an expression (or async IIFE) in the page and returns its JSON value.
  async evaluate(expression, options) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, options);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 5000, message = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for: ${message}`);
  }

  close() {
    this.#failAll('CDP connection closed');
    this.ws.close();
  }
}
