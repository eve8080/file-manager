# Handoff

_Last updated: 2026-10-09. M1 is committed (`1fa3d1b`) and passed review (its history is in that commit's
`docs/HANDOFF.md`). **M2 is implemented, independently re-reviewed (PASS, `docs/CLAUDE_REVIEW.md`), and the review's approved
follow-ups F1–F4 plus D21–D23 and the `CLAUDE.md` update are done**, uncommitted. Stopped before commit, push,
deployment and M3._

## Status
- **M2 acceptance criteria:** all implemented, each with tests (see "M2 acceptance criteria" below).
- **Review follow-ups:** F1 name collisions, F2 total request limit, F3 overlapping uploads, F4 no upload after a
  failed folder load, all test-first (see "Review follow-ups"). D21 (`sameOriginWrites`), D22 (request limit)
  and D23 (collisions) are recorded in `IMPLEMENTATION_BRIEF.md`; `CLAUDE.md` is updated (authorised by Mr. So).
- `npm test`: **317/317 pass, 0 skipped** (285 at the M2 review).
- **Quota checkpoint resolved:** the previous session stopped on a hanging test ("invalid names"). Root cause:
  a raw control character in a multipart *header* is malformed framing, and `receiveUploads` had no parser
  `'error'` handler, so the request never settled. See the "Checkpoint resolution" and S12d rows.
- **Found and fixed during M2** (each with its own RED): a server crash when the size limit tripped before S3
  started reading (S12b); `NoSuchBucket` misreported as a missing file (S8); exactly-at-limit files rejected
  (S12b); client disconnects leaving S3 multipart uploads open (S12e); `MAX_UPLOAD_MB` not wired into the
  running app (S12g); cross-site uploads through the user's browser (X1).

## M2 approvals (2026-10-09, given in the M2 resume instruction)
1. **Approved:** add `@aws-sdk/s3-request-presigner` and keep the brief's 302 redirect to a presigned download URL
   with a 5-minute expiry.
2. **Approved:** add `busboy` and keep multipart, multi-file, streamed uploads. S3 streams of unknown size use the
   multipart-upload commands already in `@aws-sdk/client-s3`, with abort-on-failure cleanup.

Installed with `npm install @aws-sdk/s3-request-presigner@3.1147.0 busboy`: `@aws-sdk/s3-request-presigner@3.1147.0`
(the same version as `@aws-sdk/client-s3`) and `busboy@1.6.0`. The lockfile gained exactly 3 packages: those two
plus `streamsearch` (busboy's only dependency). npm reported "found 0 vulnerabilities" as part of the install.

## M2 slice log (strict red → green, one behaviour at a time)
| Slice | RED command and result | GREEN result |
|---|---|---|
| S1 `parseFileKey` (`src/paths.js`) | `node --test test/paths.test.js` → **1 fail**: `SyntaxError: … does not provide an export named 'parseFileKey'` | 33/33 pass |
| (test infra) fake S3: bodies, `HeadObject`, `DeleteObject`, `CopyObject`, `PutObject` + `IfNoneMatch`, multipart Create/UploadPart/Complete/Abort with S3's minimum part size, `failNext()` | no production change; M1 storage + API tests rerun | 90/90 pass |
| S2 storage `deleteFile` contract (memory, s3, s3 2-item pages) | `node --test --test-name-pattern="deletes a file and nothing else\|deleting a missing file" test/storage.test.js` → **6 fail**: `TypeError: storage.deleteFile is not a function` | 6/6; `test/storage.test.js` 52/52 |
| S3 API `DELETE /api/files?key=` | `node --test --test-name-pattern="DELETE /api/files \(M2\)" test/api.test.js` → **10 of 11 fail** with `actual: 404` (no route). The "missing file → 404" case passed by coincidence (an unknown route is also 404) | 11/11 |
| S4 storage `moveFile` contract (3 drivers) | `node --test --test-name-pattern="moves \(renames\)\|refuses to move" test/storage.test.js` → **6 fail**: `TypeError: storage.moveFile is not a function` | 6/6 |
| S5 S3 move failure paths | `node --test --test-name-pattern="^move: " test/storage.test.js` → **1 of 3 fail**: copy ok + source delete fails gave the raw SDK error (`actual: undefined, expected: 502`). The other 2 are guards that passed at once: a failed copy never deletes the source (copy-then-delete order), and `CopySource` is URL-encoded per segment | 3/3; `test/storage.test.js` 61/61 |
| S6 API `POST /api/files/move` | `node --test --test-name-pattern="POST /api/files/move \(M2\)" test/api.test.js` → **13 fail** (`actual: 404`, no route) | 13/13 |
| S7 storage `getDownload` (memory bytes; S3 presigned URL, exactly 300 s) | `node --test --test-name-pattern="^download: " test/storage.test.js` → **6 fail**: `getDownload is not a function` | 6/6; `test/storage.test.js` 67/67. Signing uses `TEST_SIGNER`, a real `S3Client` with dummy credentials whose request handler throws, so no request can leave the process |
| S7b `attachmentDisposition` encoding (UTF-8 `filename*`, ASCII fallback, quotes, CR/LF) | That encoding went beyond S7's ASCII-only test, so `test/disposition.test.js` was proved against a deliberately simplified helper (no encoding) → **1 fail** (`actual: attachment; filename="Été "q" …`). Then the real helper was restored | 1/1 |
| S8 API `GET /api/files/download` | `node --test --test-name-pattern="GET /api/files/download \(M2\)" test/api.test.js` → **4 fail** (`actual: 404`, no route). After the route: **1 fail**, a missing bucket (`NoSuchBucket`, 404) came back as 404 `NOT_FOUND`, because `fileExists` treated every 404 as a missing key | 4/4 after `fileExists` counts only `NotFound`/`NoSuchKey` as missing. 302 + `Cache-Control: no-store` (S3); 200 attachment bytes (memory) |
| S9 storage `putFile` contract (3 drivers): stream of unknown size, `{ size }`, 0-byte file, never overwrites (`FILE_EXISTS`), a failing stream stores nothing | `node --test --test-name-pattern="^upload: " test/storage.test.js` → **9 fail**: `storage.putFile is not a function` | 9/9; `test/storage.test.js` 76/76. Minimal S3 version: buffered single conditional `PutObject` |
| S10 S3 multipart streaming (`partSize` lowered to 64 in tests; the fake enforces the same minimum) | `node --test --test-name-pattern="^upload: (a stream larger\|parts are sent\|a stream that fits)" test/storage.test.js` → **2 of 3 fail**: a 230-byte stream used `PutObject` (`actual: 1, expected: 0`); "the first part must be uploaded before the stream ends" timed out (whole stream buffered). The single-part case is a guard and passed | 3/3: Create → UploadPart (64, 64, 64, 38) while the stream is still arriving → Complete with `IfNoneMatch: '*'`; at most one part buffered |
| S11 abort-on-failure cleanup | `abortUpload` went in with S10 without its own failing test, so its tests were proved by mutation. With the abort call removed, `--test-name-pattern="^upload( cleanup)?: (a stream error\|a failed\|losing the race\|if the abort\|a small upload)"` → **5 of 6 fail**. With the `PreconditionFailed` → `FILE_EXISTS` mapping (from S9) removed, `--test-name-pattern="412"` → **2 of 2 fail**. Both files were restored from backups | 6/6; `test/storage.test.js` 85/85. Covers: stream error after parts, UploadPart failure, Complete failure, 412 race on Complete (the other writer's file is kept), the abort itself failing (original error reported, failure logged), 412 on a small `PutObject` |
| S12a API `POST /api/files?prefix=` (busboy), multi-file, download round trip | `node --test --test-name-pattern="M2 upload" test/api.test.js` → **1 fail** (`actual: 404, expected: 201`, no route) | 1/1: two files in one request, including binary bytes and a UTF-8 name, downloaded byte for byte |
| S12b per-file size limit (`createApp({ maxUploadBytes })`) | `--test-name-pattern="size limit"` → **3 of 4 fail** (`actual: 201, expected: 413`, no limit); "exactly at the limit" passed only because no limit existed | 6/6 after three problems found while making it pass: (1) busboy emits `'limit'` when a file *reaches* `fileSize`, so it is given `max + 1` (otherwise exactly-at-limit was a 413). (2) **Crash:** the limit could trip while the S3 driver was still awaiting `HeadObject`, and the destroyed `PassThrough` had no `'error'` listener, an unhandled `'error'`. Regression proved by mutation: with the listener removed, "during its existence check" hung and was cancelled at the 10 s test timeout (the watchdog killed the run); restored → passes in 14 ms. (3) My first S3 abort-through-API test used 2,000 bytes, which fits in the stream buffers, so S3 never started a multipart upload. It was strengthened to a 200,000-byte file against a 100,000-byte limit, which asserts parts were streamed, then exactly one abort, no open upload, no object. Hung runs were stopped with `pkill`; afterwards there were no `node --test` processes. All unit + API files: 197/197 |
| S12c per-file name validation, collisions, request-level 400s | `"$TMPDIR/fm-debug/run.sh" 40 --test-timeout=10000 --test-name-pattern="per file:\|request level:" test/api.test.js` → **3 fail + 2 cancelled**: JSON body and no-boundary gave `500` (busboy's constructor throws); no files gave `201`; the invalid-names test **hung**. Per-file `FILE_EXISTS` and both bad-prefix cases passed (guards) | Request-level 400s fixed: 6/6 non-hanging. **The quota checkpoint stopped here with the invalid-names test still hanging** |
| Checkpoint resolution: systematic debugging of the hang | One probe request per filename, each with a 2 s deadline, outside the runner (`$TMPDIR/fm-debug/names.mjs`). `..`, `.`, spaces, `/`, the long name and the empty name all returned the right per-file results. The raw `\u0001` crashed the probe with **`Unhandled 'error' event … Error: Malformed part header`** from busboy's parser. **Root cause:** a raw control character is illegal in a part header, so it is malformed framing, not a file name. `receiveUploads` had no parser `'error'` handler, so the request never settled. busboy's `_destroy` also destroys the open file stream with the error, and `pipe()` doesn't forward it | The test premise was corrected: control characters reach name validation legitimately via RFC 5987 `filename*=UTF-8''a%01b.txt`. `--test-timeout=3000 --test-name-pattern="per file: invalid names"` → 1/1 in 16 ms (validation already implemented; this confirms the premise, not new behaviour) |
| S12d malformed / truncated multipart | Tight command: `"$TMPDIR/fm-debug/run.sh" 30 --test-timeout=3000 --test-name-pattern="malformed or truncated multipart" test/api.test.js` → **5 of 5 cancelled** (each hung until the 3 s timeout; the 30 s watchdog killed the run) | 5/5 in 38 ms. Parser `'error'` → `MALFORMED_UPLOAD` (400, fixed message, detail logged server-side); the rest of the request is drained; the in-flight file fails (the file stream got its own `'error'` handler); files stored before the cut are reported; a malformed request is never 201. S3: a cut mid-multipart aborts the upload (no open upload, no object). All unit + API files: 214/214 |
| S12e client disconnects mid-upload | `run.sh 30 --test-timeout=6000 --test-name-pattern="client abort" test/api.test.js` → **1 of 2 fail**: S3 "multipart upload aborted after the client left" never happened (`actual: false`), because `pipe()` never ends the parser. The memory case passed (guard), but only because the partial stream never ended, which leaks a pending write | 2/2: `req` `'close'` without `req.complete` destroys the parser, which reuses the 12d path; the S3 upload is aborted, nothing stored, the server keeps serving. Unit + API 216/216 |
| S12f per-file S3 failure → fixed reason | `--test-name-pattern="per file: an S3 failure"` passed at once (12b sends per-file errors through `toPublicError`), so it was proved by mutation: per-file errors built from the raw `error.name`/`message` → **1 fail** (`error: { code: 'AccessDenied', message: 'secret internal detail' }`). File restored from backup | 1/1: 502 `UPLOAD_INCOMPLETE`; the file gets `STORAGE_ERROR`/`ACCESS_DENIED`; the raw message is only in the server log; no open upload |
| S12g `MAX_UPLOAD_MB` reaches the real app | `run.sh 30 --test-timeout=15000 --test-name-pattern="MAX_UPLOAD_MB reaches" test/start.test.js` (spawns the real `src/demo.js` with `MAX_UPLOAD_MB=0.001`) → **1 fail**: a 2,000-byte file got `201` (both entry points called `createApp({ storage })`, so the limit was never wired) | 1/1: `start(storage, config, label)` now builds the app with `maxUploadBytes = floor(MAX_UPLOAD_MB × 1 MiB)`. `server.js` and `demo.js` both call it, so the path is shared (the M1 startup tests still drive both entry points). `test/start.test.js` + `test/config.test.js`: 10/10 |
| U1 file-row Download/Rename/Delete, touch targets, no HTML injection | `run.sh 90 --test-timeout=20000 --test-name-pattern="M2: file-row actions" test/browser.test.js` → **3 fail**: rows had no actions (`buttons: []`; 0 of 6 targets) | 3/3. While going GREEN, the in-browser download returned 500: the browser test's storage proxy forwarded only the M1 methods (test harness, not a product bug). It now forwards `getDownload`/`deleteFile`/`moveFile`/`putFile`, with `mutationDelay` on the mutations. Rows: `a.button.download` → `/api/files/download?key=…`, plus Rename and Delete buttons, all ≥ 44×44 at 375 px and 1280 px, no horizontal scroll at 375 px; a `<img onerror>` file name renders as text |
| U2 UI file delete | `--test-name-pattern="^delete: "` → **4 fail** (no confirm; nothing deleted). An M1 N3 test also matches the pattern and passed | 5/5: explicit `confirm('Delete file "x"?')`; declining sends nothing; errors shown; completion after navigation leaves the new folder's status alone (D16) |
| U3 UI rename/move | `--test-name-pattern="^rename: "` → **5 fail** (no prompt) | 5/5: `prompt` pre-filled with the full key (checked through CDP's `defaultPrompt`); cancel or no change sends nothing; rename in place or move to `docs/sub/`; 409 shown; S3 `MOVE_INCOMPLETE` shown as an error; D16 |
| U4 UI uploads: multi-file picker, per-file progress/result, partial failure, D16, touch target | `run.sh 120 --test-timeout=20000 --test-name-pattern="M2: uploads" test/browser.test.js` → **6 fail** (no `#upload-input`, no `label.upload`) | 6/6 after one CSS fix (the label measured 85×22 px because the button rule targeted only `a.button`). Real files go through CDP `DOM.setFileInputFiles` from a `mkdtemp` dir, removed in `after()`. One XHR per file (fetch has no upload progress); an intermediate progress value is observed on an 8 MiB file; a partial failure gives `Uploaded 1 of 2 files; 1 failed (see the list below).` as an error, with the per-file reason, and nothing overwritten; an upload finishing after navigation leaves the new folder's status alone while the list keeps its result. Browser + helper suites: 57/57, 0 skipped |
| X1 cross-site write protection (found during the M2 security review) | A multipart POST is a CORS "simple request" (no preflight), so any web page could upload into the bucket through the user's browser; the Host guard allows `127.0.0.1:3000`. `run.sh 30 --test-timeout=5000 --test-name-pattern="cross-site requests" test/api.test.js` → **3 of 4 fail**: uploads with `Origin: http://evil.example`, `null` and `http://127.0.0.1:1` all got `201`. The same-origin/no-Origin case passed (guard) | 4/4: `sameOriginWrites` refuses API writes (anything but GET/HEAD) whose `Origin` is present and isn't this host → 403 `FORBIDDEN_ORIGIN`. The UI (same-origin) and the agent (no `Origin`) are unaffected. M1's DELETE and JSON POSTs were already protected by CORS preflight; this covers them too. Non-browser files: 226/226 |

`run.sh` above is a scratch watchdog wrapper outside the repo (`$TMPDIR/fm-debug/run.sh`, since removed). It ran
`node --test <args>`, killed the run if it passed the given number of seconds, and printed the summary.
macOS has no `timeout` binary, and `--test-timeout` alone can't end a run while a request is stuck open.
The other mutation checks used `cp` backups in `$TMPDIR` that were restored and deleted.

## Review follow-ups (after the M2 review PASS, `docs/CLAUDE_REVIEW.md`; approved by Eve)
The same `run.sh` watchdog was recreated for this session (`$TMPDIR/fm-debug/run.sh`) and removed at the end.

| Follow-up | RED command and result | GREEN result |
|---|---|---|
| F1 file/folder name collisions (storage contract for 3 drivers, API, UI) | `run.sh 60 --test-timeout=10000 --test-name-pattern="collision" test/storage.test.js test/api.test.js` → **8 of 11 fail** (uploads/moves onto `empty`, `implicit`, `a/sub`, `ab`, and through `readme.txt/…`, all succeeded). The 3 passes are the guard "similar names (`abc` vs `ab/`, `a.txt` vs `a/`) are not conflicts, and an existing file is still `FILE_EXISTS`", once per driver. `run.sh 90 --test-timeout=20000 --test-name-pattern="onto a folder's name\|name of a folder here" test/browser.test.js` → **2 fail** (the rename and the upload went through) | 11/11 and 2/2. 409 `NAME_CONFLICT`, with exactly two fixed messages: `A folder with that name already exists` (the key is a folder's name; marker or implicit) and `Part of that path is a file, not a folder` (an ancestor of the key is a file). It is checked after `FILE_EXISTS`, which keeps precedence, for `putFile` (before reading the stream; memory re-checks before storing) and `moveFile`. One existing test (`… during its existence check) is a 413, not a crash`) asserted the exact S3 call list `['HeadObjectCommand']`; the new read-only `ListObjectsV2` collision check made it fail. It now asserts its intent, "no write or upload command, no object", which keeps the guarantee. Non-browser files: 237/237 |
| F2 total upload request limit (decision **D22**: body ≤ `MAX_UPLOAD_MB` + 64 KiB multipart framing) | `run.sh 60 --test-timeout=8000 --test-name-pattern="request limit" test/api.test.js` → **5 of 7 fail**: a declared body one byte over the limit and 70 × 1,000-byte files (each within the per-file limit) both got `201`; a chunked 70-file body got `201`; a flood after an over-limit file was read in full (it ended as a 400 truncated form); a malformed flood stayed `connection: keep-alive` (the old malformed path called `req.resume()`, an unbounded drain). The 2 passes are guards (malformed under the limit stays `MALFORMED_UPLOAD`; client disconnect keeps only complete files, no open S3 upload) | 9/9, then 11/11 with 2 more guards. `src/upload.js`: a declared `Content-Length` over the limit → 413 `REQUEST_TOO_LARGE` before anything is read or stored; a chunked body is counted as it streams and stops the parser at the limit (the in-flight file fails with the same error and its S3 multipart upload is aborted; files before it are reported and stored; `details.requestTooLarge`); on any stop the counter is removed, `req` is unpiped and paused, and the route answers `Connection: close`, so the rest is never read. **Two test premises were corrected** while going GREEN: (1) a client writing 3.2 MB can't read an early answer (Node's client gets `EPIPE` and drops the response; seen in a probe), so the flood test asserts "cut off: connection closed early, nothing stored, server healthy"; a separate test shows a client still sending a little after the stop *does* get its 413/400 with `Connection: close`. (2) The "a little after" over-limit case must first pass 66,560 bytes, or only the per-file limit applies. **No lingering-close code was added:** the guard "a body up to 2× the limit still reads its 413" passed in 3 of 3 runs (declared and chunked) without it. One existing test (S3 abort when the per-file limit trips mid-upload) sent 200,000 bytes, which is now over the request limit; it now sends 150,000 (over the 100,000 file limit, under the 165,536 request limit), keeping its coverage. Non-browser files: 248/248 |
| F3 overlapping uploads keep every row and result | `run.sh 120 --test-timeout=20000 --test-name-pattern="overlapping uploads" test/browser.test.js` → **3 of 3 fail**: once batch B started, the list held only B (`actual: ['three.txt']`); A's partial failure, and every A row in the D16 case, were gone | `public/app.js` appends each batch's rows instead of `replaceChildren`; the list lasts until the page is reloaded. One expectation was corrected: a rejected file's progress bar shows 100, because it measures bytes *sent* (the browser sent the whole file before the server refused). All `M2: uploads` tests: 10/10 |
| F4 no upload into a folder that failed to load | `run.sh 150 --test-timeout=20000 --test-name-pattern="upload needs a loaded folder" test/browser.test.js` → **5 of 5 fail**: upload was never disabled (`{ disabled: false, labelDisabled: null }`) after a 404, after a 502, during loading, or after stale loads in either order | 5/5. `load()` disables upload when it starts and enables it only when the *current* load succeeds (stale results return before touching it), with `input.disabled`, `aria-disabled` and a `.disabled` style on the label. `uploadFiles` also refuses while disabled. Mutation check: with that handler guard removed, the forced `change` test failed because `one.txt` was uploaded into `missing/`, creating it; restored → passes. Browser + helper suites: 67/67, 0 skipped |

## M2 acceptance criteria → evidence
| Criterion (`IMPLEMENTATION_BRIEF.md` §5 M2) | Where |
|---|---|
| Upload (multi-file, progress), download, rename/move, delete | API: S3, S6, S8, S12a; UI: U1–U4 |
| Tests: upload/download round trip, oversize → 413, rename, delete, bad keys → 400 | S12a (byte-for-byte round trip), S12b, S6/U3, S3/U2, S1/S3/S6/S8/S12c |
| Uploads streamed, bounded by `MAX_UPLOAD_MB` (default 100); partial multi-file failures reported per file, never claiming failed files succeeded | S10 (parts sent while the stream arrives, at most one part buffered), S12b/S12g (limit, wired from the env), S12b–S12f, U4 |
| Download: short-lived presigned 302 from real S3; deterministic local response for memory/demo | S7 (`X-Amz-Expires=300`), S8 (302 + `no-store`; memory 200 attachment) |
| Rename/move is copy-then-delete; rejects a missing source and an existing destination; never deletes the source when the copy fails; reports a partial move | S4, S5, S6, U3 |
| Delete file: explicit browser confirmation and exact server-side key validation | U2 (`confirm`), S1/S3 (`parseFileKey`, no normalisation) |
| UI: multi-file picker, per-file progress/result, row actions, phone width, stale outcomes don't overwrite a later folder's status, touch targets ≥ 44×44 | U1–U4 (375 px and 1280 px; D16 tests for delete, rename and upload) |
| Shared memory/S3 contract + fake-S3 tests; browser regression tests; no unapproved dependency | `test/storage.test.js` contract (memory, s3, s3 2-item pages), S3 specifics; `test/browser.test.js`; only the two approved packages were added |

## Key decisions (M2)
| Decision | Reason |
|---|---|
| Storage interface gains `putFile(key, stream)`, `getDownload(key)`, `moveFile(from, to)`, `deleteFile(key)` (documented in `src/storage/memory.js`) | One contract for both drivers |
| Uploads and moves never overwrite (409 `FILE_EXISTS`). S3 uses a `HeadObject` pre-check plus conditional writes (`IfNoneMatch: '*'` on `PutObject`/`CompleteMultipartUpload`) | Safe default with no overwrite flag in the brief; the conditional write closes the upload race |
| S3 upload: at most one 8 MiB part buffered; a body that fits in one part is a single `PutObject` with a known length, otherwise Create/UploadPart/Complete; abort on any failure (an abort failure is logged, and the original error reported) | The approved decision; memory stays bounded; S3's 5 MiB minimum part size |
| `getDownload`: S3 checks existence first (a JSON 404 instead of an S3 error page), then presigns `GetObject` for 300 s with `Content-Disposition: attachment` (RFC 6266/8187, `src/disposition.js`). Memory returns the bytes | Approved decision; never render bucket content inline |
| Move partial failure → 502 `MOVE_INCOMPLETE` `{ from, to, copied: true, sourceDeleted: false, reason }` | "Report a partial move"; no data loss, but it must be visible |
| Upload response: 201 `{ files }` only if every file was stored. Otherwise `UPLOAD_FAILED`/`UPLOAD_INCOMPLETE` with per-file `error`s; the status is the failures' common status, else 502 if any is a 5xx, else 400. A malformed or cut-off body is never 201 and is reported as `details.malformed` | Per-file reporting; never claim failed files succeeded; oversize single file → 413 |
| busboy: `preservePath: true` (a `/` in a name is rejected, never silently cut), `defParamCharset: 'utf8'`, `fileSize: max + 1`, an empty file input is ignored, non-file fields are ignored | Exact names; busboy's limit fires when the limit is *reached* |
| `toPublicError()` (`src/errors.js`) is shared by the error handler and the per-file upload errors | Fixed client errors everywhere; raw details only in the server log |
| `start(storage, config, label)` builds the app for both entry points | `MAX_UPLOAD_MB` was not wired; one shared path |
| `sameOriginWrites`: API writes with a foreign/`null` `Origin` → 403 `FORBIDDEN_ORIGIN` | Multipart POSTs need no CORS preflight; there is no login (D2/D9). Now recorded as **D21** |
| F1/D23: 409 `NAME_CONFLICT` (two fixed messages) for upload/move destinations that are a folder's name or go through a file; checked after `FILE_EXISTS` | No same-name file + folder through uploads or moves; existing collision semantics kept. Folder creation unchanged (M1 scope) |
| F2/D22: request body ≤ `MAX_UPLOAD_MB` + 64 KiB; declared `Content-Length` pre-checked; chunked bodies counted; on stop: unread rest, `Connection: close` | Smallest rule tied to the existing setting (one file of exactly the limit always fits); no new config; bounded reading. No lingering-close drain: the only case where it would matter (a client streaming far beyond the limit) gets a connection reset, documented |
| F3: the upload list is appended to, never replaced | An earlier upload's rows (and the rows its status points at) must stay visible |
| F4: upload is enabled only after the *current* folder loaded successfully (`setUploadEnabled` in `load()`; handler guard too) | A failed/missing folder must not be created implicitly; stale loads can't toggle it |
| UI: one XHR per file (fetch has no upload progress); the upload list keeps every file's result after navigation, while the status line follows D16; rename is a `prompt` pre-filled with the full key (rename or move) | Brief's UI requirements; D16 unchanged |
| `IMPLEMENTATION_BRIEF.md`: D20 (dependency approvals), D21–D23, the stack line. `README.md`: status, M2 API, IAM `s3:AbortMultipartUpload`, a lifecycle-rule tip, `FORBIDDEN_ORIGIN`, `NAME_CONFLICT`, the request limit. `CLAUDE.md`: architecture and stale-response rules | Durable record; M2 scope unchanged |

## Changed files (uncommitted; HEAD `1fa3d1b`; nothing staged)
- **New (untracked):** `src/upload.js` (busboy receiver), `src/disposition.js` (attachment header),
  `test/disposition.test.js`
- **Modified source:** `src/app.js` (routes, `sendUploadResults`, `sameOriginWrites`, `toPublicError` use, request limit),
  `src/errors.js` (`toPublicError`, `moveIncomplete`, `NAME_CONFLICT` factories), `src/paths.js` (`parseFileKey`,
  `ancestorPaths`), `src/storage/memory.js`,
  `src/storage/s3.js`, `src/start.js`, `src/server.js`, `src/demo.js`, `public/app.js`, `public/index.html`,
  `public/style.css`
- **Modified tests:** `test/api.test.js`, `test/storage.test.js`, `test/paths.test.js`, `test/start.test.js`,
  `test/browser.test.js`, `test/helpers/fake-s3-client.js` (M2 commands, failure injection, `TEST_SIGNER`)
- **Modified docs/config:** `docs/HANDOFF.md`, `README.md`, `IMPLEMENTATION_BRIEF.md` (D20–D23 + stack line),
  `CLAUDE.md` (architecture + stale-response rules; authorised by Mr. So), `package.json` and `package-lock.json`
  (the two approved dependencies)
- **Review artifact, preserved as written by the reviewer:** `docs/CLAUDE_REVIEW.md` (not edited by this session)
- **Unchanged:** `.env.example`, `.gitignore`, chrome helper and its tests

## Verification (2026-10-09, Node v26.8.1, npm 11.19.0, Google Chrome 155.0.8059.39)
All rerun after the review follow-ups.

| Command | Result |
|---|---|
| `npm test` | exit 0: **317 tests, 317 pass, 0 fail, 0 cancelled, 0 skipped**, 44 suites, about 35 s (285 at the M2 review; M1 baseline 154) |
| `node --test test/browser.test.js test/chrome-helper.test.js` | 67/67, 0 skipped |
| Non-browser files (`api`, `storage`, `paths`, `disposition`, `config`, `start`) | 248/248 (after F2); also included in the full run above |
| `node --check` on all 22 `.js` files in `src/`, `src/storage/`, `public/`, `test/`, `test/helpers/` | no failures |
| `npm ls --depth=0` | exit 0: `@aws-sdk/client-s3@3.1147.0`, `@aws-sdk/s3-request-presigner@3.1147.0`, `busboy@1.6.0`, `express@5.2.1` |
| `npm ls --all` | exit 0 |
| package/lock | `package.json` dependency ranges == lockfile `packages[""]`; lock == installed for all four; lockfileVersion 3. vs HEAD, the lock added exactly `@aws-sdk/s3-request-presigner`, `busboy`, `streamsearch` and removed nothing |
| `git diff --check` / untracked files | clean / no trailing whitespace |
| Secret scan (tracked + untracked: `AKIA…`, `aws_secret_access_key`, `secretAccessKey`, `-----BEGIN`) | only the dummy `TEST_SIGNER` credential in `test/helpers/fake-s3-client.js` and docs describing the scan. `.env` is absent |
| Frontend HTML sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`, `document.write`) | only the comment saying none are used |
| Live smoke (follow-ups): real `src/demo.js`, free port, `MAX_UPLOAD_MB=0.001` (request limit 66,584 B), no AWS | upload `ok.txt` 201; a file named `Documents` → 409 `NAME_CONFLICT` "A folder with that name already exists"; move to `readme.txt/inside.txt` → 409 "Part of that path is a file, not a folder"; move onto `Photos` → 409; 70 × 1,000 B declared (76,170 B) → 413 `REQUEST_TOO_LARGE`; the same chunked → 413 `UPLOAD_INCOMPLETE`, `connection: close`, 60 stored, and the listing matches the reported files exactly; cross-site upload → 403; `/app.js` serves `setUploadEnabled` and the appending list; demo stopped |
| Live smoke (M2, earlier session) | upload/list/download/move/delete/cross-site all as specified. Its "Host guard" line was **not** evidence (`fetch` drops a custom `Host`); the guard is covered by `test/api.test.js` |
| Processes / temp | no `node --test`, demo, server or Chrome processes; no `file-manager-chrome-*` or `file-manager-upload-test-*` dirs in `$TMPDIR`; scratch `$TMPDIR/fm-debug` removed |
| `npm audit` | not run separately (network). `npm install` reported "found 0 vulnerabilities" during the approved install |
| Real S3 / manual phone check | **not run** (forbidden in this session / M4) |

## Incomplete, deferred and open items
- **Not done here (by instruction):** independent review, commit, push, M3, M4 (real S3, phone).
- **Unproven against real S3:** multipart part sizes, `IfNoneMatch` conditional writes (S3 has supported them
  since 2024), `CopySource` encoding, the presigned URL's host and region style, `HeadObject` on a missing bucket
  (real S3 returns a bodiless 404 `NotFound` for HEAD, so a missing bucket may look like a missing file there; the
  later operation then fails as a storage error).
- **Known, out of scope (unchanged):** an ordinary error can be replaced by a later overlapping success in the
  same folder (M1 gap); the lockfile's top-level `name` (`file-manager`) differs from `package.json`.
- **Deleting or moving the last file out of an implicit folder** (no marker) makes that folder disappear; the
  reload then reports "This folder does not exist" with the success. That's S3 prefix semantics (D11); not changed.
- **Uploading into a non-existent prefix** through the API creates it implicitly (S3 semantics); the UI now only
  uploads into a folder that loaded successfully (F4).
- **Not covered by D23:** creating a folder where a file of that name exists (M1 path, unchanged), and objects
  written outside the app. The collision check is not atomic with the S3 write (two concurrent requests could race).
- **Oversize uploads far beyond the limit:** a client that keeps streaming far past the request limit may get a
  connection reset instead of the 413 (the server stops reading; Node's client drops the response on `EPIPE`).
  In the UI that shows as "Upload failed: the connection was lost." A body up to 2× the limit gets its 413
  (tested). The UI doesn't know the limit, so it can't warn before sending.
- **The upload list grows** for the life of the page (by design, F3); there is no Clear button.
- **`CopyObject` limit:** moving an object over 5 GB (only possible if uploaded outside the app) fails as a generic
  `STORAGE_ERROR`.
- **Git remote** `origin` exists; Eve should confirm it was authorised (review risk). Not used here.

## Risks
- **Security:** still no login. `127.0.0.1` by default, the Host guard against DNS rebinding, and now the
  `Origin` check against cross-site writes. **Never expose it to the internet.**
- **Data:** uploads and moves never overwrite; deletes are permanent without bucket versioning. A partial move
  leaves both copies (reported). Check-then-act races remain for move (the destination check isn't atomic:
  CopyObject has no destination precondition here).
- **Cost/cleanup:** a failed abort leaves multipart parts until a lifecycle rule removes them (logged; README
  tip). The presigned URL is valid for 5 minutes for anyone who has it.
- **Privacy:** server logs hold raw S3 errors, keys of failed operations and malformed-upload reasons; local only.
- **Browser tests:** they need local Chrome; they use fixed delays (300–900 ms; the progress test uses an 8 MiB
  file and a 600 ms server delay) that could be flaky on a slow machine.

## Next recommended step
1. Eve reviews the follow-ups (F1–F4), D21–D23 and the `CLAUDE.md` update.
2. A fresh, independent, read-only re-review. Expect `npm test` to show 317 pass, 0 skipped.
3. Commit only with explicit approval; no push. M3 only after M2 is accepted.
