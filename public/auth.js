// Browser login for AUTH_MODE=cognito (Phase A). Without it (GET /api/auth/config → { mode: 'none' }) nothing here
// is used and the page is the v1 page. All user-controlled text is inserted with textContent, never innerHTML.
//
// The OIDC protocol (authorization code + PKCE, state, nonce check, code exchange, token revocation, logout URL)
// is done by oidc-client-ts (its pinned browser build, served by this app at /vendor/). This file only chooses
// the client and how the result is shown:
// - two Cognito app clients: "Continue with Google" (identity_provider=Google) and "Email + password"
//   (identity_provider=COGNITO; that path never contacts Google)
// - tokens live only in memory (InMemoryWebStorage); sessionStorage holds only the login transaction in flight
//   (keys starting with TRANSACTION_PREFIX), removed after the callback. Nothing else in storage is touched.
// - no automatic renewal: when the access token expires (or the server answers 401) the page returns to the
//   chooser. A reload also returns to the chooser; nothing redirects on its own.

const TRANSACTION_PREFIX = 'fm.oidc.';
const IDENTITY_PROVIDER = { google: 'Google', native: 'COGNITO' };
const REVOKE_TIMEOUT_MS = 5000;

const els = {
  login: document.getElementById('login'),
  message: document.getElementById('login-message'),
  google: document.getElementById('login-google'),
  email: document.getElementById('login-email'),
  account: document.getElementById('account'),
  signOut: document.getElementById('sign-out'),
  main: document.querySelector('main'),
};

let mode = 'none';
let managers = null; // { google, native }: oidc.UserManager, one per Cognito app client
let activeManager = null; // the one that signed in
let accessToken = null;
let epoch = 0; // incremented whenever a session ends
let onSessionEnd = () => {};
let logoutUri = null; // where Cognito's /logout returns to (this page)

export const auth = {
  get enabled() {
    return mode === 'cognito';
  },
  // True without login (v1), or while a verified token is held.
  get signedIn() {
    return mode === 'none' || accessToken !== null;
  },
  // Changes when the session ends: work started before must not touch the page afterwards.
  get epoch() {
    return epoch;
  },
  // Headers for every private API request (none without login).
  headers() {
    return accessToken === null ? {} : { 'X-App-Authorization': `Bearer ${accessToken}` };
  },
  // The server answered 401 (expired or revoked token): back to the chooser.
  expired() {
    if (accessToken !== null) endSession('Your session has ended. Sign in again.');
  },
};

// Ends the session in this page at once: forgets the token, lets the app clear everything private, shows the
// chooser. Returns the library's manager, which still holds the refresh token for revocation.
function endLocally(message) {
  const manager = activeManager;
  accessToken = null;
  activeManager = null;
  epoch += 1;
  onSessionEnd();
  showChooser(message);
  return manager;
}

// Expiry or 401: the refresh token is revoked and the user forgotten in the background.
function endSession(message) {
  const manager = endLocally(message);
  if (manager) revokeAndForget(manager);
}

// Sign out: end the session here first (whatever happens next), revoke the refresh token, forget the user, then
// Cognito's /logout ends the hosted-login session and returns to this page. It does not sign out of Google
// itself, and an access token already issued stays valid until it expires (see README "Login").
async function signOut() {
  const manager = endLocally('Signing out…');
  if (!manager) return;
  setChooserEnabled(false);
  await revokeAndForget(manager);
  try {
    // The user is already forgotten, so the library adds no id_token_hint; Cognito expects client_id + logout_uri.
    await manager.signoutRedirect({ client_id: manager.settings.client_id, extraQueryParams: { logout_uri: logoutUri } });
  } catch {
    showChooser('Signed out on this device. The sign-in service could not be reached to end its session there.');
  }
}

function showChooser(message) {
  els.main.hidden = true;
  els.account.hidden = true;
  els.login.hidden = false;
  els.message.textContent = message;
  setChooserEnabled(true);
}

function setChooserEnabled(enabled) {
  els.google.disabled = !enabled;
  els.email.disabled = !enabled;
}

function showSignedIn() {
  els.login.hidden = true;
  els.message.textContent = '';
  els.account.hidden = false;
  els.main.hidden = false;
}

// The library's self-contained browser build defines the global `oidc`. A script that loads but is not the library
// (a wrong file, a proxy page served as JavaScript) counts as a failed load too.
function loadLibrary() {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('Could not load the sign-in library. Reload to try again.'));
    const script = document.createElement('script');
    script.src = '/vendor/oidc-client-ts.min.js';
    script.addEventListener('load', () => (typeof window.oidc?.UserManager === 'function' ? resolve(window.oidc) : failed()));
    script.addEventListener('error', failed);
    document.head.append(script);
  });
}

function createManager(oidc, config, method) {
  return new oidc.UserManager({
    authority: config.authority,
    client_id: config.clients[method],
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope,
    // Cognito's endpoints are given, so no discovery request is made.
    metadata: {
      issuer: config.authority,
      authorization_endpoint: config.endpoints.authorization,
      token_endpoint: config.endpoints.token,
      revocation_endpoint: config.endpoints.revocation,
      end_session_endpoint: config.endpoints.logout,
    },
    userStore: new oidc.WebStorageStateStore({ store: new oidc.InMemoryWebStorage() }),
    stateStore: new oidc.WebStorageStateStore({ prefix: `${TRANSACTION_PREFIX}${method}.`, store: window.sessionStorage }),
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    revokeTokenTypes: ['refresh_token'],
    revokeTokensOnSignout: false,
  });
}

// Removes this app's login transactions (and only those) from sessionStorage.
async function clearTransactions() {
  for (const manager of Object.values(managers)) {
    const store = manager.settings.stateStore;
    for (const key of await store.getAllKeys()) await store.remove(key);
  }
}

async function signIn(method) {
  setChooserEnabled(false);
  els.message.textContent = '';
  try {
    // The nonce is only a random value for the library to send and then check in the returned ID token.
    await managers[method].signinRedirect({
      nonce: crypto.randomUUID(),
      extraQueryParams: { identity_provider: IDENTITY_PROVIDER[method] },
    });
  } catch {
    showChooser('Could not start the sign-in. Try again, or choose the other method.');
  }
}

// The provider sent the browser back with ?code&state (or ?error&state). The query is removed from the address
// bar first; the library then checks the state against this tab's transaction and exchanges the code.
async function finishSignIn(url, state) {
  const method = state ? await findTransaction(state) : undefined;
  if (!method) {
    await clearTransactions();
    showChooser('This sign-in link has expired or was already used. Choose a sign-in method.');
    return false;
  }
  let user;
  try {
    user = await managers[method].signinRedirectCallback(url);
  } catch (err) {
    await clearTransactions();
    showChooser(
      err?.error === 'access_denied'
        ? 'Sign-in was cancelled. Choose a sign-in method.'
        : 'Sign-in did not complete. Try again, or choose the other method.',
    );
    return false;
  }
  await clearTransactions();
  return confirmAccess(managers[method], user);
}

// A successful login is not yet access: the server decides (approved owner sub or agent client; never email).
async function confirmAccess(manager, user) {
  accessToken = user.access_token;
  let res;
  try {
    res = await fetch('/api/me', { headers: auth.headers(), cache: 'no-store' });
  } catch {
    res = undefined;
  }
  if (res?.ok) {
    activeManager = manager;
    showSignedIn();
    return true;
  }
  accessToken = null;
  await revokeAndForget(manager);
  showChooser(
    res?.status === 403
      ? 'This account is not allowed to use this file manager. Choose another sign-in method or account.'
      : 'Sign-in did not complete. Try again, or choose the other method.',
  );
  return false;
}

// Revokes the refresh token at the provider (bounded wait; a failure is ignored) and forgets the user in memory.
async function revokeAndForget(manager) {
  try {
    await Promise.race([
      manager.revokeTokens(['refresh_token']),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), REVOKE_TIMEOUT_MS)),
    ]);
  } catch {
    // The memory is cleared anyway; an unrevoked refresh token expires at the provider.
  }
  await manager.removeUser();
}

async function findTransaction(state) {
  for (const method of Object.keys(managers)) {
    if ((await managers[method].settings.stateStore.get(state)) !== null) return method;
  }
  return undefined;
}

// Resolves true when the file manager may load (no login, or signed in), false when the chooser is shown.
// `sessionEnded` is called (synchronously) whenever a session ends, before the chooser is shown.
export async function startAuth(sessionEnded) {
  onSessionEnd = sessionEnded;
  const res = await fetch('/api/auth/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the sign-in settings (${res.status}). Reload to try again.`);
  const config = await res.json();
  if (config.mode === 'none') return true;
  if (config.mode !== 'cognito') throw new Error('Unknown sign-in settings. Reload to try again.');
  mode = 'cognito';
  els.main.hidden = true;
  let oidc;
  try {
    oidc = await loadLibrary();
  } catch (err) {
    // Shown where the user looks (the login area; the file UI stays hidden), with no way to start a sign-in.
    showChooser(err.message);
    setChooserEnabled(false);
    return false;
  }
  managers = { google: createManager(oidc, config, 'google'), native: createManager(oidc, config, 'native') };
  // The library's timer for the access token's expiry (no automatic renewal).
  for (const manager of Object.values(managers)) {
    manager.events.addAccessTokenExpired(() => {
      if (manager === activeManager) auth.expired();
    });
  }
  logoutUri = config.postLogoutUri;
  els.google.addEventListener('click', () => signIn('google'));
  els.email.addEventListener('click', () => signIn('native'));
  els.signOut.addEventListener('click', signOut);
  // Back from a provider page that failed (e.g. Google blocked) can restore this page as it was left, with the
  // buttons disabled mid-redirect: offer both methods again.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && accessToken === null) showChooser('');
  });

  const params = new URLSearchParams(location.search);
  if (params.has('state') || params.has('code') || params.has('error')) {
    const url = location.href;
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    return finishSignIn(url, params.get('state'));
  }
  await clearTransactions(); // an attempt that never came back (e.g. Back from a blocked page)
  showChooser('');
  return false;
}
