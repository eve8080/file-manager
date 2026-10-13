// The environment for every child process that runs a real entry point (src/server.js, src/demo.js). Built from
// scratch: nothing is inherited from the test runner except PATH, so AWS_PROFILE, SSO/web-identity/container
// settings, proxies and real keys can never reach the child. The AWS SDK then
// - takes the synthetic static keys from the environment (the first provider of its default chain; with them and no
//   AWS_PROFILE it never reads profiles, credential files, SSO caches or instance metadata),
// - reads its config/credential files from /dev/null and has instance metadata disabled anyway,
// - sends S3 requests to AWS_ENDPOINT_URL_S3, by default a closed loopback port, with a single attempt.
// See test/isolation.test.js, which proves a storage request from src/server.js only ever reaches loopback.
export const SYNTHETIC_ACCESS_KEY_ID = 'AKIDTESTONLYNOTREAL';
export const CLOSED_S3_ENDPOINT = 'http://127.0.0.1:1'; // port 1 on loopback: nothing listens, connections are refused

const ISOLATION = {
  AWS_ACCESS_KEY_ID: SYNTHETIC_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: 'test-only-not-a-real-secret',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_ENDPOINT_URL_S3: CLOSED_S3_ENDPOINT,
  AWS_MAX_ATTEMPTS: '1',
};
// Settings a test may add: the app's own, plus a different loopback S3 endpoint.
const APP_SETTINGS = new Set([
  'S3_BUCKET',
  'AWS_REGION',
  'HOST',
  'PORT',
  'MAX_UPLOAD_MB',
  'AUTH_MODE',
  'COGNITO_REGION',
  'USER_POOL_ID',
  'COGNITO_DOMAIN',
  'NATIVE_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
  'OWNER_SUBS',
  'AGENT_CLIENTS',
  'AGENT_SCOPE_PREFIX',
  'PUBLIC_ORIGIN',
]);

export function isolatedEnv(extra = {}) {
  const env = { PATH: process.env.PATH, ...ISOLATION };
  for (const [name, value] of Object.entries(extra)) {
    if (!APP_SETTINGS.has(name) && name !== 'AWS_ENDPOINT_URL_S3') throw new Error(`${name} is not allowed in an isolated test environment`);
    env[name] = value;
  }
  assertIsolatedEnv(env);
  return env;
}

// Throws unless `env` keeps every isolation setting, only adds app settings, and points S3 at loopback.
export function assertIsolatedEnv(env) {
  for (const [name, value] of Object.entries(ISOLATION)) {
    if (name === 'AWS_ENDPOINT_URL_S3') continue;
    if (env[name] !== value) throw new Error(`Not an isolated test environment: ${name}`);
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.AWS_ENDPOINT_URL_S3 ?? '')) {
    throw new Error('Not an isolated test environment: AWS_ENDPOINT_URL_S3 must be a loopback URL');
  }
  for (const name of Object.keys(env)) {
    if (name !== 'PATH' && !(name in ISOLATION) && !APP_SETTINGS.has(name)) throw new Error(`Not an isolated test environment: ${name}`);
  }
}
