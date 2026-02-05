import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { config } from '../dist/config.js';
import { fetchUrlToolHandler } from '../dist/tools.js';
import { shutdownTransformWorkerPool } from '../dist/transform.js';

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
});
