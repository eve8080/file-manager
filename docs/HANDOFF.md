# Handoff

_Last updated: 2026-10-10. M1 (`1fa3d1b`), M2 (`d4d6b50`) and M3 (`39d3761`) are committed; their session histories are
in those commits' `docs/HANDOFF.md`. The M4 follow-up "JPEG previews for iPhone Safari" (decision D25) is implemented,
automatically verified, and has passed a physical-iPhone Safari test with the exact private `IMG_0001.jpeg` through the
in-memory demo driver. `docs/CLAUDE_REVIEW.md` is the authoritative independent-review verdict._

## Status
- **Implemented test-first, all automated checks green** (see "Verification").
- **Physical Safari acceptance:** Mr. So confirmed on 2026-10-10 that the exact private gain-map `IMG_0001.jpeg`
  previews correctly on a physical iPhone through the in-memory demo driver at phone width. The demo exercised the real
  same-origin sharp conversion path but not the S3 source-read path. Real-S3 acceptance therefore remains open.
- New dependency: **`sharp@0.35.5`** (approved by Mr. So). New decision **D25** in `IMPLEMENTATION_BRIEF.md`.

## The problem and the fix
On a physical iPhone, `IMG_0001.jpeg` (baseline JPEG, 5712×4284, Display P3, MPF + XMP HDR gain map) failed in the preview
`<img>` although the response was `200 image/jpeg` with valid bytes and desktop Chrome decodes it; ordinary JPEGs worked.
Differential fixtures on the phone: original 5712 px/P3 **failed**; resized to 4032 px/P3 and 2048 px/P3 worked; a full-size
5712 px re-encode worked in sRGB and in P3. Root cause: the original's MPF/gain-map encoding and metadata, not the
dimensions or P3 alone.

Fix (D25): `.jpg`/`.jpeg` previews are produced on demand by `sharp` as a plain baseline JPEG: EXIF-rotated, fitted inside
2048×2048 without enlargement, sRGB, quality 85, no metadata/ICC/gain map/second image. Originals, downloads and every
other format are untouched; nothing is stored back (S3 is read-only here) and no temp file is used.

## Design decisions and trade-offs
| Decision | Reason / trade-off |
|---|---|
| `GET /api/files/preview` for a JPEG returns `{ kind: 'image', url: '/api/files/preview/content?key=…' }` on **both** drivers; S3 does one `HeadObject`, no presign | No presigned JPEG URL is exposed; S3 reads the photo only when the picture is requested |
| `GET /api/files/preview/content` for a JPEG: `readPreviewSource` → `normalizeJpeg` → 200 `image/jpeg`, `inline`, `nosniff`, `no-store`, CSP `default-src 'none'; frame-ancestors 'self'`. No redirect | Same-origin, fixed type; the existing content-route security headers are kept |
| Storage: `getPreview` for a JPEG is `{ kind, contentType }` only; new `readPreviewSource(key, maxBytes)` → Buffer (S3: one unranged `GetObject`, no HEAD) | One contract for memory and S3; the converter has no storage knowledge |
| Bound = **`MAX_UPLOAD_MB`** (no new setting). S3 refuses from the GET's `ContentLength` before reading and destroys the body; a stream longer than declared is cut off at the limit. Over → 413 `PREVIEW_TOO_LARGE` | Anything uploadable can be previewed; sharp needs the whole file in memory, so buffering is inherent and bounded |
| `createLimiter(2)` (`MAX_CONCURRENT_CONVERSIONS`): at most 2 conversions at once; waiting requests hold no data | Peak ≈ 2 × `MAX_UPLOAD_MB` (+ decoder memory) however many previews are requested. The waiting queue itself is unbounded in count (it holds only pending requests) |
| Converter accepts only input starting `FF D8 FF`, ≤ 128 megapixels (`limitInputPixels`), 30 s `timeout`; `sharp.cache(false)` | An SVG/PNG named `.jpg` is refused, never rendered; a small file with huge dimensions cannot exhaust memory; no decoded pictures kept |
| Any decode failure → 422 `PREVIEW_FAILED` (fixed message); the libvips error is only `console.error`'d | libvips messages ("VipsJpeg: premature end…") never reach a client |
| UI: an image stays `loading` ("Loading preview…") until its `load` event; `error` sets state `error` | The conversion takes a moment; before, the dialog looked finished and blank. No other UI change |
| `failOn: 'error'` (final audit; sharp's default is `'warning'`) | The default also rejected JPEGs with harmless libjpeg warnings (a few stray bytes between segments) that browsers display. `'error'` accepts those but still fails a JPEG cut off mid-file (422) instead of showing a partial picture; Download remains |
| Dependency pinned the project's way: `^0.35.5` in `package.json` (like every other dependency) with the exact version fixed by `package-lock.json` | No `.npmrc` / exact-pin convention exists |

## Slice log (strict red → green, as it happened)
Baseline: HEAD `39d3761`, clean tree; the previous handoff recorded `npm test` 377/377 (not re-run by me before editing).
`npm install sharp` first (needed by the fixtures); lockfile diff = additions only (31 package entries, no existing entry changed; the root dependency list gains one line).
Scratch probes ran from a git-ignored `tmp/` inside the repo and were deleted. Fixtures were checked first: sharp reads a gain
map in the synthetic MPF/XMP fixture, and its raw P3 pixel is (187,106,63) for sRGB (200,100,50).

| Slice | RED command and result | GREEN |
|---|---|---|
| Unit: `needsNormalizing`, `normalizeJpeg` (size, no enlargement, EXIF rotation, P3→sRGB, CMYK, metadata/gain-map stripping, corrupt input, pixel limit), `createLimiter` | `node --test test/preview.test.js test/jpeg-preview.test.js` → both files fail to load: `SyntaxError: The requested module '../src/preview.js' does not provide an export named 'needsNormalizing'`; `ERR_MODULE_NOT_FOUND … src/jpeg-preview.js` | 7/7 and 12/12; the final audit added 2 more unit tests (gain-map colours; harmless decoder warnings, RED→fix `failOn: 'error'`) → 14/14 |
| Storage contract (memory, s3, s3 2-item pages) and S3 specifics: JPEG metadata only, `readPreviewSource` bytes/limit/NOT_FOUND/untouched; one HEAD; one unranged GET; refusal from headers with the body destroyed unread; stream longer than declared; error passthrough | `node --test test/storage.test.js` → 138 tests, **20 fail** (5 contract tests × 3 drivers: `TypeError: storage.readPreviewSource is not a function` / JPEG metadata still has a URL or body; 5 S3 tests, e.g. `TypeError … reading 'endpointProvider'`: the old code presigned a JPEG) | 138/138 |
| API: JPEG metadata is a same-origin URL (no `amazonaws`/`X-Amz`), content ≤ 2048 px/sRGB/rotated/headers, original unchanged and downloadable, corrupt → 422 and the server keeps working, S3 HEAD-then-GET timing, S3 failures as fixed reasons, PNG/GIF/WebP/PDF unchanged, size bound 2000 vs 2001 bytes | `node --test test/api.test.js` → 139 tests, **10 fail** (content ×2 drivers, corrupt ×2, S3 metadata, S3 corrupt-file metadata, S3 timing, S3 failures, size bound ×2); the memory metadata, "original unchanged", other-format and 404/400 tests passed at once (they pin existing behaviour) | 139/139, then 140/140 with the concurrency test below |
| Browser, phone width 375 px | `node --test --test-timeout=60000 --test-name-pattern="M4: JPEG previews" test/browser.test.js` → **4 of 4 fail**: the original was served (`natural size [2000, 3000]`, expected `[1365, 2048]`); the cut-off `.jpg` never showed an error; state `ready` instead of `loading` during a slow conversion; the S3 case failed because the old code gave the `<img>` a presigned amazonaws.com URL, which the test's network intercept blocked (`TypeError: Failed to fetch`) | 4/4; whole `M3: preview` group 21/21 |
| App-level concurrency: 6 simultaneous JPEG previews, storage proxy counts concurrent reads | written after the implementation; proved by mutation (below) | peak = 2 |
| REFACTOR | none beyond shaping the content route; the two existing `fake.jpg` browser tests now silence the expected server log | all green |

**Mutation checks** (production code temporarily broken, then restored byte for byte; each run failed as listed):
no `.rotate()` → 1 unit test; no `.resize()` → 1; `withoutEnlargement: false` → 2; `.keepIccProfile()` → 2;
`.keepGainMap().keepMetadata()` → 3; no JPEG-signature check → 1; leaking the raw decoder error → 4 (unit + API);
app without the limiter → 1; `readPreviewSource(key, Infinity)` → 2; S3 presigning JPEGs again → 5; no cap while reading → 1;
declared length not checked → 1; an extra HEAD before the GET → 3; memory without size check → 2; wrong content type → 2;
UI back to "ready immediately" → all 4 browser tests.

## Acceptance criteria → evidence (`IMPLEMENTATION_BRIEF.md` §5 "M4 follow-up")
| Criterion | Test |
|---|---|
| JPEG previews use same-origin content, no presigned URL, both drivers | api "metadata: a same-origin content URL…" (memory, s3); browser S3 test (no request leaves 127.0.0.1) |
| ≤ 2048 px, never enlarged, rotated, sRGB, no EXIF/XMP/MPF/ICC/COM/gain map/second image, baseline | `test/jpeg-preview.test.js`; api "content: a 200 image/jpeg…"; browser pixel/natural-size check in Chrome |
| Headers: inline, nosniff, no-store, content CSP | api (both drivers) |
| S3 timing: preview JSON = 1 HEAD; photo = 1 unranged GET, only on the content request; no writes | storage S3 specifics; api "S3 request behaviour"; browser S3 test |
| Original unchanged, download unchanged | api "the stored original is unchanged…"; browser downloads the original and compares its length |
| Bounds: exact `MAX_UPLOAD_MB` converts, +1 byte → 413; header refusal reads nothing; over-long stream cut off; ≤ 2 at once; signature and pixel limit | storage contract + S3 specifics; api "size bound"; api concurrency; unit pixel limit |
| Corrupt/unsupported → clean fixed error, no raw text, server alive, UI keeps Download, folder status untouched | unit, api (both drivers), browser (cut-off real JPEG and a text file named `.jpg`) |
| PNG/GIF/WebP/PDF unchanged; text cap and security headers unchanged | api "other formats are unchanged" + the existing M3 tests |
| Phone-width UI success/error, loading state | browser `M4: JPEG previews` (375 px) |
| No personal photo | all fixtures are generated by `test/helpers/jpeg-fixtures.js` (flat colour, synthetic MPF/XMP/gain-map structure) |

## Verification (2026-10-10, Node v26.8.1, npm 11.19.0, Google Chrome 155)
| Command | Result |
|---|---|
| `npm test` | exit 0: **436 tests, 436 pass, 0 fail, 0 cancelled, 0 skipped**, 61 suites, about 46 s. 432 are real tests; the other 4 are the files in `test/helpers/` that Node's default glob also loads as empty passing test files (377 before: 374 + 3) |
| Per file | api 140, storage 138, browser 79, paths 33, jpeg-preview 14, chrome-helper 9, preview 7, config 5, start 5, disposition 2 (all pass, 0 skipped) |
| `node --check` on every tracked + untracked `.js`/`.mjs` outside `node_modules` | 28 files, 0 failures |
| `npm ls --depth=0` | exit 0: `@aws-sdk/client-s3@3.1147.0`, `@aws-sdk/s3-request-presigner@3.1147.0`, `busboy@1.6.0`, `express@5.2.1`, `sharp@0.35.5` |
| `npm ls --all` | exit 0; no missing/invalid/extraneous. It prints `UNMET OPTIONAL DEPENDENCY` for the `@img/sharp-*` packages of other platforms; that is normal (only `@img/sharp-darwin-arm64` and `@img/sharp-libvips-darwin-arm64@1.3.4` are installed here) |
| `git diff --check`; trailing whitespace in untracked files | clean; none |
| Secret scan (`AKIA…`, `ASIA…`, `aws_secret_access_key`, `secretAccessKey`, `-----BEGIN`) | only the existing dummy `TEST_SIGNER` credential and the docs describing scans. `.env` not read |
| Frontend HTML sinks | only the comment saying none are used; `sharp` is imported only by `src/jpeg-preview.js` (and tests) |
| Live smoke (real `src/demo.js` on 127.0.0.1:3987, curl) | `beach.jpg` preview JSON → same-origin URL; content → 422 `PREVIEW_FAILED` with the fixed message; `gradient.png` content → 200 `image/png`, 352 bytes (unchanged). Server stopped with SIGTERM |
| Processes / temp | none of my demo, `node --test` or Chrome processes remain; no cleanup beyond stopping the smoke server was needed. `tmp/` scratch removed. Chrome/`.hermes` processes visible in `ps` belong to another tool and were not touched |
| Real S3 / phone / network | Real S3 was not used. After automated verification, Mr. So opened the LAN demo on a physical iPhone and confirmed the exact private `IMG_0001.jpeg` preview worked. The server was then stopped. npm registry was used only to install sharp |

## Changed and new files
- **New:** `src/jpeg-preview.js`, `test/jpeg-preview.test.js`, `test/helpers/jpeg-fixtures.js`
- **Modified source:** `src/app.js` (content route, concurrency limiter), `src/errors.js` (`previewFailed`, `previewTooLarge`), `src/preview.js`
  (`needsNormalizing`), `src/storage/memory.js`, `src/storage/s3.js` (`readCapped`, `readPreviewSource`, JPEG `getPreview`),
  `public/app.js` (image `loading`/`ready`/`error` states)
- **Modified tests:** `test/api.test.js`, `test/storage.test.js`, `test/browser.test.js`, `test/preview.test.js`,
  `test/helpers/fake-s3-client.js` (a `GetObject` body is now a stream that also has `transformToByteArray`; `lastBody`)
- **Modified docs/config:** `IMPLEMENTATION_BRIEF.md` (D25, API rows, criteria), `README.md`, `CLAUDE.md`, `docs/HANDOFF.md`,
  `package.json`, `package-lock.json`
- **Review artifact:** `docs/CLAUDE_REVIEW.md` contains the fresh read-only M4 review verdict. **Unchanged:** `src/demo.js`, `src/server.js`, `src/start.js`,
  `src/config.js`, `src/upload.js`, `src/paths.js`, `.env.example`, `.gitignore`

## Dependency note
`sharp@0.35.5` (Apache-2.0) with `@img/colour`, `detect-libc`, `semver` and per-platform optional packages
(`@img/sharp-<platform>` Apache-2.0, `@img/sharp-libvips-<platform>` **LGPL-3.0-or-later**, a prebuilt libvips). Added to the
lockfile: 31 entries, of which 6 are installed on this Mac. About 18 MB in `node_modules/@img`. No install script runs.
sharp is the only new direct dependency.

## Risks and open items
- **Physical-device result:** physical iPhone Safari displayed the converted exact private photo through the demo driver.
  This confirms the browser-decoding fix; it does not exercise the S3 source-read path. Whether 2048 px or sRGB *and* the
  stripping are each needed is not known, so all remain applied.
- **Real S3 unproven:** the `GetObject` stream behaviour (`Body` as a Node stream, `ContentLength`) is covered by a fake only.
- **Memory:** up to ~2 × `MAX_UPLOAD_MB` + decoder memory at peak (≈ 200 MB + working memory at the default 100 MB), plus libvips's
  own thread pool. `MAX_UPLOAD_MB` is now also the preview limit; raising it raises both.
- **Cost and latency:** every JPEG preview downloads the whole file from S3 and re-encodes it (no cache): a 5712×4284 photo of
  several MB per open. Expect a noticeable wait on a phone; the dialog shows "Loading preview…".
- **Strictness:** cut-off or corrupt JPEGs fail with 422 instead of showing partial pictures; harmless decoder warnings are tolerated.
- **Not exercised by a test:** the 30 s conversion timeout; a client that disconnects mid-conversion (the work finishes anyway);
  other browsers/phones.
- **Quality:** the picture is re-encoded at quality 85, 4:2:0; a very large photo is shown at ≤ 2048 px (Download for the original).
- **Licence:** libvips is LGPL; fine for a private tool, worth knowing before any distribution.
- Carried over from M3/M2 (unchanged): no login (D2; never expose it); back button with a preview open also goes back a folder;
  text detection is by extension; presigned preview/download URLs live 5 minutes and sit in the JSON/DOM; the CSP allows any
  `*.amazonaws.com` for images/frames (not China regions); iOS Safari may show only page 1 of a framed PDF; filenames with `"` are
  stored percent-encoded; many tiny files in one API request start S3 uploads concurrently; uppercase `Host` is refused by the
  Origin check; an ordinary error can be replaced by a later overlapping success (M1 gap); lockfile `name` differs from
  `package.json`; deleting/moving the last file out of an implicit folder removes the folder; check-then-act races for move
  and name collisions; the upload list grows for the page's life; browser tests use fixed delays (300–900 ms) and Chrome's PDF
  viewer extension id.

## Next steps
1. Complete a fresh independent read-only review of this working tree and record the verdict in `docs/CLAUDE_REVIEW.md`.
2. Exercise the real-S3 checklist on desktop and physical iPhone when AWS-backed acceptance is authorized; the demo-driver
   physical Safari result is already PASS.
3. Commit or push only on explicit approval.

## Release gate
Use `docs/CLAUDE_REVIEW.md` for the independent-review verdict. After a PASS, Eve reruns the deterministic gates. Commit
and push require explicit approval.
