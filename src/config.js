// Reads configuration from environment variables (.env is loaded by `node --env-file-if-exists`).
// AWS credentials are NOT read here: the AWS SDK finds them itself (AWS_PROFILE, ~/.aws, env).
export function loadConfig(env, { requireS3 = true } = {}) {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.AWS_REGION?.trim();
  if (requireS3 && !bucket) throw new Error('S3_BUCKET is required. Set it in .env (see .env.example).');
  if (requireS3 && !region) throw new Error('AWS_REGION is required. Set it in .env (see .env.example).');

  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}".`);
  }

  const maxUploadMb = Number(env.MAX_UPLOAD_MB?.trim() || 100);
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) {
    throw new Error(`MAX_UPLOAD_MB must be a positive number, got "${env.MAX_UPLOAD_MB}".`);
  }

  const host = env.HOST?.trim() || '127.0.0.1';
  return {
    bucket,
    region,
    host,
    port,
    maxUploadMb,
    auth: loadAuthConfig(env, { host, port }),
  };
}

// ---- Login (AUTH_MODE=cognito, Phase A) ----
// Unset AUTH_MODE keeps the local v1 app without login (D1/D2). Anything that suggests a hosted or login
// setup without AUTH_MODE=cognito refuses to start, so the app never silently runs unauthenticated there.
// Messages are fixed: they never repeat a configured value.

export const AUTH_SETTINGS = [
  'COGNITO_REGION',
  'USER_POOL_ID',
  'COGNITO_DOMAIN',
  'NATIVE_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
  'OWNER_SUBS',
  'AGENT_CLIENTS',
  'AGENT_SCOPE_PREFIX',
  'PUBLIC_ORIGIN',
];
const CLOUD_MARKERS = ['AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'LAMBDA_TASK_ROOT', 'AWS_LAMBDA_RUNTIME_API'];
export const AGENT_SCOPES = ['read', 'write', 'delete'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const CLIENT_ID = /^[A-Za-z0-9]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const AGENT_ENTRY = /^([A-Za-z0-9]{1,128}):((?:read|write|delete)(?:\+(?:read|write|delete))*)$/;

function loadAuthConfig(env, { host, port }) {
  if (env.AUTH_MODE === undefined) {
    const stray = AUTH_SETTINGS.find((name) => env[name] !== undefined);
    if (stray) throw new Error(`${stray} is set but AUTH_MODE is not: login settings require AUTH_MODE=cognito.`);
    const cloud = CLOUD_MARKERS.find((name) => env[name] !== undefined);
    if (cloud) {
      throw new Error(`This looks like a cloud runtime (${cloud}), and the app without AUTH_MODE has NO login: set AUTH_MODE=cognito.`);
    }
    return { mode: 'none' };
  }
  if (env.AUTH_MODE !== 'cognito') throw new Error('AUTH_MODE must be unset or "cognito".');

  const value = {};
  for (const name of AUTH_SETTINGS) {
    value[name] = env[name]?.trim();
    if (!value[name]) throw new Error(`${name} is required when AUTH_MODE=cognito (see README, "Login").`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('AUTH_MODE=cognito runs on loopback only (HOST 127.0.0.1, localhost or ::1) until hosting is approved.');
  }

  if (!REGION.test(value.COGNITO_REGION)) throw new Error('COGNITO_REGION must be an AWS region such as ap-east-1.');
  const pool = /^([a-z0-9-]+)_([A-Za-z0-9]+)$/.exec(value.USER_POOL_ID);
  if (!pool) throw new Error('USER_POOL_ID must look like <region>_<id>.');
  if (pool[1] !== value.COGNITO_REGION) throw new Error('USER_POOL_ID must belong to COGNITO_REGION.');

  const domain = value.COGNITO_DOMAIN;
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels.at(-1))) {
    throw new Error('COGNITO_DOMAIN must be a host name only (lowercase, no https://, port or path), e.g. login.example.com.');
  }

  if (!CLIENT_ID.test(value.NATIVE_CLIENT_ID)) throw new Error('NATIVE_CLIENT_ID must be a Cognito app client ID (letters and digits).');
  if (!CLIENT_ID.test(value.GOOGLE_CLIENT_ID)) throw new Error('GOOGLE_CLIENT_ID must be a Cognito app client ID (letters and digits).');
  if (value.GOOGLE_CLIENT_ID === value.NATIVE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID must differ from NATIVE_CLIENT_ID.');

  const ownerSubs = value.OWNER_SUBS.split(',');
  if (!ownerSubs.every((sub) => UUID.test(sub))) {
    throw new Error('OWNER_SUBS must be a comma-separated list of Cognito user sub values (UUIDs), never email addresses.');
  }
  if (new Set(ownerSubs).size !== ownerSubs.length) throw new Error('OWNER_SUBS contains a duplicate.');

  const agentClients = value.AGENT_CLIENTS.split(',').map((entry) => {
    const match = AGENT_ENTRY.exec(entry);
    if (!match) {
      throw new Error('AGENT_CLIENTS must be a comma-separated list of clientId:scope+scope (scopes: read, write, delete).');
    }
    const scopes = match[2].split('+');
    if (new Set(scopes).size !== scopes.length) throw new Error('AGENT_CLIENTS repeats a scope for one client.');
    return { clientId: match[1], scopes };
  });
  const agentIds = agentClients.map((a) => a.clientId);
  if (new Set(agentIds).size !== agentIds.length) throw new Error('AGENT_CLIENTS contains a duplicate client.');
  if (agentIds.some((id) => id === value.NATIVE_CLIENT_ID || id === value.GOOGLE_CLIENT_ID)) {
    throw new Error('AGENT_CLIENTS must not contain the owner login clients (NATIVE_CLIENT_ID, GOOGLE_CLIENT_ID).');
  }

  if (!/^[\x21-\x7e]{1,256}$/.test(value.AGENT_SCOPE_PREFIX) || value.AGENT_SCOPE_PREFIX.endsWith('/')) {
    throw new Error('AGENT_SCOPE_PREFIX must be the Cognito resource-server identifier (no spaces, no trailing slash).');
  }

  return {
    mode: 'cognito',
    region: value.COGNITO_REGION,
    userPoolId: value.USER_POOL_ID,
    domain,
    nativeClientId: value.NATIVE_CLIENT_ID,
    googleClientId: value.GOOGLE_CLIENT_ID,
    ownerSubs,
    agentClients,
    agentScopePrefix: value.AGENT_SCOPE_PREFIX,
    publicOrigin: parsePublicOrigin(value.PUBLIC_ORIGIN, port),
  };
}

// The exact origin the browser uses (scheme, host and port; nothing else). Phase A serves it on loopback only.
function parsePublicOrigin(origin, port) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must be an origin such as http://127.0.0.1:3000 (no path, query or trailing slash).');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PUBLIC_ORIGIN must be a loopback origin (127.0.0.1, localhost or [::1]) until hosting is approved.');
  }
  if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port) {
    throw new Error("PUBLIC_ORIGIN must use the app's PORT.");
  }
  return origin;
}
