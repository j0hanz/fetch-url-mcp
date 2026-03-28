import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transformHtmlToMarkdownInProcess } from '../src/transform/index.js';

describe('transform metadata footer controls', () => {
  it('includes the rendered footer with extracted metadata', () => {
    const html = `
      <html>
        <head>
          <title>Example Title</title>
          <meta name="description" content="Example description" />
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <main>
            <h1>Example Title</h1>
            <p>Hello world.</p>
          </main>
        </body>
      </html>
    `;
    const url = 'https://example.com/article';

    const result = transformHtmlToMarkdownInProcess(html, url, {
      includeMetadataFooter: true,
    });

    assert.ok(result.markdown.includes('Original Source'));
    assert.ok(result.markdown.includes('Example Author'));
    assert.equal(result.metadata?.author, 'Example Author');
    assert.equal(result.metadata?.description, 'Example description');
  });

  it('includes source injection for raw markdown', () => {
    const rawMarkdown = '# Hello\n\nContent';
    const url = 'https://example.com/raw';

    const result = transformHtmlToMarkdownInProcess(rawMarkdown, url, {
      includeMetadataFooter: true,
    });

    assert.ok(result.markdown.includes('Source: https://example.com/raw'));
  });
});
