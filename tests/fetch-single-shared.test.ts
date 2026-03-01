import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { performSharedFetch } from '../dist/lib/mcp-tools.js';

type SharedFetchOptions = Parameters<typeof performSharedFetch>[0];
type SharedFetchDeps = NonNullable<Parameters<typeof performSharedFetch>[1]>;
type ExecuteFetchPipeline = NonNullable<
  SharedFetchDeps['executeFetchPipeline']
>;

let executeFetchPipelineCalls: Array<unknown> = [];

const executeFetchPipeline: ExecuteFetchPipeline = async (options) => {
  executeFetchPipelineCalls.push(options);
  return {
    data: { content: 'hello' } as never,
    fromCache: false,
    url: 'https://example.com',
    fetchedAt: new Date().toISOString(),
    cacheKey: 'markdown:abc',
  };
};

describe('performSharedFetch', () => {
  beforeEach(() => {
    executeFetchPipelineCalls = [];
  });

  it('forwards options to executeFetchPipeline', async () => {
    await performSharedFetch(
      {
        url: 'https://example.com',
        transform: () => ({
          markdown: 'hello',
          content: 'hello',
          title: undefined,
          truncated: false,
        }),
      } as SharedFetchOptions,
      { executeFetchPipeline }
    );

    const call = executeFetchPipelineCalls[0] as
      | { url?: string; cacheNamespace?: string }
      | undefined;
    assert.equal(call?.url, 'https://example.com');
    assert.equal(call?.cacheNamespace, 'markdown');
  });
});
