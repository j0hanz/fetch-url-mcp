import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import { stripScreenReaderText } from '../dist/lib/dom-prep.js';

function applyStrip(bodyInnerHtml: string): string {
  const { document } = parseHTML(`<html><body>${bodyInnerHtml}</body></html>`);
  stripScreenReaderText(document);
  return document.body.innerHTML;
}

describe('stripScreenReaderText', () => {
  it('removes .sr-only elements', () => {
    const result = applyStrip(
      '<span class="sr-only">Skip to content</span><p>Visible</p>'
    );
    assert.ok(!result.includes('Skip to content'), '.sr-only must be removed');
    assert.ok(result.includes('Visible'), 'Visible content preserved');
  });

  it('removes .screen-reader-text elements', () => {
    const result = applyStrip(
      '<h2 class="screen-reader-text">Read more articles</h2><p>Content</p>'
    );
    assert.ok(
      !result.includes('Read more articles'),
      '.screen-reader-text must be removed'
    );
  });

  it('removes .visually-hidden elements', () => {
    const result = applyStrip(
      '<span class="visually-hidden">Navigation</span><p>Content</p>'
    );
    assert.ok(
      !result.includes('Navigation'),
      '.visually-hidden must be removed'
    );
  });

  it('removes elements matching [class*="sr-only"]', () => {
    const result = applyStrip(
      '<span class="custom-sr-only-text">Hidden</span><p>Visible</p>'
    );
    assert.ok(!result.includes('Hidden'), '[class*="sr-only"] must be removed');
  });

  it('removes elements matching [class*="visually-hidden"]', () => {
    const result = applyStrip(
      '<span class="my-visually-hidden-class">Hidden</span><p>Visible</p>'
    );
    assert.ok(
      !result.includes('Hidden'),
      '[class*="visually-hidden"] must be removed'
    );
  });

  it('removes .cdk-visually-hidden elements', () => {
    const result = applyStrip(
      '<div class="cdk-visually-hidden">Angular a11y</div><p>Content</p>'
    );
    assert.ok(
      !result.includes('Angular a11y'),
      '.cdk-visually-hidden must be removed'
    );
  });

  it('removes .vh elements', () => {
    const result = applyStrip(
      '<span class="vh">Shorthand hidden</span><p>Content</p>'
    );
    assert.ok(!result.includes('Shorthand hidden'), '.vh must be removed');
  });

  it('removes .hidden-visually elements', () => {
    const result = applyStrip(
      '<span class="hidden-visually">Alt hidden</span><p>Content</p>'
    );
    assert.ok(
      !result.includes('Alt hidden'),
      '.hidden-visually must be removed'
    );
  });

  it('preserves elements without screen-reader classes', () => {
    const result = applyStrip(
      '<span class="visible-text">Regular text</span><p>Content</p>'
    );
    assert.ok(
      result.includes('Regular text'),
      'Non-matching elements must be preserved'
    );
  });
});
