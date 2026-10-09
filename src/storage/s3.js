import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { attachmentDisposition } from '../disposition.js';
import {
  classifyStorageError,
  conflict,
  deleteIncomplete,
  folderNameConflict,
  moveIncomplete,
  notFound,
  pathNameConflict,
  storageReason,
} from '../errors.js';
import { ancestorPaths } from '../paths.js';

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects limit
const MAX_REPORTED_FAILURES = 20;
const DOWNLOAD_URL_SECONDS = 5 * 60;
const UPLOAD_PART_BYTES = 8 * 1024 * 1024; // S3 requires at least 5 MiB for every part but the last

// S3 storage driver. See src/storage/memory.js for the interface.
// `client` can be injected for tests; by default the SDK resolves credentials itself. `signingClient`
// presigns download URLs (the same client in production; tests pass one that cannot send requests).
// `partSize` is only lowered by tests.
export function createS3Storage({
  bucket,
  region,
  client = new S3Client({ region }),
  signingClient = client,
  partSize = UPLOAD_PART_BYTES,
}) {
  async function* listPages(input) {
    let token;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, ...input }),
      );
      yield page;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async function allKeysUnder(prefix) {
    const keys = [];
    for await (const page of listPages({ Prefix: prefix })) {
      for (const object of page.Contents ?? []) keys.push(object.Key);
    }
    return keys;
  }

  // The first `maxKeys` keys under a prefix. S3 may return a short page that is still truncated,
  // so continuation pages are followed until enough keys are seen or the listing ends.
  async function firstKeysUnder(prefix, maxKeys) {
    const keys = [];
    for await (const page of listPages({ Prefix: prefix, MaxKeys: maxKeys })) {
      for (const object of page.Contents ?? []) keys.push(object.Key);
      if (keys.length >= maxKeys) break;
    }
    return keys.slice(0, maxKeys);
  }

  async function anyUnder(prefix) {
    return (await firstKeysUnder(prefix, 1)).length > 0;
  }

  // Abort an unfinished multipart upload so its parts are not kept (and billed). A failed abort is
  // logged, not thrown: the caller reports the original failure.
  async function abortUpload(key, uploadId) {
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      console.error(`Could not abort multipart upload ${uploadId} for ${key}; its parts may remain until a lifecycle rule removes them:`, err);
    }
  }

  const fileExistsError = () => conflict('FILE_EXISTS', 'A file with that name already exists');

  // Runs a conditional write; S3's 412 `PreconditionFailed` means the key was created meanwhile.
  async function conditionally(write) {
    try {
      return await write();
    } catch (err) {
      if (err?.name === 'PreconditionFailed') throw fileExistsError();
      throw err;
    }
  }

  // CopyObject's source is "bucket/key" with the key URL-encoded (each segment, keeping the slashes).
  function copySource(key) {
    return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  // True if the object exists. S3 answers HeadObject for a missing key with a bare 404 (`NotFound`).
  // Other 404s (e.g. `NoSuchBucket`) are storage errors, not a missing file.
  async function fileExists(key) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      if (err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false;
      throw err;
    }
  }

  // NAME_CONFLICT if `key` is a folder's name, or a part of its path is a file. Not atomic with the
  // write that follows (S3 has no such precondition); see docs/HANDOFF.md.
  async function assertNameFree(key) {
    if (await anyUnder(`${key}/`)) throw folderNameConflict();
    for (const path of ancestorPaths(key)) {
      if (await fileExists(path)) throw pathNameConflict();
    }
  }

  return {
    async list(prefix) {
      const folders = [];
      const files = [];
      let found = false;
      for await (const page of listPages({ Prefix: prefix, Delimiter: '/' })) {
        for (const { Prefix } of page.CommonPrefixes ?? []) {
          found = true;
          const name = Prefix.slice(prefix.length, -1);
          if (name !== '') folders.push(name); // skip odd keys like 'a//b'
        }
        for (const object of page.Contents ?? []) {
          found = true;
          if (object.Key === prefix) continue; // this folder's own marker
          files.push({
            key: object.Key,
            name: object.Key.slice(prefix.length),
            size: object.Size ?? 0,
            modified: new Date(object.LastModified).toISOString(),
          });
        }
      }
      if (prefix !== '' && !found) throw notFound('Folder not found');
      return { folders, files }; // S3 already returns these sorted by key
    },

    async createFolder(prefix) {
      if (await anyUnder(prefix)) throw conflict('FOLDER_EXISTS', 'Folder already exists');
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '' }));
    },

    async deleteFolder(prefix, { recursive = false } = {}) {
      // A non-recursive delete only needs to know if anything besides the marker exists. The marker
      // sorts first, so two keys are enough; the whole prefix is listed only for a recursive delete.
      const keys = recursive ? await allKeysUnder(prefix) : await firstKeysUnder(prefix, 2);
      if (keys.length === 0) throw notFound('Folder not found');
      if (!recursive && keys.some((key) => key !== prefix)) {
        throw conflict('FOLDER_NOT_EMPTY', 'Folder is not empty');
      }
      // Batches run in order. On the first batch with any failure we stop: the remaining batches are
      // not attempted, so a failing bucket (e.g. a policy denying deletes) loses as little as possible.
      let deleted = 0;
      for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
        const notAttempted = keys.length - i - batch.length;
        let result;
        try {
          result = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          );
        } catch (err) {
          // The request itself failed (network, throttling, ...): S3 may or may not have applied it,
          // so this batch's outcome is reported as unknown rather than guessed.
          console.error(`DeleteObjects request failed for ${prefix} (batch starting at ${i}):`, err);
          throw deleteIncomplete({
            path: prefix,
            requested: keys.length,
            deleted,
            failedCount: 0,
            failed: [],
            unknown: batch.length,
            notAttempted,
            reason: classifyStorageError(err),
          });
        }
        const errors = result.Errors ?? [];
        if (errors.length) {
          // Raw S3 codes/messages stay in the server log; clients get fixed reasons.
          console.error(
            `DeleteObjects reported ${errors.length} failure(s) for ${prefix}:`,
            errors.slice(0, MAX_REPORTED_FAILURES).map(({ Key, Code, Message }) => ({ Key, Code, Message })),
          );
          throw deleteIncomplete({
            path: prefix,
            requested: keys.length,
            deleted: deleted + batch.length - errors.length,
            failedCount: errors.length,
            failed: errors.slice(0, MAX_REPORTED_FAILURES).map(({ Key, Code }) => ({ key: Key, reason: storageReason(Code) })),
            unknown: 0,
            notAttempted,
          });
        }
        deleted += batch.length;
      }
      return deleted;
    },

    // S3's DeleteObject succeeds for a missing key, so existence is checked first to give a 404.
    async deleteFile(key) {
      if (!(await fileExists(key))) throw notFound('File not found');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    // Streams a body of unknown length. At most one part (`partSize`) is held in memory: once more than
    // that has arrived, a multipart upload is started and each full part is sent while the stream continues.
    // A body that fits in one part is a single PutObject with a known length.
    // Never overwrites: a cheap existence check fails early, and the conditional write (IfNoneMatch: '*')
    // closes the race with another writer.
    async putFile(key, stream) {
      if (await fileExists(key)) throw fileExistsError();
      await assertNameFree(key);
      let pending = [];
      let pendingBytes = 0;
      let size = 0;
      let uploadId;
      const parts = [];
      const takeBytes = (n) => {
        const all = Buffer.concat(pending);
        pending = [all.subarray(n)];
        pendingBytes = all.length - n;
        return all.subarray(0, n);
      };
      const uploadPart = async (body) => {
        const PartNumber = parts.length + 1;
        const { ETag } = await client.send(
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber, Body: body, ContentLength: body.length }),
        );
        parts.push({ PartNumber, ETag });
      };

      try {
        for await (const chunk of stream) {
          pending.push(chunk);
          pendingBytes += chunk.length;
          size += chunk.length;
          // Strictly more than one part: the last part is never empty.
          while (pendingBytes > partSize) {
            uploadId ??= (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }))).UploadId;
            await uploadPart(takeBytes(partSize));
          }
        }
        const rest = takeBytes(pendingBytes);
        if (uploadId === undefined) {
          await conditionally(() =>
            client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: rest, ContentLength: rest.length, IfNoneMatch: '*' })),
          );
        } else {
          await uploadPart(rest);
          await conditionally(() =>
            client.send(
              new CompleteMultipartUploadCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                MultipartUpload: { Parts: parts },
                IfNoneMatch: '*',
              }),
            ),
          );
        }
      } catch (err) {
        if (uploadId !== undefined) await abortUpload(key, uploadId);
        throw err;
      }
      return { size };
    },

    // A presigned GET URL, valid for 5 minutes, that makes the browser save the file under its name.
    // Signing is local; existence is checked first so a missing file is a 404 here, not an S3 error page.
    async getDownload(key) {
      if (!(await fileExists(key))) throw notFound('File not found');
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: attachmentDisposition(key.split('/').pop()),
      });
      return { url: await getSignedUrl(signingClient, command, { expiresIn: DOWNLOAD_URL_SECONDS }) };
    },

    // S3 has no rename: copy, then delete the source. The source is deleted only after the copy succeeded.
    async moveFile(from, to) {
      if (!(await fileExists(from))) throw notFound('File not found');
      if (await fileExists(to)) throw fileExistsError();
      await assertNameFree(to);
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: copySource(from) }));
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
      } catch (err) {
        console.error(`Move ${from} -> ${to}: copied, but deleting the source failed:`, err);
        throw moveIncomplete({ from, to, copied: true, sourceDeleted: false, reason: classifyStorageError(err) });
      }
    },
  };
}
