# S3 File Manager

Personal web file manager for one private AWS S3 bucket. Users: Mr. So and his AI agent.
Browse/manage folders, upload/download/rename/delete files, preview basic file types,
from a desktop or phone browser.

## Source of truth
- `IMPLEMENTATION_BRIEF.md` — agreed requirements, decisions, API, milestones, acceptance criteria, out-of-scope
- `docs/HANDOFF.md` — current state; update at the end of every work session
- `README.md` — local setup, run, test

If code and these documents disagree, stop and ask rather than silently picking one.

## Architecture
- Node.js (>= 22.9) + Express 5, ES modules, plain JavaScript, no build step
- `src/server.js` — entry point (real S3); `src/demo.js` — in-memory demo, no AWS
- `src/start.js` — `start(storage, config, label)`: builds the app (incl. `MAX_UPLOAD_MB`) for both entry points and listens
- `src/app.js` — Express app factory `createApp({ storage, maxUploadBytes })`: API routes, host guard (D9),
  cross-site write guard `sameOriginWrites` (D21), security headers, error handler, upload result reporting
- `src/upload.js` — streams multipart uploads (busboy) into `storage.putFile`; per-file and per-request limits (D22),
  malformed/cut-off bodies, client disconnects
- `src/disposition.js` — `Content-Disposition: attachment` header for downloads
- `src/config.js` — reads env (`.env` loaded via `node --env-file-if-exists`)
- `src/paths.js` — validates/normalises every folder path; file keys are validated exactly (`parseFileKey`)
- `src/errors.js` — `AppError` (status + code + optional details); API errors are `{ "error": { "code", "message", "details"? } }`;
  `toPublicError()` turns any error into its client-facing form
- `src/storage/` — storage interface (documented in `memory.js`): list, folders, `putFile`/`getDownload`/`moveFile`/`deleteFile`.
  `s3.js` (AWS SDK v3: multipart upload with abort-on-failure, presigned 5-minute downloads, copy-then-delete moves),
  `memory.js` (tests/demo). Uploads/moves never overwrite (`FILE_EXISTS`) or collide with folder names (`NAME_CONFLICT`, D23)
- `public/` — static single page (vanilla JS); talks only to `/api/*`. Uploads use one XHR per file (per-file progress)
- `test/` — `node --test`; contract tests run against memory storage AND s3 storage with a fake S3 client;
  `test/browser.test.js` drives the UI in headless Chrome (`test/helpers/chrome.js`, no dependencies);
  `test/chrome-helper.test.js` tests that helper's process lifecycle with fake Chrome scripts;
  `test/start.test.js` runs the real entry points to check startup logging

## Commands
- `npm install` — install dependencies
- `npm start` — run against the real bucket (needs `.env`)
- `npm run demo` — run with in-memory sample data (no AWS)
- `npm test` — run all tests, including browser tests (never touches AWS). Browser tests are skipped if no
  Chrome is found (`CHROME_PATH` overrides); a skip is not a pass

## Coding rules
- Keep it small; no new frameworks, build tools, or dependencies without approval
- Every storage/API change gets tests; new storage behaviour goes in the contract suite so both drivers are covered
- Every UI behaviour change gets a browser regression test
- The UI must ignore stale async responses (`public/app.js`): list loads (`load()`, sequence number + abort; only the
  current load may enable upload) and every mutation completion — folder create/delete, file upload/rename/delete —
  checked with `navigationToken()` (D16: after navigation they never change the new folder's status; a partial
  folder delete is alerted). The upload list keeps every file's result across overlapping uploads and navigation
- Destructive bulk operations are confirmed server-side, not only in the browser
- Never render user-controlled content as HTML in the frontend — use `textContent`
- Validate all paths/keys server-side via `src/paths.js`
- Don't leak internal error details to clients; log them server-side. Storage failures reach clients only as
  the fixed reasons in `STORAGE_REASONS` (`src/errors.js`), never as raw SDK names, S3 codes or messages

## Security boundaries
- Never access, request, display, or store credentials. AWS credentials come from the SDK default
  chain (AWS profile / env) configured by Mr. So
- No secrets in source, docs, tests, or logs. `.env` is git-ignored; only `.env.example` is committed
- The app has NO login. Default bind is `127.0.0.1`; LAN use is opt-in via `HOST=0.0.0.0`.
  Never expose it to the internet. A host-header guard blocks DNS-rebinding (only IP literals / `localhost` accepted)
- Never create or modify AWS resources (buckets, IAM, policies)

## Git / release rules
- Work only inside this project directory
- Do not commit until Mr. So or Eve explicitly approves
- NEVER create a GitHub repo, add a remote, push, deploy, publish, or message third parties
  until Mr. So explicitly asks
- One approved milestone at a time; stop for review after each
