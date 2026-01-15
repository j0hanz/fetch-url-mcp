import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToMarkdown } from '../dist/transform.js';

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
    assert.ok(!markdown.includes('NAVTEXT'));
    assert.ok(!markdown.includes('FOOTER'));
    assert.ok(!markdown.includes('HIDDEN'));
    assert.ok(!markdown.includes('ARIAHIDDEN'));
    assert.ok(!markdown.includes('ROLETEXT'));
    assert.ok(!markdown.includes('PROMO'));
    assert.ok(!markdown.includes('FIXED'));
    assert.ok(!markdown.includes('ZISO'));
    assert.ok(!markdown.includes('HIDDENSTYLE'));
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
});

describe('htmlToMarkdown metadata footer', () => {
  it('appends metadata as a footer after content', () => {
    const html = '<p>Hello</p>';
    const markdown = htmlToMarkdown(html, {
      title: 'hello:world',
      url: 'https://example.com/path?x=1',
    });

    // Content comes first, metadata footer at the end
    assert.ok(markdown.startsWith('Hello'));
    assert.ok(markdown.includes('> *hello:world*'));
    assert.ok(markdown.includes('> *<https://example.com/path?x=1>*'));
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
