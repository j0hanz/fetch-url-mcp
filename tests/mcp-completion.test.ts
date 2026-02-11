import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/cache.js';
import { createMcpServer } from '../dist/server.js';

interface CompletionRequest {
  method: 'completion/complete';
  params: {
    ref:
      | { type: 'ref/prompt'; name: string }
      | { type: 'ref/resource'; uri: string };
    argument: { name: string; value: string };
    context?: {
      arguments?: Record<string, string>;
    };
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
  it('completes cache resource template variables', async () => {
    cache.set(
      'markdown:abc123def456',
      JSON.stringify({ markdown: '# cached' }),
      { url: 'https://example.com/cached' }
    );

    const server = await createMcpServer();
    try {
      const complete = getCompletionHandler(server);
      const namespaceCompletion = await complete({
        method: 'completion/complete',
        params: {
          ref: {
            type: 'ref/resource',
            uri: 'internal://cache/{namespace}/{hash}',
          },
          argument: { name: 'namespace', value: 'mark' },
        },
      });

      assert.equal(Array.isArray(namespaceCompletion.completion.values), true);
      assert.equal(
        namespaceCompletion.completion.values.includes('markdown'),
        true
      );
      assert.equal(namespaceCompletion.completion.hasMore, false);

      const hashCompletion = await complete({
        method: 'completion/complete',
        params: {
          ref: {
            type: 'ref/resource',
            uri: 'internal://cache/{namespace}/{hash}',
          },
          argument: { name: 'hash', value: 'abc' },
          context: {
            arguments: {
              namespace: 'markdown',
            },
          },
        },
      });

      assert.equal(
        hashCompletion.completion.values.includes('abc123def456'),
        true
      );
      assert.equal(hashCompletion.completion.hasMore, false);
    } finally {
      await server.close();
    }
  });
});
