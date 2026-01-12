import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

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
        assert.ok(structured.markdown.includes('Hello'));
      }
    );
  });
});
