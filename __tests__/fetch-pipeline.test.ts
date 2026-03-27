import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { toCacheScopeId } from '../src/lib/cache.js';
import { config } from '../src/lib/core.js';
import { executeFetchPipeline } from '../src/lib/fetch-pipeline.js';
import { listCacheResourcesForScope } from '../src/resources/index.js';

function visibleResourcesForNamespace(namespace: string): string[] {
  return listCacheResourcesForScope(toCacheScopeId())
    .resources.map((resource) => resource.uri)
    .filter((uri) => uri.includes(`/cache/${namespace}/`));
}

async function withLocalServer<T>(
  handler: (url: string, counts: { requests: number }) => Promise<T>
): Promise<T> {
  const counts = { requests: 0 };
  const server = createServer((_, response) => {
    counts.requests += 1;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`payload-${counts.requests}`);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve test server address');
  }

  try {
    return await handler(`http://127.0.0.1:${address.port}/`, counts);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
}

describe('executeFetchPipeline cache controls', () => {
  async function runFetch(params: {
    url: string;
    namespace: string;
    useCache?: boolean;
    cacheVary?: Record<string, unknown>;
  }): Promise<
    Awaited<ReturnType<typeof executeFetchPipeline<{ body: string }>>>
  > {
    return executeFetchPipeline({
      url: params.url,
      cacheNamespace: params.namespace,
      ...(params.useCache === false ? { useCache: false } : {}),
      ...(params.cacheVary ? { cacheVary: params.cacheVary } : {}),
      transform: async ({ buffer }) => ({
        body: new TextDecoder('utf-8').decode(buffer),
      }),
      serialize: JSON.stringify,
      deserialize: (cached) => JSON.parse(cached) as { body: string },
    });
  }

  it('skips cache reads and writes when useCache is false', async () => {
    const previousAllowLocalFetch = config.security.allowLocalFetch;
    config.security.allowLocalFetch = true;

    try {
      await withLocalServer(async (url, counts) => {
        const namespace = `nocache-${randomUUID()}`;

        const first = await runFetch({ url, namespace, useCache: false });
        const second = await runFetch({ url, namespace, useCache: false });

        assert.equal(first.fromCache, false);
        assert.equal(second.fromCache, false);
        assert.equal(counts.requests, 2);
        assert.deepEqual(visibleResourcesForNamespace(namespace), []);
      });
    } finally {
      config.security.allowLocalFetch = previousAllowLocalFetch;
    }
  });

  it('uses cache entries when caching stays enabled', async () => {
    const previousAllowLocalFetch = config.security.allowLocalFetch;
    config.security.allowLocalFetch = true;

    try {
      await withLocalServer(async (url, counts) => {
        const namespace = `cache-${randomUUID()}`;

        const first = await runFetch({ url, namespace });
        const second = await runFetch({ url, namespace });

        assert.equal(first.fromCache, false);
        assert.equal(second.fromCache, true);
        assert.equal(counts.requests, 1);
        assert.equal(visibleResourcesForNamespace(namespace).length, 1);
      });
    } finally {
      config.security.allowLocalFetch = previousAllowLocalFetch;
    }
  });

  it('separates cache entries by cacheVary value', async () => {
    const previousAllowLocalFetch = config.security.allowLocalFetch;
    config.security.allowLocalFetch = true;

    try {
      await withLocalServer(async (url, counts) => {
        const namespace = `vary-${randomUUID()}`;

        const withFooter = await runFetch({
          url,
          namespace,
          cacheVary: { includeMetadataFooter: true },
        });
        const withoutFooter = await runFetch({
          url,
          namespace,
          cacheVary: { includeMetadataFooter: false },
        });
        const withFooterAgain = await runFetch({
          url,
          namespace,
          cacheVary: { includeMetadataFooter: true },
        });

        assert.equal(withFooter.fromCache, false);
        assert.equal(withoutFooter.fromCache, false);
        assert.equal(withFooterAgain.fromCache, true);
        assert.equal(counts.requests, 2);
      });
    } finally {
      config.security.allowLocalFetch = previousAllowLocalFetch;
    }
  });
});
