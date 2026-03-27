import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transformHtmlToMarkdownInProcess } from '../src/transform/transform.js';

describe('transform metadata footer controls', () => {
  it('hides the rendered footer while preserving extracted metadata', () => {
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

    const withFooter = transformHtmlToMarkdownInProcess(html, url, {
      includeMetadataFooter: true,
    });
    const withoutFooter = transformHtmlToMarkdownInProcess(html, url, {
      includeMetadataFooter: false,
    });

    assert.ok(withFooter.markdown.includes('Original Source'));
    assert.ok(withFooter.markdown.includes('Example Author'));
    assert.ok(!withoutFooter.markdown.includes('Original Source'));
    assert.ok(!withoutFooter.markdown.includes('Example Author'));
    assert.equal(withoutFooter.metadata?.author, 'Example Author');
    assert.equal(withoutFooter.metadata?.description, 'Example description');
  });

  it('suppresses source injection for raw markdown when footer is disabled', () => {
    const rawMarkdown = '# Hello\n\nContent';
    const url = 'https://example.com/raw';

    const withFooter = transformHtmlToMarkdownInProcess(rawMarkdown, url, {
      includeMetadataFooter: true,
    });
    const withoutFooter = transformHtmlToMarkdownInProcess(rawMarkdown, url, {
      includeMetadataFooter: false,
    });

    assert.ok(withFooter.markdown.includes('Source: https://example.com/raw'));
    assert.ok(
      !withoutFooter.markdown.includes('Source: https://example.com/raw')
    );
  });
});
