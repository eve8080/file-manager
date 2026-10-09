# Fresh Claude Review

- Reviewed at: 2026-10-09T18:59:04+08:00
- Claude session: cc638332-fce3-4067-bf10-e08540cb02ab
- Completion subtype: success
- Reported cost: US$1.08
- Mode: fresh session; Claude tools restricted to Read and Bash; no Edit or Write tool

VERDICT: PASS

I found no blocking issues in M2 (file operations), its follow-ups F1–F4, or decisions D21–D23. Every M2 acceptance criterion has direct evidence. The full suite passed 317/317 with none skipped, and a live smoke test of the real demo entry point behaved as the brief says. I changed no project files and staged, committed and pushed nothing. My only temp files were in `/tmp`, and I deleted them.

## Acceptance criteria (`IMPLEMENTATION_BRIEF.md` §5, M2)

| Criterion | Result | Evidence |
|---|---|---|
| Upload (several files, with progress), download, rename/move, delete | ✅ | Routes at `src/app.js:55-93`. UI at `public/app.js` (row actions, `renameFile`, `deleteFile`, `uploadFiles`, `uploadOne`). The live smoke test got 201 on upload, 200 on download, 200 on move and 200 then 404 on delete. The UI code is really served: the live `/app.js` contains `setUploadEnabled`, `uploadOne` and the move/download URLs. |
| Tests: upload/download round trip, oversize → 413, rename, delete, bad keys → 400 | ✅ | `test/api.test.js` (`M2 upload`, `size limit`, move, delete and download blocks). Live: oversize → 413 `TOO_LARGE`. Bad keys (`Documents/`, `../x`, `a//b`, empty, `%01`, `key[x]`) all → 400. |
| Uploads streamed and limited by `MAX_UPLOAD_MB`; partial failures reported per file | ✅ | `src/upload.js` (busboy). `src/storage/s3.js:228-285` keeps at most one part in memory. `src/start.js` wires `maxUploadMb` into `createApp`. The limit uses busboy's `fileSize: max + 1`; I checked `node_modules/busboy/lib/types/multipart.js:476`, which fires `'limit'` when `fileSize === fileSizeLimit`, so this is correct. Live partial upload: 413 `UPLOAD_INCOMPLETE`, with `b.txt ok:true` and `big.bin TOO_LARGE`. |
| Download: short-lived presigned 302 on real S3; fixed local response for memory/demo | ✅ | `s3.js:289-297` uses `expiresIn: 300` and `ResponseContentDisposition`. `app.js:70-80`. Live (memory driver): 200, `Cache-Control: no-store`, `octet-stream`, `Content-Disposition: attachment; filename="_t_ 1.txt"; filename*=UTF-8''%C3%89t%C3%A9%201.txt` |
| Move is copy-then-delete; rejects a missing source and an existing destination; never deletes the source if the copy fails; reports a partial move | ✅ | `s3.js:300-311`. The tests `move: a failed copy never deletes the source` and `move: copy succeeded but … MOVE_INCOMPLETE` pass. Live: missing source → 404; moving onto a folder name → 409 `NAME_CONFLICT`. |
| Delete file: browser confirmation plus exact server-side key check | ✅ | `public/app.js` `deleteFile` calls `confirm()`. `src/paths.js` `parseFileKey` checks the key as given and never normalises it. Browser tests at `test/browser.test.js:706,716` |
| UI: multi-file picker, per-file progress/result, row actions, phone width, late results don't change a later folder's status (D16), touch targets ≥ 44×44 | ✅ | `test/browser.test.js:678-1114`: D16 tests for delete (734), rename (829) and upload (1061, 1097); 44×44 at 375 px and 1280 px (845, 1114); F3 overlapping uploads (1021); F4 upload disabled until the folder loads (935) |
| Shared memory/S3 contract plus fake-S3 tests; browser tests; no unapproved dependency | ✅ | `test/storage.test.js:9-29` runs the contract against memory, s3, and s3 with 2-item pages. `npm ls` shows only `client-s3`, `s3-request-presigner@3.1147.0`, `busboy@1.6.0` and `express`. The last two are approved under D20. |
| D21 / D22 / D23 | ✅ | Live: a foreign `Origin` on upload or delete → 403; a non-IP `Host` → 403; a same-origin `Origin` → 201. Request-limit and name-collision tests pass. |

## Commands run

| Command | Result |
|---|---|
| `npm test` | exit 0: **317 tests, 317 pass, 0 fail, 0 cancelled, 0 skipped**, 44 suites, about 34.8 s. Chrome ran, so the browser tests were not skipped. |
| `node --check` on every `.js` file in `src/`, `src/storage/`, `public/`, `test/`, `test/helpers/` | no failures |
| `npm ls --depth=0` | exit 0, 4 dependencies as listed above |
| `git diff --check` | clean |
| `git status --short`, `git diff --stat`, `git remote -v` | 24 modified files, 3 untracked (all read), nothing staged. Remote `origin` → `github.com/eve8080/file-manager.git` |
| Secret scan (`AKIA…`, `ASIA…`, `aws_secret_access_key`, `secretAccessKey`, private-key headers) | No real secrets. The only credential is a dummy in `test/helpers/fake-s3-client.js:197` whose access key starts with `TEST`. The docs only mention the words. `.env` is git-ignored and **does not exist** in the working tree. |
| Frontend HTML sinks (`innerHTML` and similar) | none. `el()` (`public/app.js:84`) uses `textContent`. |
| Live smoke: `PORT=38517 MAX_UPLOAD_MB=0.01 node src/demo.js`, 16 curl checks | all as specified (results above). A malformed multipart body → 400 `MALFORMED_UPLOAD`, and the server stayed up. |
| Live smoke 2: `PORT=38518 node src/demo.js` | UTF-8 download headers correct, same-origin upload 201, the UI bundle has the new code. Stopped cleanly; no stray `node` processes. |

Real S3 and a phone were not used: both are out of scope (M4), and no network writes were made.

## Blocking findings
None.

## Non-blocking findings
1. **`docs/HANDOFF.md:138` is wrong about `.env`.** It says ".env exists, is git-ignored, and was not read", but `test -e .env` shows it is absent. This is only a documentation error.
2. **Filenames containing `"` are stored percent-encoded.** I uploaded `Été "q".txt` with curl and the key became `Été %22q%22.txt` (smoke step 5). Browsers encode `"`, CR and LF the same way, and busboy does not decode them. Nothing is lost, but the stored name differs from what the user picked.
3. **Many tiny files in one request run their S3 uploads at the same time.** Each file is fed through a small buffer (`src/upload.js:88`), so a small file ends quickly and the next one starts before the first `putFile` finishes. The 100 MB request limit bounds this, but one request with thousands of small files would start thousands of S3 calls at once. This doesn't affect the UI, which sends one file per request.
4. **Uploads don't set a content type.** No `ContentType` is passed (`s3.js:257,264`), so S3 stores every object as `binary/octet-stream`. That's harmless for M2 because downloads are attachments, but M3's image and PDF previews will probably need it.
5. **Uppercase `Host` headers are refused.** `sameOriginWrites` (`src/app.js:171`) compares hosts case-sensitively, so a `Host: LOCALHOST:3000` header would get a 403 it shouldn't. This fails safe and is unlikely to happen in practice.
6. **A git remote exists.** `origin` points to `https://github.com/eve8080/file-manager.git`, while `CLAUDE.md` says not to add a remote until Mr. So asks. HANDOFF already flags this, and nothing in this milestone uses it. Eve should confirm it was authorised.

## Residual risks
- **Untested against real S3:** conditional writes (`IfNoneMatch` on `PutObject` and `CompleteMultipartUpload`), multipart part sizes, `CopySource` encoding, the presigned URL's host and region, and `HeadObject` on a missing bucket (real S3 answers a bare 404 `NotFound`). All of this falls to M4.
- **Races:** the move destination check and the D23 name-collision check aren't atomic with the S3 write (documented).
- **No login.** Safety depends on binding to `127.0.0.1`, the `Host` guard and the `Origin` check. It must never be exposed to the internet.
- **Possible flaky tests:** the browser tests use fixed delays of 300–900 ms, which a slow machine might not meet.

## Recommended next action
Eve runs her gates and decides on the non-blocking items: correcting HANDOFF line 138 and confirming the git remote are quick; the content type (item 4) can go to M3. After that, commit only with explicit approval and don't push. Start M3 only once M2 is accepted.
