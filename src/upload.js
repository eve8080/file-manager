import busboy from 'busboy';
import { PassThrough } from 'node:stream';
import { AppError, badRequest } from './errors.js';
import { parseFileKey } from './paths.js';

const malformedUpload = () => new AppError(400, 'MALFORMED_UPLOAD', 'The upload was malformed or cut off.');
const requestTooLarge = (limit) =>
  new AppError(413, 'REQUEST_TOO_LARGE', `The upload is larger than the request limit (${limit} bytes).`);

// Streams every file in a multipart/form-data request into storage, one after another, as it arrives.
// Each file is limited to `maxFileBytes`, the whole request body to `maxRequestBytes` (a declared
// Content-Length over it is refused before anything is read; a chunked body is counted as it streams).
// Resolves to { results, stopped? }: one result per named file part, in order — { name, key, ok: true, size }
// or { name, key?, ok: false, error } — plus `stopped` (an AppError: MALFORMED_UPLOAD or REQUEST_TOO_LARGE)
// if reading stopped after some files. Once stopped, the rest of the body is not read; the caller answers
// with "Connection: close". Rejects if the request is not multipart, holds no files, is too large, or is
// malformed before any file. Non-file fields are ignored.
export function receiveUploads(req, { prefix, storage, maxFileBytes, maxRequestBytes }) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxRequestBytes) {
      reject(requestTooLarge(maxRequestBytes));
      return;
    }
    let parser;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        preservePath: true, // keep the name as sent; a "/" in it is rejected below rather than silently cut
        // busboy signals 'limit' when a file *reaches* fileSize, so +1 lets a file of exactly maxFileBytes through.
        limits: { fileSize: maxFileBytes + 1 },
      });
    } catch {
      reject(badRequest('Expected a multipart/form-data upload'));
      return;
    }
    const results = [];
    const writes = [];
    let stopped; // why reading stopped early: MALFORMED_UPLOAD or REQUEST_TOO_LARGE

    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      await Promise.all(writes);
      if (results.length === 0) reject(stopped ?? badRequest('The upload contains no files'));
      else resolve({ results, stopped });
    };

    // Counts the raw body; a chunked body over the limit stops the parser.
    let received = 0;
    const count = (chunk) => {
      received += chunk.length;
      if (received > maxRequestBytes) parser.destroy(requestTooLarge(maxRequestBytes));
    };
    req.on('data', count);

    // busboy reports a malformed or truncated body as an 'error' (our size limit arrives the same way) and
    // destroys the open file stream with it. Parsing stops, the file in flight fails, and the rest of the
    // body is left unread: nothing keeps the request flowing, so it can't be streamed in without end.
    parser.on('error', (err) => {
      console.error('Upload stopped:', err.message);
      stopped = err instanceof AppError ? err : malformedUpload();
      req.off('data', count);
      req.unpipe(parser);
      req.pause();
      settle();
    });

    parser.on('file', (field, file, { filename }) => {
      if (!filename) {
        file.resume(); // an empty file input
        return;
      }
      let key;
      try {
        if (filename.includes('/')) throw badRequest('A file name must not contain "/"');
        key = parseFileKey(`${prefix}${filename}`);
      } catch (error) {
        results.push({ name: filename, ok: false, error });
        file.resume();
        return;
      }
      const result = { name: filename, key };
      results.push(result);
      // Storage reads from `body`; on a failure the rest of this file is drained, so the next file can follow.
      const body = new PassThrough();
      // Storage may not be reading yet (e.g. awaiting an existence check) when `body` is destroyed. The
      // error still reaches it when it reads; this listener only stops an unhandled 'error' crashing the process.
      body.on('error', () => {});
      const drain = () => {
        file.unpipe(body);
        file.resume();
      };
      file.on('limit', () => {
        drain();
        body.destroy(new AppError(413, 'TOO_LARGE', `File is larger than the upload limit (${maxFileBytes} bytes).`));
      });
      file.on('error', (err) => body.destroy(err instanceof AppError ? err : malformedUpload()));
      file.pipe(body);
      writes.push(
        storage.putFile(key, body).then(
          ({ size }) => Object.assign(result, { ok: true, size }),
          (error) => {
            drain();
            Object.assign(result, { ok: false, error });
          },
        ),
      );
    });

    parser.on('close', settle);
    // A client that disconnects mid-upload never ends the piped body, so stop the parser explicitly:
    // the file in flight then fails like a cut-off body, and storage aborts it (S3: AbortMultipartUpload).
    req.on('close', () => {
      if (!req.complete) parser.destroy(new Error('the client closed the connection mid-upload'));
    });
    req.pipe(parser);
  });
}
