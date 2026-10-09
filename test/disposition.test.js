import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentDisposition } from '../src/disposition.js';

describe('attachmentDisposition (M2)', () => {
  it('keeps the exact UTF-8 name in filename* and an ASCII-safe fallback in filename', () => {
    assert.equal(attachmentDisposition('a.txt'), `attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    assert.equal(
      attachmentDisposition(`Été "q" \\ (1)*'.pdf`),
      `attachment; filename="_t_ _q_ _ (1)*'.pdf"; filename*=UTF-8''%C3%89t%C3%A9%20%22q%22%20%5C%20%281%29%2A%27.pdf`,
    );
    assert.equal(attachmentDisposition('a\r\nb'), `attachment; filename="a__b"; filename*=UTF-8''a%0D%0Ab`, 'no header injection');
  });
});
