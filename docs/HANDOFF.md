# Handoff

_Last updated: 2026-10-09. Implementation stopped after the M1 closure fixes N1–N4._

## Current goal and approved milestone
- **Approved milestone:** M1, browse and folders. M0 passed earlier review.
- **Review history:**
  - Eve's first review: 4 findings, fixed.
  - Eve's second review: 3 items, fixed.
  - A fresh, read-only Claude review (`docs/CLAUDE_REVIEW.md`, 2026-10-09) returned **PASS**, with 6
    non-blocking findings.
- **This session:** Mr. So approved fixing **N1–N4** before M1 acceptance. Only those four were changed.
  Review findings 5 and 6 are still open (see below).
- **A new fresh review is required.** The earlier PASS covered the previous tree, and this session changed code
  (`src/start.js`, `public/app.js`) and tests. **M1 is not accepted yet**, and nothing here claims Eve's approval.
- M2 has not been started.

## N1–N4: fixes and tests (test-first)
Each regression test was written first and run against the unchanged code.

| # | Finding | Before the fix (red) | Fix | Test |
|---|---|---|---|---|
| N1 | `src/start.js` printed "listening" even when binding failed (Express 5 also calls the `app.listen` callback on error) | 2 of 4 failed: stdout contained `… listening on http://127.0.0.1:<busy port>` | `src/start.js`: `http.createServer(app)`, and success is logged only on the `'listening'` event. `'error'` prints exactly one line, e.g. `Could not start server: 127.0.0.1:3000 is already in use (EADDRINUSE). Set PORT to a free port.`, then exits 1. Other errors print `err.message` | `test/start.test.js` (new, 4 tests): runs the real `src/demo.js` and `src/server.js` (dummy S3 settings, no AWS call) as child processes. On a busy port: exit 1, exactly one stderr line, no "listening". On a free port: "listening" with the right URL and empty stderr |
| N2 | An undecodable hash (`#/%E0%A4%A/`) showed the root but kept the bad URL, breaking the URL = `current.prefix` rule | 3 of 3 failed: hash stayed `#/%E0%A4%A/`; navigating to `#/docs/%ZZ/` never became `#/`; `#/docs` stayed `#/docs` | `public/app.js` `load()`: computes the canonical hash with `hashFor(prefix)` and, if it differs, calls `history.replaceState`. That doesn't fire `hashchange`, so it can't loop, and it adds no history entry. An undecodable hash therefore becomes `#/` | `test/browser.test.js` "M1 closure: N2" (3 tests): checks for an undecodable hash on first load and on navigation, and a non-canonical `#/docs`. Each asserts the final hash, the displayed folder, and **the exact list requests made**, which proves there's no loop. It also checks `history.length` (replaced, not pushed) and that a folder created from the canonicalised screen lands in the root |
| N3 | After a successful create, a failed reload's error was overwritten by "Created folder" | 3 of 3 failed: create and delete timed out waiting for the reload error (it was overwritten); the partial-delete status lacked the reload error | `load()` now resolves to `{ok}`, `{ok:false, message}` or `{stale}`. New `reloadAndReport()` is used after create and delete. Success → `Created folder "x".` Reload failed → `Created folder "x", but the folder could not be reloaded: <message>` (shown as an error). Partial delete appends ` The folder could not be reloaded: <message>`. A stale reload, or a navigation in the meantime, still reports nothing (D16 unchanged) | `test/browser.test.js` "M1 closure: N3" (3 tests): a simulated 502 on the reload after create, after delete, and after a partial delete. Each asserts the exact error status |
| N4 | No automated coverage for sorting, folders-first, or toolbar touch targets | Passed on the first run. This is coverage only: the behaviour was already correct, as the review found manually | No app change | `test/browser.test.js` "M1 closure: N4" (3 tests): the select offers exactly six orders; each order produces the exact expected row sequence (numeric-aware names, sizes, dates) with folders first. New-folder input, Create button and sort select are at least 44×44 CSS px at 375 px and 1280 px wide |

**Problem found and fixed in a test while verifying:** the N2 `history.length` assertion passed alone but failed
in the full run (`actual: 50`), because all browser tests share one tab and Chrome caps history at 50.
`open()` in `test/browser.test.js` now calls the Chrome DevTools command `Page.resetNavigationHistory` between
`about:blank` and the page under test. No app change was needed.

**Unchanged by request:** a create or delete that finishes after the user has navigated away still never changes
the destination folder's status, and there is no new notice area. A partial delete is still reported with
`alert()` (D16).

## Completed work (cumulative)
- **Project docs**, M0, and M1 (folders: list, create, delete with server-side confirmation, structured
  partial-delete errors, fixed storage-error reasons).
- **Phone-first UI:** breadcrumbs, stale-response guards for both loads and mutations, canonical URL hash,
  sorting, 44px touch targets.
- **Hardened test harness:** Chrome lifecycle, fake S3, fake Chrome.
- **This session:** N1–N4.

## Incomplete, deferred and open items
- **Not fixed (not in the approved N1–N4 scope), from `docs/CLAUDE_REVIEW.md`:**
  - **Finding 5:** a non-recursive delete lists every key under the folder just to check whether it is empty.
    This is slow on very large folders.
  - **Finding 6:** `?prefix[a]=b` lists the root (200) instead of returning 400.
- **Not started:** M2 (file operations), M3 (previews), M4 (manual real-S3 check).
- **Not checked by a person** on a desktop browser or a phone. **Not run against real S3.**
- No linter, type checker or build step, by design.

## Key decisions and reasons
D1–D17 are unchanged. Added:

| # | Decision | Reason |
|---|---|---|
| D18 | Record N1–N4 as approved M1 closure fixes, each with a regression test (`IMPLEMENTATION_BRIEF.md` §2 and §5) | Mr. So's instruction (2026-10-09) |
| — | N1: listen through `http.createServer` and log on `'listening'` | Express 5's `app.listen` callback also fires on failure |
| — | N2: canonicalise with `history.replaceState` inside `load()` | It doesn't fire `hashchange`, so it can't loop and adds no history entry. One place covers both first load and navigation |
| — | N3: report success and the reload error together, as an error | Keeps both facts: the folder was created or deleted, and the list shown may be out of date |

## Changed and untracked files
The branch is `main` with **no commits** and **no remote**. `git diff` is empty because nothing is tracked.
`git status --short --untracked-files=all` lists **30** untracked files: the 28 from the last handoff, plus
`docs/CLAUDE_REVIEW.md` (added by the reviewer, not edited this session) and `test/start.test.js` (new).

Changed this session:
- **New:** `test/start.test.js`
- **Modified:**
  - `src/start.js`: N1
  - `public/app.js`: N2 canonical hash; N3 `load()` result plus `reloadAndReport()`
  - `test/browser.test.js`: list-call recording, list-failure hook, history reset in `open()`, 9 new tests for
    N2, N3 and N4
  - `IMPLEMENTATION_BRIEF.md`: D18 and M1 criteria
  - `README.md`: what to do when port 3000 is in use
  - `CLAUDE.md`: test list
  - this file
- **Unchanged:** `package.json`, `package-lock.json` and all other source files. There are no new dependencies.
- **Not in git:** `node_modules/` is ignored. There is no `.env`.

## Verification (2026-10-09, Node v26.8.1, npm 11.19.0, Google Chrome 155.0.8059.39)
| Command | Result |
|---|---|
| `node --test test/start.test.js` before the N1 fix | 2 pass, **2 fail** (expected: "listening" printed on a busy port) |
| `node --test --test-name-pattern="M1 closure" test/browser.test.js` before the N2/N3 fixes | 3 pass (N4), **6 fail** (expected: N2 ×3, N3 ×3) |
| `node --test test/start.test.js` after the fix | exit 0, 4/4 pass |
| `node --test --test-name-pattern="M1 closure" test/browser.test.js` after the fixes | 9/9 pass, 0 skipped |
| `npm test` (first full run after the fixes) | 144/145; **1 fail**: the N2 `history.length` assertion (`actual: 50`). The cause was shared tab history; fixed in the test as described above |
| `node --test test/browser.test.js test/chrome-helper.test.js`, 3 runs after that fix | exit 0, **34/34 pass, 0 skipped**, every run (25 browser + 9 helper) |
| `npm test` (final full suite) | exit 0. **145 tests, 145 pass, 0 fail, 0 skipped**, 0 cancelled, 26 suites |
| `node --check` on all 19 `.js` files in `src/`, `src/storage/`, `public/`, `test/`, `test/helpers/` | exit 0 |
| `npm ls --depth=0` | exit 0: `@aws-sdk/client-s3@3.1147.0`, `express@5.2.1`; nothing else |
| Smoke: `node src/demo.js` and `node src/server.js` (dummy S3 settings) on the default port 3000, which is held on this Mac by `node`, pid 1862 | each printed exactly `Could not start server: 127.0.0.1:3000 is already in use (EADDRINUSE). Set PORT to a free port.` with exit 1 and no "listening" line |
| Smoke: `PORT=3123 node src/demo.js` plus `curl` | health 200; list 200; create folder 201; recursive delete with `confirm` 200; `/app.js` 200; `Host: evil.example` 403. Server stopped |
| Smoke: `node src/server.js` with dummy S3 settings on `PORT=3124` | `/api/health` 200 (no storage call, so no AWS contact). Server stopped |
| Leftovers: `find $TMPDIR … 'file-manager-chrome-*' 'file-manager-fake-chrome-*'` and `ps` | 0 profiles, no stray Chrome, fake, demo or server processes |
| `npm audit` | **Not run this session.** It sends the lockfile to the npm registry, and it wasn't in this task's verification list. The last run was 2026-10-08 (0 vulnerabilities), and dependencies are unchanged since (`npm ls` above) |
| Lint / type check / build | Not available (none configured) |
| Real S3 / manual browser or phone check | Not run |

## Risks
- **Security:** there is no login. The app binds to `127.0.0.1` by default; the Host guard is the only defence
  against DNS rebinding. **Never port-forward, tunnel or deploy it before a login milestone.**
- **Data loss:** recursive deletes are permanent without bucket versioning. Partial failures are reported but not
  rolled back. A request that times out may still have deleted its batch on S3.
- **Privacy:** server logs contain raw S3 error details and up to 20 object keys per failed delete, and stay local.
  Clients see only fixed reasons.
- **Credentials:** never read or stored by the app; `.env` is git-ignored.
- **Deployment:** none. No remote.
- **Operational:** port 3000 on this Mac is used by another program (pid 1862). `npm start` and `npm run demo`
  will fail cleanly until `PORT` is set, for example `PORT=3001` in `.env`. This matters for M4.
- **Browser tests:**
  - They need local Chrome, and are skipped (not passed) without it.
  - Fixed delays (400/700 ms) were stable in all runs but could be flaky on a very slow machine.
  - The helper uses `/bin/sh`, `ps` and process groups, so it isn't Windows-compatible.
  - If the run is stopped with Ctrl+C, a detached headless Chrome can be left behind
    (`pkill -f file-manager-chrome-`).
- **Correctness gaps:**
  - Review findings 5 and 6 above.
  - Unproven against real S3.
  - Keys containing `//` are hidden.
  - A file and a folder can share a name.
  - The existence check before creating a folder is not atomic.

## Next recommended step
1. **A new fresh review of M1**, because the previous PASS covered the earlier tree. Expect `npm test` to show
   145 pass, 0 skipped, when Chrome is present.
2. Mr. So or Eve decides whether review findings 5 and 6 should be fixed before M1 acceptance or deferred.
3. If M1 is accepted, a first **local** commit, only with explicit approval. No push.
4. M2 only after explicit approval.
