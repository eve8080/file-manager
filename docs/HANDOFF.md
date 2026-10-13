# Handoff

_Last updated: 2026-10-13. Phase A of `docs/AWS_LOGIN_PLAN.md` (optional Cognito login, local only) is implemented on
top of `125cfb88d3292cee9f5ab82c924e60b088c34479` as decision D26 in `IMPLEMENTATION_BRIEF.md`, and the implementer's
adversarial self-audit was completed on 2026-10-13 (continuation approved by Mr. So: "ok, please proceed phase A"),
followed the same day by the approved close-out round ("Ok, approve 1-2"; see "Close-out round 2026-10-13").
M1–M3 and the M4 JPEG follow-up are committed; their session histories are in those commits' `docs/HANDOFF.md`.
Independent review verdicts live in `docs/CLAUDE_REVIEW.md`._

## Status
- **Implemented and self-audited locally; Phase A acceptance is not complete.** The self-audit is the implementer's own
  check, not an independent review. Real-provider, corporate-network and physical-device gates are open (see "Open gates").
- Current run (after the close-out round's self-audit, 2026-10-13, sanitized environment, see "Safe verification
  recipe"): `npm test` exit 0, **547 tests, 547 pass, 0 fail/cancelled/skipped/todo, 81 suites**.
- No AWS/Google account was configured, no resource provisioned or changed, nothing deployed, committed, staged or pushed.
  Tests use synthetic tokens, an offline JWKS, a local fake provider and memory/fake-S3 storage.
- **AWS contact during this work cannot be ruled out.** On 2026-10-11 one startup-test RED run let `src/server.js`
  reach the S3 driver before test isolation existed (see "Boundary incident"). Whether that child read local AWS
  configuration or contacted a remote service is UNKNOWN; later isolation cannot prove it did not. Until 2026-10-13 the
  in-process S3 tests could also read the AWS config files named by the runner's environment (finding I2 below); they
  sent no request (the signing client cannot send), but whether a config file was read in those runs is also unknown.
  `.env`, `~/.aws` and credential files were never opened by the implementer.
- Scope: `AUTH_MODE=cognito` server auth and scopes, `/api/me`, `/api/auth/config`, the two-method login page, OIDC
  through `oidc-client-ts`, authorized downloads/previews/uploads, expiry and sign-out. Phase B (direct-to-S3 uploads,
  Lambda, 6 MB transport) and Phase C (provisioning, deployment) are not approved and not started.
- Direct dependencies added (the two approved, exact pins): **`aws-jwt-verify@5.2.1`**, **`oidc-client-ts@3.5.0`**
  (+ transitive `jwt-decode@4.0.0`). No dependency change in the self-audit.

## Boundary incident (2026-10-11, slice 4 RED) — outcome UNKNOWN
The first RED version of a startup test sent `GET /api/list` to `src/server.js` (env: `PATH`, `HOST`, `PORT`,
`S3_BUCKET=dummy-bucket`, `AWS_REGION=us-east-1`, synthetic login values; no `.env`, no `AWS_PROFILE`, `HOME` not set
in the child). Login was not wired yet, so the request reached the S3 driver and returned **502 after ≈2 s**. The AWS
SDK default credential chain therefore ran in that child; whether it read local AWS files or made a network call
(credentials, IMDS, S3) is unknown. No response body or credential was shown to the implementer. Mitigations since:
the startup test first avoided storage routes; then all real entry-point children moved to `isolatedEnv()`
(2026-10-11, partial self-audit) and in-process presigning was isolated (2026-10-13). None of this resolves the
original question.

## Close-out round 2026-10-13 (approved local fixes; implementer)
Six findings from the 2026-10-13 independent review were handled together. Test safety as in "Safe verification
recipe": original `HOME`, null AWS config/credential files, synthetic keys, IMDS off, profile/session/role/web-identity/
container/SSO/endpoint variables removed, `npm_config_update_notifier=false`, no global S3 endpoint; real-server children
only through `isolatedEnv()`. Raw logs: `/Users/eveso/.hermes/cache/scratch/file-manager-closeout-20261013T155632-8f4b6f05/`.

| # | Finding | Disposition | Evidence |
|---|---|---|---|
| 1 | Sign-in library load failure left a blank page: `public/auth.js` hid `<main>`, then the load error went to `#status`, inside the hidden `<main>` | **Fixed test-first.** The login area now shows the fixed message "Could not load the sign-in library. Reload to try again." (`role=alert`), both sign-in buttons disabled; no file UI, no data request, no token | New browser tests "the sign-in library cannot be loaded" at 375 and 1280 px (vendor script answered 404 through CDP `Fetch`). RED `f1-vendor404-red.txt`: exit 1, 2/2 fail on assertions (`chooser: false`, `message: ''`, `visible: false`). GREEN `f1-vendor404-green.txt`: exit 0, `auth-browser.test.js` 29/29 |
| 2 | D26 rendered outside the decisions table (blank line before it) | **Fixed** (docs): blank line removed in `IMPLEMENTATION_BRIEF.md` | fence/table check below |
| 3 | §4 error status list lacked 401/503 | **Fixed** (docs): 401 and 503 listed, both login-mode only | — |
| 4 | Proposed adding the review artifact to the HANDOFF file inventory | **Not adopted**, as directed: HANDOFF does not describe the review result artifact | — |
| 5 | Provider-side key problems answered 401 instead of 503 | **Fixed narrowly test-first** after reading the installed `aws-jwt-verify@5.2.1` (`dist/esm/jwk.js`, `jwt-verifier.js`, `error.js`): `JwkValidationError` is thrown only for provider data, either a malformed key while parsing the fetched JWKS (`assertIsJwk`) or the selected key's missing RSA/EC/OKP fields (`assertIs*SignatureJwk`); a token chooses which key, not its contents. It now maps to 503 `AUTH_UNAVAILABLE` (class name logged only). **Kept 401:** `KidNotFoundInJwksError` and the library's 10 s `WaitPeriodNotYetEndedJwkError` (unknown kid; fail closed, attacker-triggerable), `JwkInvalidUseError`/`JwkInvalidKtyError` (token points at a non-signature key), `JwtInvalidSignatureAlgorithmError`, signature and claim errors. Already 503: `FetchError`, `JwksValidationError`, non-library errors | `test/auth.test.js` "provider JWKS problems vs token problems" (4 tests; the provider JWKS is served by the library's own `SimpleJwksCache` with an offline fetcher). RED `f5-jwks-red.txt`: exit 1, 2 fail (401 instead of 503 for a non-string key field and for a key without its RSA exponent), 2 pins pass. GREEN `f5-jwks-green.txt`: exit 0, 25/25. Mutation `f5-jwks-mutation-broad503.txt`: also mapping use/kty/alg/unknown-kid errors to 503 → exit 1, the 401 pin failed (`[503, 'AUTH_UNAVAILABLE']`); restored |
| 6 | README stated absolutely that `npm test` never touches AWS | **Fixed** (docs): README now says the isolation statement describes the current tests only, and records that the 2026-10-11 startup test and the earlier in-process config reads remain unknown | — |

Commands (each run once, from the project directory, in the sanitized environment; exits as reported by the shell):
- `node --test --test-name-pattern="provider JWKS" --test-reporter=spec --test-reporter-destination=<dir>/f5-jwks-red.txt test/auth.test.js` → exit 1
- `node --test --test-reporter=spec --test-reporter-destination=<dir>/f5-jwks-green.txt test/auth.test.js` → exit 0, 25/25
- `node --test --test-name-pattern="stays 401" --test-reporter=spec --test-reporter-destination=<dir>/f5-jwks-mutation-broad503.txt test/auth.test.js` (mutated) → exit 1
- `node --test --test-timeout=60000 --test-name-pattern="cannot be loaded" --test-reporter=spec --test-reporter-destination=<dir>/f1-vendor404-red.txt test/auth-browser.test.js` → exit 1
- `node --test --test-timeout=60000 --test-reporter=spec --test-reporter-destination=<dir>/f1-vendor404-green.txt test/auth-browser.test.js` → exit 0, 29/29
- Full regression: the "Safe verification recipe" wrapper with its report at `<dir>/full-npm-test-spec.txt` → printed
  `{"exit":0,"signal":null,"home":true,"s3EndpointSet":false,"tests":544,"suites":81,"pass":544,"fail":0,"cancelled":0,"skipped":0,"todo":0}`
- `node --check` over 37 `.js` files (result in `<dir>/node-check.json`) → exit 0, 0 failures; `git diff --check` → exit 0, no output;
  `grep -rn MUTATION src public test` → no matches

Files changed in this round: `public/auth.js`, `src/auth.js`, `test/auth-browser.test.js`, `test/auth.test.js`,
`IMPLEMENTATION_BRIEF.md`, `README.md`, `docs/AWS_LOGIN_PLAN.md`, `docs/HANDOFF.md`. No dependency, `CLAUDE.md` or
instruction-file change.

### Self-audit of the close-out fixes (2026-10-13, implementer; not an independent review)
Logs in the same directory, prefixed `selfaudit-`.

| # | Challenge | Result | Evidence |
|---|---|---|---|
| S1 | Finding-1 fix handled only a load *error*. A vendor URL answering **200 with something that is not the library** (wrong file, proxy page served as JavaScript) fired `load` with `window.oidc` undefined, `createManager` threw, and the error went to the hidden `#status`: the same blank page | **Defect, fixed test-first.** The loader now resolves only if `window.oidc.UserManager` is a function; otherwise it shows the same fixed login-area error | Browser test extended to "200 but not the library" at 375 and 1280 px. RED `selfaudit-vendor200-red.txt`: exit 1, the two new cases fail (`chooser: false`, `message: ''`, `visible: false`), the two 404 cases pass. GREEN `selfaudit-vendor200-green.txt`: exit 0, `auth-browser.test.js` 31/31 (all real-library sign-in flows included) |
| S2 | Vendor-failure DOM: visible accessible message, no file data or storage access, no token, no unintended sign-in or fallback | Holds | The 4 tests assert: message visible inside the viewport, `role=alert`, both buttons disabled, `<main>` and account bar hidden, no storage call, no principal on the server, no authorize request, empty session/local storage, no `oidc` global. Code reading: no button or `pageshow` listener is registered before a successful load; `auth.signedIn` is false, so hash navigation loads nothing; the server still requires a token, so there is no unauthenticated fallback |
| S3 | `JwkValidationError` → 503: can a token cause it? | No. In `aws-jwt-verify@5.2.1` it is thrown only for provider key data (parsing the fetched JWKS, or the selected key's missing fields). A token chooses which key, not its contents. A failed refetch does not replace the cached JWKS, so cached good keys keep working | source reading; existing tests |
| S4 | Unknown `kid` during the library's 10 s wait period, and a token without `kid` | Both 401; a good token still verifies during the wait period. **Coverage gap closed** with a pin test (passed at once: a pin, not a RED) | `selfaudit-penalty-pin.txt` exit 0. Mutation mapping `WaitPeriodNotYetEndedJwkError`/`JwtWithoutValidKidError` to 503: `selfaudit-penalty-mutation.txt` exit 1 (`[503, 'AUTH_UNAVAILABLE']`); restored |
| S5 | Probe: provider key without `alg`, token header `ES256` but genuinely RS256-signed by the pool key | Accepted (the library verifies by key type and hash). Not a forgery: the signature is the pool's; `none`/`HS256` stay refused. Cognito JWKS keys carry `alg`, which the library enforces against the header. No change; recorded | offline probe with the installed library (not a test) |

Self-audit commands (sanitized environment; exits as reported by the shell):
- `node --test --test-timeout=60000 --test-name-pattern="cannot be loaded" --test-reporter=spec --test-reporter-destination=<dir>/selfaudit-vendor200-red.txt test/auth-browser.test.js` → exit 1
- `node --test --test-timeout=60000 --test-reporter=spec --test-reporter-destination=<dir>/selfaudit-vendor200-green.txt test/auth-browser.test.js` → exit 0, 31/31
- `node --test --test-name-pattern="wait period" --test-reporter=spec --test-reporter-destination=<dir>/selfaudit-penalty-pin.txt test/auth.test.js` → exit 0; same command with the mutation, destination `selfaudit-penalty-mutation.txt` → exit 1
- Full regression: the recipe wrapper with report `<dir>/selfaudit-full-npm-test-spec.txt` → printed
  `{"exit":0,"signal":null,"home":true,"s3EndpointSet":false,"tests":547,"suites":81,"pass":547,"fail":0,"cancelled":0,"skipped":0,"todo":0}`
- `node --check` over 37 files (`<dir>/selfaudit-node-check.json`) → exit 0, 0 failures; `git diff --check` → exit 0;
  `grep -rn MUTATION src public test` → no matches

Files changed by the self-audit: `public/auth.js`, `test/auth-browser.test.js`, `test/auth.test.js`, and the four durable docs.

## Self-audit 2026-10-13: findings and fixes
Order: test safety first, then baseline, then audit. Every in-scope behavioural fix got a failing regression first.

| # | Finding | RED (command → result) | Fix | GREEN |
|---|---|---|---|---|
| I1 | (2026-10-11, partial self-audit) Real entry-point children got an ad-hoc environment; a broken build could reach AWS | `node --test test/isolation.test.js` with a stub helper (today's behaviour) → exit 1, 4/4 fail on assertions (`AWS_ACCESS_KEY_ID isolates the SDK`, `Missing expected exception`); the server tests stopped at their own safety guard before spawning anything. Then the spawn guard: `--test-name-pattern="every test that spawns"` → exit 1, offenders `config.test.js`, `start.test.js` | `test/helpers/isolated-env.js`; `start.test.js`, `config.test.js` migrated | 4/4, then 34/34 (isolation+start+config) |
| I2 | **In-process presigning read AWS config files named by the inherited environment.** `TEST_SIGNER` (a real `S3Client` with dummy keys and a throwing request handler) resolves endpoint settings, including `endpoint_url` from the shared config file. Every test process that imports `fake-s3-client.js` could therefore read the runner's `~/.aws/config`/credentials (no request could be sent) | New test plants a synthetic config file in a fresh temp dir (`endpoint_url = http://planted-config.invalid`) and points `AWS_CONFIG_FILE` at it: `node --test --test-name-pattern="in-process presigning" test/isolation.test.js` → exit 1, presigned URL host `isolation-bucket.planted-config.invalid` | `test/helpers/fake-s3-client.js` sets `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` to `/dev/null`, `AWS_EC2_METADATA_DISABLED=true`, deletes profile/role/web-identity/container/SSO/endpoint variables in the test process. `HOME` and the default endpoint unchanged | exit 0, 1/1 |
| I3 | Scanner-flagged fixture at `test/isolation.test.js:54`: a synthetic, AWS-access-key-ID-*shaped* literal used to check that overriding `AWS_ACCESS_KEY_ID` is refused. Written by the implementer as an obvious placeholder, never a credential. The refusal depends on the variable name only | not behavioural (test data) | replaced by a value that is not key-shaped; `grep -E "A(KIA\|SIA)[0-9A-Z]{16}"` over `src public test` → 0 in every file | the refusal test still passes |
| A | **A download finishing after the session ended kept a `blob:` copy of the file** (up to 60 s; session-end cleanup had already run) | `node --test --test-timeout=60000 --test-name-pattern="arrives after the session ended\|only ever sent to this app" test/auth-browser.test.js` → exit 1: `no blob: URL holds the file after the session ended` (one `blob:` URL) | `public/app.js` `downloadFile`: no object URL if the session ended while the body arrived | exit 0 |
| B | **The token could be requested for a non-origin URL.** Previews were fetched with the token when `url.startsWith('/')`, which a protocol-relative `//host/…` also matches. (URLs come from storage via the server, so this was not reachable from the current drivers.) | Same command, after fixing a harness blind spot (the fake answered CORS preflights before recording them) → exit 1: `OPTIONS /steal.png` with `access-control-request-headers: x-app-authorization`. The token itself was not transmitted (the preflight was refused); in production the CSP limits `connect-src` to the Cognito domain | `isOwnApiUrl()`: the URL must resolve to this origin and `/api/` | exit 0 (3 URL forms: `//host`, absolute, `/\host`) |
| C | No test showed the browser enforces the ID-token nonce (the library checks it only when the app supplies one) | Pinning tests passed at once; **mutation**: nonce sent as a plain query parameter instead of to the library → `--test-name-pattern="nonce is not this login"` exit 1 (the wrong-nonce login was accepted). Restored | none needed | wrong nonce and missing ID token both refused, no session, server never saw the token |
| D | No test for `HEAD`/`OPTIONS` and upper-case/trailing-slash variants of private routes | pinning test, passed at once (regression pin, no RED) | none needed | 401 + `no-store` + no storage call for 8 variants |

Reviewed without finding a defect (evidence in tests listed under "Acceptance criteria → evidence"): JWT signature,
issuer/pool, `token_use`, client allowlist, required `exp`, `nbf`, `alg none`/HS256, malformed and repeated
`X-App-Authorization`, `Authorization`/query tokens ignored; owner/agent confusion (agent `sub` must equal its client,
no `username`; owner needs an owner client and listed sub; email never consulted); config guards (fail closed,
loopback-only, disjoint clients, fixed messages); parser and guard order (no-store → exact host → security headers →
cross-site write check → public routes → authenticate → JSON body parser → scope → route); public `/api/health` and
`/api/auth/config` content; blob/download handling and revocation; session-end races; refresh-token revoke and
`/logout` without token; no token in URL, DOM, storage or logs. Not changed by design: a partial-delete warning that
completes after the session ended is still `alert()`ed (D16: possible data loss is always reported).

## Implementation-run RED/GREEN log (2026-10-11, historical)
This is the implementer's recorded history. Not every initial failure met behavioural-TDD criteria: the verifier's
first RED was a module-not-found import error, and several failures were test-helper bugs. Behavioural evidence for those
areas comes from later assertions and the mutation checks below.
| Slice | RED command → result | GREEN |
|---|---|---|
| 1 Config | `node --test test/config.test.js` → 18 tests, **14 fail** (assertions), 4 pass | 18/18 |
| 2 Verifier | `node --test test/auth.test.js` → `ERR_MODULE_NOT_FOUND … src/auth.js` (**import error, not a behavioural RED**) | 21/21 |
| 3 HTTP auth | `node --test test/auth-api.test.js` → 25 tests, **24 fail**, 1 pass | 25/25; full suite 496/496 |
| 4 Entry points | `node --test test/start.test.js` → 2 fail (demo `/api/list` 200; server.js 502 — the incident above); re-RED 2 fail (`/api/me` 404) | 11/11 |
| 5a Chooser | `TypeError … reading 'hidden'` (element missing) | 1/1 |
| 5b Email login | `Timed out waiting for: signed in and the folder loaded` | 2/2 |
| 5c Google / unapproved | 1 fail (unapproved message never shown); the Google test passed at once (pin) | 4/4 |
| 5d Failures | 3 fail: 2 test-helper bugs, 1 real bug (bfcache Back left buttons disabled) | 10/10 |
| 5e Files | 3/3 fail; then a vacuous revocation check (CSP blocks `fetch(blob:)`) was replaced | 3/3 |
| 5f Session end | 4/4 fail; 2 helper fixes | 4/4 |
| 5g Sign-out | 4 fail, 4 pass | 8/8 |
| Gap test | `stateStore → localStorage` was undetected; added the in-flight storage test | pass; mutation M4b |

Mutation checks (2026-10-11; production code broken, focused tests run, restored): M1 owner-sub allowlist off → 3 fail;
M2 scope check off → 5 fail; M3 `Authorization` accepted → 1 fail; M4a tokens in sessionStorage → 1 fail; M4b
transactions in localStorage → 1 fail; M5 preview blobs not revoked → 1 fail; M6 session end without `loadSeq`
bump/abort → 2 fail; M7 user kept before `/logout` (→ `id_token_hint`) → 2 fail. 2026-10-13: M8 nonce not given to the
library → 1 fail. `grep -rn MUTATION src public test` afterwards: no output.

## Prerequisite gate (2026-10-11, before any test or production edit)
| Check | Result |
|---|---|
| Baseline `npm test` (HEAD `125cfb8`) | exit 0: 436 tests, 436 pass, 0 fail, 0 skipped, 61 suites |
| Registry metadata / primary docs / installed source | as recorded: `aws-jwt-verify@5.2.1` (no deps; `exp` checked only if present → app requires it; scope any-of → app checks per route), `oidc-client-ts@3.5.0` (`jwt-decode` dep; state removed before validation; nonce checked only if supplied; `signoutRedirect` adds `id_token_hint` if a user is stored) |
| Install | `npm install --ignore-scripts --save-exact aws-jwt-verify@5.2.1 oidc-client-ts@3.5.0`; lockfile: 3 entries added, none changed |
| Browser artifact | `dist/browser/oidc-client-ts.min.js`: self-contained IIFE (global `oidc`, `jwt-decode` inlined, no `require`/`import`/`eval`), 70,851 bytes, SHA-256 `f999daa383f09eb090d0ae32211e9ca931c76840e08e47fcf334fc8f5f74f1ef`, served as installed from `/vendor/` |
| Isolated `npm pack`, `shasum`, secret `grep` | blocked by the permission system on 2026-10-11 |

## Design (D26)
| Area | Decision |
|---|---|
| Modes | `AUTH_MODE` unset = v1 (incl. `HOST=0.0.0.0` LAN). Login settings or Lambda markers without `AUTH_MODE=cognito` → refuse to start; any other `AUTH_MODE` value → refuse |
| Config | 9 required settings incl. `AGENT_SCOPE_PREFIX`; strict formats; fixed messages; loopback `HOST` and `PUBLIC_ORIGIN` on `PORT`; `COGNITO_DOMAIN` host name only, always `https://` |
| Verification (`src/auth.js`) | `CognitoJwtVerifier` (`tokenUse: 'access'`, client allowlist); `exp` required; owner = owner client + sub ∈ `OWNER_SUBS`; agent = agent client, `sub === client_id`, no `username`, scopes = configured ∩ `<prefix>/<scope>`; 401/403/503 |
| HTTP (`src/app.js`) | exact host, exact write Origin, `no-store` on `/api`, public health/config, authenticate before body parsing and 404, per-route scope, `X-App-Authorization: Bearer` only (one header, ≤ 8192), S3 download → `{ url }`, vendor route and `blob:`/`connect-src` CSP only in login mode |
| Browser (`public/auth.js`, `public/app.js`) | two `UserManager`s with supplied metadata, in-memory user store, `fm.oidc.<method>.` transactions in sessionStorage, no silent renew, nonce given to the library, `/api/me` confirmation, session end clears everything and invalidates late work, sign-out = revoke refresh token → forget user → `/logout?client_id&logout_uri`; token sent only to own `/api/`; late downloads dropped |
| No-login UI | visually unchanged; fetches `/api/auth/config` first; a cross-site write with malformed JSON is now 403 (was 400) |

## Acceptance criteria → evidence
| Criterion | Tests |
|---|---|
| Unset `AUTH_MODE` = v1; fail-closed markers; strict config; no values in messages | `test/config.test.js` (18), `test/start.test.js` (11), `test/auth-api.test.js` "no-login mode is unchanged", all baseline tests |
| Signature, pool issuer, `token_use=access`, client IDs, exp (required)/nbf; 401/403/503 incl. provider-JWKS faults → 503 and token-chosen key problems → 401 | `test/auth.test.js` (26) |
| Sign-in library load failure (404, or 200 that is not the library): visible fixed error in the login area at 375/1280 px, buttons disabled, nothing private | `test/auth-browser.test.js` "the sign-in library cannot be loaded" (4) |
| Owner exact sub, both clients same owner; same-email/Google stranger 403; agent/owner confusion | `test/auth.test.js`, `test/auth-api.test.js`, browser Google/unapproved tests |
| Route scopes with storage side effects; nothing runs on insufficient scope | `test/auth-api.test.js`: owner + 4 agent profiles × 10 routes |
| `no-store`; public routes minimal; 401 before 404; HEAD/OPTIONS/path variants; header strictness; Authorization/SigV4 ignored; exact host/origin; CSP | `test/auth-api.test.js` (26) |
| Library code+PKCE/state/nonce; wrong nonce/missing ID token refused; email path no Google request; tokens memory only; transaction-only sessionStorage, cleaned; URL cleared | `test/auth-browser.test.js` |
| Wrong state, replay, bad/used code, cancel, Google blocked → chooser, both methods usable | `test/auth-browser.test.js` |
| Expiry/401 → chooser; late list/preview/upload/download can't bring anything back | `test/auth-browser.test.js` "the session ends without signing out" (5) |
| Logout: memory cleared, refresh token revoked only, `/logout` without token; revoke failure safe; race | `test/auth-browser.test.js` "signing out" (4) |
| Authorized upload/rename/delete, downloads (blob and S3 `{url}`), JPEG/PDF/text previews, blob revocation, token only to own `/api/`, no `/api` links in DOM | `test/auth-browser.test.js` "signed in: files with the token" (5) |
| 375/1280 px targets ≥ 44 px, accessible chooser | browser chooser and touch-target tests |
| Real entry points wire `AUTH_MODE`; logs carry no identifiers | `test/start.test.js`; smoke below |
| 100 MiB streamed upload, 1 MiB text preview, on-demand JPEG with unchanged originals | baseline api/storage/jpeg/browser tests, unchanged and passing; JPEG through login in auth-api and browser tests |
| Tests cannot reach AWS or read AWS configuration | `test/isolation.test.js` (6) |

## Verification 2026-10-13, self-audit round (Node v26.8.1, npm 11.19.0, installed Google Chrome, original `HOME`)
Counts in this section are that round's; the current counts are under "Close-out round 2026-10-13".
| Command | Exit / result |
|---|---|
| `git rev-parse HEAD` | `125cfb88d3292cee9f5ab82c924e60b088c34479` |
| Baseline before the audit fixes: sanitized `env …` (recipe below) `node --test` (spec report to a temp file) | exit 0: 533 tests, 533 pass, 0 fail/cancelled/skipped, 79 suites, ≈45 s |
| Focused RED/GREEN runs | as in the findings table (exit 1 for each RED, exit 0 for each GREEN) |
| Entry-point smoke (package scripts `start`/`demo` equivalents): a `node --input-type=module` script spawning `src/demo.js` and `src/server.js`, each in `isolatedEnv()`, no env-file flag, both auth modes, ports 3911–3914 | exit 0, 0 failures. demo: `/api/list` 200 (no login) / 401 `AUTH_REQUIRED` (cognito). server: 502 `STORAGE_ERROR` reason `NETWORK` (no login: the SDK could only reach the closed loopback port) / 401 (cognito). Health 200 and "listening" in all four |
| `npm test` (declared script) in the sanitized environment, spec report to a temp file | **exit 0: 538 tests, 538 pass, 0 fail, 0 cancelled, 0 skipped, 79 suites**, ≈45 s. npm's own update notifier printed a version notice (npm itself queried the registry; not requested) |
| Phase A and isolation files only | exit 0: 109/109 (isolation 6, auth 21, auth-api 26, auth-browser 27, config 18, start 11) |
| `node --check` on all 37 `.js` files in `src`, `src/storage`, `public`, `test`, `test/helpers` | exit 0, 0 failures |
| `git diff --check` | exit 0, no output |
| `grep -rnEc "A(KIA\|SIA)[0-9A-Z]{16}" src public test` | 0 in every file |
| Not run this round (as instructed) | `npm audit`, package installs, `npm start`/`npm run demo` themselves (they load `.env`) |

**Documentation corrections (2026-10-13, docs only; no application, test or dependency change):** README's isolation
guard block had lost its closing code fence (the API and Login sections rendered inside it) and now closes on its own
line; its guard command now matches the recipe below. The brief's §3 "Config" now names `AUTH_MODE` and the nine login
settings (D26, README "Login"). The verification recipe below now writes its report to
`/Users/eveso/.hermes/cache/scratch/` instead of `/tmp` and disables npm's update notifier. Verification afterwards:
`git diff --check` exit 0; a fence check over the four docs found every code fence balanced with bare closing lines; the
recipe below, run exactly as written: **exit 0, 538 tests, 538 pass, 79 suites, 0 fail/cancelled/skipped/todo**,
≈49 s, no npm notice.

## Safe verification recipe (for Eve)
Run from the project directory with the user's normal `HOME` (Chrome needs it) and **no global S3 endpoint override**
(presigned-URL tests expect the real `amazonaws.com` shape; real-server children get their own loopback endpoint):
The wrapper below starts from the caller's environment (so `HOME` is the user's own), removes profile, role,
web-identity, container, SSO, session/security-token and endpoint variables, adds null AWS config/credential files, disabled instance
metadata, synthetic keys and `npm_config_update_notifier=false`, runs the declared `npm test` with the spec report in
the scratch directory, and prints the raw exit code and the report's counts (no shell pipeline):
```sh
node -e '
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const report = "/Users/eveso/.hermes/cache/scratch/file-manager-phase-a-verify.txt";
const env = { ...process.env };
for (const n of Object.keys(env)) if (/^AWS_(PROFILE|DEFAULT_PROFILE|SESSION_TOKEN|SECURITY_TOKEN|ROLE_ARN|ROLE_SESSION_NAME|WEB_IDENTITY_TOKEN_FILE|CONTAINER_.*|SSO_.*|ENDPOINT_URL.*|IGNORE_CONFIGURED_ENDPOINT_URLS)$/.test(n)) delete env[n];
Object.assign(env, { AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_EC2_METADATA_DISABLED: "true",
  AWS_ACCESS_KEY_ID: "AKIDTESTONLYNOTREAL", AWS_SECRET_ACCESS_KEY: "test-only-not-a-real-secret", npm_config_update_notifier: "false" });
const r = spawnSync("npm", ["test", "--", "--test-reporter=spec", `--test-reporter-destination=${report}`,
  "--test-reporter=dot", "--test-reporter-destination=stdout"], { env, stdio: "inherit" });
const counts = Object.fromEntries([...fs.readFileSync(report, "utf8").matchAll(/^ℹ (\w+) (\d+(?:\.\d+)?)$/gm)].map((m) => [m[1], Number(m[2])]));
console.log(JSON.stringify({ exit: r.status, signal: r.signal, ...counts }));
process.exit(r.status ?? 1);'
```
Expected (since the close-out round's self-audit): `exit` 0, `tests` = `pass` = 547, `suites` 81, `fail`/`cancelled`/`skipped`/`todo` 0.
Never run `npm start`/`npm run demo` for verification: they load `.env`. Use `test/start.test.js`/`test/isolation.test.js`
or spawn `src/server.js`/`src/demo.js` with `isolatedEnv()` from `test/helpers/isolated-env.js` and no env-file flag.
Inner guards that hold even without the outer `env`: every real entry-point child is built by `isolatedEnv()` (only
`PATH` inherited, synthetic keys, `/dev/null` config files, IMDS off, `AWS_MAX_ATTEMPTS=1`, S3 → `http://127.0.0.1:1`),
`test/isolation.test.js` fails if any test spawns an entry point without it, and `fake-s3-client.js` isolates the
in-process SDK.

## Historical checkpoint (2026-10-11, recorded by Eve)
The first self-audit session (`781e94c4-0369-44bc-98b7-12a38c165c7f`) stopped with HTTP 429 (`terminal_reason=api_error`);
no retry, quota redemption or scheduled resumption was made. Eve's frozen-tree run then: `npm test` exit 0, 532 tests,
79 suites, 0 fail/cancelled/skipped; `node --check` 37 files; `git diff --check` exit 0; lockfile only the three expected
entries; artifact hash as above; isolated `npm audit --omit=dev --json` exit 0, 0 vulnerabilities. An earlier Eve
attempt timed out because a global S3 endpoint override broke presigned-URL tests and a scratch `HOME` affected Chrome
(harness, not app, issues). Her heuristic scan flagged the fixture fixed as I3. Logs:
`/Users/eveso/.hermes/cache/scratch/file-manager-phase-a-checkpoint.*`.

## Changed and new files (whole Phase A tree vs `125cfb8`)
- **New source:** `src/auth.js`, `public/auth.js`
- **Modified source:** `src/app.js`, `src/config.js`, `src/errors.js`, `src/start.js`, `public/app.js`, `public/index.html`,
  `public/style.css`
- **New tests/helpers:** `test/auth.test.js`, `test/auth-api.test.js`, `test/auth-browser.test.js`, `test/isolation.test.js`,
  `test/helpers/auth-fixtures.js`, `test/helpers/fake-oidc.js`, `test/helpers/isolated-env.js`
- **Modified tests/helpers:** `test/config.test.js`, `test/start.test.js`, `test/helpers/fake-s3-client.js` (2026-10-13)
- **Docs/config:** `README.md`, `IMPLEMENTATION_BRIEF.md`, `docs/AWS_LOGIN_PLAN.md` (untracked), `docs/HANDOFF.md`,
  `package.json`, `package-lock.json`; `CLAUDE.md` modified by Eve through her protected-file process
- **Changed in the 2026-10-13 self-audit:** `public/app.js`, `test/helpers/fake-s3-client.js`, `test/helpers/fake-oidc.js`,
  `test/isolation.test.js`, `test/auth-api.test.js`, `test/auth-browser.test.js`, `README.md`, `IMPLEMENTATION_BRIEF.md`,
  `docs/AWS_LOGIN_PLAN.md`, `docs/HANDOFF.md`
- **Changed in the 2026-10-13 close-out round:** `public/auth.js`, `src/auth.js`, `test/auth-browser.test.js`,
  `test/auth.test.js`, `IMPLEMENTATION_BRIEF.md`, `README.md`, `docs/AWS_LOGIN_PLAN.md`, `docs/HANDOFF.md`
- **Unchanged:** `src/demo.js`, `src/server.js`, `src/upload.js`, `src/paths.js`, `src/preview.js`, `src/jpeg-preview.js`,
  `src/storage/*`, `.env.example`, `.gitignore`. No generated or vendored file added.

## Instruction-file reconciliation (for Eve; not edited by the implementer)
`CLAUDE.md` (as reconciled by Eve) matches the code. Suggested small additions: (1) under `test/`, name
`test/isolation.test.js` and `test/helpers/isolated-env.js`, and that importing `test/helpers/fake-s3-client.js`
nulls AWS config/credential files and profile/endpoint variables for in-process tests; (2) under `public/`, "the token
is sent only to this origin's `/api/`"; (3) `src/start.js` also wires `AUTH_MODE`.

## Open gates and risks
- **Offline only.** Not shown: real Cognito hosted UI (Google resources on the email page), Cognito CORS for token/revoke,
  revoke with `token_type_hint=refresh_token`, `/logout` parameters, nonce in real ID tokens, `identity_provider`
  routing, `http://localhost` callback registration, MFA, recovery, account linking, corporate network, physical
  phones/mobile data, real S3. A mock flow does not close these.
- **Historical AWS uncertainty** (incident above and I2) remains unknown.
- **Residual access (documented):** issued access tokens valid until expiry; Cognito `/logout` doesn't sign out of Google;
  presigned S3 URLs live 5 minutes and sit in the DOM for S3 image/PDF previews; allowlist changes need a restart.
- **Upload stop on session end:** a file whose body already reached the server may still be stored.
- **No refresh:** sign in again when the access token expires (Cognito default 1 h) and after each reload.
- **Unapproved login:** the provider's hosted-UI session remains, so the same account may sign in again until it signs out there.
- **Partial-delete alert after session end** (D16 kept): it can show a folder name after the session ended.
- **JWKS:** fetched on the first token; unknown `kid` → one fetch, then a 10 s penalty box (401 meanwhile). A malformed
  key in the pool's JWKS → 503 until the pool's JWKS is fixed and refetched; its error class is logged. Real Cognito JWKS
  behaviour (rotation, caching) is not exercised offline.
- **Sign-in library unavailable:** the login area says so and sign-in is impossible until the vendor script loads.
- **Bundle upgrades:** update the pinned SHA-256 in `test/auth-api.test.js` deliberately after reviewing a new build.
- Carried over from M4 and earlier: see `docs/HANDOFF.md` in commit `125cfb8`.

## Next steps
1. Fresh independent read-only review of the frozen tree (verdict recorded in `docs/CLAUDE_REVIEW.md`), then Eve's
   deterministic/security/scope gates using the recipe above.
2. Eve: optional `CLAUDE.md` additions above; decide whether anything more is needed about the historical AWS uncertainty.
3. Phase B and Phase C each need their own approval; commit/push only on explicit approval.
