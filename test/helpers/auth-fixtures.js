// Synthetic Cognito-shaped access tokens for the login tests (Phase A). Keys are generated per test run
// with node:crypto and never written anywhere; every pool, client, sub and email is a placeholder.
// Production code never signs anything: tokens are verified only by aws-jwt-verify (src/auth.js).
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';

export const REGION = 'ap-east-1';
export const USER_POOL_ID = 'ap-east-1_Example123';
export const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
export const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
export const NATIVE_CLIENT = 'nativeclientexample0000001';
export const GOOGLE_CLIENT = 'googleclientexample0000001';
export const OWNER_SUB = '11111111-2222-4333-8444-555555555555';
export const STRANGER_SUB = '99999999-8888-4777-8666-555555555555';
export const OWNER_EMAIL = 'owner@example.invalid';
export const SCOPE_PREFIX = 'file-manager';
export const AGENTS = {
  reader: 'agentreaderexample00000001',
  writer: 'agentwriterexample00000001',
  deleter: 'agentdeleterexample0000001',
  all: 'agentallscopesexample00001',
};

// The settings loadConfig() would produce for these placeholders (see test/config.test.js).
export function authSettings(publicOrigin) {
  return {
    mode: 'cognito',
    region: REGION,
    userPoolId: USER_POOL_ID,
    domain: 'login.example.invalid',
    nativeClientId: NATIVE_CLIENT,
    googleClientId: GOOGLE_CLIENT,
    ownerSubs: [OWNER_SUB],
    agentClients: [
      { clientId: AGENTS.reader, scopes: ['read'] },
      { clientId: AGENTS.writer, scopes: ['read', 'write'] },
      { clientId: AGENTS.deleter, scopes: ['read', 'delete'] },
      { clientId: AGENTS.all, scopes: ['read', 'write', 'delete'] },
    ],
    agentScopePrefix: SCOPE_PREFIX,
    publicOrigin,
  };
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function createSigningKey(kid = `test-${randomUUID()}`) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

// Signs `payload` (RS256) with `key`; `header` overrides header fields.
export function signJwt(key, payload, header = {}) {
  const head = b64url({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = b64url(payload);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(key.privateKey.export({ format: 'pem', type: 'pkcs8' })));
  return `${head}.${body}.${signature.toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);

// An access token as Cognito issues it after a browser login through one of the owner clients.
export function ownerClaims({ clientId = NATIVE_CLIENT, sub = OWNER_SUB, ...extra } = {}) {
  return {
    sub,
    iss: ISSUER,
    client_id: clientId,
    origin_jti: randomUUID(),
    token_use: 'access',
    scope: 'openid email profile',
    auth_time: now(),
    exp: now() + 3600,
    iat: now(),
    jti: randomUUID(),
    username: clientId === GOOGLE_CLIENT ? `google_${sub.slice(0, 8)}` : 'owner-example',
    ...extra,
  };
}

// An access token from the client-credentials grant: sub is the client ID, scopes are `<prefix>/<name>`.
export function agentClaims(clientId, scopes, extra = {}) {
  return {
    sub: clientId,
    iss: ISSUER,
    client_id: clientId,
    token_use: 'access',
    scope: scopes.map((s) => `${SCOPE_PREFIX}/${s}`).join(' '),
    auth_time: now(),
    exp: now() + 3600,
    iat: now(),
    jti: randomUUID(),
    version: 2,
    ...extra,
  };
}

// The library's own JWKS cache with an offline fetcher: it answers only the pool's real JWKS URI with the
// fixture keys and records every fetch, so a test can prove which URL the verifier would contact.
export function offlineJwksCache(keys) {
  const fetches = [];
  const jwksCache = new SimpleJwksCache({
    fetcher: {
      async fetch(uri) {
        fetches.push(uri);
        if (uri !== JWKS_URI) throw new Error(`offline test: unexpected JWKS fetch ${uri}`);
        return new TextEncoder().encode(JSON.stringify({ keys: keys.map((k) => k.jwk) })).buffer;
      },
    },
  });
  return { jwksCache, fetches };
}
