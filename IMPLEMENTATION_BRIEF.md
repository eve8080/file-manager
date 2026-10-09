# Implementation Brief — S3 File Manager

Status: direction approved by Mr. So on 2026-10-08.

## 1. Requirements
- Web application usable from desktop and mobile browsers.
- All files stored in one new, private AWS S3 bucket. No other storage.
- Basic file manager functions: browse folders, create/delete folders, upload, download,
  rename/move files, delete files.
- Preview for basic types: text, images (jpg/png/gif/webp), PDF.
- Users: Mr. So and his AI agent (agent uses the same HTTP JSON API as the UI).
- v1: no access control — anyone who can reach the app has full access.

## 2. Decisions
| # | Decision |
|---|---|
| D1 | v1 runs locally on Mr. So's Mac. Default `127.0.0.1`; phone access over home Wi-Fi with `HOST=0.0.0.0`. Internet hosting is a later, separately approved milestone. |
| D2 | No login in v1, accepted on the condition it is never exposed to the internet. An access token milestone must precede any deployment. |
| D3 | AWS credentials via the SDK default chain, configured by Mr. So. README documents a least-privilege IAM policy scoped to the bucket. |
| D4 | Mr. So creates the bucket, keeps Block Public Access ON; S3 versioning recommended. The app never creates/modifies AWS resources. |
| D5 | Deletes require confirmation; deleting a non-empty folder requires typing the folder name. The API enforces this too: `recursive=true` requires `confirm=<exact folder name>` (review finding 2, 2026-10-08). |
| D6 | v1 supports file rename/move and folder create/delete. Folder rename is out of scope. |
| D7 | Uploads streamed through the server, `MAX_UPLOAD_MB` default 100. |
| D8 | Single JSON API serves both the browser UI and the AI agent. |
| D9 | Host-header guard: requests are accepted only when the Host is an IP literal or `localhost` (blocks DNS-rebinding attacks against the unauthenticated API). `.local` hostnames are therefore not supported. |
| D10 | `npm run demo` runs the app with in-memory sample data so the UI can be reviewed without AWS. |
| D11 | Folders are S3 prefixes. "Create folder" writes a zero-byte marker object `path/`. A folder exists if any object has that prefix. |
| D12 | Partial recursive deletes return 502 `DELETE_INCOMPLETE` with counts (`deleted`, `failedCount`, `unknown`, `notAttempted`) and up to 20 failed keys, each with a fixed `reason`. Deletion stops at the first failing batch; a batch whose request errored is reported as `unknown`, never as deleted (review finding 3). |
| D13 | The UI ignores stale list responses: each load aborts the previous request and checks a sequence number, so `current.prefix` always matches the URL hash (review finding 1). |
| D14 | Browser regression tests drive headless Chrome via the DevTools Protocol with Node's built-in WebSocket (`test/helpers/chrome.js`): no new dependencies. Skipped with a reason if no Chrome is found. The helper bounds startup, shutdown (SIGTERM, then SIGKILL of the process group), CDP commands and navigation; cleanup is idempotent; pending commands fail when the connection drops (second review, 2026-10-08). |
| D15 | Breadcrumb links, folder links and buttons are at least 44×44 CSS px (review finding 4). |
| D16 | Create/delete completions are discarded if the user navigated while they were in flight (navigation sequence token): they never change the new folder's status, and a delete never prompts about a folder the user has left. Exception: a partial delete is still reported, via `alert()`, because it means possible data loss (second review). |
| D17 | Storage failures are reported to clients only as fixed reasons (`ACCESS_DENIED`, `CREDENTIALS_UNAVAILABLE`, `BUCKET_NOT_FOUND`, `THROTTLED`, `NETWORK`, `UNAVAILABLE`, `UNKNOWN`) in 502 `STORAGE_ERROR` / `DELETE_INCOMPLETE`. Raw SDK names, S3 codes and messages are logged server-side only (second review). |
| D18 | M1 closure fixes N1–N4 from the fresh Claude review (`docs/CLAUDE_REVIEW.md`), approved by Mr. So on 2026-10-09: startup logs "listening" only after a successful bind; the URL hash is kept canonical (an undecodable hash becomes `#/` via `history.replaceState`, so there is no loop and no new history entry); a failed reload after a successful create/delete is reported together with the success, never hidden by it; automated browser coverage for all six sort orders, folders first, and toolbar controls ≥ 44×44. Operations finishing after navigation keep D16 unchanged (no notice area; partial delete stays an alert). |
| D19 | On 2026-10-09 Mr. So delegated acceptance to Eve and approved fixing all four remaining non-blocking M1 review findings, then proceeding to M2 without his manual review. M1 must still pass a fresh independent read-only Claude review and Eve's deterministic gates before M2 starts. No deployment or real-S3 action is authorized. |
| D20 | M2 dependencies, approved 2026-10-09: `@aws-sdk/s3-request-presigner` (same version line as `@aws-sdk/client-s3`) for the 302 redirect to a 5-minute presigned download URL, and `busboy` for streamed multipart, multi-file uploads. S3 streams of unknown size use `@aws-sdk/client-s3`'s multipart-upload commands, aborting the upload on failure. No other dependency is approved. |
| D21 | Cross-site write protection (`sameOriginWrites` in `src/app.js`, added during M2, acknowledged after the M2 review): any `/api` request other than GET/HEAD that carries an `Origin` header naming another host, or `Origin: null`, is refused with 403 `FORBIDDEN_ORIGIN` before any route runs. Reason: a multipart upload is a CORS "simple request" that browsers send cross-site without a preflight, so with no login (D2) any web page could write into the bucket through the user's browser; the Host guard (D9) does not stop this. The same-origin UI and clients that send no `Origin` (the AI agent, scripts) are unaffected. Tested: foreign, `null` and other-port origins are refused and store nothing; same-origin and no-`Origin` uploads succeed. |
| D22 | Upload request limit (review follow-up, 2026-10-09): `MAX_UPLOAD_MB` limits each file **and** each upload request, whose body may be at most `MAX_UPLOAD_MB` + 64 KiB of multipart framing (so one file of exactly the limit always fits). A declared `Content-Length` over it → 413 `REQUEST_TOO_LARGE` before anything is read or stored. A chunked body is counted as it streams; at the limit, parsing stops, the file in flight fails with `REQUEST_TOO_LARGE` (its S3 multipart upload aborted), files before it are stored and reported, and the rest of the body is not read (`Connection: close`). No new configuration. |
| D23 | File/folder name collisions (review follow-up, 2026-10-09): an upload or move may not give a file the visible name of an existing folder, nor put it under a path whose part is an existing file. Both → 409 `NAME_CONFLICT`, with the fixed messages "A folder with that name already exists" / "Part of that path is a file, not a folder". An existing file at the destination is still 409 `FILE_EXISTS` (checked first). The check is not atomic with the S3 write. Creating a folder where a file of that name exists is unchanged (M1). |
| D24 | M3 preview (approved by Mr. So on 2026-10-09): the kind comes from the file extension only (`src/preview.js`): text (`txt`, `md`, `csv`, `json`, `html`, `svg`, … shown strictly as text via `textContent`), image (`jpg`/`jpeg`/`png`/`gif`/`webp`), PDF; anything else is `none` (download only). Text previews send at most the first 1 MiB (1,048,576 bytes; S3: one ranged GET), with `truncated: true` and a visible notice when the file is larger; a UTF-8 character cut by the limit is dropped. Image/PDF previews from real S3 are 5-minute presigned GET URLs that override `Content-Type` (from the extension, never the stored type) and `Content-Disposition: inline`. Memory/demo instead returns a same-origin URL, `GET /api/files/preview/content?key=` (bytes inline, typed by extension, `nosniff`, its own CSP `default-src 'none'; frame-ancestors 'self'` so the PDF can be framed; on S3 the same route 302s to the presigned URL). The page CSP adds `img-src`/`frame-src 'self' https://*.amazonaws.com`; scripts stay same-origin. No new dependency. |

## 3. Architecture
```
Browser (desktop/phone) ─┐
AI agent ────────────────┴─ HTTP JSON API ─ Node.js + Express 5 ─ storage interface ─┬─ S3 (AWS SDK v3)
                                                                                    └─ memory (tests/demo)
```
- Stack: Node.js >= 22.9, Express 5, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and `busboy`
  (both approved for M2, 2026-10-09), vanilla HTML/CSS/JS frontend, `node:test`.
- Config (`.env`): `S3_BUCKET`, `AWS_REGION`, optional `AWS_PROFILE`, `HOST`, `PORT`, `MAX_UPLOAD_MB`.
- Downloads / image and PDF previews (M2/M3): 5-minute presigned GET URLs. Text preview capped at 1 MiB, rendered as text (D24).
- Path rules (`src/paths.js`): no leading `/`, no empty / `.` / `..` segments, no control characters,
  no leading/trailing whitespace in a segment, max 1024 bytes.

## 4. API
Errors: `{ "error": { "code": "...", "message": "...", "details"?: {...} } }` with 400 / 403 / 404 / 409 / 413 / 502 / 500.

| Method | Path | Milestone | Result |
|---|---|---|---|
| GET | `/api/health` | M0 | `{ ok: true }` |
| GET | `/api/list?prefix=a/b/` | M1 | `{ prefix, folders: [{name, path}], files: [{key, name, size, modified}] }`; 404 if folder missing |
| POST | `/api/folders` `{ path }` | M1 | 201 `{ path }`; 409 `FOLDER_EXISTS` |
| DELETE | `/api/folders?path=&recursive=true&confirm=<name>` | M1 | `{ path, deleted }`; 409 `FOLDER_NOT_EMPTY` unless `recursive=true`; recursive needs `confirm` = exact folder name, else 400 `CONFIRMATION_REQUIRED` / `CONFIRMATION_MISMATCH`; partial S3 failure → 502 `DELETE_INCOMPLETE` with `details`; other S3 failures → 502 `STORAGE_ERROR` with `details.reason` |
| POST | `/api/files?prefix=` (multipart) | M2 | upload; 413 if over limit |
| GET | `/api/files/download?key=` | M2 | 302 to presigned URL |
| POST | `/api/files/move` `{ from, to }` | M2 | rename/move file |
| DELETE | `/api/files?key=` | M2 | delete file |
| GET | `/api/files/preview?key=` | M3 | `{ kind: text|image|pdf|none, text?, truncated?, url? }` |
| GET | `/api/files/preview/content?key=` | M3 | image/PDF bytes inline (memory/demo); 302 to the presigned URL (S3); 400 for other kinds (D24) |

## 5. Milestones and acceptance criteria
**M0 – Skeleton** (delivered together with M1)
- `npm test` passes; `npm start` with valid `.env` serves on `127.0.0.1:3000`
- Missing `S3_BUCKET` / `AWS_REGION` exits with a clear message
- Path validator rejects `..`, leading `/`, empty segments, control characters

**M1 – Browse and folders**
- List root and nested folders; folders first; marker objects hidden; breadcrumbs; sort by name/size/date
- Create folder; 409 if it already exists
- Delete empty folder; non-empty → 409 unless `recursive=true`; recursive delete removes all nested objects and
  never touches sibling prefixes (`a/` vs `ab/`); handles > 1000 objects (S3 batch limit) and paginated listings
- Recursive delete requires the exact folder name in `confirm`, enforced by the API
- Partial S3 delete failures → structured 502 `DELETE_INCOMPLETE`; stops at the first failing batch; tests show
  exactly which objects remain
- Missing folder → 404; invalid path → 400; non-IP/non-localhost Host → 403
- UI usable at phone width; back button navigates folders; touch targets ≥ 44×44 CSS px
- Rapid navigation never leaves the URL and the displayed folder (`current.prefix`) inconsistent
  (browser regression tests)
- A create/delete that completes after the user navigated never changes the new folder's status
  (browser regression tests, including navigation to a missing folder)
- Storage errors reach clients only as fixed classifications
- M1 closure (D18), each with a regression test:
  - N1: a port already in use → exit 1, exactly one error line, no "listening" message (`test/start.test.js`)
  - N2: an undecodable or non-canonical hash is replaced in place by the canonical URL; no navigation loop
  - N3: a failed reload after create/delete (including partial delete) is reported, not overwritten
  - N4: all six sort orders and folders-first; toolbar controls ≥ 44×44 CSS px at 375 px and 1280 px
- Final M1 closure (D19), each with a regression test where behavior changes:
  - reject structured/non-string query values such as `prefix[a]=b` with 400, consistently with repeated values
  - non-recursive folder deletion must determine non-emptiness with a bounded listing (at most the marker plus one child), not enumerate the entire prefix
  - when two same-folder mutations overlap, each successful mutation must retain a user-visible outcome even if its reload becomes stale; D16 still forbids notices after navigation
  - keep decision numbering in order in this document

**M2 – File operations**
- Upload (multi-file, progress), download, rename/move, delete
- Tests: upload/download round trip, oversize → 413, rename, delete, bad keys → 400
- Uploads are streamed through the server and bounded by `MAX_UPLOAD_MB` (default 100); partial multi-file failures must be reported per file without claiming failed files succeeded.
- Download returns a short-lived presigned GET redirect from real S3; the memory/demo driver must provide a deterministic local download response so automated API/browser tests never touch AWS.
- Rename/move is copy-then-delete for S3. It must reject a missing source and an existing destination, never delete the source when copy fails, and report a partial move if copy succeeds but source deletion fails.
- Delete file requires an explicit browser confirmation and exact server-side key validation.
- UI requirements: multi-file picker, per-file progress/result, file-row Download/Rename/Delete actions, phone-width usability, stale async outcomes must not overwrite the status of a folder navigated to later, and touch targets remain at least 44×44 CSS px.
- Storage/API behavior must be covered by the shared memory/S3 contract and fake-S3 tests; UI behavior must have headless-browser regression tests. No new framework or dependency without approval.

**M3 – Preview**
- Text / image / PDF preview; other types offer download
- Tests: each kind; text > 1 MiB truncated with notice; HTML content shown as text

**M4 – Manual real-S3 check (Mr. So)**
- Checklist run against the real bucket from desktop and phone on Wi-Fi

## 6. Out of scope (v1)
Authentication; internet hosting/deployment; folder rename; search; share links; trash/undo beyond S3
versioning; direct-to-S3 large uploads; thumbnails; multiple buckets.
