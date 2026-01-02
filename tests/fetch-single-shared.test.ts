import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { performSharedFetch } from '../dist/tools/handlers/fetch-single.shared.js';

let executeFetchPipelineCalls: Array<unknown> = [];

const executeFetchPipeline = async (options: unknown) => {
  executeFetchPipelineCalls.push(options);
  return {
    data: { content: 'hello' },
    fromCache: false,
    url: 'https://example.com',
    fetchedAt: new Date().toISOString(),
    cacheKey: 'url:abc',
  };
};

describe('performSharedFetch', () => {
  beforeEach(() => {
    executeFetchPipelineCalls = [];
  });

  it('forwards timeout to executeFetchPipeline', async () => {
    await performSharedFetch(
      {
        url: 'https://example.com',
        format: 'markdown',
        extractMainContent: true,
        includeMetadata: true,
        timeout: 1234,
        transform: () => ({ content: 'hello' }),
      },
      { executeFetchPipeline }
    );

    const call = executeFetchPipelineCalls[0] as
      | { timeout?: number }
      | undefined;
    assert.equal(call?.timeout, 1234);
  });
});
