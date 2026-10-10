// Errors with an HTTP status and a stable machine-readable code.
// The API error handler turns these into { error: { code, message, details? } }.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST') => new AppError(400, code, message);
export const notFound = (message) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new AppError(409, code, message);

// ---- Storage failures ----
// Clients only ever see one of these fixed reasons, never raw SDK/S3 names or messages
// (those go to the server log).
export const STORAGE_REASONS = {
  ACCESS_DENIED: 'S3 denied access. Check the IAM policy for this bucket.',
  CREDENTIALS_UNAVAILABLE: 'No AWS credentials found. Check AWS_PROFILE or your AWS configuration.',
  BUCKET_NOT_FOUND: 'The S3 bucket does not exist. Check S3_BUCKET and AWS_REGION.',
  THROTTLED: 'S3 is throttling requests. Try again shortly.',
  NETWORK: 'Could not reach S3 (network error or timeout).',
  UNAVAILABLE: 'S3 is temporarily unavailable.',
  UNKNOWN: 'S3 request failed.',
};

const REASON_BY_NAME = {
  AccessDenied: 'ACCESS_DENIED',
  AllAccessDisabled: 'ACCESS_DENIED',
  AccountProblem: 'ACCESS_DENIED',
  InvalidAccessKeyId: 'ACCESS_DENIED',
  SignatureDoesNotMatch: 'ACCESS_DENIED',
  ExpiredToken: 'ACCESS_DENIED',
  InvalidToken: 'ACCESS_DENIED',
  CredentialsProviderError: 'CREDENTIALS_UNAVAILABLE',
  NoSuchBucket: 'BUCKET_NOT_FOUND',
  SlowDown: 'THROTTLED',
  Throttling: 'THROTTLED',
  ThrottlingException: 'THROTTLED',
  RequestLimitExceeded: 'THROTTLED',
  TooManyRequestsException: 'THROTTLED',
  TimeoutError: 'NETWORK',
  RequestTimeout: 'NETWORK',
  RequestTimeoutException: 'NETWORK',
  NetworkingError: 'NETWORK',
  ECONNREFUSED: 'NETWORK',
  ECONNRESET: 'NETWORK',
  ENOTFOUND: 'NETWORK',
  ETIMEDOUT: 'NETWORK',
  EAI_AGAIN: 'NETWORK',
  InternalError: 'UNAVAILABLE',
  ServiceUnavailable: 'UNAVAILABLE',
};

// Maps an S3 error name/code (and HTTP status, if known) to one of STORAGE_REASONS' keys.
export function storageReason(nameOrCode, httpStatus) {
  if (Object.hasOwn(REASON_BY_NAME, nameOrCode)) return REASON_BY_NAME[nameOrCode];
  if (httpStatus === 403) return 'ACCESS_DENIED';
  if (httpStatus === 429) return 'THROTTLED';
  if (httpStatus >= 500) return 'UNAVAILABLE';
  return 'UNKNOWN';
}

const knownName = (err) => [err?.name, err?.code].find((n) => typeof n === 'string' && Object.hasOwn(REASON_BY_NAME, n));

// True for errors thrown by the AWS SDK (they carry $metadata) or the network layer beneath it.
export function isStorageError(err) {
  return Boolean(err?.$metadata) || knownName(err) !== undefined;
}

export function classifyStorageError(err) {
  return storageReason(knownName(err), err?.$metadata?.httpStatusCode);
}

// A file must not take a folder's visible name, and no part of its path may be a file
// (otherwise a listing would show a file and a folder with the same name).
export const folderNameConflict = () => conflict('NAME_CONFLICT', 'A folder with that name already exists');
export const pathNameConflict = () => conflict('NAME_CONFLICT', 'Part of that path is a file, not a folder');

// The client-facing form of any error, as { status, code, message, details? }. AppErrors pass through;
// storage failures become a fixed reason; anything else is a generic 500. The raw error of the last two
// is logged server-side only.
export function toPublicError(err) {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) };
  }
  console.error(err);
  if (isStorageError(err)) {
    const reason = classifyStorageError(err);
    return { status: 502, code: 'STORAGE_ERROR', message: STORAGE_REASONS[reason], details: { reason } };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

// JPEG previews are converted by the app (src/jpeg-preview.js). Fixed messages: no decoder or S3 detail reaches a client.
export const previewFailed = () =>
  new AppError(422, 'PREVIEW_FAILED', 'This image could not be converted for preview. Download it to open it in another app.');
export const previewTooLarge = () =>
  new AppError(413, 'PREVIEW_TOO_LARGE', 'This image is too large to preview. Download it to open it in another app.');

// A move (copy-then-delete) whose copy succeeded but whose source could not be deleted, so the file
// now exists under both names. details: { from, to, copied: true, sourceDeleted: false, reason }
export const moveIncomplete = (details) =>
  new AppError(
    502,
    'MOVE_INCOMPLETE',
    'The file was copied to the new name, but the original could not be removed. It now exists under both names.',
    details,
  );

// A recursive delete that stopped partway. `details` says exactly what is known:
// { path, requested, deleted, failedCount, failed: [{ key, reason }] (first 20), unknown, notAttempted, reason? }
// `reason` (one of STORAGE_REASONS' keys) is present when a whole delete request failed.
export const deleteIncomplete = (details) =>
  new AppError(
    502,
    'DELETE_INCOMPLETE',
    'Folder deletion did not complete. Some objects may already be deleted; list the folder to see what remains.',
    details,
  );
