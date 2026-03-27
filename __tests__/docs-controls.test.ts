import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removeNoiseFromHtml } from '../src/transform/dom-prep.js';

// Padding ensures body innerHTML > 100 chars after cleanup (MIN_BODY_CONTENT_LENGTH).
const PAD =
  '<p>This paragraph provides enough body text content for the serialization threshold during testing.</p>';

function clean(bodyHtml: string): string {
  const html = `<html><body><main>${bodyHtml}${PAD}</main></body></html>`;
  return removeNoiseFromHtml(html, undefined, 'https://docs.example.com');
}

describe('Docs control selector removal', () => {
  it('removes .edit-this-page elements', () => {
    const result = clean(
      '<p>Content</p><a class="edit-this-page" href="/edit">Edit this page</a>'
    );
    assert.ok(!result.includes('Edit this page'), '.edit-this-page removed');
    assert.ok(result.includes('Content'), 'Content preserved');
  });

  it('removes .back-to-top elements', () => {
    const result = clean(
      '<p>Content</p><a class="back-to-top" href="#">Back to top</a>'
    );
    assert.ok(!result.includes('Back to top'), '.back-to-top removed');
  });

  it('removes .backtotop elements', () => {
    const result = clean('<p>Content</p><div class="backtotop">↑ Top</div>');
    assert.ok(!result.includes('↑ Top'), '.backtotop removed');
  });

  it('removes .headerlink elements', () => {
    const result = clean(
      '<h2>Title<a class="headerlink" href="#title">¶</a></h2><p>Content</p>'
    );
    assert.ok(!result.includes('headerlink'), '.headerlink removed');
    assert.ok(result.includes('Title'), 'Heading text preserved');
  });

  it('removes [title="Edit this page"] elements', () => {
    const result = clean(
      '<p>Content</p><a title="Edit this page" href="/edit">✏️</a>'
    );
    assert.ok(
      !result.includes('title="Edit this page"'),
      '[title] selector removed'
    );
  });

  it('removes .baseline-indicator elements', () => {
    const result = clean(
      '<p>Content</p><div class="baseline-indicator">Baseline 2024</div>'
    );
    assert.ok(!result.includes('Baseline 2024'), '.baseline-indicator removed');
  });

  it('removes mdn-content-feedback custom elements', () => {
    const result = clean(
      '<p>Content</p><mdn-content-feedback>Was this helpful?</mdn-content-feedback>'
    );
    assert.ok(
      !result.includes('Was this helpful'),
      'mdn-content-feedback removed'
    );
  });

  it('removes interactive-example custom elements', () => {
    const result = clean(
      '<p>Content</p><interactive-example>Try it</interactive-example>'
    );
    assert.ok(!result.includes('Try it'), 'interactive-example removed');
  });

  it('preserves content not matching control selectors', () => {
    const result = clean(
      '<h1>Documentation</h1><p>This is real documentation content.</p>'
    );
    assert.ok(result.includes('Documentation'), 'Content preserved');
    assert.ok(result.includes('real documentation'), 'Content preserved');
  });
});
