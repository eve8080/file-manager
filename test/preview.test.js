import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_TEXT_BYTES, needsNormalizing, previewKind } from '../src/preview.js';

describe('previewKind (M3)', () => {
  const cases = {
    text: ['a.txt', 'notes.md', 'data.csv', 'x.json', 'page.html', 'page.HTM', 'dir/sub/app.log', 'pic.svg', 'README.TXT'],
    image: ['a.jpg', 'a.jpeg', 'a.png', 'a.gif', 'a.webp', 'Photos/IMG.JPG', 'x.PnG'],
    pdf: ['a.pdf', 'docs/Report.PDF'],
    none: ['a', 'archive.zip', 'movie.mp4', 'a.bmp', 'a.tiff', 'a.heic', 'Makefile', '.png', 'dir.png/file', 'a.pdf.exe', 'a.txt.'],
  };
  for (const [kind, keys] of Object.entries(cases)) {
    it(`${kind}: ${keys.join(', ')}`, () => {
      for (const key of keys) assert.equal(previewKind(key).kind, kind, key);
    });
  }

  it('gives each image/PDF kind a fixed content type taken from the extension, never from the file', () => {
    assert.deepEqual(previewKind('a.JPG'), { kind: 'image', contentType: 'image/jpeg' });
    assert.deepEqual(previewKind('a.jpeg'), { kind: 'image', contentType: 'image/jpeg' });
    assert.deepEqual(previewKind('a.png'), { kind: 'image', contentType: 'image/png' });
    assert.deepEqual(previewKind('a.gif'), { kind: 'image', contentType: 'image/gif' });
    assert.deepEqual(previewKind('a.webp'), { kind: 'image', contentType: 'image/webp' });
    assert.deepEqual(previewKind('a.pdf'), { kind: 'pdf', contentType: 'application/pdf' });
    assert.deepEqual(previewKind('a.txt'), { kind: 'text' });
    assert.deepEqual(previewKind('a.zip'), { kind: 'none' });
  });

  it('caps text previews at exactly 1 MiB', () => {
    assert.equal(PREVIEW_TEXT_BYTES, 1024 * 1024);
  });
});

describe('needsNormalizing (M4: JPEG previews are converted on demand)', () => {
  it('is true for .jpg / .jpeg in any case, and only for them', () => {
    for (const key of ['a.jpg', 'a.jpeg', 'Photos/IMG_0001.JPG', 'x.JpEg', 'dir.png/photo.jpg']) assert.equal(needsNormalizing(key), true, key);
    for (const key of ['a.png', 'a.gif', 'a.webp', 'a.pdf', 'a.txt', 'a.zip', 'a.heic', '.jpg', 'jpg', 'a.jpg.png', 'a.jpg.', 'a']) {
      assert.equal(needsNormalizing(key), false, key);
    }
  });
});
