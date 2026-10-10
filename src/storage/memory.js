import { conflict, folderNameConflict, notFound, pathNameConflict, previewTooLarge } from '../errors.js';
import { ancestorPaths } from '../paths.js';
import { needsNormalizing, previewKind, textPreview } from '../preview.js';

// In-memory storage with the same behaviour as the S3 driver. Used by tests and `npm run demo`.
//
// Storage interface (both drivers):
//   list(prefix)                      -> { folders: [name], files: [{ key, name, size, modified }] }
//                                        throws NOT_FOUND if prefix !== '' and nothing exists under it
//   createFolder(prefix)              -> writes marker object `prefix`; throws FOLDER_EXISTS
//   deleteFolder(prefix, {recursive}) -> number of objects deleted; throws NOT_FOUND / FOLDER_NOT_EMPTY
//   deleteFile(key)                   -> deletes one file; throws NOT_FOUND
//   putFile(key, stream)              -> { size }; stores a stream of unknown length; throws FILE_EXISTS
//                                        (never overwrites) / NAME_CONFLICT (see moveFile); a stream error
//                                        rejects and stores nothing
//   getDownload(key)                 -> { url } (S3: presigned GET, 5 minutes) or { body } (memory);
//                                        throws NOT_FOUND
//   getPreview(key)                  -> by extension (src/preview.js); throws NOT_FOUND for any kind:
//                                        { kind: 'text', text, truncated } (first PREVIEW_TEXT_BYTES, UTF-8)
//                                        { kind: 'image'|'pdf', contentType, url } (S3: presigned inline GET,
//                                        5 minutes) or { kind, contentType, body } (memory)
//                                        { kind: 'none' } (download only)
//                                        JPEGs (needsNormalizing) are { kind: 'image', contentType } only: the app
//                                        serves a converted copy from readPreviewSource, so there is no URL or body
//   readPreviewSource(key, maxBytes) -> Buffer, the whole stored file (S3: one GET, nothing else); throws
//                                        NOT_FOUND / PREVIEW_TOO_LARGE (413) if it is longer than maxBytes -
//                                        checked before the body is read, and again while reading
//   moveFile(from, to)               -> renames/moves one file; throws NOT_FOUND (from) / FILE_EXISTS (to) /
//                                        NAME_CONFLICT (`to` is a folder's name, or part of its path is a file);
//                                        S3 only: MOVE_INCOMPLETE if the copy exists but the source remains
// Prefixes and keys are already validated by src/paths.js ('' or 'a/b/'; 'a/b.txt').
export function createMemoryStorage(initial = {}) {
  const objects = new Map(); // key -> { body: Buffer, modified: Date }

  function putObject(key, body = '', modified = new Date()) {
    objects.set(key, { body: Buffer.from(body), modified });
  }

  function keysUnder(prefix) {
    return [...objects.keys()].filter((key) => key.startsWith(prefix));
  }

  // NAME_CONFLICT if `key` is a folder's name, or a part of its path is a file.
  function checkNameFree(key) {
    if (keysUnder(`${key}/`).length > 0) throw folderNameConflict();
    if (ancestorPaths(key).some((path) => objects.has(path))) throw pathNameConflict();
  }

  for (const [key, body] of Object.entries(initial)) putObject(key, body);

  return {
    putObject,

    async list(prefix) {
      const keys = keysUnder(prefix);
      if (prefix !== '' && keys.length === 0) throw notFound('Folder not found');

      const folders = new Set();
      const files = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        if (rest === '') continue; // this folder's own marker
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const { body, modified } = objects.get(key);
          files.push({ key, name: rest, size: body.length, modified: modified.toISOString() });
        } else if (slash > 0) {
          folders.add(rest.slice(0, slash));
        }
      }
      return {
        folders: [...folders].sort(),
        files: files.sort((a, b) => (a.name < b.name ? -1 : 1)),
      };
    },

    async createFolder(prefix) {
      if (keysUnder(prefix).length > 0) throw conflict('FOLDER_EXISTS', 'Folder already exists');
      putObject(prefix);
    },

    async deleteFolder(prefix, { recursive = false } = {}) {
      const keys = keysUnder(prefix);
      if (keys.length === 0) throw notFound('Folder not found');
      if (!recursive && keys.some((key) => key !== prefix)) {
        throw conflict('FOLDER_NOT_EMPTY', 'Folder is not empty');
      }
      for (const key of keys) objects.delete(key);
      return keys.length;
    },

    async deleteFile(key) {
      if (!objects.has(key)) throw notFound('File not found');
      objects.delete(key);
    },

    // Like the S3 driver, refuses to overwrite: checked before reading and again before storing (the
    // second check stands in for S3's conditional write, in case another upload won the race).
    async putFile(key, stream) {
      const exists = () => conflict('FILE_EXISTS', 'A file with that name already exists');
      if (objects.has(key)) throw exists();
      checkNameFree(key);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      if (objects.has(key)) throw exists();
      checkNameFree(key);
      const body = Buffer.concat(chunks);
      putObject(key, body);
      return { size: body.length };
    },

    // The demo/test driver answers downloads itself, deterministically, with the file's bytes.
    async getDownload(key) {
      if (!objects.has(key)) throw notFound('File not found');
      return { body: Buffer.from(objects.get(key).body) };
    },

    async getPreview(key) {
      if (!objects.has(key)) throw notFound('File not found');
      const preview = previewKind(key);
      const { body } = objects.get(key);
      if (preview.kind === 'text') return textPreview(body, body.length);
      if (preview.kind === 'none' || needsNormalizing(key)) return preview;
      return { ...preview, body: Buffer.from(body) };
    },

    async readPreviewSource(key, maxBytes) {
      if (!objects.has(key)) throw notFound('File not found');
      const { body } = objects.get(key);
      if (body.length > maxBytes) throw previewTooLarge();
      return Buffer.from(body);
    },

    async moveFile(from, to) {
      if (!objects.has(from)) throw notFound('File not found');
      if (objects.has(to)) throw conflict('FILE_EXISTS', 'A file with that name already exists');
      checkNameFree(to);
      objects.set(to, objects.get(from));
      objects.delete(from);
    },
  };
}
