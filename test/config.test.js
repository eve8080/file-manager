import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

const VALID = { S3_BUCKET: 'my-bucket', AWS_REGION: 'ap-east-1' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    assert.deepEqual(loadConfig(VALID), {
      bucket: 'my-bucket',
      region: 'ap-east-1',
      host: '127.0.0.1',
      port: 3000,
      maxUploadMb: 100,
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

describe('server startup', () => {
  it('exits with a clear message when S3_BUCKET is missing', () => {
    const env = { PATH: process.env.PATH, AWS_REGION: 'ap-east-1' };
    const result = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuration error: S3_BUCKET is required/);
  });
});
