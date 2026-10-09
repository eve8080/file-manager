# Handoff

_Last updated: 2026-10-09. M1 (`1fa3d1b`) and M2 (`d4d6b50`) are committed and reviewed; their session
histories are in those commits' `docs/HANDOFF.md`. **M3 (preview) implementation and verification evidence is
recorded below.** The authoritative independent-review verdict is `docs/CLAUDE_REVIEW.md`._

## Status
- **M3 acceptance criteria:** all implemented test-first (see "M3 acceptance criteria → evidence").
- `npm test`: **377/377 pass, 0 skipped** (317 before M3).
- Fresh read-only Claude review `3e5422ad-d5a3-4d61-b368-ca36ed32f760`: **PASS**, no blocking findings.
- The review's documentation findings are corrected in this snapshot. A post-correction review attempt stopped at Claude's
  usage limit before a verdict; Mr. So explicitly requested commit and push, so the pushed commit retains this fact and
  may receive a follow-up review without history rewriting.
- New decision **D24** in `IMPLEMENTATION_BRIEF.md` (preview kinds, 1 MiB cap, presigned inline URLs, the
  memory/demo content route, the CSP change). No new dependency; `package.json`/lockfile unchanged.
- `CLAUDE.md` records the M3 architecture and stale-preview rules.

## M3 slice log (strict red → green, recorded as it happened)
Baseline before any M3 change (HEAD `d4d6b50`, clean tree): `npm test` → 317 tests, 317 pass, 0 skipped.

| Slice | RED command and result | GREEN result |
|---|---|---|
| P1 `previewKind(key)` + `PREVIEW_TEXT_BYTES` (`src/preview.js`, new) | `node --test test/preview.test.js` → **1 fail**: `ERR_MODULE_NOT_FOUND … src/preview.js` | 6/6 |
| (test infra) fake S3 `GetObject` with `Range` (clamped end; 416 `InvalidRange` on an empty object; `NoSuchKey`; `Body.transformToByteArray()`) | no production change | — (exercised from P2 on) |
| P2 storage contract `getPreview` for text (memory, s3, s3 2-item pages): small/empty file, HTML returned raw, exactly 1 MiB vs 1 MiB + 1 byte, a multi-byte character split by the limit, missing key / folder name → `NOT_FOUND` for every kind | `node --test --test-name-pattern="^preview" test/storage.test.js` → **15 of 15 fail**: `TypeError: make(...).getPreview is not a function` / `storage.getPreview is not a function` | 15/15; `test/storage.test.js` + `test/preview.test.js` 115/115. Shared `textPreview()` (streaming `TextDecoder` drops a character cut by the limit). S3: `HeadObject` (existence + size), then one ranged `GetObject` `bytes=0-1048575` (none for an empty object). Non-text kinds temporarily `{ kind: 'none' }` (P3) |
| P3 storage contract `getPreview` for image/PDF/none (3 drivers): memory → `{ kind, contentType, body }`; S3 → `{ kind, contentType, url }`, presigned for exactly 300 s with `response-content-type` from the extension and `response-content-disposition: inline` | `node --test --test-name-pattern="^preview" test/storage.test.js` → **3 of 21 fail** (the image/PDF test, once per driver): memory `actual: { kind: 'none' }`; S3 `actual: ['kind'], expected: ['contentType', 'kind', 'url']`. The "other types are none" test passed (guard; the P2 placeholder already answered `none`) | 21/21; storage + preview + disposition 123/123. `inlineDisposition()` was added to `src/disposition.js` (shared with `attachmentDisposition`); its unit test in `test/disposition.test.js` was written together with it, not seen failing on its own; its behaviour was first seen failing through this slice's S3 assertion `^inline; filename="` |
| P4 S3 preview specifics: request cost (HEAD + one GET `Range: bytes=0-1048575`; no GET for an empty file or an image), a file deleted between HEAD and GET, SDK errors (incl. `NoSuchBucket` on HEAD) passed through | `node --test --test-name-pattern="^preview: (a text file costs\|a file deleted\|S3 failures)" test/storage.test.js` → **1 of 3 fail**: the HEAD→GET race gave the raw `NoSuchKey: simulated NoSuchKey` instead of `{ status: 404, code: 'NOT_FOUND' }`. The other 2 are guards that passed at once | 3/3; storage + preview + disposition 126/126. `GetObject` `NoSuchKey` → `NOT_FOUND` |
| P5 API `GET /api/files/preview?key=` (each kind, 1 MiB boundary, HTML as JSON text, memory same-origin URL, S3 presigned URL, `none`, 404/400 incl. `%01`/repeated/structured keys, S3 failures → fixed reasons, `Cache-Control: no-store`) | `node --test --test-name-pattern="GET /api/files/preview \(M3\)" test/api.test.js` → **7 of 7 fail** (`actual: 404`, `Unknown API endpoint`: no route) | 7/7. Response is exactly `{ kind, text, truncated }`, `{ kind, url }` or `{ kind }` (the storage's `contentType`/`body` never reach the JSON) |
| Experiment (scratch, `$TMPDIR/fm-m3/pdf-csp.mjs`, localhost only): a PDF in a same-origin iframe under 4 response CSPs, headless Chrome 155 | The page's global CSP (`frame-ancestors 'none'`) → the frame is `chrome-error://chromewebdata/` (blocked). `frame-ancestors 'self'`, `default-src 'none'; frame-ancestors 'self'` and even `… sandbox` → Chrome's PDF viewer loads (target `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`) | Chosen for the content route: `default-src 'none'; frame-ancestors 'self'` (no `sandbox`: not needed with a fixed type + `nosniff`, and other browsers' PDF viewers may refuse sandboxed frames) |
| P6 API `GET /api/files/preview/content?key=` (memory/demo's preview URL): bytes inline with the extension's type (even if the bytes are HTML), `nosniff`, `no-store`, own CSP; S3 → 302 to the presigned URL; text/none → 400; missing → 404; bad keys → 400 | `node --test --test-name-pattern="preview/content" test/api.test.js` → **3 of 3 fail** (`actual: 404`, no route) | 3/3. The kind is checked from the key before storage is called |
| P7 page CSP allows S3 presigned previews: `img-src`/`frame-src 'self' https://*.amazonaws.com`; `default-src`, `object-src`, `frame-ancestors` unchanged; no `script-src` widening | `node --test --test-name-pattern="M3: the page CSP" test/api.test.js` → **1 fail**: `img-src` `actual: undefined` | 1/1. All non-browser files (`api`, `storage`, `preview`, `disposition`, `paths`, `config`, `start`): 290/290 |
| U1 UI: a Preview button on every file row; a `<dialog>` with the file name, the exact text in a `<pre>` (`textContent`), a Download link; Close; HTML content and a hostile file name never become markup or run script. The two M2 row tests now expect the Preview button (labels; 8 targets ≥ 44×44 instead of 6) | `node --test --test-timeout=30000 --test-name-pattern="M3: preview\|M2: file-row actions" test/browser.test.js` → **5 of 15 fail**: the 2 M3 tests (no Preview button; one also hit a **test bug**: a hostile name's `"` broke the CSS attribute selector, so the helper now matches the label by equality; rerun → both fail with `Cannot read properties of undefined (reading 'click')`), plus the 3 updated M2 expectations (`actual: 6`; no Preview label) | 15/15 |
| U2 UI truncation notice: over 1 MiB → the first 1 MiB, a visible on-screen notice, Download still offered; exactly 1 MiB → no notice | `node --test --test-timeout=30000 --test-name-pattern="text over 1 MiB" test/browser.test.js` → **1 fail**: notice `actual: ''` | `M3: preview` 3/3 |
| U3 UI image / PDF / none: a real 1×1 PNG loads in an `<img>` (`naturalWidth` 1, alt = name) from the preview URL; an undecodable `.jpg` → error in the dialog, Download kept, folder status untouched; a real PDF (`test/helpers/fixtures.js`) in an `<iframe>` that Chrome's PDF viewer renders (its extension target appears; absent before), plus an "Open the PDF in a new tab" link (`noopener noreferrer`); `.zip` → a message, an empty body, Download | `node --test --test-timeout=30000 --test-name-pattern="^(image\|PDF\|other types)" test/browser.test.js` → **4 of 4 fail**: `img`/`frame` `actual: null`; the bad-image message never appeared (timed out); the `none` message `actual: ''` | `M3: preview` 7/7 |
| U4 UI errors: a file deleted after the listing loaded → "This file no longer exists." and a simulated S3 outage → the fixed "S3 is temporarily unavailable.", both as errors in the dialog (state `error`), Download kept, folder status untouched, no uncaught page error | `node --test --test-timeout=30000 --test-name-pattern="^errors: a file removed" test/browser.test.js` → **1 fail**: `Timed out waiting for: preview settled` (the rejected request left the dialog loading, an unhandled rejection) | 7 of 8, then 8/8: the U3 bad-image test then failed once (`actual: ''`). **Test race, not a regression:** it waited for "message not empty", which `Loading preview…` already satisfies; it now waits for the error class. 8/8 in 3 consecutive runs |
| U5 UI stale previews (500 ms server delay per key): navigating while loading, the back button while loading, Close while loading, Escape while loading, A (slow) then B, and a late image-decode error from a closed preview | `node --test --test-timeout=30000 --test-name-pattern="stale preview responses" test/browser.test.js` → **6 of 6 fail**: the dialog stayed open after navigation (`actual: true`) and after back (`{ open: true, children: 1 }`); late responses filled the closed dialog (`children: 1`, after Close and after Escape); A's late text was added next to B's (`actual: 2` `<pre>`s); the old image's error marked the next preview (`'This image could not be displayed…', true`) | 6/6; `M3: preview` 14/14. `previewSeq` + `AbortController` like `load()`; `endPreview()` on open/Close/Escape (`close` event, ignored if a newer preview reopened the dialog)/`hashchange`; the image `error` handler checks `isCurrent()` |
| U6 UI phone (375 px) and desktop (1280 px): dialog and long title inside the viewport; a 4,000-character line wraps; a 3000×20 PNG (`solidPng`, `test/helpers/fixtures.js`) and the PDF frame scale to fit; no horizontal page scrolling; Close/Download/"Open the PDF" ≥ 44×44 | `node --test --test-timeout=30000 --test-name-pattern="^usable on a" test/browser.test.js` → **2 of 2 fail**: `long lines wrap` `actual: true` (the `<pre>` overflowed) | 2/2; `M3: preview` 16/16. `public/style.css`: dialog full screen ≤ 560 px, `pre-wrap` + `overflow-wrap: anywhere`, `img { max-width: 100% }`, PDF frame `70dvh` |
| U7 S3 driver (fake client + `TEST_SIGNER`) in the browser: the image and PDF previews use the presigned `https://test-bucket.s3.us-east-1.amazonaws.com/…` URLs and the page CSP lets them load. **No network:** Chrome now starts with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` (`test/helpers/chrome.js`, every browser test), and the test intercepts every request with CDP `Fetch` (127.0.0.1 continues; the bucket host is answered from the fake bucket; anything else fails) | Guard: `node --test --test-timeout=30000 --test-name-pattern="^S3: image and PDF previews" test/browser.test.js` passed at once (P7 + U3 already implement it). **Proved by mutation** (backup in `$TMPDIR/fm-m3`, restored, then deleted): `S3_PREVIEW_SOURCE = ''` → **1 fail** `the S3 image loaded (CSP allowed it)` `actual: 0`; only `frame-src` without the S3 source → **1 fail** (the frame never requested its presigned URL; timed out) | 1/1 after each restore |
| Full browser + helper suites after U7 (does the resolver flag break anything?) | — | `node --test test/browser.test.js test/chrome-helper.test.js` → 84/84, 0 skipped |
| REFACTOR: the S3 driver's download and preview URLs share `presignGet(key, overrides)`; `DOWNLOAD_URL_SECONDS` → `PRESIGNED_URL_SECONDS` | behaviour unchanged | all non-browser files 290/290 |
| Demo data (`src/demo.js`): a real 96×64 PNG (`Photos/gradient.png`), a one-page PDF with text (`Documents/sample.pdf`), an HTML file with a `<script>` (`Documents/page.html`); the existing fake `beach.jpg` shows the "could not be displayed" path. Bytes generated once by scratch scripts in `$TMPDIR/fm-m3` and stored as base64 | `test/start.test.js` still drives `src/demo.js` | in the full run |
| Live smoke + screenshots (scratch `$TMPDIR/fm-m3/smoke.mjs`): real `src/demo.js` on a free 127.0.0.1 port; headless Chrome with the test helper (no host resolution) | — | `page.html` → `{ kind: 'text', text: '<h1>…<script>…', truncated: false }`; `gradient.png`/`sample.pdf` → same-origin `url`; `.csv` → text; `nope.txt` 404; `../x` 400; content route → `image/png` / `application/pdf` with CSP `default-src 'none'; frame-ancestors 'self'`, `no-store`; `page.html` on the content route → 400. Screenshots (375 px and 1280 px) checked by eye: HTML shown as literal text; the PDF rendered ("Demo PDF") with the open-in-tab link; the image fits; the bad JPEG shows the error with Download. One cosmetic fix from them: the phone dialog bar wrapped Close onto its own line, so the title's flex basis went 12rem → 8rem (the U6 layout tests still pass). No page errors; demo stopped (SIGTERM) |

## M3 acceptance criteria → evidence
| Criterion (`IMPLEMENTATION_BRIEF.md` §5 M3, §4 API, and the M3 instruction) | Where |
|---|---|
| Text / image (jpg, jpeg, png, gif, webp) / PDF preview; other types offer download only | P1, P3, P5; U1, U3 (`none` → message + Download) |
| `GET /api/files/preview?key=` → `{ kind, text?, truncated?, url? }` | P5 (exact JSON shapes per kind) |
| Text capped at 1 MiB; `truncated: true` and a visible notice when larger | P2 (exactly 1 MiB vs + 1 byte; split UTF-8 character), P4 (S3 fetches only the first 1 MiB), P5, U2 (notice on screen; none at exactly 1 MiB) |
| HTML and every user-controlled string shown strictly as text | P2/P5 (raw characters), U1 (no element injected, no script run, hostile file name as title), content route types by extension + `nosniff` (P6). `public/app.js` still has no HTML sinks |
| Image/PDF URLs: 5-minute presigned GET for real S3; memory/demo deterministic, never AWS | P3 (`X-Amz-Expires=300`, `response-content-type`, inline), P5, P6, U7 (S3 URLs load under the CSP, intercepted locally) |
| Phone and desktop UI, touch targets, download always available | U1 (row buttons, now 8 targets ≥ 44×44 at 375/1280 px), U6, U3/U4 (Download in every state) |
| Stale-navigation protections preserved; safe DOM APIs | U5 (navigation, back, Close, Escape, A→B, late image error); all existing M1/M2 stale tests pass |
| Contract + fake-S3/API + browser tests: every kind, truncation boundary, invalid/missing keys, storage failures, HTML/XSS, navigation while loading, phone usability | P2–P7, U1–U7 |
| M1/M2 behaviour and tests preserved | full run 377/377; the only changed expectations are the two M2 file-row tests (the new Preview button) |

## Key decisions (M3; recorded as D24)
| Decision | Reason |
|---|---|
| Kind by extension only (`src/preview.js`), case-insensitive; `.svg` is text | No content sniffing; SVG can carry script, so it's never shown as an image |
| Storage gains `getPreview(key)` (documented in `src/storage/memory.js`): text `{ kind, text, truncated }`; image/PDF `{ kind, contentType, url }` (S3) or `{ kind, contentType, body }` (memory); `{ kind: 'none' }`; `NOT_FOUND` for any kind | One contract for both drivers; the API never forwards `contentType`/`body` |
| S3 text: `HeadObject` (existence + size; `NoSuchBucket` stays a storage error) + one `GetObject` `Range: bytes=0-1048575`; none for an empty object; `NoSuchKey` on the GET → `NOT_FOUND` | At most 1 MiB read; S3 refuses a range on an empty object |
| UTF-8 with U+FFFD for invalid bytes; when truncated, a character cut by the limit is dropped | No broken last character |
| S3 image/PDF: presigned 300 s with `ResponseContentType` from the extension and `ResponseContentDisposition: inline` | The stored type is never trusted (uploads store none; the M2 review's note 4) |
| Memory/demo: `GET /api/files/preview/content?key=` (bytes, extension type, `nosniff`, own CSP `default-src 'none'; frame-ancestors 'self'`); on S3 it 302s to the presigned URL; 400 for text/none | A deterministic URL without AWS; the global CSP's `frame-ancestors 'none'` would block the PDF frame (experiment row) |
| Page CSP: `img-src`/`frame-src 'self' https://*.amazonaws.com` | Presigned S3 previews must load; scripts remain same-origin |
| UI: `<dialog>` (modal; full screen ≤ 560 px) with title, Download, Close; text in `<pre>` via `textContent`; image `<img alt=name>`; PDF `<iframe>` + "Open the PDF in a new tab"; errors in the dialog only (never the folder status) | Phone + desktop; iOS may show only page 1 of a framed PDF |
| Stale previews: `previewSeq` + `AbortController` (like `load()`); closed on Close, Escape and every `hashchange` (incl. Back) | Only the preview on screen may render; D16's spirit |
| Test Chrome: `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` | Hard guarantee that browser tests can't reach AWS/the internet |

## M3 implementation scope (relative to the M2 commit `d4d6b50`)
- **New:** `src/preview.js`, `test/preview.test.js`, `test/helpers/fixtures.js`
- **Modified source:** `src/app.js` (two routes, CSP), `src/storage/memory.js`, `src/storage/s3.js`, `src/disposition.js`
  (`inlineDisposition`), `src/demo.js` (sample files), `public/app.js`, `public/index.html`, `public/style.css`
- **Modified tests:** `test/storage.test.js`, `test/api.test.js`, `test/browser.test.js`, `test/disposition.test.js`,
  `test/helpers/fake-s3-client.js` (`GetObject` + `Range`), `test/helpers/chrome.js` (resolver rule)
- **Modified docs:** `docs/HANDOFF.md`, `README.md`, `IMPLEMENTATION_BRIEF.md` (D24, architecture line, API row)
- **Unchanged:** `CLAUDE.md`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `docs/CLAUDE_REVIEW.md`,
  `test/chrome-helper.test.js`, `src/config.js`, `src/server.js`, `src/start.js`, `src/upload.js`, `src/errors.js`, `src/paths.js`

## Verification (2026-10-09, Node v26.8.1, Google Chrome 155)
| Command | Result |
|---|---|
| `npm test` | exit 0: **377 tests, 377 pass, 0 fail, 0 cancelled, 0 skipped**, 50 suites, about 42 s. Of these, 374 are real tests and 3 are the files in `test/helpers/` that Node's default glob also loads as (empty, passing) test files; the 317 baseline likewise counted 2 |
| Per file | api 121, storage 118, browser 75, paths 33, chrome-helper 9, preview 6, config 5, start 5, disposition 2 (all pass, 0 skipped) |
| `node --check` on every tracked + untracked `.js`/`.mjs` outside `node_modules` | 25 files, 0 failures |
| `npm ls --depth=0` / `npm ls --all` | exit 0 / exit 0: `@aws-sdk/client-s3@3.1147.0`, `@aws-sdk/s3-request-presigner@3.1147.0`, `busboy@1.6.0`, `express@5.2.1` |
| `git diff --check`; trailing whitespace in untracked files | clean; none |
| Secret scan (`AKIA…`, `ASIA…`, `aws_secret_access_key`, `secretAccessKey`, `-----BEGIN`) | only the existing dummy `TEST_SIGNER` credential and docs describing scans. `.env` absent, not read |
| Frontend HTML sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`, `document.write`) | only the comment saying none are used |
| Processes / temp | no demo, `node --test` or Chrome processes left; scratch dir `$TMPDIR/fm-m3` removed at the end |
| Real S3 / phone / network | **not used** (M4; forbidden here). The only HTTP was to 127.0.0.1 |

## Incomplete, deferred and open items
- **Remaining milestone:** M4 (real S3 + physical phone). The independent-review verdict is maintained separately
  in `docs/CLAUDE_REVIEW.md`.
- **Unproven against real S3:** that S3 honours `response-content-type`/`response-content-disposition` on these
  presigned URLs (documented S3 behaviour, signed by the SDK; the fake only reflects the query), the ranged `GetObject`,
  and the amazonaws.com host style for the bucket (the CSP allows any `*.amazonaws.com` host, which covers
  virtual-hosted and path-style URLs but **not** China regions, `amazonaws.com.cn`).
- **Phones:** iOS Safari may show only the first page of a PDF in a frame (hence "Open the PDF in a new tab"); only
  headless Chrome at phone width was tested, not a real phone (M4).
- **Back button with a preview open** closes the preview *and* goes back a folder (the preview adds no history entry).
- **Text detection is by extension:** a binary file named `.txt` shows replacement characters; non-UTF-8 text
  (e.g. Latin-1) shows U+FFFD for non-ASCII bytes.
- **A broken image** shows the browser's broken-image icon with its alt text under the error message.
- Carried over from M2 (unchanged): filenames with `"` stored percent-encoded; many tiny files in one API request start
  S3 uploads concurrently; uppercase `Host` refused by
  the Origin check; an ordinary error can be replaced by a later overlapping success (M1 gap); lockfile `name` differs
  from `package.json`; deleting/moving the last file out of an implicit folder removes the folder; check-then-act races
  for move and name collisions; the upload list grows for the page's life.

## Risks
- **Security:** still no login (D2); never expose it to the internet. M3 widens the page CSP only for images and frames
  from `*.amazonaws.com` (anyone's bucket there could be framed/imaged, but the page only sets URLs the API returns;
  scripts stay same-origin). Presigned preview URLs work for 5 minutes for anyone who has them, like downloads.
- **Memory:** a text preview reads at most 1 MiB per request; the JSON is about that size.
- **Browser tests:** fixed delays (300–900 ms) could be flaky on a slow machine; the PDF test relies on Chrome's built-in
  PDF viewer extension id (`mhjfbmdgcfjbbpaeojofohoefgiehjai`).

## Documentation follow-up
Completed with Mr. So's approval: `CLAUDE.md` now records `src/preview.js`, the preview routes/storage contract, and
the preview stale-response rule (`previewSeq` + abort; closed on navigation, Close and Escape). D24 now records the
approval explicitly, and the M3 threshold is consistently described as 1 MiB.

## Release gate
Use `docs/CLAUDE_REVIEW.md` for the current independent-review verdict. After a PASS, Eve reruns the deterministic
gates. Commit and push require explicit approval; M4 is Mr. So's real-S3 and physical-phone checklist.
