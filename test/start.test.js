// Startup logging (src/start.js) through the real entry points, run as child processes.
// server.js gets dummy S3 settings; starting it makes no AWS call (the SDK only connects on a request).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ENTRY_POINTS = {
  'src/demo.js': {},
  'src/server.js': { S3_BUCKET: 'dummy-bucket', AWS_REGION: 'us-east-1' },
};

// Runs an entry point until it exits or prints `until`, then stops it. Returns its output.
function run(script, env, { until, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} neither exited nor printed ${until} within ${timeoutMs}ms\n${stdout}${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (until && until.test(stdout)) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// M2: MAX_UPLOAD_MB from the environment must reach the running app (both entry points go through start()).
describe('MAX_UPLOAD_MB reaches the running app (src/demo.js)', () => {
  let child;
  let url;
  before(async () => {
    const port = await freePort();
    child = spawn(process.execPath, ['src/demo.js'], {
      env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), MAX_UPLOAD_MB: '0.001' }, // 1048 bytes
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('demo did not start')), 10_000);
      child.stdout.on('data', (chunk) => {
        if (/listening/.test(chunk)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    url = `http://127.0.0.1:${port}`;
  });
  after(() => child?.kill('SIGTERM'));

  const upload = (name, size) => {
    const form = new FormData();
    form.append('files', new Blob([Buffer.alloc(size)]), name);
    return fetch(`${url}/api/files?prefix=`, { method: 'POST', body: form });
  };

  it('a file over the configured limit is 413; one under it is stored', async () => {
    const over = await upload('over.bin', 2000);
    assert.equal(over.status, 413);
    assert.equal((await over.json()).error.details.files[0].error.message, 'File is larger than the upload limit (1048 bytes).');
    assert.equal((await upload('under.bin', 1000)).status, 201);
  });
});

describe('server startup logging', () => {
  let blocker;
  let busyPort;

  before(async () => {
    blocker = net.createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => blocker.once('listening', resolve));
    busyPort = blocker.address().port;
  });

  after(() => blocker.close());

  for (const [script, env] of Object.entries(ENTRY_POINTS)) {
    it(`${script}: a port already in use exits 1 with one clear error and no "listening" message`, async () => {
      const result = await run(script, { ...env, PORT: String(busyPort) });
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /listening/i);
      const errorLines = result.stderr.trim().split('\n');
      assert.equal(errorLines.length, 1, `exactly one error line, got:\n${result.stderr}`);
      assert.match(
        errorLines[0],
        new RegExp(`^Could not start server: 127\\.0\\.0\\.1:${busyPort} is already in use \\(EADDRINUSE\\)\\. Set PORT to a free port\\.$`),
      );
    });

    it(`${script}: logs "listening" once the port is actually bound`, async () => {
      const port = await freePort();
      const result = await run(script, { ...env, PORT: String(port) }, { until: /listening/ });
      assert.match(result.stdout, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}\\n`));
      assert.equal(result.stderr, '');
    });
  }
});
