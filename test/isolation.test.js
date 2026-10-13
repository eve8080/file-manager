// Child processes that run the real entry points (src/server.js with the AWS SDK) must never be able to reach AWS
// or read local AWS configuration, even if a route unexpectedly reaches storage or the build is broken. Every such
// child gets isolatedEnv() (test/helpers/isolated-env.js): built from scratch (nothing inherited but PATH), synthetic
// static keys (so the SDK never consults profiles, credential files, SSO or instance metadata), config/credential
// files pointed at /dev/null, IMDS disabled, one attempt, and S3 sent to a loopback endpoint.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { CLOSED_S3_ENDPOINT, SYNTHETIC_ACCESS_KEY_ID, assertIsolatedEnv, isolatedEnv } from './helpers/isolated-env.js';

// The safety rule, stated independently of the helper. Checked before anything is spawned here.
const REQUIRED = {
  AWS_ACCESS_KEY_ID: /^AKIDTESTONLY[A-Z]*$/,
  AWS_SECRET_ACCESS_KEY: /^test-only-/,
  AWS_EC2_METADATA_DISABLED: /^true$/,
  AWS_CONFIG_FILE: /^\/dev\/null$/,
  AWS_SHARED_CREDENTIALS_FILE: /^\/dev\/null$/,
  AWS_ENDPOINT_URL_S3: /^http:\/\/127\.0\.0\.1:\d+$/,
  AWS_MAX_ATTEMPTS: /^1$/,
};
const FORBIDDEN = /^(AWS_PROFILE|AWS_DEFAULT_PROFILE|AWS_SESSION_TOKEN|AWS_ROLE_ARN|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_CONTAINER_.*|AWS_SSO_.*|AWS_IGNORE_CONFIGURED_ENDPOINT_URLS|AWS_ENDPOINT_URL|AWS_EC2_METADATA_SERVICE_ENDPOINT.*|HTTPS?_PROXY|NODE_USE_ENV_PROXY|NODE_OPTIONS)$/i;

function mustBeSafe(env) {
  for (const [name, pattern] of Object.entries(REQUIRED)) assert.match(env[name] ?? '', pattern, `${name} isolates the SDK`);
  for (const name of Object.keys(env)) assert.doesNotMatch(name, FORBIDDEN, `${name} must not reach a child`);
}

describe('test isolation for real entry points', () => {
  it('isolatedEnv: built from scratch with synthetic AWS settings; nothing from the parent leaks', () => {
    const planted = ['AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'HTTPS_PROXY', 'S3_BUCKET'];
    for (const name of planted) process.env[name] = 'planted-by-test';
    try {
      const env = isolatedEnv({ HOST: '127.0.0.1' });
      mustBeSafe(env);
      assert.equal(env.AWS_ENDPOINT_URL_S3, CLOSED_S3_ENDPOINT);
      assert.equal(env.AWS_ACCESS_KEY_ID, SYNTHETIC_ACCESS_KEY_ID);
      assert.deepEqual(
        Object.keys(env).sort(),
        ['AWS_ACCESS_KEY_ID', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_ENDPOINT_URL_S3', 'AWS_MAX_ATTEMPTS',
          'AWS_SECRET_ACCESS_KEY', 'AWS_SHARED_CREDENTIALS_FILE', 'HOST', 'PATH'],
      );
      for (const name of planted) assert.equal(env[name], undefined, name);
    } finally {
      for (const name of planted) delete process.env[name];
    }
  });

  it('isolatedEnv refuses extras that would undo the isolation', () => {
    for (const extra of [
      { AWS_PROFILE: 'x' },
      { AWS_ACCESS_KEY_ID: 'override-of-the-synthetic-key' }, // any override is refused by name; not key-shaped
      { AWS_ENDPOINT_URL_S3: 'https://s3.amazonaws.com' },
      { AWS_ENDPOINT_URL_S3: 'http://example.invalid:9' },
      { AWS_CONFIG_FILE: '/Users/someone/.aws/config' },
      { AWS_EC2_METADATA_DISABLED: 'false' },
      { HTTPS_PROXY: 'http://127.0.0.1:1' },
    ]) {
      assert.throws(() => isolatedEnv(extra), /isolated/, JSON.stringify(extra));
    }
    assert.throws(() => assertIsolatedEnv({ PATH: '/bin' }), /isolated/);
  });

  it('every test that spawns an entry point builds its environment with isolatedEnv()', () => {
    const dir = new URL('.', import.meta.url);
    const offenders = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      if (!/src\/(server|demo)\.js/.test(source) || !/\bspawn(Sync)?\(/.test(source)) continue;
      // Each spawn call's options must take env from isolatedEnv(...) (directly or via a variable built by it).
      for (const match of source.matchAll(/\bspawn(?:Sync)?\(([^;]*?)\)\s*;/gs)) {
        const call = match[1];
        if (!/env(\s*:\s*isolatedEnv\(|\s*[,}])/.test(call)) offenders.push(`${file}: ${call.slice(0, 80)}`);
      }
      if (/env:\s*\{\s*PATH/.test(source) || !/import \{[^}]*isolatedEnv[^}]*\} from '\.\/helpers\/isolated-env\.js'/.test(source)) {
        offenders.push(`${file}: builds a child env without isolatedEnv`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  // In-process S3 tests use a real S3Client only to presign (TEST_SIGNER). Presigning resolves endpoint and client
  // settings, which the SDK may read from the shared AWS config/credential files named by the inherited environment.
  // Importing the fake-S3 helper must therefore cut that off for the whole test process.
  it('in-process presigning (TEST_SIGNER) never reads the AWS config files named by the inherited environment', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fm-planted-aws-config-'));
    const planted = path.join(dir, 'config');
    // A synthetic file in a fresh temp dir (never ~/.aws): if it were read, presigned URLs would point at this host.
    writeFileSync(planted, '[default]\nendpoint_url = http://planted-config.invalid\n');
    const names = ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    Object.assign(process.env, { AWS_CONFIG_FILE: planted, AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' });
    for (const n of ['AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3']) delete process.env[n];
    try {
      const { FakeS3Client, TEST_SIGNER } = await import('./helpers/fake-s3-client.js');
      const { createS3Storage } = await import('../src/storage/s3.js');
      const storage = createS3Storage({ bucket: 'isolation-bucket', client: new FakeS3Client({ 'a.txt': 'A' }), signingClient: TEST_SIGNER });
      const { url } = await storage.getDownload('a.txt');
      assert.match(url, /^https:\/\/isolation-bucket\.s3\.us-east-1\.amazonaws\.com\/a\.txt\?/, 'the planted config file was not used');
      assert.equal(process.env.AWS_CONFIG_FILE, '/dev/null');
      assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
      assert.equal(process.env.AWS_EC2_METADATA_DISABLED, 'true');
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('src/server.js reaching storage (no login) talks only to loopback, with the synthetic key', () => {
    let trap;
    let seen;
    before(async () => {
      seen = [];
      trap = http.createServer((req, res) => {
        seen.push({ host: req.headers.host, authorization: req.headers.authorization ?? '', url: req.url });
        res.writeHead(500, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>InternalError</Code></Error>');
      });
      trap.listen(0, '127.0.0.1');
      await new Promise((resolve) => trap.once('listening', resolve));
    });
    after(() => trap.close());

    async function serverChild(env) {
      mustBeSafe(env); // before anything is spawned
      assertIsolatedEnv(env);
      const child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server.js did not start')), 10_000);
        child.stdout.on('data', (chunk) => {
          if (/listening/.test(chunk)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return child;
    }

    async function freePort() {
      const probe = net.createServer().listen(0, '127.0.0.1');
      await new Promise((resolve) => probe.once('listening', resolve));
      const { port } = probe.address();
      await new Promise((resolve) => probe.close(resolve));
      return port;
    }

    it('a storage request goes to the loopback endpoint, signed with the synthetic key (no profile, file or IMDS credentials)', async () => {
      const port = await freePort();
      const endpoint = `http://127.0.0.1:${trap.address().port}`;
      const child = await serverChild(isolatedEnv({ S3_BUCKET: 'isolated-test-bucket', AWS_REGION: 'us-east-1', HOST: '127.0.0.1', PORT: String(port), AWS_ENDPOINT_URL_S3: endpoint }));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/list`);
        assert.equal(res.status, 502);
        assert.ok(seen.length >= 1, 'the S3 request reached the loopback trap');
        for (const request of seen) {
          assert.equal(request.host, `127.0.0.1:${trap.address().port}`);
          assert.match(request.authorization, new RegExp(`Credential=${SYNTHETIC_ACCESS_KEY_ID}/`));
        }
      } finally {
        child.kill('SIGTERM');
      }
    });

    it('with the default closed endpoint a storage request fails fast as a network error', async () => {
      const port = await freePort();
      const child = await serverChild(isolatedEnv({ S3_BUCKET: 'isolated-test-bucket', AWS_REGION: 'us-east-1', HOST: '127.0.0.1', PORT: String(port) }));
      try {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/api/list`);
        assert.equal(res.status, 502);
        assert.deepEqual((await res.json()).error.details, { reason: 'NETWORK' });
        assert.ok(Date.now() - started < 5000, 'no retries against a real service');
      } finally {
        child.kill('SIGTERM');
      }
    });
  });
});
