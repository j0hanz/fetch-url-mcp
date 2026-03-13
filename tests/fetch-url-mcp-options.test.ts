import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import * as cache from '../dist/lib/core.js';
import { config } from '../dist/lib/core.js';
import { normalizeUrl } from '../dist/lib/http.js';
import { fetchUrlInputSchema } from '../dist/schemas.js';
import { createMcpServer } from '../dist/server.js';
import { fetchUrlToolHandler } from '../dist/tools/fetch-url.js';
import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';

type RequestHandler = (request: unknown, extra?: unknown) => Promise<unknown>;

type HandlerMap = Map<string, RequestHandler>;

function getPrivateRequestHandlers(target: object): Map<string, unknown> {
  const handlers = Reflect.get(target, '_requestHandlers');
  assert.ok(
    handlers instanceof Map,
    'MCP protocol should expose _requestHandlers'
  );
  return handlers;
}

function getRequestHandler(
  server: Awaited<ReturnType<typeof createMcpServer>>,
  method: string
): RequestHandler {
  const handlers = getPrivateRequestHandlers(server.server) as HandlerMap;
  const handler = handlers.get(method);
  assert.ok(handler, `${method} handler should be registered`);
  return handler;
}

after(async () => {
  await shutdownTransformWorkerPool();
});

describe('fetch-url MCP validation and options', () => {
  it('rejects invalid URL arguments through tools/call with InvalidParams', async () => {
    const server = await createMcpServer();

    try {
      const callTool = getRequestHandler(server, 'tools/call');

      await assert.rejects(
        async () =>
          callTool({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'fetch-url',
              arguments: { url: 'not-a-url' },
            },
          }),
        (error: unknown) =>
          error instanceof Error &&
          /Invalid arguments for fetch-url/i.test(error.message) &&
          (error as Error & { code?: number }).code === -32602
      );
    } finally {
      await server.close();
    }
  });

  it('exposes original and transformed raw GitHub URLs in tool output', async (t) => {
    const sourceUrl =
      'https://github.com/octocat/Hello-World/blob/main/README.md';
    const rawUrl =
      'https://raw.githubusercontent.com/octocat/Hello-World/main/README.md';

    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert.equal(String(input), rawUrl);
      return new Response('# Hello from raw markdown\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    });

    const response = await fetchUrlToolHandler({ url: sourceUrl });
    const structured = response.structuredContent;

    assert.ok(structured);
    assert.equal(structured.url, sourceUrl);
    assert.equal(structured.inputUrl, sourceUrl);
    assert.equal(structured.resolvedUrl, rawUrl);
    assert.match(String(structured.markdown), /Hello from raw markdown/);
  });

  it('bypasses cached markdown when forceRefresh is true', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    config.cache.enabled = true;

    const url = 'https://example.com/force-refresh';
    let fetchCount = 0;

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        fetchCount += 1;
        const body =
          fetchCount === 1
            ? '<html><body><p>Cached version</p></body></html>'
            : '<html><body><p>Fresh version</p></body></html>';

        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const first = await fetchUrlToolHandler({ url });
      const second = await fetchUrlToolHandler({ url });
      const refreshed = await fetchUrlToolHandler({ url, forceRefresh: true });

      assert.equal(fetchCount, 2);
      assert.equal(first.structuredContent?.fromCache, false);
      assert.equal(second.structuredContent?.fromCache, true);
      assert.equal(refreshed.structuredContent?.fromCache, false);
      assert.match(
        String(second.structuredContent?.markdown),
        /Cached version/
      );
      assert.match(
        String(refreshed.structuredContent?.markdown),
        /Fresh version/
      );
    } finally {
      config.cache.enabled = originalCacheEnabled;
    }
  });

  it('keeps the cache key stable for identical default requests', async (t) => {
    const originalCacheEnabled = config.cache.enabled;
    config.cache.enabled = true;

    const url = 'https://example.com/default-cache-key';
    const normalizedUrl = normalizeUrl(url).normalizedUrl;
    const cacheKey = cache.createCacheKey('markdown', normalizedUrl);

    assert.ok(cacheKey);

    try {
      t.mock.method(globalThis, 'fetch', async () => {
        return new Response('<html><body><p>Default cache</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      await fetchUrlToolHandler({ url });
      const cachedEntry = cache.get(cacheKey);

      assert.ok(cachedEntry);
      assert.equal(cachedEntry?.url, normalizedUrl);
    } finally {
      config.cache.enabled = originalCacheEnabled;
    }
  });
});

describe('fetchUrlInputSchema strictness', () => {
  it('rejects removed skipNoiseRemoval parameter', () => {
    const result = fetchUrlInputSchema.safeParse({
      url: 'https://example.com',
      skipNoiseRemoval: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects removed maxInlineChars parameter', () => {
    const result = fetchUrlInputSchema.safeParse({
      url: 'https://example.com',
      maxInlineChars: 100,
    });
    assert.equal(result.success, false);
  });
});
