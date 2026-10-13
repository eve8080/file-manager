# Implementation Brief — S3 File Manager

Status: direction approved by Mr. So on 2026-10-08. JPEG preview conversion (D25) approved and implemented 2026-10-10; the exact private image passed on physical-iPhone Safari through the demo driver, while the real-S3 physical retest remains open. Phase A of the login plan (optional local Cognito login, D26) was approved by Mr. So, implemented on 2026-10-11, self-audited on 2026-10-13 and revised the same day in the approved close-out round; it is verified offline only (see "Phase A — local implementation authorized"). Phases B and C are not approved.

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
| D25 | JPEG previews are converted on demand (M4 follow-up, approved by Mr. So, recorded 2026-10-10). **Finding:** on a physical iPhone, `IMG_0001.jpeg` (baseline JPEG, 5712×4284, Display P3, MPF + XMP HDR gain map) did not show in the preview `<img>` although the response was a valid `200 image/jpeg` that desktop Chrome decodes; an ordinary JPEG worked. Differential fixtures on the phone: the original 5712 px/P3 failed; the same picture resized to 4032 px or 2048 px (P3) worked; a full-size 5712 px re-encode worked in sRGB and in P3. So the cause is the original's MPF/gain-map encoding and metadata, not its size or P3 alone. **Decision:** `sharp` (the only new direct dependency) converts every `.jpg`/`.jpeg` preview: rotated by its EXIF orientation, fitted inside 2048×2048 without enlargement, converted to sRGB, re-encoded as a baseline JPEG (quality 85) with all metadata, the colour profile, the gain map and the MPF second image dropped (`src/jpeg-preview.js`). The original is never changed and no derivative is stored (S3 is read only); there are no temp files. **API:** for JPEGs `GET /api/files/preview` returns `{ kind: 'image', url: '/api/files/preview/content?key=…' }` on every driver (never a presigned URL; S3 does one `HeadObject`), and `GET /api/files/preview/content` reads the file (S3: one `GetObject`, only now), converts it and answers 200 `image/jpeg` with `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and the content route's CSP `default-src 'none'; frame-ancestors 'self'`. PNG, GIF, WebP and PDF are unchanged (presigned on S3, so animation and format are untouched); downloads are unchanged. **Storage:** `getPreview` for a JPEG returns only `{ kind, contentType }`; the new `readPreviewSource(key, maxBytes)` returns the whole file as a Buffer. **Bounds:** the source is limited to `MAX_UPLOAD_MB` (no new setting; default 100 MB): S3 refuses from the GET's `ContentLength` before reading a byte and also stops a longer-than-declared stream; over the limit → 413 `PREVIEW_TOO_LARGE`. sharp needs the whole file in memory, so at most 2 conversions run at once (`MAX_CONCURRENT_CONVERSIONS`; the others wait without holding data), giving a peak of roughly 2 × `MAX_UPLOAD_MB` plus decoder working memory. Input is accepted only if it starts with a JPEG signature (an SVG or PNG named `.jpg` is refused, not rendered), at most 128 megapixels, and a conversion is stopped after 30 s. **Errors:** a corrupt, cut-off or unsupported file → 422 `PREVIEW_FAILED` with a fixed message; the decoder's own error is only logged. The UI shows its usual "could not be displayed" message with Download kept. **UI:** an image preview stays "Loading preview…" (state `loading`) until the picture has arrived, because the conversion takes a moment. |
| D26 | Phase A login (approved by Mr. So, "批准開始Phase A"; implemented 2026-10-11, offline-tested only). Optional `AUTH_MODE=cognito`; unset keeps v1 (D1/D2) unchanged, and login settings or an AWS Lambda runtime without it refuse to start. Cognito mode needs `COGNITO_REGION`, `USER_POOL_ID`, `COGNITO_DOMAIN`, `NATIVE_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `OWNER_SUBS`, `AGENT_CLIENTS`, `AGENT_SCOPE_PREFIX`, `PUBLIC_ORIGIN` (strictly validated, fixed messages) and in this phase binds loopback only with a loopback `PUBLIC_ORIGIN`. Server (`src/auth.js`, `aws-jwt-verify@5.2.1`): access token only in `X-App-Authorization: Bearer` (never `Authorization` or the URL); pool issuer, `token_use=access`, configured client IDs, required `exp`, `nbf`; owner = owner client + exact sub in `OWNER_SUBS`; agent = `AGENT_CLIENTS` client via client credentials with configured ∩ granted `<prefix>/<scope>`; email never grants. 401 `AUTH_REQUIRED`/`INVALID_TOKEN`, 403 `NOT_AUTHORIZED`/`INSUFFICIENT_SCOPE`, 503 `AUTH_UNAVAILABLE` (only for provider-side faults: JWKS unreachable, not a JWKS, or one of the pool's own keys malformed; an unknown `kid`, a non-signature key or a wrong `alg` stay 401); scopes read (list, download, preview, preview content), write (folder create, upload, move), delete (folder/file delete); exact `PUBLIC_ORIGIN` host and write Origin; `Cache-Control: no-store` on all `/api`; S3 download → JSON `{ url }`. Browser (`public/auth.js`, `oidc-client-ts@3.5.0` self-contained browser build served from `/vendor/`): two public clients, code + PKCE + state + nonce by the library, tokens in `InMemoryWebStorage`, transaction-only `sessionStorage` under `fm.oidc.`, no automatic renewal, expiry/401 → chooser, sign-out = clear memory, revoke refresh token, Cognito `/logout`; same-origin previews and downloads via authorized fetch + revoked `blob:` URLs; if the sign-in library cannot be loaded (an error, or a script that is not the library), the login area shows a fixed error with both sign-in buttons disabled and no file UI. Details: README "Login". |

## 3. Architecture
```
Browser (desktop/phone) ─┐
AI agent ────────────────┴─ HTTP JSON API ─ Node.js + Express 5 ─ storage interface ─┬─ S3 (AWS SDK v3)
                                                                                    └─ memory (tests/demo)
```
- Stack: Node.js >= 22.9, Express 5, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and `busboy`
  (both approved for M2, 2026-10-09), `sharp` (approved for JPEG previews, D25), vanilla HTML/CSS/JS frontend,
  `node:test`.
- Config (`.env`): `S3_BUCKET`, `AWS_REGION`, optional `AWS_PROFILE`, `HOST`, `PORT`, `MAX_UPLOAD_MB`. Optional login
  (Phase A, D26): `AUTH_MODE=cognito` plus nine required settings (`COGNITO_REGION`, `USER_POOL_ID`, `COGNITO_DOMAIN`,
  `NATIVE_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `OWNER_SUBS`, `AGENT_CLIENTS`, `AGENT_SCOPE_PREFIX`, `PUBLIC_ORIGIN`); rules and
  examples in README "Login". Without `AUTH_MODE` the app is v1; login settings without it refuse to start.
- Downloads / PNG, GIF, WebP and PDF previews (M2/M3): 5-minute presigned GET URLs. Text preview capped at 1 MiB,
  rendered as text (D24). JPEG previews are converted by the app and served from `/api/files/preview/content` (D25).
- Path rules (`src/paths.js`): no leading `/`, no empty / `.` / `..` segments, no control characters,
  no leading/trailing whitespace in a segment, max 1024 bytes.

## 4. API
Errors: `{ "error": { "code": "...", "message": "...", "details"?: {...} } }` with 400 / 401 / 403 / 404 / 409 / 413 / 422 / 500 / 502 / 503. 401 (`AUTH_REQUIRED`, `INVALID_TOKEN`) and 503 (`AUTH_UNAVAILABLE`) occur only with `AUTH_MODE=cognito` (D26).

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
| GET | `/api/files/preview?key=` | M3 | `{ kind: text|image|pdf|none, text?, truncated?, url? }`; a JPEG's `url` is always the same-origin content route (D25) |
| GET | `/api/files/preview/content?key=` | M3 | PNG/GIF/WebP/PDF bytes inline (memory/demo); 302 to the presigned URL (S3); 400 for other kinds (D24). `.jpg`/`.jpeg`: a converted 200 `image/jpeg` on every driver; 413 `PREVIEW_TOO_LARGE`, 422 `PREVIEW_FAILED` (D25) |
| GET | `/api/auth/config` | Phase A | public. `{ mode: 'none' }` without login; with `AUTH_MODE=cognito` the browser-public login values only (D26) |
| GET | `/api/me` | Phase A | login only: `{ role: 'owner', sub, scopes }` / `{ role: 'agent', clientId, scopes }` (D26) |

With `AUTH_MODE=cognito` (D26) every route except `/api/health` and `/api/auth/config` needs the token and its route scope, and `GET /api/files/download` on S3 answers 200 `{ url }` instead of the 302.

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

**M4 follow-up – JPEG previews on iPhone (D25)**, each with an automated test (`test/jpeg-preview.test.js`, `test/storage.test.js`, `test/api.test.js`, `test/browser.test.js`):
- `.jpg`/`.jpeg` previews (any case) use a same-origin content URL on memory/demo and S3; no presigned JPEG URL is ever exposed
- The converted JPEG is `image/jpeg`, at most 2048 px on its longer side, never enlarged, rotated by its EXIF orientation, in sRGB (a Display P3 pixel keeps its colour), with no EXIF/XMP/MPF/ICC/COM segment, no gain map and no second image, baseline, and ends at a single EOI
- Headers: inline disposition, `nosniff`, `Cache-Control: no-store`, CSP `default-src 'none'; frame-ancestors 'self'`
- S3: the preview JSON costs one `HeadObject`; the photo is read by exactly one unranged `GetObject` and only when the content is requested; nothing is written, copied or deleted; the original stays byte for byte and downloads as before
- Bounds: a source of exactly `MAX_UPLOAD_MB` converts, one byte more → 413 `PREVIEW_TOO_LARGE` (refused from the headers before any byte is read; a stream longer than declared is cut off at the limit); at most 2 conversions at once; a non-JPEG signature and a picture over the pixel limit (128 MP; the tests lower it) fail. The 30 s conversion timeout is set in code but not exercised by a test
- Corrupt, cut-off, wrong-format or oversized files → fixed 422 `PREVIEW_FAILED` / 413 `PREVIEW_TOO_LARGE`; no sharp/libvips/AWS text reaches a client; the server keeps serving; the UI shows the error in the dialog with Download kept and the folder status untouched
- PNG, GIF, WebP and PDF behave exactly as before (S3: presigned URLs; memory: stored bytes); the 1 MiB text cap and the page/content security headers are unchanged
- Phone width (375 px): the converted picture is shown (natural size 1365×2048 for the 3000×2000 rotated test photo, fits the viewport, no horizontal scrolling); the image stays "Loading preview…" until it arrives
- **Manual acceptance:** the exact private gain-map `IMG_0001.jpeg` passed on physical-iPhone Safari through the demo driver on 2026-10-10. The same test with real S3 remains open and requires separate AWS authorization (the automated fixtures are synthetic and test Chrome is not Safari)

## Login and internet access — planning record (historical)

The planning text below records the planning rounds before Phase A was approved. Phase A has since been approved and implemented locally (see "Phase A — local implementation authorized"); internet hosting, Phase B and Phase C remain planning-only.

Mr. So selected internet access from mobile data/outside the home in the current chat, then explicitly selected AWS hosting with CloudFront + S3 + Lambda instead of a Mac-hosted Cloudflare Tunnel. This authorizes an AWS-specific read-only architecture proposal, not implementation or deployment. The existing v1 restrictions remain in force until a replacement design is approved.

AWS planning requirements: evaluate CloudFront with a private S3 frontend origin and Lambda backend, managed browser login (Cognito as a candidate), separate authenticated AI-agent access, and private file storage. Verify Lambda/API Gateway/Function URL upload and response limits against current 100 MB streaming uploads; evaluate direct-to-S3 signed uploads and multipart, CORS, post-upload confirmation and collision guarantees (a changed upload architecture requires approval). Verify native sharp packaging, temporary/runtime limits, JPEG response size and private derivative delivery. Distinguish frontend and user-file buckets, OAC support for each origin, Lambda origin bypass protection versus app JWT authorization, HTTPS/domain requirements, infrastructure costs, and deployment packaging changes. No Cloudflare or always-on Mac in the recommended hosting path.

Planning deliverable: inspect the current app; compare managed identity/edge access and application-level login for a single owner; preserve authenticated AI-agent API access; identify hosting, HTTPS, origin-bypass prevention, domain/Host and proxy changes, browser sessions/CSRF/logout, credential rotation and scopes, private S3 access, presigned URL residual access, upload limits, sharp runtime support, and expected costs. Recommend a minimal route with official documentation and a testable milestone sequence. Identify new dependencies/services and decisions needing approval.

### Selectable browser login — approved requirements (planning record)

Mr. So requested Google login, then required a non-Google alternative because his company network may block Google. He approved recording this change in the plan. This approves the requirements below, not implementation, cloud provisioning, account configuration or deployment.

- The login entry screen must offer two explicit choices: **Continue with Google** and **Email + password**. Recommended planning direction: Google federation plus native user-pool login through Cognito, retaining CloudFront + private S3 + Lambda hosting.
- The email/password path must not redirect to, load required resources from, or otherwise depend on Google. A blocked or unavailable Google path must leave the alternative reachable; users can return to the login-method chooser after an error or cancellation.
- Both approved owner login methods must resolve to the same canonical owner authorization identity, file access and permissions. Account linking is a security-sensitive design item requiring official-document verification and explicit trusted provisioning; do not automatically link or grant owner access solely because two providers report the same email address.
- Restrict access to explicitly approved identities. Do not permit public self-registration or grant access merely because Google authentication succeeded. Password reset, MFA, logout, refresh/session handling and recovery for the non-Google path must be included in the design; do not weaken the password path to make it a fallback.
- AI agents keep separate machine identities and scoped credentials, independent of either browser login method. Never share the owner's Google credentials or email/password credentials with agents.
- Corporate-network compatibility is an acceptance condition, not a guarantee: CloudFront, Cognito, email delivery or other required endpoints may also be blocked. Record the exact dependencies and test the native login path on Mr. So's actual company network; do not attempt to bypass company network policy.

Planning verification / later implementation acceptance gates:
- Confirm Cognito's current native-login, Google federation and supported secure account-linking behavior against official AWS/Google documentation. At planning time the integration, dependencies and account-provisioning steps were unverified; Phase A has since been approved and implemented offline, while real-provider behaviour and account provisioning remain Phase C gates. Recording these requirements does not mark the AWS proposal independently verified.
- Test login-method selection at desktop and phone widths, including Google blocked/unreachable, failed login and cancellation. Verify that email/password login and its recovery path work without Google requests.
- Verify both provisioned owner methods map to the same canonical identity and permissions, while unapproved Google/native users and a forged matching-email claim receive no file access. Account-linking tests must cover impersonation and unauthorized linking attempts.
- Verify logout/session behavior for both methods, preserving documented JWT and presigned-URL residual-access limitations. Verify agent read/write/delete scopes separately.
- Complete company-network and physical-phone/mobile-data acceptance after separately authorized deployment; a local or simulated network test does not close those gates.

Planning-verification handoff: Mr. So explicitly selected completing plan verification and receiving an implementation checklist for approval, rather than starting implementation. The revised proposal and local-first approval checklist are in `docs/AWS_LOGIN_PLAN.md`. Claude Code Opus researched/revised the proposal; Eve independently retrieved its 21 listed primary-source pages. This establishes documented feasibility, not integration/runtime acceptance: no application tests, real Cognito/Google login, corporate-network check, real-S3 flow or AWS deployment were exercised in this planning round. The earlier claim that the previous scratch proposal's 40 sources were independently verified was withdrawn; do not use that scratch claim as evidence. Security findings corrected in the new proposal include maintaining per-principal upload binding, measured rather than instantaneous config revocation, safe cleanup and the existing 1 MiB text-preview requirement. Independent review verdicts live in `docs/CLAUDE_REVIEW.md`.

### Phase A — local implementation authorized

#### Approved close-out round (2026-10-13)

Mr. So explicitly approved items 1–2 ("Ok, approve 1-2"): local fixes and renewed acceptance only. Address the six findings in the 2026-10-13 review together: reproduce the vendor-script-load blank login screen with a failing browser regression before fixing it; restore D26's Markdown table continuity; add 401/503 to the API error list; qualify README's isolation claim without erasing historical AWS uncertainty; evaluate provider-side JWKS error classification against the installed library and add failing offline regression tests before any behavioral change. Do not add review-artifact state to HANDOFF (finding 4 is rejected under project policy; record the disposition in the review result). Preserve fail-closed authorization and unknown-kid rejection; do not indiscriminately convert invalid tokens to service-unavailable errors.

Use the existing implementing Claude Code session `781e94c4-0369-44bc-98b7-12a38c165c7f`, then resume that same session for an adversarial self-audit. Batch all documentation reconciliation before freezing for a fresh independent read-only review; Eve performs separate deterministic tests/security/scope gates afterwards. The previous PASS is historical once this round edits the reviewed surface. `docs/CLAUDE_REVIEW.md` owns verdict state; HANDOFF must not describe the result artifact's own changed/current state. Acceptance requires a visible safe failure at desktop/phone widths when the vendor script fails, behavioral RED/GREEN evidence, full offline regression success without skipped acceptance tests, explicit disposition of all six findings, fresh independent review, and Eve's verification. No dependency changes, CLAUDE.md edits through delegation, real AWS/Google/S3 or credential/.env access, account/resource changes, quota reset/redemption, scheduled retry, staging, commit, push, deployment or Phase B/C are authorized.

Close-out implementation (2026-10-13, implementer): (1) a sign-in library that fails to load now shows a fixed, accessible error in the login area with both sign-in buttons disabled and no file UI (browser regression at 375 and 1280 px, RED then GREEN); (2) the D26 row is back inside the decisions table; (3) §4 lists 401 and 503; (4) not adopted, as directed; (5) after reading the installed `aws-jwt-verify` error classes, only `JwkValidationError` (a malformed key in the pool's own JWKS) was moved from 401 to 503, with offline RED/GREEN tests; unknown `kid`, non-signature keys and wrong `alg` stay 401 (pinned, and a broader mapping was shown to fail the tests); (6) README's isolation statement now says it describes the current test setup and points to the historical AWS uncertainty, which remains unknown. The implementer's self-audit of these fixes (not an independent review) found one more case of (1), a vendor script that loads but is not the library, fixed test-first; it also pinned that an unknown `kid` during the library's wait period and a token without `kid` stay 401. Commands, logs and counts: `docs/HANDOFF.md`. Independent review verdicts live in `docs/CLAUDE_REVIEW.md`.

Continuation approved by Mr. So on 2026-10-13: "ok, please proceed phase A". Resume the interrupted implementer self-audit in session `781e94c4-0369-44bc-98b7-12a38c165c7f`, fix any in-scope defects test-first, reconcile the durable handoff documents, then freeze the complete nonsecret tree for a fresh independent read-only Claude Code review and Eve's deterministic verification. This continuation does not authorize Phase B/C, real-provider or real-S3 access, credential/.env reads, account changes, quota reset/redemption, commit, push, deployment, or delegated edits to `CLAUDE.md`. Preserve pre-existing user changes and carry the historical startup-test uncertainty forward.

Mr. So explicitly approved starting Phase A in this chat ("批准開始Phase A"). This supersedes the planning-only restriction for Phase A below; historical v1 decisions still describe the unchanged unauthenticated mode, not permission to expose that mode to the internet.

Approved scope:
- Implement the Phase A requirements and acceptance gates in `docs/AWS_LOGIN_PLAN.md`: baseline tests; configurable Cognito access-token validation and owner-sub/agent-client scope authorization; Google/native email login-method chooser; maintained-library OIDC code+PKCE callback handling; in-memory browser tokens with transient transaction-only sessionStorage; refresh-token revoke plus logout; authentication-aware upload/download/preview UI; offline fake-JWKS/fake-OIDC and 375/1280 px browser tests. No real provider accounts or data may be used.
- Approved new direct packages are **only** `aws-jwt-verify` and `oidc-client-ts`, with compatible exact installed versions recorded in package.json/lockfile. Prefer install with lifecycle scripts disabled. Serving the package's pinned prebuilt browser artifact from the app's own origin (including deterministic generation/copy and tests) is approved; no CDN, new frontend framework or undeclared direct transitive import.
- Before any test/production edit, verify the declared libraries and platform primitives provide each required protocol and packaging capability. If an unapproved package, new service, custom security parser/signing or incompatible API change is needed, report the exact capability gap and stop before partial implementation; do not work around it.
- Authentication disabled/unset preserves current local v1 behavior; Cognito mode validates required configuration and fails closed. Cloud/public deployment configuration must never silently fall back to unauthenticated mode. Authenticated mode must not break download, previews, uploads or stale-response protections. Preserve all originals, the current 100 MiB streamed upload and 1 MiB text-preview limits, and the on-demand JPEG pipeline without derivative storage.
- Required route scopes: list/download/preview need read; folder-create/upload/move need write; file/folder-delete need delete. Owner access requires the exact approved Cognito sub and approved browser client ID; agents require exact approved client IDs and per-route scopes, never an email-based owner bypass. Public `/api/auth/config` contains public configuration only; `/api/health` contains no sensitive data. All other API access is authenticated in Cognito mode, with private response caching disabled.
- TDD is mandatory: prove each new behavior's failing regression before implementation, then focused GREEN and the complete baseline/regression suite. Run all declared package scripts and real offline browser/JWKS/OIDC flows. Capture actual commands, exits, test counts, skipped tests and remaining physical/provider gates in `docs/HANDOFF.md`. An automated mock flow is not evidence of real Google/Cognito or corporate-network acceptance.
- On completion, resume the implementing session for an adversarial self-audit and fixes, then freeze the tree for a fresh independent read-only Claude Code review. Eve reruns deterministic tests/security/scope gates. Do not begin Phase B, commit, push or deploy.

Phase A implementation (2026-10-11): the local deliverable was implemented test-first as D26; evidence, commands and test counts are in `docs/HANDOFF.md`, and the review/commit gates in the scope list above still apply. Verification is offline only: real `aws-jwt-verify` against synthetic Cognito-shaped tokens and an offline JWKS, real `oidc-client-ts` in headless Chrome against a local fake Cognito login, memory storage, 375/1280 px. Not covered by these tests (later gates): real Cognito/Google behaviour (supplied endpoint metadata, revoke token type, `/logout`, nonce, `identity_provider` routing, Google-page resources on the email path), MFA/recovery and account linking (Phase C); `localhost` callback registration against a real pool; corporate network and physical phone/mobile data; real S3; Phase B transport limits.

Phase A self-audit (2026-10-13, implementer, not an independent review): test isolation was hardened first (real entry-point children run in `test/helpers/isolated-env.js`; in-process presigning no longer reads AWS config files named by the inherited environment), then two browser defects were fixed test-first (a download finishing after the session ended no longer leaves a `blob:` copy; the token is sent only to this origin's `/api/`), and nonce, method and path-variant coverage was added. Evidence and the safe verification recipe are in `docs/HANDOFF.md`. Whether the 2026-10-11 startup-test incident read local AWS configuration or contacted AWS remains unknown. Independent review verdicts live in `docs/CLAUDE_REVIEW.md`.

Boundaries: Phase A local source/tests/documentation/package changes and the two named dependency installations are authorized. Credential/.env reads, AWS/Google account access, real-S3 activity, resource creation, account changes, commits, pushes and deployment are NOT authorized. Direct-S3 uploads/Lambda packaging (Phase B) and AWS/Google provisioning/deployment (Phase C) remain separately gated. Do not edit `CLAUDE.md` through the delegated CLI; any required instruction-file reconciliation must go through Eve's protected-file approval tool. Preserve all pre-existing planning edits and unrelated work.

## 6. Out of scope (v1)
Authentication (v1; optional local login was added later as Phase A, D26); internet hosting/deployment; folder rename; search; share links; trash/undo beyond S3
versioning; direct-to-S3 large uploads; thumbnails; multiple buckets.
