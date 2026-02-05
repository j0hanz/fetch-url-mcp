import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { NodeHtmlMarkdown } from 'node-html-markdown';

import * as cache from '../dist/cache.js';
import { config } from '../dist/config.js';
import { normalizeUrl } from '../dist/fetch.js';
import { cleanupMarkdownArtifacts } from '../dist/markdown-cleanup.js';
import { fetchUrlToolHandler } from '../dist/tools.js';
import {
  htmlToMarkdown,
  shutdownTransformWorkerPool,
} from '../dist/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

function withMockedFetch(mock, execute) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  return execute().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe('fetchUrlToolHandler', () => {
  it('inserts spaces after inline links/code without touching fenced code blocks', () => {
    const input = [
      'Chakra UI relies on [next-themes](https://example.com)to add support.',
      '',
      'In most cases, it is set up in the `Provider`component.',
      '',
      '```js',
      'const x = "[next-themes](https://example.com)to";',
      'const y = "`Provider`component";',
      '```',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(
      cleaned.includes(
        'Chakra UI relies on [next-themes](https://example.com) to add support.'
      )
    );
    assert.ok(
      cleaned.includes(
        'In most cases, it is set up in the `Provider` component.'
      )
    );
    assert.ok(
      cleaned.includes('const x = "[next-themes](https://example.com)to";')
    );
    assert.ok(cleaned.includes('const y = "`Provider`component";'));
  });

  it('returns a validation error when url is missing', async () => {
    const response = await fetchUrlToolHandler({ url: '' });

    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent, {
      error: 'URL is required',
      url: '',
    });
  });

  it('returns markdown content for successful fetches', async () => {
    const html =
      '<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>';

    await withMockedFetch(
      async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      async () => {
        const response = await fetchUrlToolHandler({
          url: 'https://example.com/test',
        });

        const structured = response.structuredContent;
        assert.ok(structured);
        assert.equal(structured.url, 'https://example.com/test');
        assert.equal(typeof structured.markdown, 'string');
        assert.ok((structured.markdown as string).includes('Hello'));
      }
    );
  });

  it('respects cancellation via the MCP request abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await withMockedFetch(
      async (_url, init) => {
        const signal = init?.signal as unknown;
        if (
          typeof signal === 'object' &&
          signal !== null &&
          'aborted' in signal &&
          (signal as { aborted?: unknown }).aborted === true
        ) {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return new Response('<html><body>ok</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      async () => {
        const url = 'https://example.com/cancelled-test';
        const response = await fetchUrlToolHandler(
          { url },
          { signal: controller.signal }
        );

        assert.equal(response.isError, true);
        const structured = response.structuredContent;
        assert.ok(structured);
        assert.equal(structured.url, url);
        assert.match(String(structured.error), /cancel|abort/i);
      }
    );
  });

  it('exposes truncated flag when inline content is trimmed', async () => {
    const originalCacheEnabled = config.cache.enabled;
    config.cache.enabled = false;

    const html = `<html><body><p>${'a'.repeat(21000)}</p></body></html>`;

    try {
      await withMockedFetch(
        async () => {
          return new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        async () => {
          const response = await fetchUrlToolHandler({
            url: 'https://example.com/large',
          });

          const structured = response.structuredContent;
          assert.ok(structured);
          assert.equal(structured.truncated, true);
        }
      );
    } finally {
      config.cache.enabled = originalCacheEnabled;
    }
  });

  it('exposes truncated flag when cached transform indicates truncation', async () => {
    const url = 'https://example.com/html-truncation';
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheKey = cache.createCacheKey('markdown', normalizedUrl);

    assert.ok(cacheKey);
    cache.set(
      cacheKey,
      JSON.stringify({ markdown: 'cached content', truncated: true }),
      { url: normalizedUrl }
    );

    const response = await fetchUrlToolHandler({ url });
    const structured = response.structuredContent;
    assert.ok(structured);
    assert.equal(structured.truncated, true);
  });

  it('returns truncated markdown even when cache + http mode are enabled', async () => {
    const originalHttpMode = config.runtime.httpMode;
    const originalCacheEnabled = config.cache.enabled;
    config.runtime.httpMode = true;
    config.cache.enabled = true;

    const html = `<html><body><p>${'a'.repeat(25000)}</p></body></html>`;

    try {
      await withMockedFetch(
        async () => {
          return new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        async () => {
          const response = await fetchUrlToolHandler({
            url: 'https://example.com/large-http',
          });

          const structured = response.structuredContent;
          assert.ok(structured);
          assert.equal(structured.truncated, true);
          assert.equal(typeof structured.markdown, 'string');
          assert.ok(String(structured.markdown).includes('[truncated]'));
        }
      );
    } finally {
      config.runtime.httpMode = originalHttpMode;
      config.cache.enabled = originalCacheEnabled;
    }
  });

  it('preserves anchor lists without a TOC heading', async () => {
    const html = `
      <html>
        <body>
          <ul>
            <li><a href="#intro">Intro</a></li>
            <li><a href="#usage">Usage</a></li>
          </ul>
        </body>
      </html>
    `;

    await withMockedFetch(
      async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      async () => {
        const response = await fetchUrlToolHandler({
          url: 'https://example.com/anchors',
        });

        const structured = response.structuredContent;
        assert.ok(structured);
        const markdown = String(structured.markdown);
        assert.ok(markdown.includes('[Intro](#intro)'));
        assert.ok(markdown.includes('[Usage](#usage)'));
      }
    );
  });

  it('preserves raw markdown content even with inline HTML', async () => {
    const rawContent =
      '# Title\n\n<details><summary>More</summary>Details</details>';

    await withMockedFetch(
      async () => {
        return new Response(rawContent, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
      async () => {
        const response = await fetchUrlToolHandler({
          url: 'https://example.com/readme.md',
        });

        const structured = response.structuredContent;
        assert.ok(structured);
        const markdown = String(structured.markdown);
        assert.ok(markdown.includes('<details>'));
        assert.ok(markdown.includes('Source: https://example.com/readme.md'));
      }
    );
  });

  it('returns an error response when markdown conversion fails', async () => {
    // Ensure clean state
    await shutdownTransformWorkerPool();

    // Disable worker pool to force in-process transform which uses the mocked NodeHtmlMarkdown
    const originalMaxWorkerScale = config.transform.maxWorkerScale;
    config.transform.maxWorkerScale = 0;

    const originalTranslate = NodeHtmlMarkdown.prototype.translate;
    NodeHtmlMarkdown.prototype.translate = () => {
      throw new Error('Translate failed');
    };

    try {
      await withMockedFetch(
        async () => {
          return new Response('<html><body><p>Fail</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        async () => {
          const response = await fetchUrlToolHandler({
            url: 'https://example.com/convert-fail',
          });

          assert.equal(response.isError, true);
          const structured = response.structuredContent;
          assert.ok(structured);
          assert.match(String(structured.error), /convert|markdown/i);
        }
      );
    } finally {
      NodeHtmlMarkdown.prototype.translate = originalTranslate;
      config.transform.maxWorkerScale = originalMaxWorkerScale;
    }
  });

  it('does not drop aggressive promo matches inside main content', () => {
    const originalAggressiveMode = config.noiseRemoval.aggressiveMode;
    const originalThreshold = config.noiseRemoval.weights.threshold;
    const originalPromoWeight = config.noiseRemoval.weights.promo;
    const originalStickyWeight = config.noiseRemoval.weights.stickyFixed;
    config.noiseRemoval.aggressiveMode = true;
    config.noiseRemoval.weights.threshold = 50;
    config.noiseRemoval.weights.promo = 35;
    config.noiseRemoval.weights.stickyFixed = 30;

    const html = `
      <html>
        <body>
          <main>
            <div class="related fixed"><p>KEEP_RELATED</p></div>
          </main>
        </body>
      </html>
    `;

    try {
      const markdown = htmlToMarkdown(html);
      assert.match(markdown, /KEEP\\?_RELATED/);
    } finally {
      config.noiseRemoval.aggressiveMode = originalAggressiveMode;
      config.noiseRemoval.weights.threshold = originalThreshold;
      config.noiseRemoval.weights.promo = originalPromoWeight;
      config.noiseRemoval.weights.stickyFixed = originalStickyWeight;
    }
  });
});
