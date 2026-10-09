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
