// Access-token verification and authorization (src/auth.js, Phase A) with the real aws-jwt-verify library
// against synthetic Cognito-shaped tokens and an offline fixture JWKS. No network, no real pool.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FetchError } from 'aws-jwt-verify/error';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { createAuth } from '../src/auth.js';
import {
  AGENTS,
  GOOGLE_CLIENT,
  ISSUER,
  JWKS_URI,
  NATIVE_CLIENT,
  OWNER_EMAIL,
  OWNER_SUB,
  STRANGER_SUB,
  agentClaims,
  authSettings,
  createSigningKey,
  offlineJwksCache,
  ownerClaims,
  signJwt,
} from './helpers/auth-fixtures.js';

const ORIGIN = 'http://127.0.0.1:3000';
const key = createSigningKey();
const otherKey = createSigningKey(); // not in the JWKS

function setup() {
  const { jwksCache, fetches } = offlineJwksCache([key]);
  return { auth: createAuth(authSettings(ORIGIN), { jwksCache }), fetches };
}

// Resolves to the principal, or to { status, code } of the refusal.
async function check(auth, token) {
  try {
    return await auth.verifyToken(token);
  } catch (err) {
    return { status: err.status, code: err.code, message: err.message };
  }
}

const now = () => Math.floor(Date.now() / 1000);

describe('createAuth: verifying access tokens (aws-jwt-verify, offline JWKS)', () => {
  it('both owner login clients map to the same approved owner sub; the JWKS comes from the pool URL only', async () => {
    const { auth, fetches } = setup();
    for (const clientId of [NATIVE_CLIENT, GOOGLE_CLIENT]) {
      assert.deepEqual(await check(auth, signJwt(key, ownerClaims({ clientId }))), {
        role: 'owner',
        sub: OWNER_SUB,
        scopes: ['read', 'write', 'delete'],
      });
    }
    assert.deepEqual(fetches, [JWKS_URI], 'one JWKS fetch, from the user pool, then cached');
  });

  it('a valid token for an unapproved identity is 403 - also with the owner email, a Google login or an email_verified claim', async () => {
    const { auth } = setup();
    for (const clientId of [NATIVE_CLIENT, GOOGLE_CLIENT]) {
      const token = signJwt(key, ownerClaims({ clientId, sub: STRANGER_SUB, email: OWNER_EMAIL, email_verified: true, username: OWNER_EMAIL }));
      assert.deepEqual(await check(auth, token), {
        status: 403,
        code: 'NOT_AUTHORIZED',
        message: 'This account is not allowed to use this file manager.',
      });
    }
  });

  it('agents: the configured scopes that the token also grants; nothing else', async () => {
    const { auth } = setup();
    const agent = async (clientId, scopes, extra) => check(auth, signJwt(key, agentClaims(clientId, scopes, extra)));
    assert.deepEqual(await agent(AGENTS.reader, ['read']), { role: 'agent', clientId: AGENTS.reader, scopes: ['read'] });
    assert.deepEqual(await agent(AGENTS.all, ['read', 'delete']), { role: 'agent', clientId: AGENTS.all, scopes: ['read', 'delete'] });
    // The token grants more than the app allows this client: only the configured part counts.
    assert.deepEqual(await agent(AGENTS.reader, ['read', 'write', 'delete']), { role: 'agent', clientId: AGENTS.reader, scopes: ['read'] });
    // Scopes without the resource-server prefix, or another prefix, grant nothing.
    assert.deepEqual(await agent(AGENTS.all, [], { scope: 'read write delete other/read file-manager-x/read' }), {
      role: 'agent',
      clientId: AGENTS.all,
      scopes: [],
    });
  });

  it('owner/agent confusion is refused: an agent client token must be the client itself, an owner token never comes from an agent', async () => {
    const { auth } = setup();
    // A user who somehow signed in through an agent client: sub is a person, not the client.
    const viaAgentClient = signJwt(key, { ...agentClaims(AGENTS.all, ['read']), sub: OWNER_SUB, username: 'owner-example' });
    assert.equal((await check(auth, viaAgentClient)).status, 403);
    // An owner client token whose sub is an agent's client ID.
    assert.equal((await check(auth, signJwt(key, ownerClaims({ sub: AGENTS.all })))).status, 403);
  });

  const invalid = {
    'expired': () => signJwt(key, ownerClaims({ exp: now() - 5 })),
    'not yet valid (nbf)': () => signJwt(key, ownerClaims({ nbf: now() + 600 })),
    'no exp claim': () => {
      const claims = ownerClaims();
      delete claims.exp;
      return signJwt(key, claims);
    },
    'tampered payload': () => {
      const [h, , s] = signJwt(key, ownerClaims()).split('.');
      return `${h}.${Buffer.from(JSON.stringify(ownerClaims({ sub: OWNER_SUB, scope: 'x' }))).toString('base64url')}.${s}`;
    },
    'signed by an unknown key': () => signJwt(otherKey, ownerClaims()),
    'unknown kid header with the right key': () => signJwt(key, ownerClaims(), { kid: 'nope' }),
    'alg none': () => `${Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid })).toString('base64url')}.${Buffer.from(JSON.stringify(ownerClaims())).toString('base64url')}.`,
    'HS256 with the public key as secret': () => signJwt(key, ownerClaims(), { alg: 'HS256' }),
    'another user pool (iss)': () => signJwt(key, ownerClaims({ iss: 'https://cognito-idp.ap-east-1.amazonaws.com/ap-east-1_Other999' })),
    'issuer with a trailing slash': () => signJwt(key, ownerClaims({ iss: `${ISSUER}/` })),
    'an id token': () => signJwt(key, { ...ownerClaims(), token_use: 'id', aud: NATIVE_CLIENT }),
    'unknown client_id': () => signJwt(key, ownerClaims({ clientId: 'someotherclient00000000001' })),
    'missing client_id': () => signJwt(key, { ...ownerClaims(), client_id: undefined }),
    'not a JWT': () => 'abc.def',
    'empty': () => '',
  };
  for (const [name, make] of Object.entries(invalid)) {
    it(`401 INVALID_TOKEN: ${name}`, async () => {
      const { auth } = setup();
      const result = await check(auth, make());
      assert.deepEqual([result.status, result.code], [401, 'INVALID_TOKEN']);
      assert.equal(result.message, 'The access token is invalid or has expired. Sign in again.');
    });
  }

  it('a JWKS that cannot be fetched is 503 AUTH_UNAVAILABLE, not a login loop', async () => {
    const auth = createAuth(authSettings(ORIGIN), { jwksCache: brokenCache() });
    const token = signJwt(key, ownerClaims());
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    let result;
    try {
      result = await check(auth, token);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(result, {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'The sign-in service could not be reached to check the access token. Try again shortly.',
    });
    assert.deepEqual(logged, ['Access token check failed: FetchError'], 'the log names the failure, never the token');
    assert.equal(logged.join('').includes(token.split('.')[1]), false);
  });

  // Provider-side key problems (the pool's own JWKS is malformed) are a service fault, not the caller's: 503, with the
  // error class logged. Anything a token can choose (its kid, a key not meant for signatures, its alg) stays 401.
  describe('provider JWKS problems vs token problems', () => {
    const quietly = async (fn) => {
      const logged = [];
      const original = console.error;
      console.error = (...args) => logged.push(args.join(' '));
      try {
        return { result: await fn(), logged };
      } finally {
        console.error = original;
      }
    };
    const serving = (jwks) => createAuth(authSettings(ORIGIN), { jwksCache: jwksCacheServing(jwks) });
    const unavailable = {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'The sign-in service could not be reached to check the access token. Try again shortly.',
    };

    it('the pool JWKS has a key with a non-string field (rejected while parsing the JWKS): 503, class logged only', async () => {
      const token = signJwt(key, ownerClaims());
      const { result, logged } = await quietly(() => check(serving({ keys: [{ ...key.jwk, alg: 256 }] }), token));
      assert.deepEqual(result, unavailable);
      assert.deepEqual(logged, ['Access token check failed: JwkValidationError']);
      assert.equal(logged.join('').includes(token.split('.')[1]), false);
    });

    it('the pool JWKS has the token\'s key without its RSA exponent (malformed provider key): 503', async () => {
      const { e, ...withoutExponent } = key.jwk;
      const { result } = await quietly(() => check(serving({ keys: [withoutExponent] }), signJwt(key, ownerClaims())));
      assert.deepEqual(result, unavailable);
    });

    it('stays 401: unknown kid, a key not meant for signatures, an algorithm the key does not allow', async () => {
      const auth = serving({ keys: [key.jwk, { ...otherKey.jwk, use: 'enc' }] });
      for (const [name, token] of [
        ['unknown kid', signJwt(key, ownerClaims(), { kid: 'not-in-the-pool' })],
        ['kid of an encryption key', signJwt(otherKey, ownerClaims())],
        ['RS384 against an RS256 key', signJwt(key, ownerClaims(), { alg: 'RS384' })],
      ]) {
        const { result } = await quietly(() => check(auth, token));
        assert.deepEqual([result.status, result.code], [401, 'INVALID_TOKEN'], name);
      }
      // The same verifier still accepts a good token: nothing was poisoned.
      assert.equal((await check(auth, signJwt(key, ownerClaims()))).role, 'owner');
    });

    it('stays 401: a second unknown kid inside the library\'s 10 s wait period, and a token without kid; good tokens unaffected', async () => {
      const auth = serving({ keys: [key.jwk] });
      for (const [name, token] of [
        ['unknown kid (fetches the JWKS once)', signJwt(key, ownerClaims(), { kid: 'unknown-1' })],
        ['another unknown kid during the wait period', signJwt(key, ownerClaims(), { kid: 'unknown-2' })],
        ['no kid', signJwt(key, ownerClaims(), { kid: undefined })],
      ]) {
        const { result } = await quietly(() => check(auth, token));
        assert.deepEqual([result.status, result.code], [401, 'INVALID_TOKEN'], name);
      }
      assert.equal((await check(auth, signJwt(key, ownerClaims()))).role, 'owner', 'a good token during the wait period');
    });

    it('stays 503: a JWKS that is not JSON or has no keys array', async () => {
      for (const body of ['not json', '{"nokeys":[]}']) {
        const auth = createAuth(authSettings(ORIGIN), { jwksCache: jwksCacheServing(body) });
        const { result } = await quietly(() => check(auth, signJwt(key, ownerClaims())));
        assert.deepEqual(result, unavailable, body);
      }
    });
  });

  it('public browser configuration contains public values only', () => {
    const { auth } = setup();
    assert.deepEqual(auth.publicConfig, {
      mode: 'cognito',
      authority: ISSUER,
      clients: { google: GOOGLE_CLIENT, native: NATIVE_CLIENT },
      redirectUri: `${ORIGIN}/`,
      postLogoutUri: `${ORIGIN}/`,
      scope: 'openid email profile',
      endpoints: {
        authorization: 'https://login.example.invalid/oauth2/authorize',
        token: 'https://login.example.invalid/oauth2/token',
        revocation: 'https://login.example.invalid/oauth2/revoke',
        logout: 'https://login.example.invalid/logout',
      },
    });
    const text = JSON.stringify(auth.publicConfig);
    for (const secret of [OWNER_SUB, ...Object.values(AGENTS), 'file-manager']) assert.equal(text.includes(secret), false, secret);
  });
});

// The library's own JWKS cache with an offline fetcher that answers the pool's JWKS URI with `jwks` (an object, or a
// raw string body), so the library's real parsing and key checks run on provider data chosen by the test.
function jwksCacheServing(jwks) {
  return new SimpleJwksCache({
    fetcher: {
      async fetch(uri) {
        assert.equal(uri, JWKS_URI);
        return new TextEncoder().encode(typeof jwks === 'string' ? jwks : JSON.stringify(jwks)).buffer;
      },
    },
  });
}

// The library's JWKS cache with a fetcher that fails like an unreachable network (the library's FetchError).
function brokenCache() {
  return new SimpleJwksCache({
    fetcher: {
      async fetch(uri) {
        throw new FetchError(uri, 'connect ECONNREFUSED');
      },
    },
  });
}
