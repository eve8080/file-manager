import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { classifyStorageError, conflict, deleteIncomplete, notFound, storageReason } from '../errors.js';

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects limit
const MAX_REPORTED_FAILURES = 20;

// S3 storage driver. See src/storage/memory.js for the interface.
// `client` can be injected for tests; by default the SDK resolves credentials itself.
export function createS3Storage({ bucket, region, client = new S3Client({ region }) }) {
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
  };
}
