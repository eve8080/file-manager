import {
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

// Minimal in-process stand-in for S3Client, implementing just the commands the S3 driver uses,
// with S3's listing semantics: sorted keys, Prefix, Delimiter/CommonPrefixes, MaxKeys pagination.
// `pageSize` forces small pages so pagination is exercised; `failDeleteKeys` simulates per-key errors
// (reported in the response's Errors); `throwOnDeleteCall: n` makes the n-th DeleteObjects request
// throw before deleting anything (like a network error).
export class FakeS3Client {
  constructor(initial = {}, { pageSize = 1000, failDeleteKeys = [], failDeleteCode = 'AccessDenied', throwOnDeleteCall } = {}) {
    this.objects = new Map();
    this.pageSize = pageSize;
    this.failDeleteKeys = new Set(failDeleteKeys);
    this.failDeleteCode = failDeleteCode;
    this.throwOnDeleteCall = throwOnDeleteCall;
    this.deleteCalls = 0;
    this.calls = [];
    for (const [key, body] of Object.entries(initial)) this.put(key, body);
  }

  put(key, body = '', modified = new Date()) {
    this.objects.set(key, { size: Buffer.byteLength(body), modified });
  }

  async send(command) {
    this.calls.push(command.constructor.name);
    if (command instanceof ListObjectsV2Command) return this.#list(command.input);
    if (command instanceof PutObjectCommand) {
      this.put(command.input.Key, command.input.Body ?? '');
      return {};
    }
    if (command instanceof DeleteObjectsCommand) return this.#delete(command.input);
    throw new Error(`FakeS3Client: unsupported command ${command.constructor.name}`);
  }

  #list({ Prefix = '', Delimiter, MaxKeys = 1000, ContinuationToken }) {
    const limit = Math.min(MaxKeys, this.pageSize);
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(Prefix)).sort();
    const contents = [];
    const commonPrefixes = [];
    let last = ContinuationToken;
    let truncated = false;

    // `last` is the last emitted key or common prefix; a common prefix also covers every key under it.
    const isCommonPrefix = (item) => Boolean(Delimiter) && item.slice(Prefix.length).includes(Delimiter);
    for (const key of keys) {
      if (last !== undefined && (key <= last || (isCommonPrefix(last) && key.startsWith(last)))) {
        continue;
      }
      const rest = key.slice(Prefix.length);
      const cut = Delimiter ? rest.indexOf(Delimiter) : -1;
      const item = cut >= 0 ? Prefix + rest.slice(0, cut + Delimiter.length) : key;
      if (item === last) continue;
      if (contents.length + commonPrefixes.length >= limit) {
        truncated = true;
        break;
      }
      if (cut >= 0) {
        commonPrefixes.push({ Prefix: item });
      } else {
        const { size, modified } = this.objects.get(key);
        contents.push({ Key: key, Size: size, LastModified: modified });
      }
      last = item;
    }

    return {
      Contents: contents.length ? contents : undefined,
      CommonPrefixes: commonPrefixes.length ? commonPrefixes : undefined,
      KeyCount: contents.length + commonPrefixes.length,
      IsTruncated: truncated,
      NextContinuationToken: truncated ? last : undefined,
    };
  }

  #delete({ Delete: { Objects } }) {
    this.deleteCalls += 1;
    if (this.deleteCalls === this.throwOnDeleteCall) {
      const err = new Error('simulated network failure');
      err.name = 'TimeoutError';
      throw err;
    }
    if (Objects.length > 1000) throw new Error('FakeS3Client: DeleteObjects accepts at most 1000 keys');
    const errors = [];
    for (const { Key } of Objects) {
      if (this.failDeleteKeys.has(Key)) errors.push({ Key, Code: this.failDeleteCode, Message: 'simulated' });
      else this.objects.delete(Key);
    }
    return { Errors: errors.length ? errors : undefined };
  }
}
