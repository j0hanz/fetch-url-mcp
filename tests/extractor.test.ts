import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractContent } from '../dist/transform/transform.js';

type MetadataCase = {
  html: string;
  expected: {
    title?: string;
    description?: string;
    author?: string;
  };
};

function assertMetadataCase(testCase: MetadataCase): void {
  const result = extractContent(testCase.html, 'https://example.com', {
    extractArticle: false,
  });

  assert.equal(result.metadata.title, testCase.expected.title);
  assert.equal(result.metadata.description, testCase.expected.description);
  assert.equal(result.metadata.author, testCase.expected.author);
  assert.equal(result.article, null);
}

describe('extractContent', () => {
  it('extracts metadata from title and meta tags', () => {
    assertMetadataCase({
      html: `
      <html>
        <head>
          <title>Example Title</title>
          <meta name="description" content="Example description" />
          <meta name="author" content="Example Author" />
        </head>
        <body><p>Content</p></body>
      </html>
    `,
      expected: {
        title: 'Example Title',
        description: 'Example description',
        author: 'Example Author',
      },
    });
  });

  it('prefers OpenGraph metadata over Twitter and standard metadata', () => {
    assertMetadataCase({
      html: `
      <html>
        <head>
          <title>Standard Title</title>
          <meta name="description" content="Standard description" />
          <meta name="twitter:title" content="Twitter Title" />
          <meta name="twitter:description" content="Twitter description" />
          <meta property="og:title" content="  OG Title  " />
          <meta property="og:description" content="OG description" />
        </head>
        <body><p>Content</p></body>
      </html>
    `,
      expected: {
        title: 'OG Title',
        description: 'OG description',
      },
    });
  });

  it('prefers Twitter metadata over standard metadata when OpenGraph is absent', () => {
    assertMetadataCase({
      html: `
      <html>
        <head>
          <title>Standard Title</title>
          <meta name="description" content="Standard description" />
          <meta name="twitter:title" content="Twitter Title" />
          <meta name="twitter:description" content="Twitter description" />
        </head>
        <body><p>Content</p></body>
      </html>
    `,
      expected: {
        title: 'Twitter Title',
        description: 'Twitter description',
      },
    });
  });

  it('extracts article content when enabled', () => {
    const html = `
      <html>
        <head>
          <title>Example Title</title>
        </head>
        <body>
          <article>
            <h1>Example Title</h1>
            <p>Hello world</p>
          </article>
        </body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com', {
      extractArticle: true,
    });

    assert.ok(result.article);
    assert.ok(result.article.content.length > 0);
    assert.ok(result.article.textContent.includes('Hello world'));
  });

  it('extracts nested article text from DOM structure', () => {
    const html = `
      <html>
        <head>
          <title>Nested Article</title>
        </head>
        <body>
          <main>
            <article>
              <section>
                <p>Nested content</p>
              </section>
            </article>
          </main>
        </body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com/nested', {
      extractArticle: true,
    });

    assert.ok(result.article);
    assert.ok(result.article.textContent.includes('Nested content'));
  });

  it('returns empty result for invalid input', () => {
    const result = extractContent('', '', { extractArticle: false });
    assert.equal(result.article, null);
    assert.deepEqual(result.metadata, {});
  });

  it('extracts 32x32 favicon when declared', () => {
    const html = `
      <html>
        <head>
          <title>Favicon Test</title>
          <link rel="icon" sizes="16x16" href="/icon-16.png" />
          <link rel="icon" sizes="32x32" href="/icon-32.png" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        </head>
        <body><p>Content</p></body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com', {
      extractArticle: false,
    });

    assert.equal(result.metadata.favicon, 'https://example.com/icon-32.png');
  });

  it('resolves relative favicon URL against baseUrl', () => {
    const html = `
      <html>
        <head>
          <title>Favicon Test</title>
          <link rel="icon" sizes="32x32" href="assets/icon.png" />
        </head>
        <body><p>Content</p></body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com/page/', {
      extractArticle: false,
    });

    assert.equal(
      result.metadata.favicon,
      'https://example.com/page/assets/icon.png'
    );
  });

  it('returns undefined favicon when no 32x32 icon is present', () => {
    const html = `
      <html>
        <head>
          <title>No Favicon</title>
          <link rel="icon" href="/icon.png" />
          <link rel="apple-touch-icon" href="/apple.png" />
        </head>
        <body><p>Content</p></body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com', {
      extractArticle: false,
    });

    assert.equal(result.metadata.favicon, undefined);
  });

  it('handles missing favicon gracefully without baseUrl', () => {
    const html = `
      <html>
        <head>
          <title>No URL</title>
          <link rel="icon" href="/icon.png" />
        </head>
        <body><p>Content</p></body>
      </html>
    `;

    const result = extractContent(html, '', { extractArticle: false });

    // When no baseUrl is provided, favicon extraction should not crash
    // The metadata may or may not include favicon depending on implementation
    assert.doesNotThrow(() => result.metadata.favicon);
  });
});
