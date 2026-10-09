// Lifecycle tests for test/helpers/chrome.js. Fake Chrome executables (/bin/sh scripts, which start in
// milliseconds) simulate a startup hang, an early exit, a missing binary and a shutdown hang
// deterministically; the CDP timeout/close tests use real Chrome and are skipped without it.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_PREFIX, findChrome, launchChrome, startChromeProcess } from './helpers/chrome.js';

const QUICK = { startupTimeoutMs: 1500, shutdownTimeoutMs: 300, commandTimeoutMs: 1000, navigationTimeoutMs: 1000 };

// Chrome is spawned as a process-group leader, so "no processes remain" means the group is empty.
function groupMembers(pgid) {
  return execFileSync('ps', ['-A', '-o', 'pgid=,pid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([group]) => group === pgid)
    .map(([, pid]) => pid);
}
const isRunning = (pgid) => groupMembers(pgid).length > 0;

async function closedPort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('chrome helper lifecycle (fake Chrome executables)', () => {
  let dir;
  let profileParent;
  const fakes = {};
  const pids = [];

  // `trap '' TERM` makes the shell and its `sleep` children ignore SIGTERM, like a hung Chrome.
  // It is set before the DevTools line is printed, so "started" implies "ignores SIGTERM".
  const IGNORE_SIGTERM = `trap '' TERM`;
  const SLEEP_FOREVER = 'while :; do sleep 1; done';
  const announce = (port) => `echo 'DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fake' >&2`;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'file-manager-fake-chrome-'));
    profileParent = path.join(dir, 'profiles');
    await mkdir(profileParent);
    const scripts = {
      silent: `${IGNORE_SIGTERM}\n${SLEEP_FOREVER}`,
      'early-exit': 'exit 3',
      'hang-on-shutdown': `${IGNORE_SIGTERM}\n${announce(9)}\n${SLEEP_FOREVER}`,
      graceful: `${announce(9)}\nexec sleep 600`,
      unreachable: `${announce(await closedPort())}\nexec sleep 600`,
    };
    for (const [name, body] of Object.entries(scripts)) {
      const file = path.join(dir, name);
      await writeFile(file, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\n${body}\n`);
      await chmod(file, 0o755);
      // macOS scans a new executable on its first run, which can take seconds. Run each fake once
      // now so the timed tests below measure the helper, not the scan.
      execFileSync(file, ['--warmup']);
      fakes[name] = file;
    }
  });

  after(async () => {
    for (const pid of pids) assert.equal(isRunning(pid), false, `fake Chrome ${pid} still running`);
    assert.deepEqual(await readdir(profileParent), [], 'no profiles left behind');
    await rm(dir, { recursive: true, force: true });
  });

  async function assertCleanedUp(pid, userDataDir) {
    assert.ok(pid > 0, 'a process was started');
    pids.push(pid);
    assert.equal(isRunning(pid), false, 'process is gone');
    assert.equal(existsSync(userDataDir), false, 'profile is removed');
    assert.ok(path.basename(userDataDir).startsWith(PROFILE_PREFIX));
  }

  it('startup timeout: kills a silent Chrome that ignores SIGTERM and removes its profile', async () => {
    const exe = fakes.silent;
    const started = Date.now();
    const err = await startChromeProcess(exe, { ...QUICK, startupTimeoutMs: 300, profileParent }).catch((e) => e);
    assert.match(err.message, /did not start within 300ms/);
    assert.ok(Date.now() - started >= 300 + 300, 'waited for SIGTERM grace before SIGKILL');
    await assertCleanedUp(err.chromePid, err.userDataDir);
  });

  it('early exit: reports the exit code and removes the profile', async () => {
    const exe = fakes['early-exit'];
    const err = await startChromeProcess(exe, { ...QUICK, profileParent }).catch((e) => e);
    assert.match(err.message, /exited early \(code 3\)/);
    await assertCleanedUp(err.chromePid, err.userDataDir);
  });

  it('missing executable: fails cleanly and removes the profile', async () => {
    const err = await startChromeProcess(path.join(dir, 'does-not-exist'), { ...QUICK, profileParent }).catch((e) => e);
    assert.match(err.message, /could not be started/);
    assert.equal(err.chromePid, undefined);
    assert.equal(existsSync(err.userDataDir), false);
  });

  it('shutdown hang: escalates to SIGKILL, removes the profile, and close() is idempotent', async () => {
    const exe = fakes['hang-on-shutdown'];
    const chrome = await startChromeProcess(exe, { ...QUICK, profileParent });
    assert.ok(isRunning(chrome.proc.pid));
    assert.ok(existsSync(chrome.userDataDir));

    const started = Date.now();
    const first = chrome.close();
    const second = chrome.close();
    assert.equal(first, second, 'concurrent close() calls share one shutdown');
    await first;
    assert.ok(Date.now() - started >= 300, 'SIGTERM was given its grace period first');
    assert.equal(chrome.proc.signalCode, 'SIGKILL');
    await chrome.close(); // again, after completion: no error
    await assertCleanedUp(chrome.proc.pid, chrome.userDataDir);
  });

  it('graceful shutdown: a Chrome that honours SIGTERM is not SIGKILLed', async () => {
    const exe = fakes.graceful;
    const chrome = await startChromeProcess(exe, { ...QUICK, profileParent });
    await chrome.close();
    assert.equal(chrome.proc.signalCode, 'SIGTERM');
    await assertCleanedUp(chrome.proc.pid, chrome.userDataDir);
  });

  it('failure after startup (DevTools unreachable): launchChrome cleans up the process and profile', async () => {
    const exe = fakes.unreachable;
    const before = new Set(await readdir(profileParent));
    await assert.rejects(launchChrome(exe, { ...QUICK, profileParent }));
    assert.deepEqual(new Set(await readdir(profileParent)), before);
  });
});

const chromePath = findChrome();

describe('chrome helper CDP timeouts (real Chrome)', { skip: chromePath ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  it('times out a CDP command that never answers', async () => {
    const chrome = await launchChrome(chromePath, QUICK);
    try {
      await assert.rejects(
        chrome.page.evaluate('new Promise(() => {})', { timeoutMs: 200 }),
        /Timed out after 200ms: CDP Runtime.evaluate/,
      );
    } finally {
      await chrome.close();
    }
    assert.equal(isRunning(chrome.proc.pid), false);
    assert.equal(existsSync(chrome.userDataDir), false);
  });

  it('times out a navigation to a server that never responds', async () => {
    const server = http.createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const chrome = await launchChrome(chromePath, QUICK);
    try {
      await assert.rejects(
        chrome.page.goto(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 300 }),
        /Timed out after 300ms/,
      );
    } finally {
      await chrome.close();
      server.closeAllConnections();
      server.close();
    }
    assert.equal(isRunning(chrome.proc.pid), false);
  });

  it('rejects pending commands when the connection closes (Chrome killed)', async () => {
    const chrome = await launchChrome(chromePath, QUICK);
    const pending = chrome.page.evaluate('new Promise(() => {})', { timeoutMs: 30_000 });
    process.kill(chrome.proc.pid, 'SIGKILL'); // the main process dies; its WebSocket closes
    await assert.rejects(pending, /CDP connection (closed|error)/);
    await assert.rejects(chrome.page.send('Runtime.evaluate', { expression: '1' }), /CDP connection (closed|error)/);
    await chrome.close(); // process already dead: still cleans up, no error
    await chrome.close();
    assert.equal(isRunning(chrome.proc.pid), false);
    assert.equal(existsSync(chrome.userDataDir), false);
  });
});
