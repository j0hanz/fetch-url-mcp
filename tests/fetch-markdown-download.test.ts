import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as cache from '../dist/services/cache.js';
import { enableHttpMode } from '../dist/config/index.js';
import { createFetchMarkdownToolHandler } from '../dist/tools/handlers/fetch-markdown.tool.js';

enableHttpMode();

const longContent = `# Title\n\n${'a'.repeat(21000)}`;

let performSharedFetchResult:
  | {
      pipeline: {
        data: {
          content: string;
          markdown: string;
          title: string;
          truncated: boolean;
        };
        fromCache: boolean;
        url: string;
        fetchedAt: string;
        cacheKey: string | null;
      };
      inlineResult: {
        content?: string;
        contentSize: number;
        resourceUri?: string;
        resourceMimeType?: string;
      };
    }
  | undefined;

const performSharedFetch = async () => {
  if (!performSharedFetchResult) {
    throw new Error('performSharedFetchResult not set');
  }
  return performSharedFetchResult;
};

const fetchMarkdownToolHandler = createFetchMarkdownToolHandler({
  performSharedFetch,
});

describe('fetch-markdown download info', () => {
  beforeEach(() => {
    const cacheKey = 'markdown:abc123def456.7890abcd';
    cache.set(cacheKey, 'cached', {
      url: 'https://example.com/article',
      title: 'Test Title',
    });

    performSharedFetchResult = {
      pipeline: {
        data: {
          content: longContent,
          markdown: longContent,
          title: 'Test Title',
          truncated: false,
        },
        fromCache: false,
        url: 'https://example.com/article',
        fetchedAt: new Date().toISOString(),
        cacheKey,
      },
      inlineResult: {
        contentSize: longContent.length,
        resourceUri: `superfetch://cache/${cacheKey.replace(':', '/')}`,
        resourceMimeType: 'text/markdown',
      },
    };
  });

  it('includes file download info when content exceeds inline limit', async () => {
    const result = await fetchMarkdownToolHandler({
      url: 'https://example.com/article',
    });

    const file = result.structuredContent?.file as
      | {
          downloadUrl: string;
          fileName: string;
          expiresAt: string;
        }
      | undefined;

    assert.ok(file);
    assert.equal(file.downloadUrl.startsWith('/mcp/downloads/markdown/'), true);
    assert.equal(file.fileName.endsWith('.md'), true);
    assert.equal(Number.isNaN(Date.parse(file.expiresAt)), false);
  });

  it('omits file info when cache key is null', async () => {
    performSharedFetchResult = {
      pipeline: {
        data: {
          content: '# Title',
          markdown: '# Title',
          title: 'Title',
          truncated: false,
        },
        fromCache: false,
        url: 'https://example.com',
        fetchedAt: new Date().toISOString(),
        cacheKey: null,
      },
      inlineResult: {
        contentSize: longContent.length,
        resourceUri: 'superfetch://cache/markdown/abc123def456.7890abcd',
        resourceMimeType: 'text/markdown',
      },
    };

    const result = await fetchMarkdownToolHandler({
      url: 'https://example.com',
    });

    assert.equal(result.structuredContent?.file, undefined);
  });

  it('omits file info when content is inlined', async () => {
    performSharedFetchResult = {
      pipeline: {
        data: {
          content: 'short',
          markdown: 'short',
          title: 'Short Title',
          truncated: false,
        },
        fromCache: false,
        url: 'https://example.com/short',
        fetchedAt: new Date().toISOString(),
        cacheKey: 'markdown:abc123def456.7890abcd',
      },
      inlineResult: {
        content: 'short',
        contentSize: 5,
      },
    };

    const result = await fetchMarkdownToolHandler({
      url: 'https://example.com/short',
    });

    assert.equal(result.structuredContent?.file, undefined);
  });

  it('generates correct filename from URL path', async () => {
    const cacheKey = 'markdown:route123';
    cache.set(cacheKey, 'cached', {
      url: 'https://example.com/blog/my-great-article',
      title: 'Test Title',
    });

    performSharedFetchResult = {
      pipeline: {
        data: {
          content: longContent,
          markdown: longContent,
          title: 'Test Title',
          truncated: false,
        },
        fromCache: false,
        url: 'https://example.com/blog/my-great-article',
        fetchedAt: new Date().toISOString(),
        cacheKey,
      },
      inlineResult: {
        contentSize: longContent.length,
        resourceUri: `superfetch://cache/${cacheKey.replace(':', '/')}`,
        resourceMimeType: 'text/markdown',
      },
    };

    const result = await fetchMarkdownToolHandler({
      url: 'https://example.com/blog/my-great-article',
    });

    const file = result.structuredContent?.file as
      | {
          fileName: string;
        }
      | undefined;

    assert.equal(file?.fileName.endsWith('my-great-article.md'), true);
  });
});
