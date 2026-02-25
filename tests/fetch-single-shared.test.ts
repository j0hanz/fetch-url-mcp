import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { performSharedFetch } from '../dist/lib/tool-pipeline.js';

let executeFetchPipelineCalls: Array<unknown> = [];

const executeFetchPipeline = async (options: unknown) => {
  executeFetchPipelineCalls.push(options);
  return {
    data: { content: 'hello' },
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
        includeMetadata: true,
        transform: () => ({ content: 'hello' }),
      } as any,
      { executeFetchPipeline: executeFetchPipeline as any }
    );

    const call = executeFetchPipelineCalls[0] as
      | { url?: string; cacheNamespace?: string }
      | undefined;
    assert.equal(call?.url, 'https://example.com');
    assert.equal(call?.cacheNamespace, 'markdown');
  });
});
