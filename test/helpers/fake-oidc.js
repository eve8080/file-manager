// A deterministic stand-in for the Cognito hosted login (test only, 127.0.0.1): /oauth2/authorize, /oauth2/token,
// /oauth2/revoke and /logout, enough for the real oidc-client-ts in the browser. It checks the PKCE verifier,
// redirect URI, client and single use of each code, and records every request. It is passed to the app only through
// createAuth's test-only `providerOrigin`; no environment setting can point the app at it.
// `behaviour` (set by tests): authorize: 'approve' | 'cancel' | 'badcode' | 'hold' | 'google-blocked'; revoke: 'ok' | 'fail';
// revokeDelayMs; sub/email of the person who "signs in".
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { ISSUER, OWNER_EMAIL, OWNER_SUB, ownerClaims, signJwt } from './auth-fixtures.js';

const IDENTITY_PROVIDER = { native: 'COGNITO', google: 'Google' };

export async function startFakeOidc({ appOrigin, clients, key }) {
  const fake = {
    behaviour: {},
    authorizations: [], // query parameters of every authorize request
    redirects: [], // every Location sent back to the app
    tokenRequests: [], // form fields of every token request
    issued: [], // every token response body
    revocations: [], // form fields of every revoke request
    logouts: [], // query parameters of every logout request
    sequence: [], // endpoint names in the order they were called
    others: [], // requests to any other path: { method, path, token, preflightHeaders }
    reset() {
      fake.behaviour = { authorize: 'approve', revoke: 'ok', revokeDelayMs: 0, sub: OWNER_SUB, email: OWNER_EMAIL };
      for (const list of [fake.authorizations, fake.redirects, fake.tokenRequests, fake.issued, fake.revocations, fake.logouts, fake.sequence, fake.others]) {
        list.length = 0;
      }
    },
  };
  fake.reset();
  const codes = new Map(); // code -> { clientId, redirectUri, challenge, nonce, sub, email, used }
  const methodOf = (clientId) => Object.keys(clients).find((m) => clients[m] === clientId);

  const cors = { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  };
  const redirect = (res, location) => {
    fake.redirects.push(location);
    res.writeHead(302, { Location: location });
    res.end();
  };
  const readForm = async (req) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    return Object.fromEntries(new URLSearchParams(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    fake.sequence.push(`${req.method} ${url.pathname}`);
    if (req.method === 'OPTIONS') {
      if (!url.pathname.startsWith('/oauth2/')) {
        fake.others.push({ method: 'OPTIONS', path: url.pathname, token: undefined, preflightHeaders: req.headers['access-control-request-headers'] });
      }
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST' });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const q = Object.fromEntries(url.searchParams);
      fake.authorizations.push(q);
      const method = methodOf(q.client_id);
      const valid =
        method &&
        q.identity_provider === IDENTITY_PROVIDER[method] &&
        q.response_type === 'code' &&
        q.redirect_uri === `${appOrigin}/` &&
        q.scope === 'openid email profile' &&
        q.code_challenge_method === 'S256' &&
        /^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '') &&
        q.state &&
        q.nonce;
      if (!valid) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('invalid authorize request');
      }
      const back = new URL(q.redirect_uri);
      const { authorize } = fake.behaviour;
      if (authorize === 'google-blocked' && method === 'google') {
        // Cognito would send the browser on to Google; the test browser resolves no host names, like a blocked network.
        return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=placeholder');
      }
      if (authorize === 'hold') {
        // The user is still on the login page: the transaction stays open in the app's tab.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('login page');
      }
      if (authorize === 'cancel') {
        back.search = new URLSearchParams({ error: 'access_denied', error_description: 'cancelled', state: q.state });
        return redirect(res, back.href);
      }
      let code = randomUUID();
      if (authorize === 'badcode') code = 'not-a-code-this-server-issued';
      else {
        codes.set(code, {
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          challenge: q.code_challenge,
          nonce: q.nonce,
          sub: fake.behaviour.sub,
          email: fake.behaviour.email,
          used: false,
        });
      }
      back.search = new URLSearchParams({ code, state: q.state });
      return redirect(res, back.href);
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const form = await readForm(req);
      fake.tokenRequests.push(form);
      const grant = codes.get(form.code);
      const verifierOk =
        grant && createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === grant.challenge;
      if (form.grant_type !== 'authorization_code' || !grant || grant.used || form.client_id !== grant.clientId || form.redirect_uri !== grant.redirectUri || !verifierOk) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      grant.used = true;
      const now = Math.floor(Date.now() / 1000);
      // behaviour.idToken: 'badnonce' (a forged/replayed ID token for another login) or 'missing'.
      const tokens = {
        access_token: signJwt(key, ownerClaims({ clientId: grant.clientId, sub: grant.sub })),
        id_token: signJwt(key, {
          sub: grant.sub,
          aud: grant.clientId,
          iss: ISSUER,
          token_use: 'id',
          nonce: fake.behaviour.idToken === 'badnonce' ? 'nonce-of-another-login' : grant.nonce,
          email: grant.email,
          auth_time: now,
          iat: now,
          exp: now + 3600,
        }),
        refresh_token: `refresh-${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: fake.behaviour.expiresIn ?? 3600,
      };
      if (fake.behaviour.idToken === 'missing') delete tokens.id_token;
      fake.issued.push(tokens);
      return json(res, 200, tokens);
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      const form = await readForm(req);
      fake.revocations.push(form);
      if (fake.behaviour.revokeDelayMs) await new Promise((r) => setTimeout(r, fake.behaviour.revokeDelayMs));
      if (fake.behaviour.revoke === 'fail') return json(res, 503, { error: 'unavailable' });
      res.writeHead(200, cors);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/logout') {
      const q = Object.fromEntries(url.searchParams);
      fake.logouts.push(q);
      if (q.logout_uri === `${appOrigin}/` && methodOf(q.client_id)) return redirect(res, q.logout_uri);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('invalid logout request');
    }

    // Anything else: recorded with the headers that would show a token being sent (or asked for by a preflight).
    fake.others.push({
      method: req.method,
      path: url.pathname,
      token: req.headers['x-app-authorization'],
      preflightHeaders: req.headers['access-control-request-headers'],
    });
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  fake.origin = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((resolve) => server.close(resolve));
  return fake;
}
