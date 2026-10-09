import { conflict, notFound } from '../errors.js';

// In-memory storage with the same behaviour as the S3 driver. Used by tests and `npm run demo`.
//
// Storage interface (both drivers):
//   list(prefix)                      -> { folders: [name], files: [{ key, name, size, modified }] }
//                                        throws NOT_FOUND if prefix !== '' and nothing exists under it
//   createFolder(prefix)              -> writes marker object `prefix`; throws FOLDER_EXISTS
//   deleteFolder(prefix, {recursive}) -> number of objects deleted; throws NOT_FOUND / FOLDER_NOT_EMPTY
// Prefixes are already validated by src/paths.js ('' or 'a/b/').
export function createMemoryStorage(initial = {}) {
  const objects = new Map(); // key -> { body: Buffer, modified: Date }

  function putObject(key, body = '', modified = new Date()) {
    objects.set(key, { body: Buffer.from(body), modified });
  }

  function keysUnder(prefix) {
    return [...objects.keys()].filter((key) => key.startsWith(prefix));
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
  };
}
