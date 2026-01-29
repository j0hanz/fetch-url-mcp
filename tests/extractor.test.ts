import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractContent } from '../dist/transform.js';

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
});
