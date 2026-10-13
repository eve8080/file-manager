# S3 File Manager

A small personal web file manager for one private AWS S3 bucket, usable from a desktop or phone browser.

> ⚠ **No login by default.** Without `AUTH_MODE`, anyone who can reach the app has full access to the bucket.
> Run it only on your own machine or a trusted Wi-Fi. Never expose it to the internet. The optional login
> (`AUTH_MODE=cognito`, see [Login](#login-auth_modecognito-phase-a)) is a local Phase A build: it runs on
> loopback only and does not make the app safe to host yet.

Status: Milestone 3 (folders; upload, download, rename/move and delete of files; preview of text, images and
PDFs), the M4 follow-up that converts JPEG previews for iPhone Safari (D25), and Phase A of the login plan
(optional Cognito login, tested offline only). See `IMPLEMENTATION_BRIEF.md` and `docs/AWS_LOGIN_PLAN.md`.

## Prerequisites
- Node.js 22.9 or newer
- An existing **private** S3 bucket (keep "Block Public Access" on; enabling versioning is recommended
  so deleted files can be recovered)
- AWS credentials that you configure yourself, e.g. a named profile via `aws configure --profile file-manager`.
  The app never stores credentials; the AWS SDK finds them on its own.

### Minimal IAM policy
Give the credentials access to this bucket only (replace `YOUR-BUCKET`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR-BUCKET" },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

Large uploads are streamed to S3 as multipart uploads; if one fails, the app aborts it (hence
`s3:AbortMultipartUpload`). As a safety net in case an abort itself fails, add a bucket lifecycle rule that
deletes incomplete multipart uploads after a day or so (S3 console → bucket → Management → Lifecycle rules).

## Setup
```sh
npm install
cp .env.example .env
# edit .env: S3_BUCKET, AWS_REGION, and optionally AWS_PROFILE
```
`npm install` also installs [`sharp`](https://sharp.pixelplumbing.com/) (JPEG previews). It ships prebuilt native
libraries for the platform (macOS, Linux and Windows on common CPUs), so no compiler or system libvips is needed;
on a platform without a prebuilt package `npm install` fails or the JPEG preview reports an error.
It also installs `aws-jwt-verify@5.2.1` and `oidc-client-ts@3.5.0` (with its dependency `jwt-decode@4.0.0`),
used only with `AUTH_MODE=cognito`. Neither has an install script; they were added with `npm install --ignore-scripts`.

## Run
If port 3000 is taken by another program, startup stops with `Could not start server: … is already in use
(EADDRINUSE)`; set `PORT` in `.env` (e.g. `PORT=3001`).

```sh
npm start          # real bucket → http://127.0.0.1:3000
npm run demo       # in-memory sample data, no AWS needed (changes are lost on exit)
```

**From your phone on the same Wi-Fi:** set `HOST=0.0.0.0` in `.env`, restart, and open
`http://<your-mac-ip>:3000` (find the IP with `ipconfig getifaddr en0`). Use the IP address — hostnames
such as `my-mac.local` are deliberately rejected (protection against DNS-rebinding attacks).

## Test
```sh
npm test           # in-memory storage and a fake S3 client; designed not to reach AWS (see "Test isolation" below)
```
`npm test` includes browser regression tests (`test/browser.test.js`) that drive a headless Chrome with a
throwaway profile. They find Chrome in `/Applications` or the usual Linux paths, or use `CHROME_PATH`.
If no Chrome is found they are reported as **skipped**, not passed. The test Chrome resolves no host names
(only `127.0.0.1` is reachable), so it can never contact AWS or the internet. `test/chrome-helper.test.js` checks the
browser helper's own process handling (startup timeout, early exit, shutdown hang) with fake Chrome scripts.

**Test isolation from AWS.** This describes the test setup as it is now; it says nothing about earlier runs. During
Phase A development (2026-10-11), before this isolation existed, one startup test let the real server reach its S3
driver, and the in-process S3 tests could read the AWS config files named by the runner's environment; whether either
read local AWS configuration or contacted AWS is unknown (see `docs/HANDOFF.md`). Tests never use your `.env`. The tests that start the real entry points
(`src/server.js`, `src/demo.js`) give each child an environment built from scratch (`test/helpers/isolated-env.js`):
only `PATH` is inherited; synthetic static keys; `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` set to `/dev/null`;
instance metadata off; one attempt; S3 sent to a closed loopback port. So with the current tests even a request that
reaches storage goes only to loopback, signed with the synthetic key, and no AWS config file is read
(`test/isolation.test.js` checks this with a loopback trap and a planted config file).
In-process tests presign with a client that cannot send; importing `test/helpers/fake-s3-client.js` also points the
test process's AWS config/credential files at `/dev/null` and drops profile/endpoint settings. `HOME` and the default S3
endpoint are left alone (Chrome and the presigned-URL tests rely on them). To run the suite with an extra outer guard
(keep your normal `HOME`; do not set a global S3 endpoint):

```sh
env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_SESSION_TOKEN -u AWS_ROLE_ARN -u AWS_WEB_IDENTITY_TOKEN_FILE \
    -u AWS_CONTAINER_CREDENTIALS_FULL_URI -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
    -u AWS_ENDPOINT_URL -u AWS_ENDPOINT_URL_S3 \
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
  AWS_ACCESS_KEY_ID=AKIDTESTONLYNOTREAL AWS_SECRET_ACCESS_KEY=test-only-not-a-real-secret \
  npm_config_update_notifier=false npm test
```

## API (for scripts / AI agent)
Errors are returned as `{ "error": { "code": "...", "message": "...", "details"?: {...} } }`.
With `AUTH_MODE=cognito` every route except `/api/health` and `/api/auth/config` also needs a token and a scope
(see [Login](#login-auth_modecognito-phase-a)).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok: true }`. Public in both modes |
| GET | `/api/auth/config` | public. No login: `{ "mode": "none" }`. Login: the public values the browser needs (below) |
| GET | `/api/me` | login only: `{ "role": "owner", "sub", "scopes" }` or `{ "role": "agent", "clientId", "scopes" }` |
| GET | `/api/list?prefix=Documents/` | folders and files in a folder (root if `prefix` omitted) |
| POST | `/api/folders` with JSON `{ "path": "Documents/New" }` | 201; 409 `FOLDER_EXISTS` |
| DELETE | `/api/folders?path=Documents/New/` | deletes an empty folder; 409 `FOLDER_NOT_EMPTY` if it has contents |
| DELETE | `/api/folders?path=Documents/New/&recursive=true&confirm=New` | deletes everything inside. `confirm` must be the folder's exact name (last part of the path, case-sensitive); otherwise 400 `CONFIRMATION_REQUIRED` / `CONFIRMATION_MISMATCH` |
| POST | `/api/files?prefix=Documents/` (multipart/form-data, one or more file parts) | uploads into the folder; never overwrites. All stored → 201 `{ files: [{ name, key, ok, size }] }`. Otherwise an error `UPLOAD_FAILED` (none stored) / `UPLOAD_INCOMPLETE` (some stored) whose `details.files` lists every file with its own `error` (`FILE_EXISTS` 409, `NAME_CONFLICT` 409, `TOO_LARGE` 413, `REQUEST_TOO_LARGE` 413, `BAD_REQUEST` 400, `STORAGE_ERROR` 502, `MALFORMED_UPLOAD` 400), plus `details.malformed` / `details.requestTooLarge` if reading stopped early. Each file is limited to `MAX_UPLOAD_MB`, the whole request to `MAX_UPLOAD_MB` + 64 KiB (413 `REQUEST_TOO_LARGE`; see below) |
| GET | `/api/files/download?key=Documents/a.pdf` | real S3: 302 to a presigned download URL valid for 5 minutes (with login: 200 JSON `{ "url" }` instead, see below). Demo: the file itself as an attachment |
| POST | `/api/files/move` with JSON `{ "from": "Documents/a.pdf", "to": "Archive/a.pdf" }` | rename/move; 404 if `from` is missing, 409 `FILE_EXISTS` if `to` exists, 409 `NAME_CONFLICT` if `to` is a folder's name or goes through a file. On S3 this is copy-then-delete: if the copy worked but the original could not be removed, **502 `MOVE_INCOMPLETE`** with `details: { from, to, copied, sourceDeleted, reason }` (the file then exists under both names) |
| DELETE | `/api/files?key=Documents/a.pdf` | deletes one file; 404 if missing |
| GET | `/api/files/preview?key=Documents/a.pdf` | `{ kind: "text", text, truncated }`, `{ kind: "image" \| "pdf", url }` or `{ kind: "none" }` (see below); 404 if missing |
| GET | `/api/files/preview/content?key=Photos/a.png` | the image/PDF shown inline. Demo: the bytes; real S3: 302 to the presigned URL. 400 for other types. **`.jpg`/`.jpeg` (both modes): a converted copy, 200 `image/jpeg`** (see below); 413 `PREVIEW_TOO_LARGE`, 422 `PREVIEW_FAILED` |

**Preview.** The type comes from the file extension: text (`txt`, `md`, `csv`, `tsv`, `log`, `json`, `xml`, `yaml`,
`html`, `css`, `js`, `svg`, …), images (`jpg`, `jpeg`, `png`, `gif`, `webp`) and PDF. Everything else is
`none`: the UI offers Download only. Text previews contain at most the first 1 MiB of the file; a larger file
has `truncated: true` and the UI says so. Text, including HTML, is always shown as plain characters, never
rendered or run. On real S3, `url` (except for JPEGs, below) is a presigned link valid for 5 minutes that serves
the file inline with the type of its extension; in the demo it is a local `/api/files/preview/content` link. The page's Content
Security Policy allows images and frames from `https://*.amazonaws.com` for this (scripts stay same-origin).
**JPEG previews are converted.** An iPhone photo can carry an HDR gain map (MPF/XMP data) that some versions of
iPhone Safari refuse to show, even though the file is valid and desktop browsers display it. So for `.jpg` and
`.jpeg` the preview JSON's `url` is always this app's own `/api/files/preview/content?key=…` (never a presigned
link), and that route reads the file and answers a freshly made 200 `image/jpeg` (inline, `nosniff`,
`Cache-Control: no-store`): rotated by its EXIF orientation, at most 2048 px on its longer side (smaller pictures
are not enlarged), converted to sRGB, with all metadata, the colour profile, the gain map and the extra embedded
image removed. The stored file is never changed, nothing is written back to S3 and no temp file is used; downloads
still deliver the original, byte for byte. PNG, GIF, WebP and PDF previews are not touched (so animated GIFs keep
animating). A file that is not a decodable JPEG (corrupt, cut off, another format named `.jpg`, over 128 megapixels)
gets 422 `PREVIEW_FAILED` with a fixed message, never a decoder message; the UI shows "This image could not be
displayed" and keeps Download.

*Resources.* Converting needs the whole file in memory, so the JPEG source is limited to `MAX_UPLOAD_MB` (default
100 MB; no new setting): a larger file gets 413 `PREVIEW_TOO_LARGE` (on S3 decided from the response headers,
before any of it is read) and can still be downloaded. At most 2 conversions run at once, others wait; expect a
peak around 2 × `MAX_UPLOAD_MB` plus decoder memory when two huge photos are previewed together. Opening a preview
costs one S3 `HeadObject`; the photo itself is read (one `GetObject`) only when the picture is requested, so each
JPEG preview re-reads and re-converts it (nothing is cached).

In the UI, every file row has a Preview button; the preview opens in a dialog (full screen on a phone) with
Download and Close, and closes when you navigate to another folder (including the Back button).

A file can't take a folder's name, and its path can't pass through a file: uploads and moves that would do
so get 409 `NAME_CONFLICT` ("A folder with that name already exists" / "Part of that path is a file, not a
folder"). (Creating a folder where a file of that name exists, or objects written outside the app, can still
produce both.)

**Upload request limit.** An upload request may be at most `MAX_UPLOAD_MB` + 64 KiB (room for the multipart
framing). A request that declares a larger `Content-Length` gets 413 `REQUEST_TOO_LARGE` before anything is
stored. A streamed (chunked) request is cut off at the limit: files completed before it are stored and listed,
the file in progress fails with `REQUEST_TOO_LARGE`, and the server stops reading and closes the connection.
A client that keeps sending far beyond the limit may see the connection reset instead of the 413. The browser
UI sends one file per request: a file over `MAX_UPLOAD_MB` is refused with 413 (`TOO_LARGE`, or
`REQUEST_TOO_LARGE` once the request passes the request limit); for a file far larger than the limit the UI may
report "the connection was lost" rather than the size error.

File keys are used exactly as given (no trailing `/`, no `.`/`..`/empty names, no control characters, no
leading/trailing spaces in a name, at most 1024 bytes); otherwise 400.

Requests that change data and carry a browser `Origin` from another site are refused with 403
`FORBIDDEN_ORIGIN` (a web page you visit must not be able to upload through your browser). Scripts and the
AI agent send no `Origin` and are unaffected.

If S3 fails, the response is **502 `STORAGE_ERROR`** with `details: { reason }`, where `reason` is one of
`ACCESS_DENIED`, `CREDENTIALS_UNAVAILABLE`, `BUCKET_NOT_FOUND`, `THROTTLED`, `NETWORK`, `UNAVAILABLE`, `UNKNOWN`.
Raw AWS error names and messages are never sent to clients; they are written to the server log.

If S3 deletes only part of a folder, the response is **502 `DELETE_INCOMPLETE`** with
`details: { path, requested, deleted, failedCount, failed: [{key, reason}] (first 20), unknown, notAttempted, reason? }`.
Deletion stops at the first failing batch of 1000, so `notAttempted` objects are untouched; `unknown` objects
were in a request whose outcome S3 did not report. List the folder again to see exactly what remains.

Requests must use `localhost` or an IP address in the URL (with login: exactly the `PUBLIC_ORIGIN` host).

## Login (`AUTH_MODE=cognito`, Phase A)

Optional sign-in through an Amazon Cognito user pool, with two choices on the login page: **Continue with Google**
and **Email + password**. It was built and tested **offline only** (a local fake login server and synthetic
tokens). No real Cognito pool, Google client, MFA or account linking has been exercised, and hosting the app on
the internet is **not** approved yet (Phase C). In this phase the login mode runs on loopback only.

**Without `AUTH_MODE` nothing changes:** the app is the local v1 app without login, including the opt-in LAN
mode (`HOST=0.0.0.0`). To avoid silently running without login in a hosted setup, the app refuses to start
without `AUTH_MODE=cognito` if any login setting below is set, or if it sees an AWS Lambda runtime
(`AWS_LAMBDA_FUNCTION_NAME`, `AWS_EXECUTION_ENV`, `LAMBDA_TASK_ROOT`, `AWS_LAMBDA_RUNTIME_API`).

### Configuration
All settings are required with `AUTH_MODE=cognito`; a missing, empty or malformed one stops startup with one fixed
`Configuration error: …` line that never repeats the configured value. Example (placeholders only, not real IDs):

```sh
AUTH_MODE=cognito
COGNITO_REGION=ap-east-1
USER_POOL_ID=ap-east-1_EXAMPLE
COGNITO_DOMAIN=login.example.com
NATIVE_CLIENT_ID=exampleNativeClientId00001
GOOGLE_CLIENT_ID=exampleGoogleClientId00001
OWNER_SUBS=00000000-0000-4000-8000-000000000000
AGENT_CLIENTS=exampleAgentClientId000001:read+write
AGENT_SCOPE_PREFIX=file-manager
PUBLIC_ORIGIN=http://localhost:3000
```

| Setting | Meaning and rules |
|---|---|
| `AUTH_MODE` | unset (no login) or exactly `cognito`. Anything else, including an empty value, is refused |
| `COGNITO_REGION` | the pool's region, e.g. `ap-east-1` |
| `USER_POOL_ID` | `<region>_<id>`; must be in `COGNITO_REGION`. Tokens must be issued by this pool (`iss`) |
| `COGNITO_DOMAIN` | the hosted-login host name only (no `https://`, port or path), e.g. `login.example.com` or `<prefix>.auth.<region>.amazoncognito.com`. IP addresses and `localhost` are refused; the app always uses `https://` |
| `NATIVE_CLIENT_ID` | public app client (no secret) that allows only the `COGNITO` identity provider: **Email + password** |
| `GOOGLE_CLIENT_ID` | public app client (no secret) that allows only `Google`: **Continue with Google**. Must differ from the native client |
| `OWNER_SUBS` | comma-separated Cognito user `sub` values (UUIDs) of the owner, no duplicates. Email addresses are refused: an email never grants access |
| `AGENT_CLIENTS` | comma-separated `clientId:scope+scope` with scopes `read`, `write`, `delete`, e.g. `id1:read,id2:read+write+delete`; no duplicate clients or scopes; may not contain the two owner clients |
| `AGENT_SCOPE_PREFIX` | the Cognito resource-server identifier; an agent's token must carry `<prefix>/read` etc. |
| `PUBLIC_ORIGIN` | the exact origin the browser uses: `http://127.0.0.1:<PORT>`, `http://localhost:<PORT>` or `http://[::1]:<PORT>` (no path or trailing slash; port = `PORT`). Phase A refuses any other host, and `HOST` must be loopback |

The login redirect and the post-logout address are both `PUBLIC_ORIGIN/`. Register them in both app clients
(callback and sign-out URL). Cognito's documentation allows plain `http://` callbacks only for `localhost`
(`http://localhost:<port>/`), so use `PUBLIC_ORIGIN=http://localhost:<PORT>` against a real pool (not yet tried;
Phase C); `127.0.0.1` is what the offline tests use. Google's own redirect URI is Cognito's `https://<COGNITO_DOMAIN>/oauth2/idpresponse`,
never this app.

### Who may do what
The server checks every token with **aws-jwt-verify**: signature against the pool's JWKS
(`https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`, fetched on first use and cached),
issuer = the pool, `token_use=access`, `client_id` one of the configured clients, `exp` (required) and `nbf`.
Then:
- **Owner:** token from `NATIVE_CLIENT_ID` or `GOOGLE_CLIENT_ID` whose `sub` is in `OWNER_SUBS`. Both login methods
  give the same access because the Google identity must be linked to the owner's Cognito user (a Phase C provisioning
  step), so both tokens carry the owner's `sub`. Owner scopes: `read`, `write`, `delete`.
- **Agent:** token from a client in `AGENT_CLIENTS` obtained with the client-credentials grant (its `sub` is the
  client ID; a token from that client for a person is refused). Its scopes are those configured for it that the
  token also grants as `<AGENT_SCOPE_PREFIX>/<scope>`.
- Anything else that verifies, e.g. a Google account Cognito created automatically, even with the owner's email
  address → **403 `NOT_AUTHORIZED`**.

| Scope | Routes |
|---|---|
| `read` | `GET /api/list`, `/api/files/download`, `/api/files/preview`, `/api/files/preview/content` |
| `write` | `POST /api/folders`, `POST /api/files` (upload), `POST /api/files/move` |
| `delete` | `DELETE /api/folders`, `DELETE /api/files` |

A missing scope is **403 `INSUFFICIENT_SCOPE`** before the route touches storage or reads an upload.

**Sending the token:** exactly one header `X-App-Authorization: Bearer <access token>`. `Authorization` is never
read as the app's token (it stays free for an AWS origin signature in a later phase), and neither is a token in the
URL. No/empty header → **401 `AUTH_REQUIRED`**; malformed, repeated, expired, not yet valid, wrong pool, wrong client,
ID token, bad signature, a `kid` that is not in the pool's JWKS, a key not meant for signatures, an `alg` the key does
not allow → **401 `INVALID_TOKEN`** (with `WWW-Authenticate: Bearer`). Only provider-side faults → **503
`AUTH_UNAVAILABLE`**: the pool's JWKS cannot be fetched, is not a JWKS, or contains a malformed key (the library's
`FetchError`, `JwksValidationError`, `JwkValidationError`); the user is told to try again rather than to sign in again.
A `kid` not in the cached JWKS makes the library fetch the JWKS once more (so a newly rotated key works); if the `kid`
is still missing the token gets 401, and the library waits 10 s before fetching again for another unknown `kid`. Unknown `/api` paths are 401 before they are 404. Every `/api` response has
`Cache-Control: no-store`. Only the exact `PUBLIC_ORIGIN` host is served (other `Host` → 403 `FORBIDDEN_HOST`;
`X-Forwarded-*`/`Forwarded` are ignored and Express's trust proxy stays off), and writes with a browser `Origin` must
come from `PUBLIC_ORIGIN` exactly. Tokens, signatures and claims are never logged; a JWKS failure logs only the
library's error class.

**Downloads with login:** a browser fetch carrying the header can't be redirected usefully, so on real S3
`GET /api/files/download` answers `200 { "url": "<presigned link>" }` (5 minutes, as before) and the page opens it;
the demo/memory driver still answers the file's bytes (to that authorized request only).

**Agent example** (placeholders; never put real IDs or secrets in files you share). The agent gets its own access
token from Cognito with the client-credentials grant, then calls the API:

```sh
# The agent's client secret comes from where you keep secrets, never from this README.
ACCESS_TOKEN=$(curl -s -u "$AGENT_CLIENT_ID:$AGENT_CLIENT_SECRET" \
  -d grant_type=client_credentials --data-urlencode 'scope=file-manager/read file-manager/write' \
  "https://$COGNITO_DOMAIN/oauth2/token" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).access_token))')
curl -H "X-App-Authorization: Bearer $ACCESS_TOKEN" 'http://localhost:3000/api/list?prefix=Documents/'
```

### The browser side
`GET /api/auth/config` gives the page only public values: `{ mode: "cognito", authority, clients: { google, native },
redirectUri, postLogoutUri, scope: "openid email profile", endpoints: { authorization, token, revocation, logout } }`
(no owner subs, agent clients or scope prefix). The OIDC work is done by **oidc-client-ts 3.5.0**, loaded from this
app at `/vendor/oidc-client-ts.min.js`: the package's own self-contained browser build
(`node_modules/oidc-client-ts/dist/browser/oidc-client-ts.min.js`, 70,851 bytes, SHA-256
`f999daa383f09eb090d0ae32211e9ca931c76840e08e47fcf334fc8f5f74f1ef`, `jwt-decode` included), served as installed: no
CDN, no build step, no copy. `test/auth-api.test.js` checks the served bytes against that hash and the version;
`package-lock.json` pins the tarball integrity. After upgrading the package, review the new build and update the hash.

- Authorization code flow with PKCE (S256), `state` and a nonce, all generated, stored and checked by the library.
  Google: `identity_provider=Google` on the Google client. Email: `identity_provider=COGNITO` on the native client;
  that path makes no request to Google (tested with network interception).
- **Tokens are kept in memory only** (the library's `InMemoryWebStorage`). `sessionStorage` holds only the login
  transaction in flight (keys `fm.oidc.<method>.<state>`: PKCE verifier, nonce), removed after the callback; nothing
  else in the browser's storage is touched. The `?code&state` query is removed from the address bar at once.
- A cancelled, failed, forged or replayed callback returns to the chooser with a message; both methods stay
  available (e.g. after Back from a blocked Google page).
- If the sign-in library itself cannot be loaded (e.g. `/vendor/oidc-client-ts.min.js` answers 404, or answers with a
  script that is not the library), the login area
  shows "Could not load the sign-in library. Reload to try again." (`role=alert`), both sign-in buttons are disabled,
  and no file UI or file data is shown.
- **No automatic renewal.** When the access token expires (Cognito's default is one hour), or the server answers
  401, the page clears every file detail and shows the chooser. A reload also shows the chooser (tokens are in
  memory) and never redirects by itself. Requests still in flight then can't bring anything back.
- The token is sent only to this app's own `/api/` (checked by resolving the URL; a `//other-host/…` URL is never
  fetched with it). A download whose answer arrives after the session ended is dropped (no `blob:` copy is kept).
- Downloads, uploads, previews: every private request carries the header. Same-origin preview content (converted
  JPEGs; memory/demo files) is fetched with the token and shown from `blob:` URLs, revoked on Close, navigation and
  sign-out. The page CSP adds `blob:` to `img-src`/`frame-src` and `connect-src 'self' https://<COGNITO_DOMAIN>`;
  scripts stay `'self'` (no inline, no eval).
- **Sign out** clears the page and the tokens in memory at once (whatever happens next), revokes the refresh token
  (only that token; a failure is ignored), then goes to Cognito's `/logout?client_id=…&logout_uri=…` (no token in
  that URL), which returns to the chooser.

**Limits to know** (unchanged by this phase): Cognito's `/logout` and token revocation do not sign you out of
Google; an access token already issued stays valid until it expires, because the app checks tokens locally
(Cognito documents that revoked tokens still verify with any JWT library); presigned S3 links handed out stay valid
for their 5 minutes; changing `OWNER_SUBS`/`AGENT_CLIENTS` takes effect only after a restart.

### Tests (offline)
`test/auth.test.js`, `test/auth-api.test.js` and `test/auth-browser.test.js` use keys generated per run with
`node:crypto`, synthetic Cognito-shaped tokens, the real aws-jwt-verify with an offline JWKS (the library's own
cache with a fetcher that answers only the pool's JWKS URL), and a local fake Cognito login
(`test/helpers/fake-oidc.js`: authorize, token with PKCE and single-use codes, revoke, logout). The fake can only be
plugged in by tests (`createAuth(…, { providerOrigin })`); no environment setting can point the app at it or at any
other non-HTTPS provider. There is no runnable fake-login mode. Passing these tests is not evidence for a real
pool, Google, MFA, account linking, a corporate network or a phone.
