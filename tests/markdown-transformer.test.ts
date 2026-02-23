import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToMarkdown } from '../dist/transform/transform.js';

describe('htmlToMarkdown noise filtering', () => {
  it('removes common noise nodes while keeping content', () => {
    const html = `
      <html>
        <body>
          <p>Keep me</p>
          <div style="display:none"><p>HIDDENSTYLE</p></div>
          <nav><p>NAVTEXT</p></nav>
          <footer><p>FOOTER</p></footer>
          <div hidden><p>HIDDEN</p></div>
          <div aria-hidden="true"><p>ARIAHIDDEN</p></div>
          <div role="navigation"><p>ROLETEXT</p></div>
          <div class="newsletter"><p>PROMO</p></div>
          <div class="fixed"><p>FIXED</p></div>
          <div class="z-50 isolate"><p>ZISO</p></div>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('Keep me'));

    // Strong signals removed (score >= 50)
    assert.ok(!markdown.includes('NAVTEXT'));
    assert.ok(!markdown.includes('FOOTER'));
    assert.ok(!markdown.includes('HIDDEN'));
    assert.ok(!markdown.includes('ARIAHIDDEN'));
    assert.ok(!markdown.includes('ROLETEXT'));
    assert.ok(!markdown.includes('HIDDENSTYLE'));

    // Weaker signals preserved (score < 50)
    assert.ok(markdown.includes('PROMO'));
    assert.ok(markdown.includes('FIXED'));
    assert.ok(markdown.includes('ZISO'));
  });

  it('preserves <aside> content including role="complementary"', () => {
    const html = `
      <html>
        <body>
          <p>Main content</p>
          <aside><p>ASIDE_DEFAULT</p></aside>
          <aside role="complementary"><p>ASIDE_COMPLEMENTARY</p></aside>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('Main content'));
    assert.match(markdown, /ASIDE\\?_DEFAULT/);
    assert.match(markdown, /ASIDE\\?_COMPLEMENTARY/);
  });

  it('preserves callout content (not treated as promo noise)', () => {
    const html = `
      <html>
        <body>
          <p>Main content</p>
          <div class="callout"><p>CALLOUT</p></div>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('Main content'));
    assert.ok(markdown.includes('CALLOUT'));
  });

  it('removes boilerplate site headers but keeps article headers', () => {
    const html = `
      <html>
        <body>
          <header class="site-header"><p>SITEHEADER</p></header>
          <header class="article-header"><h1>Article Title</h1></header>
          <p>Body text</p>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(!markdown.includes('SITEHEADER'));
    assert.ok(markdown.includes('Article Title'));
    assert.ok(markdown.includes('Body text'));
  });

  it('does not leak <head> content when HTML has no noise markers', () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>SHOULD_NOT_APPEAR</title></head>
        <body><p>Keep me</p></body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('Keep me'));
    assert.ok(!markdown.includes('SHOULD_NOT_APPEAR'));
  });

  it('removes TOC headings when the list is stripped', () => {
    const html = `
      <html>
        <body>
          <h2>Table of Contents</h2>
          <ul>
            <li><a href="#intro">Intro</a></li>
            <li><a href="#usage">Usage</a></li>
          </ul>
          <h2>Intro</h2>
          <p>Content</p>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(!markdown.toLowerCase().includes('table of contents'));
    assert.ok(!markdown.includes('[Intro](#intro)'));
    assert.ok(markdown.includes('Intro'));
    assert.ok(markdown.includes('Content'));
  });

  it('uses four-space indentation for nested list items', () => {
    const html = `
      <html>
        <body>
          <ul>
            <li>Parent
              <ul>
                <li>Child
                  <ul>
                    <li>Grandchild</li>
                  </ul>
                </li>
              </ul>
            </li>
          </ul>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.match(markdown, /^- Parent\s*$/m);
    assert.match(markdown, /^ {4}- Child\s*$/m);
    assert.match(markdown, /^ {8}- Grandchild\s*$/m);
  });

  it('does not promote orphan headings without following content', () => {
    const html = `
      <html>
        <body>
          <p>Overview</p>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('Overview'));
    assert.ok(!markdown.includes('## Overview'));
  });
});

describe('htmlToMarkdown metadata footer', () => {
  it('appends metadata as a footer after content', () => {
    const html = '<p>Hello</p>';
    const markdown = htmlToMarkdown(html, {
      type: 'metadata',
      title: 'hello:world',
      url: 'https://example.com/path?x=1',
      fetchedAt: '2026-01-28T00:00:00.000Z',
    });

    // Content comes first, metadata footer at the end
    assert.ok(markdown.startsWith('Hello'));
    assert.ok(markdown.includes('_hello:world_'));
    assert.ok(
      markdown.includes('[_Original Source_](https://example.com/path?x=1)')
    );
  });
});

describe('htmlToMarkdown code blocks', () => {
  it('uses language from class name when available', () => {
    const html = '<pre><code class="language-js">console.log(1)</code></pre>';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('```js'));
    assert.ok(markdown.includes('console.log(1)'));
  });

  it('uses language from data-language when available', () => {
    const html = '<pre><code data-language="bash">npm run build</code></pre>';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('```bash'));
    assert.ok(markdown.includes('npm run build'));
  });

  it('falls back to language detection when no attributes are present', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('```javascript'));
    assert.ok(markdown.includes('const x = 1;'));
  });

  it('does not resolve relative links inside fenced code blocks', () => {
    const html = '<pre><code>[Doc](./doc.md)</code></pre>';
    const markdown = htmlToMarkdown(html, undefined, {
      url: 'https://example.com/base/page',
    });

    assert.ok(markdown.includes('[Doc](./doc.md)'));
  });
});

describe('htmlToMarkdown image alt text', () => {
  it('derives alt text from filename when alt is missing', () => {
    const html = '<img src="https://example.com/images/my-diagram.png" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes(
        '![my diagram](https://example.com/images/my-diagram.png)'
      )
    );
  });

  it('preserves existing alt text when present', () => {
    const html =
      '<img alt="Custom Alt" src="https://example.com/images/photo.jpg" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![Custom Alt](https://example.com/images/photo.jpg)')
    );
  });

  it('handles images with no filename gracefully', () => {
    const html = '<img src="https://example.com/" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('![](https://example.com/)'));
  });
});

describe('htmlToMarkdown lazy-loaded image support', () => {
  it('resolves image from data-src when src is absent', () => {
    const html =
      '<img data-src="https://cdn.example.com/lazy.jpg" alt="lazy image" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![lazy image](https://cdn.example.com/lazy.jpg)')
    );
  });

  it('resolves image from data-src when src is a data URI placeholder', () => {
    const html =
      '<img src="data:image/gif;base64,R0lGODlh" data-src="https://cdn.example.com/real.jpg" alt="placeholder" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![placeholder](https://cdn.example.com/real.jpg)')
    );
  });

  it('resolves image from data-lazy-src fallback', () => {
    const html =
      '<img data-lazy-src="https://cdn.example.com/lazy2.jpg" alt="lazy2" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('![lazy2](https://cdn.example.com/lazy2.jpg)'));
  });

  it('resolves image from data-original fallback', () => {
    const html =
      '<img data-original="https://cdn.example.com/original.jpg" alt="original" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![original](https://cdn.example.com/original.jpg)')
    );
  });

  it('resolves image from srcset when src is absent', () => {
    const html =
      '<img srcset="https://cdn.example.com/srcset.jpg 1x, https://cdn.example.com/srcset2x.jpg 2x" alt="srcset" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![srcset](https://cdn.example.com/srcset.jpg)')
    );
  });

  it('resolves image from data-srcset fallback', () => {
    const html =
      '<img data-srcset="https://cdn.example.com/ds.jpg 800w, https://cdn.example.com/ds2.jpg 1200w" alt="data-srcset" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![data-srcset](https://cdn.example.com/ds.jpg)')
    );
  });

  it('prefers real src over data-src attributes', () => {
    const html =
      '<img src="https://cdn.example.com/real.jpg" data-src="https://cdn.example.com/lazy.jpg" alt="real" />';
    const markdown = htmlToMarkdown(html);

    assert.ok(markdown.includes('![real](https://cdn.example.com/real.jpg)'));
  });

  it('handles picture with source and lazy-loaded img', () => {
    const html = `<picture>
      <source srcset="https://cdn.example.com/small.jpg" media="(max-width:480px)">
      <img data-src="https://cdn.example.com/lazy.jpg" alt="picture lazy" />
    </picture>`;
    const markdown = htmlToMarkdown(html);

    assert.ok(
      markdown.includes('![picture lazy](https://cdn.example.com/lazy.jpg)')
    );
  });
});
