// Access-token checking for AUTH_MODE=cognito (Phase A). The signature, issuer (the user pool), token_use=access,
// client_id and exp/nbf are verified by aws-jwt-verify; this module only decides who the verified token is:
// - owner: issued to one of the two browser login clients (native email+password, Google) for a sub listed in
//   OWNER_SUBS. Both login methods resolve to the same linked Cognito user, so to the same sub. Email, username
//   and every other claim are ignored: they never grant access.
// - agent: issued to a client in AGENT_CLIENTS through the client-credentials grant (sub = the client ID). Its
//   scopes are those configured for it that the token also grants as `<AGENT_SCOPE_PREFIX>/<scope>`.
// Anything else that verifies is 403; anything that does not verify is 401. Tokens are never logged.
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwkValidationError, JwksValidationError, JwtBaseError } from 'aws-jwt-verify/error';
import { authUnavailable, invalidToken, notAuthorized } from './errors.js';

export const OWNER_SCOPES = ['read', 'write', 'delete'];
// Browser login asks Cognito for these OIDC scopes only (identity, not file permissions).
const LOGIN_SCOPE = 'openid email profile';

// `settings` is loadConfig().auth. Tests inject `jwksCache` (the library's SimpleJwksCache with an offline
// fetcher) and `providerOrigin` (a local fake login server); neither can be set from the environment.
export function createAuth(settings, { jwksCache, providerOrigin } = {}) {
  const ownerClients = [settings.nativeClientId, settings.googleClientId];
  const agentScopes = new Map(settings.agentClients.map(({ clientId, scopes }) => [clientId, scopes]));
  const ownerSubs = new Set(settings.ownerSubs);
  const verifier = CognitoJwtVerifier.create(
    {
      userPoolId: settings.userPoolId,
      tokenUse: 'access',
      clientId: [...ownerClients, ...agentScopes.keys()],
    },
    jwksCache ? { jwksCache } : undefined,
  );

  const provider = providerOrigin ?? `https://${settings.domain}`;
  const appUrl = `${settings.publicOrigin}/`;

  return {
    publicOrigin: settings.publicOrigin,
    providerOrigin: new URL(provider).origin,

    // GET /api/auth/config: what the browser needs to start a login. Public values only.
    publicConfig: {
      mode: 'cognito',
      authority: `https://cognito-idp.${settings.region}.amazonaws.com/${settings.userPoolId}`,
      clients: { google: settings.googleClientId, native: settings.nativeClientId },
      redirectUri: appUrl,
      postLogoutUri: appUrl,
      scope: LOGIN_SCOPE,
      endpoints: {
        authorization: `${provider}/oauth2/authorize`,
        token: `${provider}/oauth2/token`,
        revocation: `${provider}/oauth2/revoke`,
        logout: `${provider}/logout`,
      },
    },

    // Resolves to { role: 'owner', sub, scopes } or { role: 'agent', clientId, scopes }; throws 401/403/503.
    async verifyToken(token) {
      let payload;
      try {
        payload = await verifier.verify(token);
      } catch (err) {
        // 503 for provider-side faults: the JWKS unreachable (FetchError), not a JWKS (JwksValidationError), or one of
        // the pool's own keys malformed (JwkValidationError: thrown while parsing the fetched JWKS, or for the selected
        // key's missing RSA/EC/OKP fields - a token can choose which key, not its contents). Everything a token can
        // cause stays 401: unknown kid (KidNotFoundInJwksError and the library's wait period), a key not meant for
        // signatures (JwkInvalidUseError/JwkInvalidKtyError), a wrong alg, a bad signature or claim.
        if (
          err instanceof FetchError ||
          err instanceof JwksValidationError ||
          err instanceof JwkValidationError ||
          !(err instanceof JwtBaseError)
        ) {
          console.error(`Access token check failed: ${err.constructor.name}`); // the class only; never the token or claims
          throw authUnavailable();
        }
        throw invalidToken();
      }
      // The library checks exp only when present; a Cognito access token always has one, so require it.
      if (typeof payload.exp !== 'number') throw invalidToken();
      const clientId = payload.client_id;
      if (ownerClients.includes(clientId)) {
        if (!ownerSubs.has(payload.sub)) throw notAuthorized();
        return { role: 'owner', sub: payload.sub, scopes: [...OWNER_SCOPES] };
      }
      // An agent token is the client itself (client-credentials grant), never a person signed in through it.
      if (payload.sub !== clientId || payload.username !== undefined) throw notAuthorized();
      const granted = new Set((payload.scope ?? '').split(' '));
      const scopes = agentScopes.get(clientId).filter((scope) => granted.has(`${settings.agentScopePrefix}/${scope}`));
      return { role: 'agent', clientId, scopes };
    },
  };
}
