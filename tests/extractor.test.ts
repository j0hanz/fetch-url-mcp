import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractContent } from '../dist/services/extractor.js';

describe('extractContent', () => {
  it('extracts metadata from title and meta tags', () => {
    const html = `
      <html>
        <head>
          <title>Example Title</title>
          <meta name="description" content="Example description" />
          <meta name="author" content="Example Author" />
        </head>
        <body><p>Content</p></body>
      </html>
    `;

    const result = extractContent(html, 'https://example.com', {
      extractArticle: false,
    });

    assert.equal(result.metadata.title, 'Example Title');
    assert.equal(result.metadata.description, 'Example description');
    assert.equal(result.metadata.author, 'Example Author');
    assert.equal(result.article, null);
  });

  it('returns empty result for invalid input', () => {
    const result = extractContent('', '', { extractArticle: false });
    assert.equal(result.article, null);
    assert.deepEqual(result.metadata, {});
  });
});
