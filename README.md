# S3 File Manager

A small personal web file manager for one private AWS S3 bucket, usable from a desktop or phone browser.

> ⚠ **No login.** Anyone who can reach the app has full access to the bucket.
> Run it only on your own machine or a trusted Wi-Fi. Never expose it to the internet.

Status: Milestone 3 (folders; upload, download, rename/move and delete of files; preview of text, images and
PDFs) plus the M4 follow-up that converts JPEG previews for iPhone Safari (D25). See `IMPLEMENTATION_BRIEF.md`.

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
npm test           # uses in-memory storage and a fake S3 client; never touches AWS
```
`npm test` includes browser regression tests (`test/browser.test.js`) that drive a headless Chrome with a
throwaway profile. They find Chrome in `/Applications` or the usual Linux paths, or use `CHROME_PATH`.
If no Chrome is found they are reported as **skipped**, not passed. The test Chrome resolves no host names
(only `127.0.0.1` is reachable), so it can never contact AWS or the internet. `test/chrome-helper.test.js` checks the
browser helper's own process handling (startup timeout, early exit, shutdown hang) with fake Chrome scripts.

## API (for scripts / AI agent)
Errors are returned as `{ "error": { "code": "...", "message": "...", "details"?: {...} } }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/list?prefix=Documents/` | folders and files in a folder (root if `prefix` omitted) |
| POST | `/api/folders` with JSON `{ "path": "Documents/New" }` | 201; 409 `FOLDER_EXISTS` |
| DELETE | `/api/folders?path=Documents/New/` | deletes an empty folder; 409 `FOLDER_NOT_EMPTY` if it has contents |
| DELETE | `/api/folders?path=Documents/New/&recursive=true&confirm=New` | deletes everything inside. `confirm` must be the folder's exact name (last part of the path, case-sensitive); otherwise 400 `CONFIRMATION_REQUIRED` / `CONFIRMATION_MISMATCH` |
| POST | `/api/files?prefix=Documents/` (multipart/form-data, one or more file parts) | uploads into the folder; never overwrites. All stored → 201 `{ files: [{ name, key, ok, size }] }`. Otherwise an error `UPLOAD_FAILED` (none stored) / `UPLOAD_INCOMPLETE` (some stored) whose `details.files` lists every file with its own `error` (`FILE_EXISTS` 409, `NAME_CONFLICT` 409, `TOO_LARGE` 413, `REQUEST_TOO_LARGE` 413, `BAD_REQUEST` 400, `STORAGE_ERROR` 502, `MALFORMED_UPLOAD` 400), plus `details.malformed` / `details.requestTooLarge` if reading stopped early. Each file is limited to `MAX_UPLOAD_MB`, the whole request to `MAX_UPLOAD_MB` + 64 KiB (413 `REQUEST_TOO_LARGE`; see below) |
| GET | `/api/files/download?key=Documents/a.pdf` | real S3: 302 to a presigned download URL valid for 5 minutes. Demo: the file itself as an attachment |
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

Requests must use `localhost` or an IP address in the URL.
