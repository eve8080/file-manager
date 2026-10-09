import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileKey, parseFolderPath, parsePrefix } from '../src/paths.js';

describe('parsePrefix', () => {
  it('treats empty, missing, and "/" as the root', () => {
    assert.equal(parsePrefix(undefined), '');
    assert.equal(parsePrefix(''), '');
    assert.equal(parsePrefix('/'), '');
  });

  it('normalises to a trailing slash', () => {
    assert.equal(parsePrefix('a'), 'a/');
    assert.equal(parsePrefix('a/b/'), 'a/b/');
    assert.equal(parsePrefix('Photos 2026/Été'), 'Photos 2026/Été/');
  });

  for (const bad of ['/a', '../a', 'a/../b', 'a/./b', 'a//b', 'a/ b', 'a /b', 'a\u0000b', 'a\nb']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parsePrefix(bad), { status: 400 });
    });
  }

  it('rejects non-strings (e.g. repeated query params)', () => {
    assert.throws(() => parsePrefix(['a', 'b']), { status: 400 });
  });

  it('rejects paths over 1024 bytes', () => {
    assert.throws(() => parsePrefix('x'.repeat(1024)), { status: 400 });
    assert.equal(parsePrefix('x'.repeat(1023)).length, 1024);
  });
});

describe('parseFolderPath', () => {
  it('requires a non-root path', () => {
    assert.throws(() => parseFolderPath(''), { status: 400 });
    assert.throws(() => parseFolderPath(undefined), { status: 400 });
    assert.equal(parseFolderPath('a/b'), 'a/b/');
  });
});

describe('parseFileKey (M2)', () => {
  it('accepts a file key exactly as given', () => {
    assert.equal(parseFileKey('a.txt'), 'a.txt');
    assert.equal(parseFileKey('Photos 2026/Été/beach.jpg'), 'Photos 2026/Été/beach.jpg');
    assert.equal(parseFileKey('a\\b.txt'), 'a\\b.txt', 'a backslash is an ordinary character');
  });

  const bad = [undefined, '', ['a', 'b'], 42, 'a/', 'docs/', '/a', '../a', 'a/../b', 'a/./b', 'a//b', ' a', 'a ', 'a/ b',
    'a\u0000b', 'a\nb', 'x'.repeat(1025)];
  for (const input of bad) {
    it(`rejects ${JSON.stringify(input)?.slice(0, 40)}`, () => {
      assert.throws(() => parseFileKey(input), { status: 400, code: 'BAD_REQUEST' });
    });
  }

  it('allows exactly 1024 bytes', () => {
    assert.equal(parseFileKey('x'.repeat(1024)).length, 1024);
  });
});
