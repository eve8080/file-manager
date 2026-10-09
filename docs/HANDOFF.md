# Handoff

_Last updated: 2026-10-09. Implementation stopped after fixing the two blockers from the independent review of the D19 changes. M2 has not been started._

## Current goal and approved milestone
- **Approved milestone:** M1, browse and folders. M0 passed earlier review.
- **Review history:**
  - Eve's first review: 4 findings, fixed.
  - Eve's second review: 3 items, fixed.
  - A fresh, read-only Claude review returned **PASS**, with 6 non-blocking findings. N1–N4 were fixed (D18).
  - A re-review after N1–N4 (`docs/CLAUDE_REVIEW.md`, 2026-10-09) returned **PASS**, with 4 non-blocking findings.
- **D19 (2026-10-09):** Mr. So delegated acceptance to Eve and approved fixing those 4 remaining findings, then
  moving on to M2 without his manual review. **This session fixed only those 4.**
- **The independent review of the D19 changes returned BLOCK** with 2 blocking findings, both fixed in a
  follow-up session (see "Blocking review fixes" below). That review's text was given in the task prompt;
  `docs/CLAUDE_REVIEW.md` still holds the earlier PASS review and was not edited.
- **Before M2 starts:** M1 still needs a fresh, independent, read-only Claude review and Eve's deterministic gates.
  Nothing here claims Eve's acceptance.

## Blocking review fixes (after the D19 review BLOCK)
Each blocker was handled as one slice: regressions first, red captured against unchanged code, minimal fix,
green, and only then the next blocker.

| # | Blocker | Root cause | Fix | Tests |
|---|---|---|---|---|
| B1 | A bounded non-recursive delete ignored `IsTruncated`: when S3 returns a short page, the marker was deleted even though a child exists | `firstKeysUnder` read only the first `ListObjectsV2` page. S3 may return fewer than `MaxKeys` keys and still be truncated, so with only the marker seen, the folder looked empty | `src/storage/s3.js` `firstKeysUnder` uses `listPages` (with `MaxKeys`) and follows continuation pages **only until** `maxKeys` keys are seen or the listing ends. It is still one request with `MaxKeys: 2` when S3 returns a full page (the existing "bounded listing" test still passes). `createFolder`'s `anyUnder` gets the same protection | `test/storage.test.js` "follows a short truncated page…": fake S3 `pageSize: 1`, `x/` and `x/child.txt` → `FOLDER_NOT_EMPTY`, 0 delete calls, both keys kept, exactly 2 list requests. `test/api.test.js` "returns 409 and keeps the marker when S3 returns the marker and a child on separate pages": `DELETE /api/folders?path=x/` → 409 `FOLDER_NOT_EMPTY`, both keys kept |
| B2 | Overlapping same-folder mutations could erase a partial-delete (possible data loss) warning | When the partial delete's own reload was superseded, it showed the warning once and returned. The later success's `reloadAndReport` then took `pendingReports` (successes only) and replaced the warning with e.g. `Created folder "one".` If the user navigated before that later reload finished, nothing was alerted either | `public/app.js`: `pendingReports` now holds `{ text, isError }` sentences. The partial-delete branch goes through `reloadAndReport(nav, message, true)`, so whichever current reload finishes last shows **all** queued outcomes and is an error if any of them is. The `hashchange` handler still clears the queue (D16), but alerts any dropped warning. The N3 messages are unchanged | `test/browser.test.js` "a partial-delete warning is never replaced by a later success" (2 tests). (1) Same folder: the final status contains `Delete of "big" stopped partway: 2 deleted, 1 may remain.` and `Created folder "one".`, as an error. (2) After navigating to `#/other/`: the new folder's status is `''` and exactly one alert carries the warning |

**Assessment of the non-blocking note (ordinary errors replaced by later successes):** not changed. An ordinary
error (e.g. 409 `FOLDER_EXISTS`, a failed delete) is shown at once and has no reload. Putting it in the queue
would leave it there until some later report, which would then repeat a stale error next to an unrelated
success. So the queue doesn't cover it safely, and it is listed as an open item below.

### Red/green evidence (blockers)
| Step | Command | Result |
|---|---|---|
| B1 red (storage) | `node --test --test-name-pattern="short truncated page" test/storage.test.js` | 1 test, **1 fail**: `Missing expected rejection` (`FOLDER_NOT_EMPTY`) |
| B1 red (effect) | one-off `node --input-type=module` script: `createS3Storage` with `FakeS3Client({ 'x/': '', 'x/child.txt': 'c' }, { pageSize: 1 })`, then `deleteFolder('x/')` | returned `1`; remaining keys `['x/child.txt']`; `deleteCalls 1`, so **the marker was deleted while a child existed** |
| B1 red (API) | `node --test --test-name-pattern="separate pages" test/api.test.js` | 1 test, **1 fail**: `actual: 200, expected: 409` |
| B1 green | `node --test --test-name-pattern="short truncated page\|bounded listing" test/storage.test.js`; `node --test --test-name-pattern="separate pages" test/api.test.js`; `node --test test/storage.test.js test/api.test.js` | 2/2; 1/1; 90/90 |
| B2 red | `node --test --test-name-pattern="never replaced by a later success" test/browser.test.js` | 2 tests, **2 fail**: same folder `actual: 'Created folder "one".'` (warning gone); after navigation `alerts 0 !== 1` |
| B2 green | same | 2/2 pass |
| B2 related | `node --test --test-name-pattern="overlapping mutations\|M1 closure: N3\|review 2, finding 1\|finding 3: partial" test/browser.test.js` | 17/17 pass |

## D19: the four final M1 closure findings (test-first, one at a time)
For each finding, a focused regression test was added first and run against unchanged code (red). Then the
minimal fix was made and the test was rerun (green) before the next finding started.

| # | Review finding | Root cause | Fix | Test |
|---|---|---|---|---|
| 1 | `GET /api/list?prefix[a]=b` → 200 root listing (review finding 1, earlier finding 6) | Express 5's default `simple` query parser keeps `prefix[a]` as a literal key, so `req.query.prefix` was `undefined` and the root default was used. The same applied to `path[…]`, `confirm[…]` and `recursive[…]`, so `recursive[a]=true` was silently treated as `false` | `src/app.js`: new `queryParam(req, name)` rejects any `name[…]` key with 400 `BAD_REQUEST` (`<name> must be a single value`). It is used for `prefix`, `path`, `recursive` and `confirm`. Repeated values keep their existing 400 handling | `test/api.test.js` "structured query values (D19)": `prefix[a]=b`, `prefix[]=docs`, `path[a]=…`, `recursive[a]=true`, `confirm[a]=docs` all → 400 `BAD_REQUEST`, and `empty/` and `docs/` are untouched |
| 2 | A non-recursive delete listed every key under the folder (review finding 2, earlier finding 5) | `deleteFolder` in `src/storage/s3.js` always called `allKeysUnder(prefix)`, which reads every page, before checking `recursive` | A non-recursive delete now makes one `ListObjectsV2` request with `MaxKeys: 2` (new `firstKeysUnder`; `anyUnder` reuses it). The marker `prefix` sorts before every key under it, so 0 keys → 404, any key other than the marker → 409, and the marker alone → delete it. A recursive delete still lists everything | `test/storage.test.js` "s3 driver specifics": `big/` with a marker plus 2500 keys → `FOLDER_NOT_EMPTY` after exactly **1** list request with `MaxKeys ≤ 2`, no delete call, and all 2501 objects kept. The storage contract tests (empty, marker-only, implicit, missing, non-empty) still pass for memory, s3, and s3 with 2-item pages |
| 3 | Overlapping mutations in one folder could drop a success message (review finding 3) | `load()` aborts the previous load. When a second create/delete (or a partial delete) started its reload, the first `reloadAndReport` got `{stale}` and returned, so its success was never shown | `public/app.js`: `pendingReports` holds successes whose reload hasn't reported yet. `reloadAndReport` adds to it, and whichever current reload finishes last reports all of them (`Created folder "one". Created folder "two".`). On a failed reload it uses the same format as N3. The partial-delete branch also takes pending successes when its own reload is current (`Created folder "one". Delete of "big" stopped partway: …`). B2 below later generalised this into one `{ text, isError }` queue. **D16 is unchanged:** `pendingReports` is cleared on `hashchange`, so nothing is reported in a folder the user navigated to | `test/browser.test.js` "M1 closure (D19): overlapping mutations in the same folder" (3 tests): two overlapping creates; a create overlapped by a partial delete; and a D16 guard, where a create's reload is cut short by navigation and a later create in the new folder reports only itself |
| 4 | D18 was listed before D17 in `IMPLEMENTATION_BRIEF.md` (review finding 4) | Docs ordering | **No edit by this session.** Eve's pre-existing worktree change to the brief already puts D17 before D18 and adds D19. I checked it mechanically (below) and kept it as it was | Docs only, so there is no automated test. The order check is below |

### Red/green evidence
| Step | Command | Result |
|---|---|---|
| F1 red | `node --test --test-name-pattern="structured query values" test/api.test.js` | 1 test, **1 fail**: `GET /api/list?prefix[a]=b` `200 !== 400` |
| F1 green | same | 1/1 pass. `node --test test/api.test.js`: 43/43 |
| F2 red | `node --test --test-name-pattern="bounded listing" test/storage.test.js` | 1 test, **1 fail**: "one listing request, not the whole prefix" `3 !== 1` |
| F2 green | same | 1/1 pass. `node --test test/storage.test.js test/api.test.js`: 88/88 |
| F3a red | `node --test --test-name-pattern="overlapping mutations" test/browser.test.js` | 2 tests: **1 fail**, status `'Created folder "two".'` instead of `'Created folder "one". Created folder "two".'`. The D16 guard passed, as expected, because the old code had no pending reports to leak |
| F3a green | same | 2/2 pass |
| F3a guard check | temporarily removed `pendingReports = []` from the `hashchange` handler, ran `--test-name-pattern="cut short by navigation"`, then restored the file (backup restored and removed) | **fails** without the clear, so the guard catches a D16 leak. Passes once restored |
| F3b red | `node --test --test-name-pattern="partial delete's reload" test/browser.test.js` | 1 test, **1 fail**: status began `Delete of "big" stopped partway…` and the create's success was missing |
| F3b green | `node --test --test-name-pattern="overlapping mutations\|M1 closure: N3" test/browser.test.js` | 6/6 pass (3 D19 tests plus the 3 N3 exact-message tests, unchanged) |
| F4 | order check of `^\| D<n>` rows: `git show HEAD:IMPLEMENTATION_BRIEF.md` vs. the worktree file | HEAD: `…,16,18,17` **out of order** (exit 1). Worktree: `1…19` **in order** (exit 0) |

## Completed work (cumulative)
- **Project docs**, M0, and M1 (folders: list, create, delete with server-side confirmation, structured
  partial-delete errors, fixed storage-error reasons).
- **Phone-first UI:** breadcrumbs, stale-response guards for loads and mutations, canonical URL hash, sorting,
  44px touch targets.
- **Hardened test harness:** Chrome lifecycle, fake S3, fake Chrome.
- **M1 closure:** N1–N4 (D18), plus the four D19 findings (this session).

## Incomplete, deferred and open items
- **Not started:** M2 (file operations), M3 (previews), M4 (manual real-S3 check).
- **Not checked by a person** on a desktop browser or a phone. **Not run against real S3.**
- No linter, type checker or build step, by design.
- **Known, not in D19 scope:**
  - An ordinary (non-partial) create/delete error, e.g. 409 `FOLDER_EXISTS`, can still be replaced by a later
    overlapping success's status in the same folder. It is not data loss; see the assessment under "Blocking
    review fixes". Eve decides whether to address it.
  - The top-level `"name"` in `package-lock.json` is `file-manager`, but `package.json` says `s3-file-manager`.
    This was already true at HEAD. It is cosmetic: the dependency specs match exactly and `npm ls --all` is clean.
    I left it alone because fixing it would mean an `npm install` or a hand edit to the lockfile.

## Key decisions and reasons
D1–D18 are unchanged; D19 was added by Eve (not by this session).

| # | Decision | Reason |
|---|---|---|
| — | F1: reject `name[…]` keys inside the route (`queryParam`), not by switching the query parser | Smallest change. It covers every query parameter the API uses, and repeated values keep their existing errors (e.g. `confirm=a&confirm=a` stays `CONFIRMATION_MISMATCH`) |
| — | F2: `MaxKeys: 2` for a non-recursive delete only | The brief asks for "at most the marker plus one child". A recursive delete must still enumerate everything |
| — | F3: report pending successes from the reload that finishes last; clear them on navigation | Every success stays visible, and D16 (no notices after navigation) is kept |
| — | F4: no edit | Eve's uncommitted brief change already fixes the order |

## Changed files (this session, uncommitted)
HEAD is `a8f2021` ("Complete M1 folder browsing workflow"). A remote `origin`
(`https://github.com/eve8080/file-manager.git`) is configured. I didn't add it, and nothing was pushed or fetched.
- `src/app.js`: F1 `queryParam`
- `src/storage/s3.js`: F2 `firstKeysUnder` and the bounded non-recursive check; B1 continuation pages
- `public/app.js`: F3 `pendingReports` and the clear on navigation; B2 `{ text, isError }` queue, the partial-delete
  branch through `reloadAndReport`, and the alert for dropped warnings
- `test/api.test.js`: 2 new tests (F1, B1)
- `test/storage.test.js`: 2 new tests (F2, B1); imports `ListObjectsV2Command`
- `test/browser.test.js`: 5 new tests (F3 ×3, B2 ×2)
- `docs/HANDOFF.md`: this file
- **Pre-existing, preserved and not edited:** `IMPLEMENTATION_BRIEF.md` (Eve's D19 change)
- **Unchanged:** `package.json`, `package-lock.json`, `README.md`, `CLAUDE.md` and all other files. No new
  dependencies.

## Verification (2026-10-09, Node v26.8.1, npm 11.19.0, Google Chrome 155.0.8059.39)
All rerun after the blocker fixes.

| Command | Result |
|---|---|
| `node --test --test-name-pattern="short truncated page\|bounded listing\|separate pages\|structured query values\|overlapping mutations" test/storage.test.js test/api.test.js test/browser.test.js` | 9/9 pass, 0 skipped |
| `node --test test/browser.test.js test/chrome-helper.test.js` | 39/39 pass, 0 skipped |
| `npm test` | exit 0: **154 tests, 154 pass, 0 fail, 0 skipped**, 0 cancelled, 29 suites (150 before the blocker fixes) |
| `git diff --stat HEAD -- IMPLEMENTATION_BRIEF.md docs/CLAUDE_REVIEW.md README.md CLAUDE.md` | only Eve's brief change (14 lines); the other files are unchanged |
| `pgrep -fl` for Chrome, fake Chrome, demo, server and `node --test` processes | none |
| `node --check` on all 19 `.js` files in `src/`, `src/storage/`, `public/`, `test/`, `test/helpers/` | no failures |
| `npm ls --depth=0` / `npm ls --all` | exit 0 / exit 0: `@aws-sdk/client-s3@3.1147.0`, `express@5.2.1` |
| Lockfile check (`package.json` deps vs `package-lock.json` `packages[""]`, lock vs installed versions) | dependency specs identical; lock and installed match (3.1147.0, 5.2.1); lockfileVersion 3. The top-level name differs, as at HEAD (see open items) |
| `git diff --quiet HEAD -- package.json package-lock.json` | unchanged vs HEAD |
| Leftovers: `pgrep` for Chrome/demo/server; `$TMPDIR` `file-manager-chrome-*` / `file-manager-fake-chrome-*` | none / 0 |
| `npm audit` | **Not run.** It sends the lockfile to the npm registry (a network write). Dependencies are unchanged |
| Real S3 / manual browser or phone check | Not run |

## Risks
- **Security:** there is no login. The app binds to `127.0.0.1` by default, and the Host guard is the only
  defence against DNS rebinding. **Never port-forward, tunnel or deploy it before a login milestone.**
- **Data loss:** recursive deletes are permanent without bucket versioning. Partial failures are reported but not
  rolled back. A request that times out may still have deleted its batch on S3.
- **Privacy:** server logs contain raw S3 error details and up to 20 object keys per failed delete, and stay local.
  Clients see only fixed reasons.
- **Credentials:** never read or stored by the app; `.env` is git-ignored.
- **Operational:** port 3000 on this Mac is used by another program, so set `PORT` (e.g. `PORT=3001`) for M4.
- **Browser tests:**
  - They need local Chrome, and are skipped (not passed) without it.
  - They use fixed delays (300–900 ms), including in the new D19 tests. These were stable here but could be
    flaky on a very slow machine.
  - The helper is POSIX-only.
  - Ctrl+C can leave a headless Chrome behind (`pkill -f file-manager-chrome-`).
- **Correctness gaps:** unproven against real S3; keys containing `//` are hidden; a file and a folder can share a
  name; the existence check before creating a folder is not atomic; the ordinary-error overlap noted above.

## Next recommended step
1. **A fresh, independent, read-only Claude review of M1** (D19), covering the B1/B2 fixes. With Chrome present,
   expect `npm test` to show 154 pass, 0 skipped.
2. Eve runs her deterministic gates and decides on M1 acceptance.
3. Commit only with explicit approval. No push.
4. M2 only after those gates pass.
