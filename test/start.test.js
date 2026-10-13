// Startup logging (src/start.js) through the real entry points, run as child processes.
// server.js gets dummy S3 settings. Every child runs in isolatedEnv() (test/helpers/isolated-env.js): synthetic
// keys, no AWS config files, no instance metadata, S3 on a closed loopback port, so even a request that reaches
// storage can never contact AWS or read local AWS configuration (proved in test/isolation.test.js).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { isolatedEnv } from './helpers/isolated-env.js';

const ENTRY_POINTS = {
  'src/demo.js': {},
  'src/server.js': { S3_BUCKET: 'dummy-bucket', AWS_REGION: 'us-east-1' },
};

// Runs an entry point until it exits or prints `until`, then stops it. Returns its output.
function run(script, env, { until, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: isolatedEnv({ HOST: '127.0.0.1', ...env }),
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
      env: isolatedEnv({ HOST: '127.0.0.1', PORT: String(port), MAX_UPLOAD_MB: '0.001' }), // 1048 bytes
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

// Phase A: AUTH_MODE=cognito through the real entry points, with synthetic placeholder settings. Startup makes
// no network call (the JWKS is fetched only when a token is checked) and nothing here sends a token.
const COGNITO_ENV = {
  AUTH_MODE: 'cognito',
  COGNITO_REGION: 'ap-east-1',
  USER_POOL_ID: 'ap-east-1_Example123',
  COGNITO_DOMAIN: 'login.example.invalid',
  NATIVE_CLIENT_ID: 'nativeclientexample0000001',
  GOOGLE_CLIENT_ID: 'googleclientexample0000001',
  OWNER_SUBS: '11111111-2222-4333-8444-555555555555',
  AGENT_CLIENTS: 'agentclientexample00000001:read',
  AGENT_SCOPE_PREFIX: 'file-manager',
};

describe('AUTH_MODE=cognito reaches the running app', () => {
  for (const [script, s3Env] of Object.entries(ENTRY_POINTS)) {
    it(`${script}: login is required, public config is served, and the log says so without any identifier`, async () => {
      const port = await freePort();
      const env = { ...s3Env, ...COGNITO_ENV, PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}` };
      const child = spawn(process.execPath, [script], { env: isolatedEnv({ HOST: '127.0.0.1', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${script} did not start: ${stdout}${stderr}`)), 10_000);
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (/listening/.test(stdout)) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        const url = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(`${url}/api/health`)).status, 200);
        const me = await fetch(`${url}/api/me`);
        assert.equal(me.status, 401);
        assert.equal((await me.json()).error.code, 'AUTH_REQUIRED');
        // A storage route too: refused before storage (and, isolated, storage could only reach a closed loopback port).
        assert.equal((await fetch(`${url}/api/list`)).status, 401);
        const config = await (await fetch(`${url}/api/auth/config`)).json();
        assert.equal(config.endpoints.authorization, 'https://login.example.invalid/oauth2/authorize');
        assert.equal(config.redirectUri, `${url}/`);
        assert.match(stdout, /Login required \(AUTH_MODE=cognito\)/);
        for (const value of [COGNITO_ENV.OWNER_SUBS, COGNITO_ENV.AGENT_CLIENTS, COGNITO_ENV.NATIVE_CLIENT_ID, COGNITO_ENV.USER_POOL_ID]) {
          assert.equal(`${stdout}${stderr}`.includes(value), false, 'no identifiers in the log');
        }
        assert.doesNotMatch(stdout, /NO login/);
      } finally {
        child.kill('SIGTERM');
      }
    });

    it(`${script}: an incomplete login configuration exits 1 with one clear line`, async () => {
      const result = await run(script, { ...s3Env, ...COGNITO_ENV, PORT: '3999' });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, 'Configuration error: PUBLIC_ORIGIN is required when AUTH_MODE=cognito (see README, "Login").\n');
    });

    it(`${script}: PUBLIC_ORIGIN without AUTH_MODE refuses to start without login`, async () => {
      const result = await run(script, { ...s3Env, PUBLIC_ORIGIN: 'http://127.0.0.1:3999', PORT: '3999' });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^Configuration error: PUBLIC_ORIGIN is set but AUTH_MODE is not/);
      assert.doesNotMatch(result.stdout, /listening/);
    });
  }
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
