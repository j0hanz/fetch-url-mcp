import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/services/cache.js';
import { registerDownloadRoutes } from '../dist/http/download-routes.js';

function getDownloadHandler() {
  let handler: (req: unknown, res: unknown, next: () => void) => void;
  const app = {
    get: (_path: string, fn: typeof handler) => {
      handler = fn;
    },
  };
  registerDownloadRoutes(app as never);
  return handler as (req: unknown, res: unknown, next: () => void) => void;
}

function createResponseCapture() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let jsonBody: unknown;
  let body: unknown;

  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      jsonBody = payload;
      return res;
    },
    send: (payload: unknown) => {
      body = payload;
      return res;
    },
  };

  return {
    res,
    headers,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getBody: () => body,
  };
}

describe('download routes', () => {
  it('returns markdown content for markdown namespace', async () => {
    const cacheKey = 'markdown:abc123def456';
    cache.set(cacheKey, JSON.stringify({ markdown: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
      title: 'Example Article',
    });

    const handler = getDownloadHandler();
    const { res, headers, getBody, getStatus } = createResponseCapture();
    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
    };

    await handler(
      { params: { namespace: 'markdown', hash: 'abc123def456' } },
      res,
      next
    );

    assert.equal(nextCalls, 0);
    assert.equal(getStatus(), 200);
    assert.equal(getBody(), '# Title\n\nBody');
    assert.equal(headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(headers['content-disposition'].includes('article.md'), true);
  });

  it('falls back to content field for markdown payloads', async () => {
    const cacheKey = 'markdown:abc123ff';
    cache.set(cacheKey, JSON.stringify({ content: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
    });

    const handler = getDownloadHandler();
    const { res, getBody } = createResponseCapture();
    const next = () => undefined;

    await handler(
      { params: { namespace: 'markdown', hash: 'abc123ff' } },
      res,
      next
    );

    assert.equal(getBody(), '# Title\n\nBody');
  });

  it('returns jsonl content for url namespace', async () => {
    const cacheKey = 'url:abc123def456';
    cache.set(
      cacheKey,
      JSON.stringify({ content: '{"type":"paragraph","text":"Hello"}\n' }),
      { url: 'https://example.com/article' }
    );

    const handler = getDownloadHandler();
    const { res, headers, getBody } = createResponseCapture();
    const next = () => undefined;

    await handler(
      { params: { namespace: 'url', hash: 'abc123def456' } },
      res,
      next
    );

    assert.equal(getBody(), '{"type":"paragraph","text":"Hello"}\n');
    assert.equal(
      headers['content-type'],
      'application/x-ndjson; charset=utf-8'
    );
    assert.equal(
      headers['content-disposition'].includes('article.jsonl'),
      true
    );
  });

  it('responds with not found for invalid cached payloads', async () => {
    const cacheKey = 'markdown:deadbeef';
    cache.set(cacheKey, 'not-json', { url: 'https://example.com/article' });

    const handler = getDownloadHandler();
    const { res, getJson, getStatus } = createResponseCapture();
    const next = () => undefined;

    await handler(
      { params: { namespace: 'markdown', hash: 'deadbeef' } },
      res,
      next
    );

    assert.equal(getStatus(), 404);
    assert.equal((getJson() as { code?: string }).code, 'NOT_FOUND');
  });
});
