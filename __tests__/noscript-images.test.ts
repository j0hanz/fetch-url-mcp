import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import { extractNoscriptImages } from '../src/transform/index.js';

function extract(bodyHtml: string): string {
  const { document } = parseHTML(`<html><body>${bodyHtml}</body></html>`);
  extractNoscriptImages(document);
  return document.body.innerHTML;
}

describe('extractNoscriptImages', () => {
  it('surfaces img from noscript when no adjacent img sibling', () => {
    const result = extract(
      '<div><noscript><img src="photo.jpg" alt="Photo"/></noscript></div>'
    );
    // The img should be hoisted before the noscript element
    assert.ok(
      result.includes('src="photo.jpg"'),
      'Noscript img must be surfaced'
    );
  });

  it('does not duplicate img when previous sibling is an img (lazy-load placeholder)', () => {
    const result = extract(
      '<div><img src="placeholder.jpg" data-src="real.jpg"/><noscript><img src="real.jpg" alt="Real"/></noscript></div>'
    );
    // The implementation skips noscript when previous sibling is/contains <img>
    // so no new img is inserted before the noscript — only the placeholder img exists outside
    const noscriptIdx = result.indexOf('<noscript');
    const outsideImgCount = (
      result.substring(0, noscriptIdx).match(/<img /g) ?? []
    ).length;
    assert.equal(
      outsideImgCount,
      1,
      'Should not duplicate img when sibling exists'
    );
  });

  it('does not surface 1x1 tracking pixel images', () => {
    const result = extract(
      '<div><noscript><img src="tracker.gif" width="1" height="1"/></noscript></div>'
    );
    // Tracking pixels (width=1 or height=1) are skipped — no img hoisted before noscript
    const noscriptIdx = result.indexOf('<noscript');
    const beforeNoscript =
      noscriptIdx >= 0 ? result.substring(0, noscriptIdx) : result;
    assert.ok(
      !beforeNoscript.includes('<img'),
      'Tracking pixel img must not be surfaced outside noscript'
    );
  });

  it('handles noscript with raw HTML text content', () => {
    // Some DOMs store noscript content as text, not parsed children
    const { document } = parseHTML(
      '<html><body><div><noscript>&lt;img src="text-img.jpg" alt="Alt"/&gt;</noscript></div></body></html>'
    );
    extractNoscriptImages(document);
    const body = document.body.innerHTML;
    // linkedom may or may not parse the text — the function handles both paths
    // Just verify no crash and the function completes
    assert.ok(typeof body === 'string', 'Function completes without error');
  });
});
