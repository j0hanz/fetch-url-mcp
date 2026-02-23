import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';
import { transformHtmlToMarkdown } from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

describe('document caching optimization', () => {
  it('correctly processes HTML with main element using cached document', async () => {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="Test description">
</head>
<body>
  <header>
    <nav>Navigation</nav>
  </header>
  <main>
    <article>
      <h1>Main Content</h1>
      <p>This is the main content that should be extracted.</p>
      <pre><code class="language-typescript">const x = 42;</code></pre>
    </article>
  </main>
  <footer>Footer content</footer>
</body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(html, 'https://example.com', {
      includeMetadata: false,
    });

    // Verify main content is present
    assert.ok(result.markdown.includes('# Main Content'));
    assert.ok(
      result.markdown.includes('main content that should be extracted')
    );
    assert.ok(result.markdown.includes('const x = 42;'));

    // Verify navigation and footer are removed (noise filtering)
    assert.ok(!result.markdown.includes('Navigation'));
    assert.ok(!result.markdown.includes('Footer content'));
  });

  it('correctly processes HTML with article element using cached document', async () => {
    const html = `
<!DOCTYPE html>
<html>
<body>
  <div class="sidebar">Sidebar content</div>
  <article id="content">
    <h2>Article Title</h2>
    <p>Article content goes here.</p>
    <ul>
      <li>Item 1</li>
      <li>Item 2</li>
    </ul>
  </article>
</body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/article',
      {
        includeMetadata: false,
      }
    );

    // Verify article content is present
    assert.ok(result.markdown.includes('## Article Title'));
    assert.ok(result.markdown.includes('Article content goes here'));
    assert.ok(result.markdown.includes('Item 1'));
    assert.ok(result.markdown.includes('Item 2'));
  });

  it('handles document caching when content root is not found', async () => {
    const html = `
<!DOCTYPE html>
<html>
<body>
  <div class="wrapper">
    <h1>Simple Page</h1>
    <p>Simple content without semantic structure.</p>
  </div>
</body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/simple',
      {
        includeMetadata: false,
      }
    );

    // Should still process and return content
    assert.ok(result.markdown.includes('# Simple Page'));
    assert.ok(result.markdown.includes('Simple content'));
  });

  it('processes large HTML documents efficiently with document caching', async () => {
    // Generate a large HTML document with repetitive structure
    const sections = Array.from(
      { length: 50 },
      (_, i) => `
      <section>
        <h2>Section ${i + 1}</h2>
        <p>Content for section ${i + 1} with some text.</p>
        <pre><code>code block ${i + 1}</code></pre>
      </section>
    `
    ).join('\n');

    const html = `
<!DOCTYPE html>
<html>
<head><title>Large Document</title></head>
<body>
  <main>
    <h1>Large Document</h1>
    ${sections}
  </main>
</body>
</html>
    `.trim();

    const startTime = performance.now();
    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/large',
      {
        includeMetadata: false,
      }
    );
    const duration = performance.now() - startTime;

    // Verify content is present
    assert.ok(result.markdown.includes('# Large Document'));
    assert.ok(result.markdown.includes('## Section 1'));
    assert.ok(result.markdown.includes('## Section 50'));

    // Performance check: should complete in reasonable time
    // (exact threshold depends on hardware, but should be < 5s for 50 sections)
    assert.ok(
      duration < 5000,
      `Transform took ${duration}ms, expected < 5000ms`
    );
  });

  it('preserves document through pipeline when content extraction is used', async () => {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Readability Test</title>
  <meta property="og:title" content="OG Title">
</head>
<body>
  <div class="ads">Advertisement</div>
  <main>
    ${'<p>This is a long article with enough content to trigger Readability extraction. '.repeat(20)}</p>
    <h2>Subheading</h2>
    <p>More content to ensure sufficient length for article extraction.</p>
  </main>
  <aside>Related articles</aside>
</body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/article',
      {
        includeMetadata: true,
      }
    );

    // Verify content is extracted
    assert.ok(result.markdown.includes('long article'));
    assert.ok(result.markdown.includes('## Subheading'));

    // Verify noise is removed
    assert.ok(!result.markdown.includes('Advertisement'));
    assert.ok(!result.markdown.includes('Related articles'));
  });

  it('handles edge case with empty document body', async () => {
    const html = `
<!DOCTYPE html>
<html>
<head><title>Empty Body</title></head>
<body></body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/empty',
      {
        includeMetadata: false,
      }
    );

    // Should not throw, return minimal output
    assert.ok(typeof result.markdown === 'string');
  });

  it('handles document with nested semantic elements', async () => {
    const html = `
<!DOCTYPE html>
<html>
<body>
  <main>
    <article>
      <header>
        <h1>Article Header</h1>
        <p class="byline">By Test Author</p>
      </header>
      <section>
        <h2>Section 1</h2>
        <p>Content for section one.</p>
      </section>
      <section>
        <h2>Section 2</h2>
        <p>Content for section two.</p>
      </section>
    </article>
  </main>
</body>
</html>
    `.trim();

    const result = await transformHtmlToMarkdown(
      html,
      'https://example.com/nested',
      {
        includeMetadata: false,
      }
    );

    // Verify hierarchical content is preserved
    assert.ok(result.markdown.includes('# Article Header'));
    assert.ok(result.markdown.includes('## Section 1'));
    assert.ok(result.markdown.includes('## Section 2'));
    assert.ok(result.markdown.includes('Content for section one'));
    assert.ok(result.markdown.includes('Content for section two'));
  });
});
