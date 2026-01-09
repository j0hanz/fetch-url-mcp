import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractContent } from '../dist/services/extractor.js';

type MetadataCase = {
  name: string;
  html: string;
  expected: {
    title?: string;
    description?: string;
    author?: string;
  };
};

const METADATA_CASES: readonly MetadataCase[] = [
  {
    name: 'extracts metadata from title and meta tags',
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
  },
  {
    name: 'prefers OpenGraph metadata over Twitter and standard metadata',
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
  },
  {
    name: 'prefers Twitter metadata over standard metadata when OpenGraph is absent',
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
  },
];

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
  METADATA_CASES.forEach((testCase) => {
    it(testCase.name, () => {
      assertMetadataCase(testCase);
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

  it('returns empty result for invalid input', () => {
    const result = extractContent('', '', { extractArticle: false });
    assert.equal(result.article, null);
    assert.deepEqual(result.metadata, {});
  });
});
