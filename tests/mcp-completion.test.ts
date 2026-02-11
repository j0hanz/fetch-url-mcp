import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCacheKey, parseCacheKey, set } from '../dist/cache.js';
import { createMcpServer } from '../dist/mcp.js';

interface CompletionRequest {
  method: 'completion/complete';
  params: {
    ref:
      | { type: 'ref/prompt'; name: string }
      | { type: 'ref/resource'; uri: string };
    argument: { name: string; value: string };
    context?: { arguments?: Record<string, string> };
  };
}

interface CompletionResponse {
  completion: {
    values: string[];
    total: number;
    hasMore: boolean;
  };
}

type CompletionHandler = (
  request: CompletionRequest,
  extra?: unknown
) => Promise<CompletionResponse>;

function getCompletionHandler(
  server: Awaited<ReturnType<typeof createMcpServer>>
): CompletionHandler {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, CompletionHandler>;
    }
  )._requestHandlers;
  const handler = handlers.get('completion/complete');
  assert.ok(handler, 'completion/complete handler should be registered');
  return handler;
}

describe('MCP completion handler', () => {
  it('returns URL completion values for summarize-page prompt', async () => {
    const cachedUrl = `https://example.com/completion-${Date.now()}`;
    const cacheKey = createCacheKey('markdown', cachedUrl);
    set(cacheKey, JSON.stringify({ markdown: '# cached' }), { url: cachedUrl });

    const server = await createMcpServer();
    try {
      const complete = getCompletionHandler(server);
      const response = await complete({
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'summarize-page' },
          argument: { name: 'url', value: 'https://' },
        },
      });

      assert.equal(Array.isArray(response.completion.values), true);
      assert.equal(response.completion.hasMore, false);
      assert.ok(response.completion.values.includes('https://'));
      assert.ok(response.completion.values.includes(cachedUrl));
    } finally {
      await server.close();
    }
  });

  it('filters cache urlHash completions by namespace context', async () => {
    const markdownUrl = `https://example.com/markdown-${Date.now()}`;
    const docsUrl = `https://example.com/docs-${Date.now()}`;

    const markdownKey = createCacheKey('markdown', markdownUrl);
    const docsKey = createCacheKey('docs', docsUrl);
    set(markdownKey, JSON.stringify({ markdown: '# markdown' }), {
      url: markdownUrl,
    });
    set(docsKey, JSON.stringify({ markdown: '# docs' }), { url: docsUrl });

    const docsHash = parseCacheKey(docsKey)?.urlHash;
    const markdownHash = parseCacheKey(markdownKey)?.urlHash;
    assert.ok(docsHash, 'docs cache hash should exist');
    assert.ok(markdownHash, 'markdown cache hash should exist');

    const server = await createMcpServer();
    try {
      const complete = getCompletionHandler(server);
      const response = await complete({
        method: 'completion/complete',
        params: {
          ref: {
            type: 'ref/resource',
            uri: 'superfetch://cache/{namespace}/{urlHash}',
          },
          argument: { name: 'urlHash', value: docsHash.slice(0, 8) },
          context: { arguments: { namespace: 'docs' } },
        },
      });

      assert.ok(response.completion.values.includes(docsHash));
      assert.equal(response.completion.values.includes(markdownHash), false);
    } finally {
      await server.close();
    }
  });
});
