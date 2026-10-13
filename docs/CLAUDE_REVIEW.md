# Phase A close-out — independent review and Eve verification

## Current result — 2026-10-13 HKT

**VERDICT: PASS — Phase A local/offline close-out only.** Approved items 1–2 are complete: targeted fixes, same-session self-audit, fresh independent review, and Eve's separate deterministic verification. This supersedes the earlier 538-test review and pending header; it does not close real-provider/device/network/S3 acceptance or authorize commit/push/deployment.

- Official Claude Code 2.1.294, actual primary model claude-opus-5-5. Implementer/self-audit session `781e94c4-0369-44bc-98b7-12a38c165c7f`; fresh read-only reviewer session `f7232aaa-6a16-4c9a-8d2b-16d7d2db7d8c`.
- All three raw envelopes independently parsed: completed, is_error false, api_error_status null. Fresh reviewer Read/Bash only, no continuation.
- Frozen snapshot: `review-before.json` and `review-after.json` SHA-256 `06aab6cbb4e70016b832ece5f54d50e288357c2278b4fcdf3f2f041c37f6d742`; 49 nonsecret files plus HEAD/index/status unchanged through review and Eve's tests. HEAD `125cfb88d3292cee9f5ab82c924e60b088c34479`.
- Eve independently reran sanitized offline npm test at 16:20:57–16:21:43 HKT: exit 0, 547 tests, 547 pass, 81 suites, 0 fail/cancelled/skipped/todo. All 37 JavaScript syntax checks and git diff --check passed.
- Secret-pattern scan matched only the explicit synthetic isolation fixture in HANDOFF and isolated-env.js; no AWS key-ID/private-key matches. Dependencies and CLAUDE.md unchanged this round.
- Six findings disposed: vendor failure fixed/tested for 404 and 200 non-library at 375/1280 px; D26 table fixed; 401/503 error list fixed; HANDOFF inventory proposal rejected under policy; malformed provider JwkValidationError narrowly mapped to 503 while invalid-token/unknown-kid cases stay 401; current-isolation wording qualified and historical uncertainty retained.
- Four informational reviewer notes remain, listed below. None is a blocking verdict; do not silently turn these into an unapproved additional implementation round.
- CLI self-audit init unexpectedly exposed connected MCP tools. Eve parsed actual tool-use events: implementer Bash/Read/Edit/Write, self-audit Bash/Edit, reviewer Bash/Read only; no MCP/connector invocation. This exposure is not described as ideal tool isolation.
- Existing Claude subscription used. Envelope list-equivalent values: implementation USD 35.5929671, resumed self-audit USD 37.65736110000001, fresh review USD 3.4380986000000013. These are not evidence of charges; resumed-session values are not summed as incremental spend.

## Evidence and remaining boundaries

Evidence directory: `/Users/eveso/.hermes/cache/scratch/file-manager-closeout-20261013T155632-8f4b6f05/`. Raw implement/self-audit/review JSONL and envelopes, commands.md, RED/GREEN/mutation logs, original review.txt, immutable manifests, Eve eve-verification.json and eve-independent-tests.txt are retained there. Prior review evidence remains `/Users/eveso/.hermes/cache/scratch/file-manager-review-20261013T153918-0cbf742a/`.

Only this authoritative result artifact was replaced after verification. No source/test/dependency/other documentation edit followed the frozen review. A subsequent edit to that surface requires renewed review and verification.

No staging, commit, push, deployment, resource/account changes, real AWS/Google/S3 acceptance, quota reset/redemption or scheduled retry. Real Cognito/Google, corporate network, physical phones/mobile data, real S3 and Phase B/C remain separately gated. Historical 2026-10-11 AWS activity/config reads and earlier in-process config reads remain UNKNOWN.

## Original fresh reviewer report

**VERDICT: PASS.** This covers the local, offline Phase A close-out tree only. It is not real-world acceptance, and it doesn't approve a commit, push or deploy.

**Snapshot:**
- HEAD is `125cfb88d3292cee9f5ab82c924e60b088c34479`.
- The manifest `review-before.json` has SHA-256 `06aab6cb…6d742`, which matches.
- All 49 files, the index and the status matched the manifest at the start and again at the end (16:16 HKT).
- Nothing is staged.

I found no blocking defects. There are 4 informational notes, listed after the six findings.

## The six findings
1. **The sign-in library failing to load: fixed, and I verified it.**
   - **Code:** `public/auth.js:114-123` accepts the script only if `window.oidc.UserManager` exists, for both a load error and a 200 that isn't the library. On failure, `:255-259` shows the fixed message in the login area and disables both buttons. No click, `pageshow` or sign-out listener is registered, and `auth.signedIn` stays false, so hash navigation loads nothing. The message element has `role=alert` (`public/index.html:21`).
   - **Test:** `test/auth-browser.test.js:167-235` uses real Chrome with the vendor script answered through the DevTools Protocol: a 404 and a "200 but not the library" response, at 375 and 1280 px. It checks:
     - the message is visible inside the viewport and has `role=alert`
     - both buttons are disabled; the file UI and account bar are hidden
     - no storage call, no token reaching the server, no sign-in started
     - empty session and local storage, and no `oidc` global
   - **Logs:** the RED runs failed on assertions (`chooser:false, message:'', visible:false`), 2/2 and then 2/4. GREEN was 29/29, then 31/31.
   - **My own mutations, in a scratch copy:**
     - Restoring the old rethrow failed 4/4.
     - Dropping the library check failed the two "200 but not the library" cases.
     - Leaving the buttons enabled failed 4/4.
   - There is no unauthenticated fallback: the server still requires a token.
2. **The D26 table row: fixed.** `IMPLEMENTATION_BRIEF.md:15-42` has 26 decision rows with no gap, and D26 directly follows D25.
3. **401 and 503 in the error list: fixed.** `IMPLEMENTATION_BRIEF.md:63` lists them as login-mode only. The codes match `src/errors.js:97-107`.
4. **Not adopted, as policy requires.** HANDOFF's inventory (`docs/HANDOFF.md:240-255`) leaves out the review file, and HANDOFF mentions that file only as where verdicts live (`:8`, `:283`). The rejection is recorded at `docs/HANDOFF.md:50` and `IMPLEMENTATION_BRIEF.md:176`. I don't count it as a defect.
5. **Provider key problems now get 503, and the change is narrow.**
   - **Library code** (`aws-jwt-verify@5.2.1`, as installed):
     - `JwkValidationError` is a sibling class of `JwkInvalidUseError` and `JwkInvalidKtyError`, not their parent (`dist/esm/error.js:77,87,89`).
     - It is thrown only for the pool's own key data: while parsing the fetched JWKS (`jwk.js:133-152`), or when the chosen key lacks its fields (`jwk.js:95-130`).
     - A token only picks which key is used, by `kid`.
   - **App code:** the mapping is at `src/auth.js:66-75`.
   - **Tests:** `test/auth.test.js:150-216` checks a malformed field or a missing exponent gives 503 with only the class logged. These stay 401: an unknown `kid`, a second unknown `kid` during the library's 10 s wait period, no `kid`, an encryption key, and the wrong `alg`.
   - **Logs:** RED was 2 failures (401 instead of 503). GREEN was 25/25, now 26.
   - **My own mutations:**
     - Removing `JwkValidationError` from the mapping failed 2 tests.
     - Mapping every `Jwk*` error to 503 failed the "stays 401" test.
     - Mapping an unknown `kid` to 503 failed 4 tests.
     - Letting an email claim grant owner access failed 2 tests in `auth.test.js` and `auth-api.test.js`.
   - **Algorithm check:** I probed with the real library, offline.
     - Against a key that carries `alg` (as Cognito's do), these all get 401: ES256, RS512, EdDSA, PS256, a missing `alg`, `none`, a numeric `kid` or `iss`, and a garbage signature.
     - Only with a pool key that has no `alg` are an ES256 header or an **EdDSA** header over a genuine RS256 signature accepted. Self-audit S5 recorded only the ES256 case. Neither is a forgery, because both need the pool's private key.
     - Nothing a token sent produced a 503, and nothing was logged.
6. **README isolation wording: fixed.** `README.md:77-80` now limits the claim to the current tests and keeps the 2026-10-11 activity as unknown. The historical UNKNOWN is preserved in `docs/HANDOFF.md:17-22,29-37,268`, `IMPLEMENTATION_BRIEF.md:197` and `docs/AWS_LOGIN_PLAN.md:6`.

## The rest of Phase A, with no defect found
- **Login flow:** the library handles PKCE, state and the nonce (`public/auth.js:163-166`). Tokens are kept in `InMemoryWebStorage`, and only login transactions under `fm.oidc.` go in sessionStorage (`:140-141`).
- **Sign-out:** it clears the page first, revokes only the refresh token, then calls `/logout` without `id_token_hint` (`:79-90`).
- **Access:** owner = an owner client plus an exact sub; agent = `sub === client_id` with no `username`; scopes are the configured ones the token also grants; email is never used (`src/auth.js:78-88`).
- **Requests:** the exact host and Origin guards, `no-store`, and 401 before 404 are in `src/app.js`. Request bodies are parsed only after the token check, and the token header must be a single value.
- **Session end and leaks:** session end invalidates late list, preview, upload and download work. No HTML sinks; only error class names are logged.
- **No-login mode** is unchanged.
- **Uploads, downloads and previews:** the 100 MiB upload limit, the 1 MiB text cap and the JPEG preview pipeline all have passing tests.
- **Dependencies:** `package.json` and the lockfile are byte-identical to the previous review and unchanged this round. The lockfile adds only 3 entries. Installed versions are 5.2.1, 3.5.0 and 4.0.0, with no install scripts. The browser bundle is 70,851 bytes, and its SHA-256 `f999daa3…f1ef` matches the test and the docs.
- **Files changed this round:** the comparison with `delegation-start.json` shows exactly the 8 claimed files changed. `CLAUDE.md` and `docs/CLAUDE_REVIEW.md` were not touched.

## Tests and checks I ran
- **Full suite:** the HANDOFF recipe with my normal `HOME`, synthetic keys, `/dev/null` AWS config files, instance metadata off, AWS profile and endpoint variables removed, the npm notifier off, and no global S3 endpoint. Result: `{"exit":0,"tests":547,"pass":547,"suites":81,"fail":0,"cancelled":0,"skipped":0,"todo":0}` in about 46 s. Chrome was found and the browser suites ran (no `# SKIP` lines).
- **Syntax:** `node --check` on all 37 `.js` files, 0 failures.
- **Whitespace:** `git diff --check` exit 0. No `MUTATION` markers remain.
- **Docs:** code fences balanced with bare closing lines in all six docs. HANDOFF names `docs/CLAUDE_REVIEW.md` only as where verdicts live.
- **Secret scan:** no AWS key IDs, private keys or tokens. The only secret-like values are the synthetic `test-only-not-a-real-secret` placeholders.
- **Evidence files:** everything I wrote is in the artifact directory with `review-` prefixes: the full report, the mutation logs, a scratch copy without `.env`, the probe, and the fingerprint script.

## Informational notes (none blocks)
1. **Info:** the no-`alg` header acceptance is broader than S5 recorded: EdDSA as well as ES256. It doesn't matter for Cognito keys, which carry `alg`.
2. **Info:** a vendor request that hangs, instead of failing, leaves a blank page until the browser's own network timeout. It still fails closed.
3. **Info, older than this round:** in login mode, the toolbar is visible for a moment before `/api/auth/config` answers. Any action in that window gets 401, because no token exists yet.
4. **Info, cosmetic:** the comment at `src/errors.js:99` says 503 means the JWKS is unreachable; it now also covers a malformed pool key.

## Not covered
These are still open, and offline tests don't close them:
- real Cognito and Google, MFA, recovery and account linking
- the `localhost` callback, revoke and `/logout` against a real pool
- the corporate network, physical phones and mobile data, real S3
- real key rotation and caching
- Phase B and Phase C

The historical AWS activity remains unknown: whether the 2026-10-11 startup test read config or contacted AWS, and whether earlier in-process runs read config files.

I did not run `npm start`, `npm run demo`, installs or audits. I read no `.env`, `~/.aws` or credentials, made no network, provider or AWS calls, and hit no 429.

**Changed repository files: NONE.**