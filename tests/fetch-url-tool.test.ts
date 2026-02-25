import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { NodeHtmlMarkdown } from 'node-html-markdown';

import * as cache from '../dist/lib/cache.js';
import { config } from '../dist/lib/config.js';
import { normalizeUrl } from '../dist/lib/fetch.js';
import { cleanupMarkdownArtifacts } from '../dist/lib/markdown-cleanup.js';
import { fetchUrlToolHandler } from '../dist/tools/fetch-url.js';
import {
  htmlToMarkdown,
  shutdownTransformWorkerPool,
} from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

type FetchUrlResponse = Awaited<ReturnType<typeof fetchUrlToolHandler>>;

function assertTextBlockMatchesStructured(response: FetchUrlResponse): void {
  const textBlock = response.content.find((block) => block.type === 'text');
  assert.ok(textBlock && textBlock.type === 'text');

  const parsed = JSON.parse(textBlock.text) as unknown;
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed && !Array.isArray(parsed));
  assert.deepEqual(parsed, response.structuredContent);
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
    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.deepEqual(parsed, {
      error: 'URL is required',
      code: 'VALIDATION_ERROR',
      url: '',
    });
  });

  it('returns markdown content for successful fetches', async (t) => {
    const html =
      '<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>';

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/test',
    });

    const structured = response.structuredContent;
    assert.ok(structured);
    assert.equal(structured.url, 'https://example.com/test');
    assert.equal(typeof structured.markdown, 'string');
    assert.equal(structured.fromCache, false);
    assert.equal(typeof structured.fetchedAt, 'string');
    assert.equal(typeof structured.contentSize, 'number');
    assert.equal(typeof structured.cacheResourceUri, 'string');
    assert.match(
      String(structured.cacheResourceUri),
      /^internal:\/\/cache\/markdown\/[a-f0-9.]+$/i
    );
    const resourceLink = response.content.find(
      (block) => block.type === 'resource_link'
    );
    assert.ok(resourceLink && resourceLink.type === 'resource_link');
    assert.equal(resourceLink.uri, structured.cacheResourceUri);
    assert.equal(resourceLink.mimeType, 'text/markdown');
    assert.ok((structured.markdown as string).includes('Hello'));
    assertTextBlockMatchesStructured(response);
  });

  it('returns extracted metadata fields when available', async (t) => {
    const html = `
      <html>
        <head>
          <title>Metadata Title</title>
          <meta name="description" content="Metadata description" />
          <meta name="author" content="Metadata Author" />
          <meta property="article:published_time" content="2026-01-01T00:00:00Z" />
          <meta property="article:modified_time" content="2026-01-02T00:00:00Z" />
        </head>
        <body><main><p>Hello metadata</p></main></body>
      </html>
    `;

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/metadata',
    });

    const structured = response.structuredContent;
    assert.ok(structured);
    const metadata = structured.metadata as
      | {
          title?: string;
          description?: string;
          author?: string;
          publishedAt?: string;
          modifiedAt?: string;
        }
      | undefined;
    assert.ok(metadata);
    assert.equal(metadata?.title, 'Metadata Title');
    assert.equal(metadata?.description, 'Metadata description');
    assert.equal(metadata?.author, 'Metadata Author');
    assert.equal(metadata?.publishedAt, '2026-01-01T00:00:00Z');
    assert.equal(metadata?.modifiedAt, '2026-01-02T00:00:00Z');
  });

  it('respects cancellation via the MCP request abort signal', async (t) => {
    const controller = new AbortController();
    controller.abort();

    t.mock.method(
      globalThis,
      'fetch',
      async (_url: RequestInfo | URL, init?: RequestInit) => {
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
      }
    );

    const url = 'https://example.com/cancelled-test';
    const response = await fetchUrlToolHandler(
      { url },
      { signal: controller.signal }
    );

    assert.equal(response.isError, true);
    const structured = JSON.parse(
      (response.content[0] as { text: string })?.text
    );
    assert.ok(structured);
    assert.equal(structured.url, url);
    assert.match(String(structured.error), /cancel|abort/i);
  });

  it('exposes truncated flag when inline content is trimmed', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.cache.enabled = false;
    config.constants.maxInlineContentChars = 20000;

    const html = `<html><body><p>${'a'.repeat(21000)}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/large',
      });

      const structured = response.structuredContent;
      assert.ok(structured);
      assert.equal(structured.truncated, true);
      assert.equal(structured.cacheResourceUri, undefined);
    } finally {
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
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
    assert.equal(structured.fromCache, true);
    assert.equal(structured.truncated, true);
    assert.equal(typeof structured.fetchedAt, 'string');
    assert.equal(typeof structured.cacheResourceUri, 'string');
    assert.match(
      String(structured.cacheResourceUri),
      /^internal:\/\/cache\/markdown\/[a-f0-9.]+$/i
    );
  });

  it('adds truncation marker when HTML size truncation occurs', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    const originalMaxHtmlSize = config.constants.maxHtmlSize;
    const originalMaxWorkerScale = config.transform.maxWorkerScale;
    config.cache.enabled = false;
    config.constants.maxInlineContentChars = 10000;
    config.constants.maxHtmlSize = 200;
    config.transform.maxWorkerScale = 0;

    await shutdownTransformWorkerPool();

    const html = `<html><body><p>${'a'.repeat(2000)}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/html-size-truncate',
      });

      const structured = response.structuredContent;
      assert.ok(structured);
      assert.equal(structured.truncated, true);
      assert.ok(String(structured.markdown).includes('[truncated]'));
    } finally {
      await shutdownTransformWorkerPool();
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
      config.constants.maxHtmlSize = originalMaxHtmlSize;
      config.transform.maxWorkerScale = originalMaxWorkerScale;
    }
  });

  it('includes truncation marker when fetch stage truncates', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    const originalMaxHtmlSize = config.constants.maxHtmlSize;
    const originalFetchMax = config.fetcher.maxContentLength;
    config.cache.enabled = false;
    config.constants.maxInlineContentChars = 10000;
    config.constants.maxHtmlSize = 1000;
    config.fetcher.maxContentLength = 200;

    const html = `<html><body><p>${'a'.repeat(2000)}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/fetch-size-truncate',
      });

      const structured = response.structuredContent;
      assert.ok(structured);
      assert.equal(structured.truncated, true);
      assert.ok(String(structured.markdown).includes('[truncated]'));
    } finally {
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
      config.constants.maxHtmlSize = originalMaxHtmlSize;
      config.fetcher.maxContentLength = originalFetchMax;
    }
  });

  it('persists truncation marker in cached markdown payloads', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    const originalMaxHtmlSize = config.constants.maxHtmlSize;
    const originalFetchMax = config.fetcher.maxContentLength;
    config.cache.enabled = true;
    config.constants.maxInlineContentChars = 10000;
    config.constants.maxHtmlSize = 1000;
    config.fetcher.maxContentLength = 200;

    const url = 'https://example.com/fetch-size-truncate-cache';
    const html = `<html><body><p>${'a'.repeat(2000)}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      await fetchUrlToolHandler({ url });

      const normalizedUrl = normalizeUrl(url).normalizedUrl;
      const cacheKey = cache.createCacheKey('markdown', normalizedUrl);
      assert.ok(cacheKey);

      const cachedEntry = cache.get(cacheKey);
      assert.ok(cachedEntry);

      const payload = JSON.parse(cachedEntry.content) as {
        markdown?: unknown;
        truncated?: unknown;
      };

      assert.equal(payload.truncated, true);
      assert.equal(typeof payload.markdown, 'string');
      assert.ok(String(payload.markdown).includes('...[truncated]'));
    } finally {
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
      config.constants.maxHtmlSize = originalMaxHtmlSize;
      config.fetcher.maxContentLength = originalFetchMax;
    }
  });

  it('returns truncated markdown even when cache + http mode are enabled', async (t) => {
    const originalHttpMode = config.runtime.httpMode;
    const originalCacheEnabled = config.cache.enabled;
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.runtime.httpMode = true;
    config.cache.enabled = true;
    config.constants.maxInlineContentChars = 20000;

    const html = `<html><body><p>${'a'.repeat(25000)}</p></body></html>`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/large-http',
      });

      const structured = response.structuredContent;
      assert.ok(structured);
      assert.equal(structured.truncated, true);
      assert.equal(typeof structured.markdown, 'string');
      assert.ok(String(structured.markdown).includes('[truncated]'));
      assertTextBlockMatchesStructured(response);
      const embeddedResource = response.content.find(
        (block) => block.type === 'resource'
      );
      assert.ok(
        embeddedResource,
        'Embedded resource should be emitted for markdown preview'
      );
    } finally {
      config.runtime.httpMode = originalHttpMode;
      config.cache.enabled = originalCacheEnabled;
      config.constants.maxInlineContentChars = originalInlineLimit;
    }
  });

  it('preserves anchor lists without a TOC heading', async (t) => {
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

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/anchors',
    });

    const structured = response.structuredContent;
    assert.ok(structured);
    const markdown = String(structured.markdown);
    assert.ok(markdown.includes('[Intro](#intro)'));
    assert.ok(markdown.includes('[Usage](#usage)'));
  });

  it('preserves raw markdown content even with inline HTML', async (t) => {
    const rawContent =
      '# Title\n\n<details><summary>More</summary>Details</details>';

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(rawContent, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/readme.md',
    });

    const structured = response.structuredContent;
    assert.ok(structured);
    const markdown = String(structured.markdown);
    assert.ok(markdown.includes('<details>'));
    assert.ok(markdown.includes('Source: https://example.com/readme.md'));
    assertTextBlockMatchesStructured(response);
  });

  it('falls back to UTF-8 for invalid charset labels in worker transforms', async (t) => {
    const html = '<html><body><p>café</p></body></html>';
    const utf8 = Buffer.from(html, 'utf-8');

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(utf8, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=invalid-charset',
        },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/invalid-charset',
    });

    assert.equal(response.isError, undefined);
    const structured = response.structuredContent;
    assert.ok(structured);
    assert.equal(typeof structured.markdown, 'string');
    assert.match(String(structured.markdown), /café/);
    assertTextBlockMatchesStructured(response);
  });

  it('returns an error response when markdown conversion fails', async (t) => {
    // Ensure clean state
    await shutdownTransformWorkerPool();

    // Disable worker pool to force in-process transform which uses the mocked NodeHtmlMarkdown
    const originalMaxWorkerScale = config.transform.maxWorkerScale;
    config.transform.maxWorkerScale = 0;

    try {
      t.mock.method(NodeHtmlMarkdown.prototype, 'translate', () => {
        throw new Error('Translate failed');
      });

      t.mock.method(globalThis, 'fetch', async () => {
        return new Response('<html><body><p>Fail</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/convert-fail',
      });

      assert.equal(response.isError, true);
      const structured = JSON.parse(
        (response.content[0] as { text: string })?.text
      );
      assert.ok(structured);
      assert.match(String(structured.error), /convert|markdown/i);
    } finally {
      config.transform.maxWorkerScale = originalMaxWorkerScale;
    }
  });

  it('returns an error response when markdown conversion fails in worker pool', async (t) => {
    const originalMaxWorkerScale = config.transform.maxWorkerScale;
    const originalCacheEnabled = config.cache.enabled;
    config.transform.maxWorkerScale = 1;
    config.cache.enabled = false;

    await shutdownTransformWorkerPool();

    const binary = new Uint8Array([0x3c, 0x00, 0x3e, 0x00, 0x2f, 0x00]);

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(binary, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/worker-convert-fail',
      });

      assert.equal(response.isError, true);
      const structured = JSON.parse(
        (response.content[0] as { text: string })?.text
      );
      assert.ok(structured);
      assert.equal(structured.statusCode, 500);
      assert.match(String(structured.error), /binary/i);
    } finally {
      await shutdownTransformWorkerPool();
      config.transform.maxWorkerScale = originalMaxWorkerScale;
      config.cache.enabled = originalCacheEnabled;
    }
  });

  it('includes status code and details for fetch errors', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('busy', {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/rate-limited',
    });

    assert.equal(response.isError, true);
    const structured = JSON.parse(
      (response.content[0] as { text: string })?.text
    );
    assert.ok(structured);
    assert.equal(structured.statusCode, 429);
    const details = structured.details as { retryAfter?: number } | undefined;
    assert.equal(details?.retryAfter, 30);
  });

  it('closes tilde code fences when truncating inline content', async (t) => {
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.constants.maxInlineContentChars = 20000;
    const longBody = 'a'.repeat(config.constants.maxInlineContentChars + 500);
    const rawContent = `# Title\n\n~~~\n${longBody}\n~~~\n`;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(rawContent, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      });

      const response = await fetchUrlToolHandler({
        url: 'https://example.com/tilde-fence',
      });

      const structured = response.structuredContent;
      assert.ok(structured);
      assert.equal(structured.truncated, true);
      const markdown = String(structured.markdown);
      assert.match(markdown, /~~~\n\.\.\.\[truncated\]/);
      assert.equal(markdown.includes('```\n...[truncated]'), false);
    } finally {
      config.constants.maxInlineContentChars = originalInlineLimit;
    }
  });

  it('converts html fragments even when markdown-like markers appear', async (t) => {
    const html = `<div>\n# Title\n</div>\n<p>Body</p>`;

    t.mock.method(globalThis, 'fetch', async () => {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const response = await fetchUrlToolHandler({
      url: 'https://example.com/html-fragment',
    });

    const structured = response.structuredContent;
    assert.ok(structured);
    const markdown = String(structured.markdown);
    assert.equal(markdown.includes('<div>'), false);
    assert.equal(markdown.includes('<p>'), false);
  });

  it('does not drop aggressive promo matches inside main content', () => {
    const originalAggressiveMode = config.noiseRemoval.aggressiveMode;
    config.noiseRemoval.aggressiveMode = true;

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
    }
  });
});

describe('htmlToMarkdown resolves parenthesized URLs correctly', () => {
  it('preserves balanced parentheses in resolved relative URLs', () => {
    const html = '<a href="/wiki/Foo_(bar)">Foo (bar)</a>';
    const result = htmlToMarkdown(html, undefined, {
      url: 'https://en.wikipedia.org/wiki/Main_Page',
    });
    assert.match(
      result,
      /\[Foo \(bar\)\]\(https:\/\/en\.wikipedia\.org\/wiki\/Foo(?:_|%5F)(%28|\()bar(%29|\))\)/,
      'Link with parenthesized URL should resolve correctly'
    );
  });

  it('handles simple relative URLs without parentheses', () => {
    const html = '<a href="/about">About</a>';
    const result = htmlToMarkdown(html, undefined, {
      url: 'https://example.com/page',
    });
    assert.match(result, /\[About\]\(https:\/\/example\.com\/about\)/);
  });
});
