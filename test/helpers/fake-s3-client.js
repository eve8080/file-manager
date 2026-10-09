import {
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Minimal in-process stand-in for S3Client, implementing just the commands the S3 driver uses,
// with S3's semantics where the driver depends on them:
// - listing: sorted keys, Prefix, Delimiter/CommonPrefixes, MaxKeys pagination (`pageSize` forces small pages)
// - HeadObject / CopyObject on a missing key: 404 `NotFound` / `NoSuchKey`
// - PutObject / CompleteMultipartUpload with `IfNoneMatch: '*'` on an existing key: 412 `PreconditionFailed`
// - multipart uploads: every part except the last must be at least `minPartSize` bytes (S3: 5 MiB), else
//   CompleteMultipartUpload fails with `EntityTooSmall`; an unknown UploadId gives `NoSuchUpload`
// Failure injection: `failDeleteKeys` / `throwOnDeleteCall` for DeleteObjects (see the M1 tests), and
// `failNext(commandName, errorProps, times)` to make the next call(s) of any command throw an SDK-like error.
export class FakeS3Client {
  constructor(
    initial = {},
    { pageSize = 1000, failDeleteKeys = [], failDeleteCode = 'AccessDenied', throwOnDeleteCall, minPartSize = 5 * 1024 * 1024 } = {},
  ) {
    this.objects = new Map(); // key -> { body: Buffer, modified: Date }
    this.uploads = new Map(); // UploadId -> { key, parts: Map(partNumber -> Buffer) }
    this.pageSize = pageSize;
    this.minPartSize = minPartSize;
    this.failDeleteKeys = new Set(failDeleteKeys);
    this.failDeleteCode = failDeleteCode;
    this.throwOnDeleteCall = throwOnDeleteCall;
    this.deleteCalls = 0;
    this.calls = [];
    this.inputs = []; // { name, input } for every command
    this.failures = []; // { name, props, times }
    this.nextUploadId = 1;
    for (const [key, body] of Object.entries(initial)) this.put(key, body);
  }

  put(key, body = '', modified = new Date()) {
    this.objects.set(key, { body: Buffer.from(body), modified });
  }

  body(key) {
    return this.objects.get(key)?.body.toString();
  }

  failNext(name, props, times = 1) {
    this.failures.push({ name, props, times });
  }

  async send(command) {
    const name = command.constructor.name;
    this.calls.push(name);
    this.inputs.push({ name, input: command.input });
    const failure = this.failures.find((f) => f.name === name && f.times > 0);
    if (failure) {
      failure.times -= 1;
      throw s3Error(failure.props.name, failure.props.status, failure.props.message);
    }
    const input = command.input;
    if (command instanceof ListObjectsV2Command) return this.#list(input);
    if (command instanceof PutObjectCommand) {
      this.#precondition(input);
      this.put(input.Key, toBuffer(input.Body));
      return { ETag: '"etag"' };
    }
    if (command instanceof DeleteObjectsCommand) return this.#delete(input);
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw s3Error('NotFound', 404);
      return { ContentLength: object.body.length, LastModified: object.modified };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(input.Key); // like S3: deleting a missing key succeeds
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const [bucket, ...rest] = input.CopySource.split('/');
      if (bucket !== input.Bucket) throw new Error(`FakeS3Client: CopySource bucket ${bucket} != ${input.Bucket}`);
      const sourceKey = rest.map(decodeURIComponent).join('/');
      const source = this.objects.get(sourceKey);
      if (!source) throw s3Error('NoSuchKey', 404);
      this.put(input.Key, source.body);
      return { CopyObjectResult: { ETag: '"etag"' } };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const UploadId = `upload-${this.nextUploadId++}`;
      this.uploads.set(UploadId, { key: input.Key, parts: new Map() });
      return { UploadId, Key: input.Key };
    }
    if (command instanceof UploadPartCommand) {
      const upload = this.#upload(input);
      if (!(input.PartNumber >= 1 && input.PartNumber <= 10_000)) throw s3Error('InvalidArgument', 400);
      upload.parts.set(input.PartNumber, toBuffer(input.Body));
      return { ETag: `"part-${input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const upload = this.#upload(input);
      const parts = input.MultipartUpload?.Parts ?? [];
      if (parts.length === 0) throw s3Error('MalformedXML', 400);
      const buffers = parts.map(({ PartNumber, ETag }, i) => {
        if (i > 0 && PartNumber <= parts[i - 1].PartNumber) throw s3Error('InvalidPartOrder', 400);
        const part = upload.parts.get(PartNumber);
        if (!part || ETag !== `"part-${PartNumber}"`) throw s3Error('InvalidPart', 400);
        if (i < parts.length - 1 && part.length < this.minPartSize) throw s3Error('EntityTooSmall', 400);
        return part;
      });
      this.#precondition(input);
      this.uploads.delete(input.UploadId);
      this.put(input.Key, Buffer.concat(buffers));
      return { ETag: '"etag"' };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.#upload(input);
      this.uploads.delete(input.UploadId);
      return {};
    }
    throw new Error(`FakeS3Client: unsupported command ${name}`);
  }

  #upload({ UploadId, Key }) {
    const upload = this.uploads.get(UploadId);
    if (!upload || upload.key !== Key) throw s3Error('NoSuchUpload', 404);
    return upload;
  }

  #precondition({ IfNoneMatch, Key }) {
    if (IfNoneMatch === '*' && this.objects.has(Key)) throw s3Error('PreconditionFailed', 412);
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
        const { body, modified } = this.objects.get(key);
        contents.push({ Key: key, Size: body.length, LastModified: modified });
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

// A real S3Client used only for presigning, which is local computation. Its request handler throws, so any
// attempt to send a request fails the test instead of reaching AWS. The credentials are dummies, not secrets.
export const TEST_SIGNER = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'TESTACCESSKEYID', secretAccessKey: 'test-secret-not-a-real-key' },
  requestHandler: { handle: () => Promise.reject(new Error('tests must never send requests to AWS')) },
});

// An error shaped like the SDK's: a name, a message, and $metadata.httpStatusCode.
export function s3Error(name, status, message = `simulated ${name}`) {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

function toBuffer(body) {
  if (body === undefined) return Buffer.alloc(0);
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('FakeS3Client: only string/Buffer bodies are supported (the driver buffers stream chunks)');
}
