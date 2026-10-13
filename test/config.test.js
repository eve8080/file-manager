import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { isolatedEnv } from './helpers/isolated-env.js';

const VALID = { S3_BUCKET: 'my-bucket', AWS_REGION: 'ap-east-1' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    assert.deepEqual(loadConfig(VALID), {
      bucket: 'my-bucket',
      region: 'ap-east-1',
      host: '127.0.0.1',
      port: 3000,
      maxUploadMb: 100,
      auth: { mode: 'none' },
    });
  });

  it('requires S3_BUCKET and AWS_REGION', () => {
    assert.throws(() => loadConfig({ AWS_REGION: 'x' }), /S3_BUCKET is required/);
    assert.throws(() => loadConfig({ S3_BUCKET: '  ' , AWS_REGION: 'x' }), /S3_BUCKET is required/);
    assert.throws(() => loadConfig({ S3_BUCKET: 'b' }), /AWS_REGION is required/);
  });

  it('does not require S3 settings for the demo', () => {
    assert.equal(loadConfig({}, { requireS3: false }).port, 3000);
  });

  it('validates PORT and MAX_UPLOAD_MB', () => {
    assert.throws(() => loadConfig({ ...VALID, PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ ...VALID, PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ ...VALID, MAX_UPLOAD_MB: '0' }), /MAX_UPLOAD_MB/);
    assert.equal(loadConfig({ ...VALID, PORT: '8080', HOST: '0.0.0.0' }).port, 8080);
  });
});

// Phase A login (AUTH_MODE=cognito). Every value is a synthetic placeholder, never a real pool or client.
const OWNER_SUB = '11111111-2222-4333-8444-555555555555';
const COGNITO = {
  AUTH_MODE: 'cognito',
  COGNITO_REGION: 'ap-east-1',
  USER_POOL_ID: 'ap-east-1_Example123',
  COGNITO_DOMAIN: 'login.example.invalid',
  NATIVE_CLIENT_ID: 'nativeclientexample0000001',
  GOOGLE_CLIENT_ID: 'googleclientexample0000001',
  OWNER_SUBS: OWNER_SUB,
  AGENT_CLIENTS: 'agentclientexample00000001:read+write,agentclientexample00000002:read',
  AGENT_SCOPE_PREFIX: 'file-manager',
  PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
};

describe('loadConfig: authentication (AUTH_MODE)', () => {
  it('unset keeps the local v1 mode (no login), including opt-in LAN', () => {
    assert.deepEqual(loadConfig(VALID).auth, { mode: 'none' });
    assert.deepEqual(loadConfig({ ...VALID, HOST: '0.0.0.0' }).auth, { mode: 'none' });
  });

  it('cognito: reads the complete configuration', () => {
    const config = loadConfig({ ...VALID, ...COGNITO });
    assert.deepEqual(config.auth, {
      mode: 'cognito',
      region: 'ap-east-1',
      userPoolId: 'ap-east-1_Example123',
      domain: 'login.example.invalid',
      nativeClientId: 'nativeclientexample0000001',
      googleClientId: 'googleclientexample0000001',
      ownerSubs: [OWNER_SUB],
      agentClients: [
        { clientId: 'agentclientexample00000001', scopes: ['read', 'write'] },
        { clientId: 'agentclientexample00000002', scopes: ['read'] },
      ],
      agentScopePrefix: 'file-manager',
      publicOrigin: 'http://127.0.0.1:3000',
    });
    // Several owner subs; localhost and a non-default port.
    const two = loadConfig({
      ...VALID,
      ...COGNITO,
      OWNER_SUBS: `${OWNER_SUB},aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      PUBLIC_ORIGIN: 'http://localhost:3001',
      PORT: '3001',
    });
    assert.deepEqual(two.auth.ownerSubs, [OWNER_SUB, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    assert.equal(two.auth.publicOrigin, 'http://localhost:3001');
    // The demo needs no S3 settings in either mode.
    assert.equal(loadConfig(COGNITO, { requireS3: false }).auth.mode, 'cognito');
  });

  it('cognito: every setting is required', () => {
    for (const name of Object.keys(COGNITO).filter((n) => n !== 'AUTH_MODE')) {
      const env = { ...VALID, ...COGNITO };
      delete env[name];
      assert.throws(() => loadConfig(env), new RegExp(`^Error: ${name} is required when AUTH_MODE=cognito`), name);
      assert.throws(() => loadConfig({ ...env, [name]: '   ' }), new RegExp(`${name} is required`), `${name} blank`);
    }
  });

  it('AUTH_MODE accepts only "cognito" (an empty or unknown value is refused, never treated as "no login")', () => {
    for (const value of ['', ' ', 'none', 'off', 'Cognito', 'cognito ', 'true']) {
      assert.throws(() => loadConfig({ ...VALID, AUTH_MODE: value }), /^Error: AUTH_MODE must be unset or "cognito"/, JSON.stringify(value));
    }
  });

  it('login settings or a cloud runtime without AUTH_MODE=cognito refuse to start (never silently unauthenticated)', () => {
    for (const name of Object.keys(COGNITO).filter((n) => n !== 'AUTH_MODE')) {
      assert.throws(() => loadConfig({ ...VALID, [name]: COGNITO[name] }), /^Error: .* AUTH_MODE=cognito/, name);
    }
    for (const marker of ['AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'LAMBDA_TASK_ROOT', 'AWS_LAMBDA_RUNTIME_API']) {
      assert.throws(() => loadConfig({ ...VALID, [marker]: 'x' }), /^Error: .*has NO login.*AUTH_MODE=cognito/, marker);
    }
  });

  it('cognito: binds to loopback only (Phase A; internet hosting is not approved)', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
      assert.throws(() => loadConfig({ ...VALID, ...COGNITO, HOST: host }), /^Error: AUTH_MODE=cognito runs on loopback only/, host);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(loadConfig({ ...VALID, ...COGNITO, HOST: host }).host, host);
    }
  });

  const rejects = (name, values, pattern) => {
    for (const value of values) {
      assert.throws(() => loadConfig({ ...VALID, ...COGNITO, [name]: value }), pattern, `${name}=${JSON.stringify(value)}`);
    }
  };

  it('cognito: rejects malformed region, user pool and domain', () => {
    rejects('COGNITO_REGION', ['ap_east_1', 'AP-EAST-1', 'eu-west-1'], /^Error: (COGNITO_REGION|USER_POOL_ID)/);
    rejects('USER_POOL_ID', ['ap-east-1', 'ap-east-1_', 'eu-west-1_Example123', 'ap-east-1_Ex ample', 'ap-east-1_Ex/../x'], /^Error: USER_POOL_ID/);
    rejects(
      'COGNITO_DOMAIN',
      [
        'https://login.example.invalid',
        'login.example.invalid/',
        'login.example.invalid:443',
        'localhost',
        '127.0.0.1',
        '[::1]',
        'user@login.example.invalid',
        'login..example.invalid',
        'Login.Example.invalid',
        'nodot',
      ],
      /^Error: COGNITO_DOMAIN must be a host name/,
    );
  });

  it('cognito: client IDs must be well-formed, and owner and agent clients must be distinct', () => {
    rejects('NATIVE_CLIENT_ID', ['has space', 'a/b', 'x'.repeat(129)], /^Error: NATIVE_CLIENT_ID/);
    rejects('GOOGLE_CLIENT_ID', ['nativeclientexample0000001'], /^Error: GOOGLE_CLIENT_ID must differ from NATIVE_CLIENT_ID/);
    rejects(
      'AGENT_CLIENTS',
      ['nativeclientexample0000001:read', 'agentclientexample00000001:read,googleclientexample0000001:write'],
      /^Error: AGENT_CLIENTS must not contain the owner login clients/,
    );
  });

  it('cognito: OWNER_SUBS must be distinct UUIDs (an email address is never an identity)', () => {
    rejects(
      'OWNER_SUBS',
      ['owner@example.invalid', `${OWNER_SUB},`, `,${OWNER_SUB}`, `${OWNER_SUB},,${OWNER_SUB}`, 'not-a-uuid', `${OWNER_SUB} ,x`],
      /^Error: OWNER_SUBS must be a comma-separated list of Cognito user sub values/,
    );
    rejects('OWNER_SUBS', [`${OWNER_SUB},${OWNER_SUB}`], /^Error: OWNER_SUBS contains a duplicate/);
  });

  it('cognito: AGENT_CLIENTS entries are clientId:scope+scope with read/write/delete, no duplicates', () => {
    rejects(
      'AGENT_CLIENTS',
      [
        'agentclientexample00000001',
        'agentclientexample00000001:',
        'agentclientexample00000001:admin',
        'agentclientexample00000001:read+',
        'agentclientexample00000001:read,',
        ':read',
        'agentclientexample00000001:read;agentclientexample00000002:read',
        'agentclientexample00000001:READ',
      ],
      /^Error: AGENT_CLIENTS must be a comma-separated list of clientId:scope\+scope/,
    );
    rejects('AGENT_CLIENTS', ['agentclientexample00000001:read+read'], /^Error: AGENT_CLIENTS repeats a scope/);
    rejects('AGENT_CLIENTS', ['agentclientexample00000001:read,agentclientexample00000001:write'], /^Error: AGENT_CLIENTS contains a duplicate client/);
  });

  it('cognito: AGENT_SCOPE_PREFIX is a resource-server identifier without spaces or a trailing slash', () => {
    rejects('AGENT_SCOPE_PREFIX', ['file manager', 'file-manager/', 'a\tb'], /^Error: AGENT_SCOPE_PREFIX/);
    assert.equal(loadConfig({ ...VALID, ...COGNITO, AGENT_SCOPE_PREFIX: 'https://files.example.invalid' }).auth.agentScopePrefix, 'https://files.example.invalid');
  });

  it('cognito: PUBLIC_ORIGIN is the exact loopback origin the app is served on', () => {
    rejects(
      'PUBLIC_ORIGIN',
      [
        'http://127.0.0.1:3000/',
        'http://127.0.0.1:3000/app',
        'http://127.0.0.1:3000?x=1',
        'http://127.0.0.1:3000#x',
        'http://user@127.0.0.1:3000',
        '127.0.0.1:3000',
        'HTTP://127.0.0.1:3000',
        'javascript:alert(1)',
        '*',
      ],
      /^Error: PUBLIC_ORIGIN must be an origin/,
    );
    rejects(
      'PUBLIC_ORIGIN',
      ['https://files.example.invalid', 'http://192.168.1.20:3000', 'http://files.example.invalid:3000'],
      /^Error: PUBLIC_ORIGIN must be a loopback origin/,
    );
    rejects('PUBLIC_ORIGIN', ['http://127.0.0.1:3001', 'http://localhost'], /^Error: PUBLIC_ORIGIN must use the app's PORT/);
  });

  it('error messages never contain the configured identifiers', () => {
    const env = { ...VALID, ...COGNITO, AGENT_CLIENTS: 'agentclientexample00000001:admin' };
    assert.throws(() => loadConfig(env), (err) => !/agentclientexample|nativeclient|11111111/.test(err.message));
  });
});

describe('server startup', () => {
  it('exits with a clear message when S3_BUCKET is missing', () => {
    const result = spawnSync(process.execPath, ['src/server.js'], {
      env: isolatedEnv({ AWS_REGION: 'ap-east-1' }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuration error: S3_BUCKET is required/);
  });
});
