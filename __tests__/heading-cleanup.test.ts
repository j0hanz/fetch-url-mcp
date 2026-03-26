import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removeNoiseFromHtml } from '../dist/transform/dom-prep.js';

// Padding ensures body innerHTML > 100 chars after cleanup (MIN_BODY_CONTENT_LENGTH).
const PAD =
  '<p>This paragraph provides enough body text content for the serialization threshold during testing.</p>';

function clean(bodyHtml: string): string {
  const html = `<html><body><main>${bodyHtml}${PAD}</main></body></html>`;
  return removeNoiseFromHtml(html, undefined, 'https://example.com');
}

describe('Heading permalink anchor stripping', () => {
  it('strips anchor with # text', () => {
    const result = clean(
      '<h2><a href="#section">Section Title</a><a href="#section">#</a></h2><p>Content here.</p>'
    );
    assert.ok(result.includes('Section Title'), 'Heading text preserved');
    // The lone "#" permalink should be removed
    assert.ok(!result.includes('>#<'), 'Permalink # anchor must be stripped');
  });

  it('strips anchor with ¶ text', () => {
    const result = clean(
      '<h3>API Reference<a href="#api-reference">¶</a></h3><p>Details.</p>'
    );
    assert.ok(result.includes('API Reference'), 'Heading text preserved');
    assert.ok(!result.includes('¶'), 'Pilcrow permalink must be stripped');
  });

  it('strips anchor with § text', () => {
    const result = clean(
      '<h2>Overview<a href="#overview">§</a></h2><p>Content.</p>'
    );
    assert.ok(result.includes('Overview'), 'Heading text preserved');
    assert.ok(!result.includes('§'), 'Section sign permalink must be stripped');
  });

  it('strips anchor with permalink class', () => {
    const result = clean(
      '<h2><a class="headerlink" href="#install">#</a>Installation</h2><p>Steps.</p>'
    );
    assert.ok(result.includes('Installation'), 'Heading text preserved');
    // headerlink class anchor should be removed
    assert.ok(
      !result.includes('headerlink'),
      'Headerlink anchor must be stripped'
    );
  });

  it('strips anchor with aria-hidden="true" and tabindex="-1"', () => {
    const result = clean(
      '<h2><a aria-hidden="true" tabindex="-1" href="#usage">#</a>Usage</h2><p>How to use.</p>'
    );
    assert.ok(result.includes('Usage'), 'Heading text preserved');
    assert.ok(
      !result.includes('aria-hidden'),
      'Hidden permalink anchor must be stripped'
    );
  });
});

describe('Heading zero-width space removal', () => {
  it('strips zero-width space characters from heading text', () => {
    const result = clean(
      '<h2>Config\u200Buration</h2><p>Settings explained.</p>'
    );
    assert.ok(
      result.includes('Configuration'),
      'Zero-width space must be removed from heading'
    );
    assert.ok(!result.includes('\u200B'), 'No zero-width spaces must remain');
  });
});

describe('Heading wrapper div stripping', () => {
  it('strips absolute-positioned wrapper divs inside headings', () => {
    const result = clean(
      '<h2><div class="absolute" style="position: absolute;">icon</div>Getting Started</h2><p>Begin here.</p>'
    );
    assert.ok(
      result.includes('Getting Started'),
      'Heading text preserved after div strip'
    );
    assert.ok(
      !result.includes('icon'),
      'Absolute-positioned div content must be stripped'
    );
  });

  it('strips tabindex="-1" wrapper divs inside headings', () => {
    const result = clean(
      '<h2><div tabindex="-1">anchor</div>Features</h2><p>Feature list.</p>'
    );
    assert.ok(result.includes('Features'), 'Heading text preserved');
    assert.ok(!result.includes('anchor'), 'Wrapper div must be stripped');
  });
});
