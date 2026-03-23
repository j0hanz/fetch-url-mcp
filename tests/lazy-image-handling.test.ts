import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import {
  extractNoscriptImages,
  removeNoiseFromHtml,
} from '../dist/lib/dom-prep.js';
import { htmlToMarkdown } from '../dist/transform/transform.js';

// ── helpers ─────────────────────────────────────────────────────────

function nonNoscriptImgs(document: Document): Element[] {
  return Array.from(document.querySelectorAll('img')).filter(
    (img) => !img.closest('noscript')
  );
}

// ── extractNoscriptImages ───────────────────────────────────────────

describe('extractNoscriptImages', () => {
  it('promotes images from noscript when no adjacent img exists', () => {
    const { document } = parseHTML(`
      <html><body>
        <p>Text</p>
        <noscript><img src="https://example.com/real.jpg" alt="Photo"></noscript>
      </body></html>
    `);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]?.getAttribute('src'), 'https://example.com/real.jpg');
  });

  it('skips promotion when previous sibling is an img', () => {
    const { document } = parseHTML(`
      <html><body>
        <img src="data:image/gif;base64,R0lGODlh" data-src="https://example.com/real.jpg" alt="Lazy">
        <noscript><img src="https://example.com/real.jpg" alt="Lazy"></noscript>
      </body></html>
    `);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(imgs.length, 1, 'Should not duplicate the lazy-loaded image');
  });

  it('skips promotion when previous sibling wraps an img', () => {
    const { document } = parseHTML(`
      <html><body>
        <div class="lazy-wrapper"><img src="placeholder.gif" data-src="https://example.com/real.jpg" alt="Wrapped"></div>
        <noscript><img src="https://example.com/real.jpg" alt="Wrapped"></noscript>
      </body></html>
    `);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(
      imgs.length,
      1,
      'Should not promote when sibling contains img'
    );
  });

  it('skips tracking pixels (1×1 images)', () => {
    const { document } = parseHTML(`
      <html><body>
        <p>Content</p>
        <noscript>
          <img src="https://analytics.example.com/pixel.gif" width="1" height="1" alt="">
          <img src="https://example.com/real.jpg" alt="Content">
        </noscript>
      </body></html>
    `);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(imgs.length, 1, 'Tracking pixel should be filtered out');
    assert.equal(imgs[0]?.getAttribute('src'), 'https://example.com/real.jpg');
  });

  it('ignores noscript with no img elements', () => {
    const { document } = parseHTML(`
      <html><body>
        <noscript><p>Please enable JavaScript</p></noscript>
      </body></html>
    `);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(imgs.length, 0);
  });

  it('promotes multiple images from noscript', () => {
    const { document } = parseHTML(`<html><body>
      <p>Text</p>
      <noscript>
        <img src="https://example.com/a.jpg" alt="A">
        <img src="https://example.com/b.jpg" alt="B">
      </noscript>
    </body></html>`);
    extractNoscriptImages(document);

    const imgs = nonNoscriptImgs(document);
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0]?.getAttribute('alt'), 'A');
    assert.equal(imgs[1]?.getAttribute('alt'), 'B');
  });
});

// ── noscript pipeline integration ───────────────────────────────────

describe('noscript image integration', () => {
  it('noscript images survive noise removal pipeline', () => {
    const html = `
      <html><body>
        <article>
          <p>Article content for Readability threshold.</p>
          <p>More text to ensure it passes the minimum.</p>
          <noscript><img src="https://example.com/noscript-img.jpg" alt="Noscript"></noscript>
        </article>
      </body></html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('https://example.com/noscript-img.jpg'),
      'Promoted image should survive noise removal'
    );
    assert.ok(
      !result.includes('<noscript'),
      'noscript tag itself should be stripped'
    );
  });
});

// ── placeholder src detection ───────────────────────────────────────

describe('placeholder src detection in htmlToMarkdown', () => {
  it('uses data-src when src is blank.gif', () => {
    const html =
      '<img src="blank.gif" data-src="https://cdn.example.com/real.jpg" alt="Test" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![Test](https://cdn.example.com/real.jpg)'),
      `blank.gif should be treated as placeholder, got: ${markdown}`
    );
  });

  it('uses data-src when src is spacer.png', () => {
    const html =
      '<img src="/images/spacer.png" data-src="https://cdn.example.com/real.jpg" alt="Test" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![Test](https://cdn.example.com/real.jpg)'),
      `spacer.png should be treated as placeholder, got: ${markdown}`
    );
  });

  it('uses data-src when src is placeholder.jpg', () => {
    const html =
      '<img src="placeholder.jpg" data-src="https://cdn.example.com/real.jpg" alt="Test" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![Test](https://cdn.example.com/real.jpg)'),
      `placeholder.jpg should be treated as placeholder, got: ${markdown}`
    );
  });

  it('uses data-src when src is pixel.gif', () => {
    const html =
      '<img src="https://example.com/pixel.gif" data-src="https://cdn.example.com/real.jpg" alt="px" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![px](https://cdn.example.com/real.jpg)'),
      `pixel.gif should be treated as placeholder, got: ${markdown}`
    );
  });

  it('preserves normal src even when data-src is present', () => {
    const html =
      '<img src="https://cdn.example.com/photo.jpg" data-src="https://cdn.example.com/lazy.jpg" alt="photo" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![photo](https://cdn.example.com/photo.jpg)'),
      'Non-placeholder src should be kept'
    );
  });

  it('does not false-positive on filenames containing placeholder words', () => {
    const html =
      '<img src="https://example.com/transparent-logo.png" alt="logo" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![logo](https://example.com/transparent-logo.png)'),
      'Compound filename should not match placeholder pattern'
    );
  });
});

// ── new lazy-loading attributes ─────────────────────────────────────

describe('htmlToMarkdown additional lazy-loading attrs', () => {
  it('resolves image from data-lazy when src is absent', () => {
    const html =
      '<img data-lazy="https://cdn.example.com/lazy.jpg" alt="lazy" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![lazy](https://cdn.example.com/lazy.jpg)'),
      `data-lazy should be resolved, got: ${markdown}`
    );
  });

  it('resolves image from data-echo when src is absent', () => {
    const html =
      '<img data-echo="https://cdn.example.com/echo.jpg" alt="echo" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![echo](https://cdn.example.com/echo.jpg)'),
      `data-echo should be resolved, got: ${markdown}`
    );
  });

  it('resolves data-lazy when src is a data URI placeholder', () => {
    const html =
      '<img src="data:image/gif;base64,R0lGODlh" data-lazy="https://cdn.example.com/real.jpg" alt="combo" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![combo](https://cdn.example.com/real.jpg)'),
      `data-lazy should take over data-URI src, got: ${markdown}`
    );
  });

  it('resolves data-echo when src is a placeholder filename', () => {
    const html =
      '<img src="grey.gif" data-echo="https://cdn.example.com/real.jpg" alt="grey" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![grey](https://cdn.example.com/real.jpg)'),
      `grey.gif + data-echo should resolve to real URL, got: ${markdown}`
    );
  });
});
