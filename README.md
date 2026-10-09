# S3 File Manager

A small personal web file manager for one private AWS S3 bucket, usable from a desktop or phone browser.

> ⚠ **No login.** Anyone who can reach the app has full access to the bucket.
> Run it only on your own machine or a trusted Wi-Fi. Never expose it to the internet.

Status: Milestone 1 (browse, create and delete folders). Uploads, downloads and previews come in later milestones —
see `IMPLEMENTATION_BRIEF.md`.

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
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

## Setup
```sh
npm install
cp .env.example .env
# edit .env: S3_BUCKET, AWS_REGION, and optionally AWS_PROFILE
```

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
If no Chrome is found they are reported as **skipped**, not passed. `test/chrome-helper.test.js` checks the
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

If S3 fails, the response is **502 `STORAGE_ERROR`** with `details: { reason }`, where `reason` is one of
`ACCESS_DENIED`, `CREDENTIALS_UNAVAILABLE`, `BUCKET_NOT_FOUND`, `THROTTLED`, `NETWORK`, `UNAVAILABLE`, `UNKNOWN`.
Raw AWS error names and messages are never sent to clients; they are written to the server log.

If S3 deletes only part of a folder, the response is **502 `DELETE_INCOMPLETE`** with
`details: { path, requested, deleted, failedCount, failed: [{key, reason}] (first 20), unknown, notAttempted, reason? }`.
Deletion stops at the first failing batch of 1000, so `notAttempted` objects are untouched; `unknown` objects
were in a request whose outcome S3 did not report. List the folder again to see exactly what remains.

Requests must use `localhost` or an IP address in the URL.
