# Fresh Claude Review

- Reviewed at: 2026-10-10T22:54:57+08:00
- Claude session: 79a87ba5-54f4-433a-8973-542c30358c03
- Requested model: opus
- Completion subtype: success
- Reported cost: US$0.68
- Mode: fresh session; Claude tools restricted to Read and Bash; no Edit or Write tool

VERDICT: PASS

**What I reviewed:** the M4 follow-up "JPEG previews on iPhone" (D25, `IMPLEMENTATION_BRIEF.md:41` and `:123-132`). It is uncommitted work on `main` at `39d3761`: 18 modified files and 3 new ones. I read CLAUDE.md, the brief, README, HANDOFF and the full source diff, plus every line of `src/jpeg-preview.js`. I edited, staged and committed nothing in the project. I did not read `.env`; it exists and is git-ignored (`.gitignore:2`). My only scratch files were outside the repo and are deleted.

## Acceptance criteria

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | `.jpg`/`.jpeg` in any letter case get a same-origin URL on both drivers, never a presigned one | Code: `src/storage/s3.js:331` and `memory.js:123` return only `{kind, contentType}`, and `src/app.js:94` falls back to the content route. Tests: `test/api.test.js:583` (`.jpg`/`.JPEG`/`.jpeg`, both drivers), `test/preview.test.js:36`, and the browser S3 test at `browser.test.js:1396` (`.JPG`; no request leaves 127.0.0.1). Smoke run: `{"kind":"image","url":"/api/files/preview/content?key=photo.jpg"}` | ✅ |
| 2 | At most 2048 px, never enlarged, EXIF-rotated, sRGB, metadata and gain map stripped, baseline | Code: `src/jpeg-preview.js:31-37`. Tests: the jpeg-preview unit tests (14 pass). Smoke run: a 3000×2000 photo with EXIF orientation 6 came back as 1365×2048, `srgb`, no ICC, no EXIF, not progressive | ✅ |
| 3 | Headers: inline, nosniff, no-store, content CSP | Code: `src/app.js:114-119`. Smoke headers: `Content-Disposition: inline`, `nosniff`, `no-store`, `default-src 'none'; frame-ancestors 'self'`, `image/jpeg` | ✅ |
| 4 | S3: one HEAD for the preview JSON, one unranged GET only when the content is requested, no writes, original unchanged | Code: `s3.js:355-364`. Tests: S3 specifics ("preview jpeg: costs one HEAD only", "readPreviewSource: exactly one unranged GET, nothing written") pass. Smoke run: the download is 36206 bytes, the same as the upload | ✅ |
| 5 | Size limit, refusal from headers, over-long stream cut off, at most 2 conversions, signature check, pixel limit | Code: `readCapped` at `s3.js:38-51`, the limiter at `app.js:108` and `jpeg-preview.js:46-69`. Tests: header refusal (body destroyed unread), lying-length stream, `api.test.js:745` size bound on both drivers, `api.test.js:690` concurrency (peak = 2). Smoke run: an SVG named `.jpg` → 422 | ✅ (30 s timeout untested, as the brief says) |
| 6 | Corrupt or cut-off files give a fixed error with no raw text; the server keeps running | Smoke run: `cut.jpg` and `svg.jpg` → 422 `PREVIEW_FAILED` with the fixed message. `VipsJpeg: premature end…` appeared only in the server log. `nope.jpg` → 404. Health stayed 200 afterwards | ✅ |
| 7 | PNG/GIF/WebP/PDF and the text cap unchanged | `api.test.js:460` (S3 presigned) and the "other formats are unchanged" group; all M3 tests pass | ✅ |
| 8 | Phone-width UI: converted picture shown, "Loading preview…" until it arrives, errors stay in the dialog with Download kept | Code: `public/app.js:468-487` (the load and error handlers are both guarded by `isCurrent()`; the image state is set to `loading`). Tests: the browser `M4: JPEG previews` group passes 4/4 and was not skipped | ✅ |
| 9 | No personal photo in the repo | Fixtures are generated in `test/helpers/jpeg-fixtures.js` | ✅ |
| — | Manual check: real S3 on a physical iPhone | The brief (`:132`) states this is open and needs separate AWS authorization. It cannot be done in a local review | ⏳ Open by design |

**Wiring into the real app:** both `src/server.js` and `src/demo.js` call `src/start.js:10`, which builds the app with `maxUploadBytes` from `MAX_UPLOAD_MB`. The route at `app.js:101-121` is the one the UI's `<img src>` loads, and the live demo smoke run exercised the actual `sharp` conversion.

## Commands run
| Command | Result |
|---|---|
| `node --version` / `npm --version` | v26.8.1 / 11.19.0 |
| `npm test` (run twice; the second run checked the exit code) | **EXIT=0**: 436 tests, 436 pass, 0 fail, 0 cancelled, 0 skipped, about 46 s. Browser tests ran, including `M4: JPEG previews` 4/4 |
| `git diff --check` | clean |
| `node --check` on every tracked and untracked `.js`/`.mjs` | no failures |
| `npm ls --depth=0` | exit 0; `sharp@0.35.5` is the only new direct dependency |
| `git diff package-lock.json`, removed lines only | only the `"express"` line, which gained a trailing comma; everything else is added |
| `grep "from 'sharp'"` | only `src/jpeg-preview.js` in `src/` (the other imports are tests and fixtures) |
| grep for HTML sinks in `public/` | none (only the comment saying none are used) |
| Secret-pattern grep (`AKIA`, `ASIA`, `aws_secret_access_key`, `-----BEGIN`) | no matches outside HANDOFF's description of the scan |
| Live smoke: `PORT=3988 node src/demo.js`, curl upload of 3 synthetic files, preview JSON, content, download, health, then `pkill` | all as described under criteria 1–6; no process left behind |

No commit, push, deployment, AWS access or other external write was needed for this review.

## Blocking findings
None.

## Non-blocking findings
1. **Abandoned requests still do the work** (`src/app.js:108`). A client that disconnects while its request waits in the queue or is converting still gets its full S3 read and conversion. The waiting queue has no length limit. Memory stays bounded by the 2-slot limit, but someone on the LAN could pile up S3 GET cost and latency. HANDOFF lists this partly ("the work finishes anyway"). This is acceptable given D1/D2 (no login, LAN only).
2. **HEAD requests run the full conversion.** Express answers HEAD with GET handlers, so `HEAD /api/files/preview/content?key=x.jpg` reads and converts the whole file. This is inference from Express behaviour; I did not test it. Low impact.
3. **Misplaced comment** (`src/jpeg-preview.js:16-17`). The `failOn` comment sits above the `MAX_CONCURRENT_CONVERSIONS` comment, away from line 31 where `failOn: 'error'` is used. Readability only.
4. **The concurrency test measures reads only** (`test/api.test.js:690-712`). It counts concurrent `readPreviewSource` calls, not conversions. Both run inside the same limiter task, so it still proves the limit, but only indirectly for the conversion step.

## Residual risks
- The real-S3 `GetObject` body behaviour (a Node `Readable`, `ContentLength`) is covered only by a fake client. The real-S3 iPhone acceptance remains open.
- Each JPEG preview downloads the whole original from S3 and re-encodes it, with no cache. Peak memory is about 2 × `MAX_UPLOAD_MB` plus decoder memory.
- libvips is LGPL. That is fine for a private tool but matters before any distribution.
- Carried over from M2/M3 as listed in HANDOFF: no login (never expose to the internet), check-then-act races, and so on.

## Recommended next action
Eve reruns the deterministic gates. After that, a commit can follow if Mr. So or Eve explicitly approves it. The real-S3 desktop and iPhone checklist (M4) should be scheduled only once AWS-backed testing is separately authorized. Findings 1–3 can go to a later cleanup if wanted; none of them block.
