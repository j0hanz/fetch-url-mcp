import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/cache.js';
import { registerDownloadRoutes } from '../dist/cache.js';

type ResponseState = {
  headers: Record<string, string>;
  statusCode: number;
  jsonBody: unknown;
  body: unknown;
};

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

function createResponseState(): ResponseState {
  return {
    headers: {},
    statusCode: 200,
    jsonBody: undefined,
    body: undefined,
  };
}

function createResponse(state: ResponseState) {
  const res = {
    setHeader: (name: string, value: string) => {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    status: (code: number) => {
      state.statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      state.jsonBody = payload;
      return res;
    },
    send: (payload: unknown) => {
      state.body = payload;
      return res;
    },
  };

  return res;
}

function createResponseCapture() {
  const state = createResponseState();
  const res = createResponse(state);
  return {
    res,
    headers: state.headers,
    getStatus: () => state.statusCode,
    getJson: () => state.jsonBody,
    getBody: () => state.body,
  };
}

function createNextTracker(): { next: () => void; getCalls: () => number } {
  let nextCalls = 0;
  return {
    next: () => {
      nextCalls += 1;
    },
    getCalls: () => nextCalls,
  };
}

function registerMarkdownNamespaceTest(): void {
  it('returns markdown content for markdown namespace', async () => {
    const cacheKey = 'markdown:abc123def456';
    cache.set(cacheKey, JSON.stringify({ markdown: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
      title: 'Example Article',
    });

    const handler = getDownloadHandler();
    const { res, headers, getBody, getStatus } = createResponseCapture();
    const nextTracker = createNextTracker();

    await handler(
      { params: { namespace: 'markdown', hash: 'abc123def456' } },
      res,
      nextTracker.next
    );

    assert.equal(nextTracker.getCalls(), 0);
    assert.equal(getStatus(), 200);
    assert.equal(getBody(), '# Title\n\nBody');
    assert.equal(headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(headers['content-disposition'].includes('article.md'), true);
  });
}

function registerMarkdownContentFallbackTest(): void {
  it('falls back to content field for markdown payloads', async () => {
    const cacheKey = 'markdown:abc123ff';
    cache.set(cacheKey, JSON.stringify({ content: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
    });

    const handler = getDownloadHandler();
    const { res, getBody } = createResponseCapture();

    await handler(
      { params: { namespace: 'markdown', hash: 'abc123ff' } },
      res,
      () => undefined
    );

    assert.equal(getBody(), '# Title\n\nBody');
  });
}

function registerInvalidPayloadTest(): void {
  it('responds with not found for invalid cached payloads', async () => {
    const cacheKey = 'markdown:deadbeef';
    cache.set(cacheKey, 'not-json', { url: 'https://example.com/article' });

    const handler = getDownloadHandler();
    const { res, getJson, getStatus } = createResponseCapture();

    await handler(
      { params: { namespace: 'markdown', hash: 'deadbeef' } },
      res,
      () => undefined
    );

    assert.equal(getStatus(), 404);
    assert.equal((getJson() as { code?: string }).code, 'NOT_FOUND');
  });
}

describe('download routes', () => {
  registerMarkdownNamespaceTest();
  registerMarkdownContentFallbackTest();
  registerInvalidPayloadTest();
});
