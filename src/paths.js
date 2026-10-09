import { badRequest } from './errors.js';

const MAX_KEY_BYTES = 1024; // S3 object key limit
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Validates a folder path from a client and returns it as an S3 prefix:
// '' for the root, otherwise 'a/b/' (always with a trailing slash).
export function parsePrefix(input) {
  if (input === undefined || input === '' || input === '/') return '';
  if (typeof input !== 'string') throw badRequest('Path must be a single string');
  const path = input.endsWith('/') ? input.slice(0, -1) : input;
  validateSegments(path);
  const prefix = `${path}/`;
  if (Buffer.byteLength(prefix) > MAX_KEY_BYTES) throw badRequest('Path is too long');
  return prefix;
}

// Like parsePrefix, but the root is not allowed (for creating/deleting a folder).
export function parseFolderPath(input) {
  const prefix = parsePrefix(input);
  if (prefix === '') throw badRequest('A folder path is required');
  return prefix;
}

// Last name in a non-root prefix: 'a/b/' -> 'b'.
export function folderName(prefix) {
  return prefix.slice(0, -1).split('/').pop();
}

function validateSegments(path) {
  if (path.startsWith('/')) throw badRequest('Path must not start with "/"');
  if (CONTROL_CHARS.test(path)) throw badRequest('Path contains control characters');
  for (const segment of path.split('/')) {
    if (segment === '') throw badRequest('Path contains an empty name');
    if (segment === '.' || segment === '..') throw badRequest('Path must not contain "." or ".."');
    if (segment.trim() !== segment) throw badRequest('Names must not start or end with spaces');
  }
}
