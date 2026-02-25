import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../dist/lib/cache.js';
import { handleDownload } from '../dist/lib/download.js';

type ResponseState = {
  headers: Record<string, string>;
  statusCode: number;
  jsonBody: unknown;
  body: unknown;
};

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
    end: (payload: unknown) => {
      if (typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object') {
            state.jsonBody = parsed;
          } else {
            state.body = payload;
          }
        } catch {
          state.body = payload;
        }
      } else {
        state.body = payload;
      }
      return res;
    },
    writeHead: (code: number, headers?: Record<string, string>) => {
      state.statusCode = code;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          state.headers[key.toLowerCase()] = value as string;
        }
      }
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

function registerMarkdownNamespaceTest(): void {
  it('returns markdown content for markdown namespace', async () => {
    const cacheKey = 'markdown:abc123def456';
    cache.set(cacheKey, JSON.stringify({ markdown: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
      title: 'Example Article',
    });

    const { res, headers, getBody, getStatus } = createResponseCapture();

    (
      handleDownload as (
        response: unknown,
        namespace: string,
        hash: string
      ) => void
    )(res, 'markdown', 'abc123def456');

    assert.equal(getStatus(), 200);
    assert.equal(getBody(), '# Title\n\nBody');
    assert.equal(headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(headers['content-disposition']?.includes('article.md'), true);
  });
}

function registerMarkdownContentFallbackTest(): void {
  it('falls back to content field for markdown payloads', async () => {
    const cacheKey = 'markdown:abc123ff';
    cache.set(cacheKey, JSON.stringify({ content: '# Title\n\nBody' }), {
      url: 'https://example.com/article',
    });

    const { res, getBody } = createResponseCapture();

    (
      handleDownload as (
        response: unknown,
        namespace: string,
        hash: string
      ) => void
    )(res, 'markdown', 'abc123ff');

    assert.equal(getBody(), '# Title\n\nBody');
  });
}

function registerInvalidPayloadTest(): void {
  it('responds with not found for invalid cached payloads', async () => {
    const cacheKey = 'markdown:deadbeef';
    cache.set(cacheKey, 'not-json', { url: 'https://example.com/article' });

    const { res, getJson, getStatus } = createResponseCapture();

    (
      handleDownload as (
        response: unknown,
        namespace: string,
        hash: string
      ) => void
    )(res, 'markdown', 'deadbeef');

    assert.equal(getStatus(), 404);
    assert.equal((getJson() as { code?: string }).code, 'NOT_FOUND');
  });
}

describe('download routes', () => {
  registerMarkdownNamespaceTest();
  registerMarkdownContentFallbackTest();
  registerInvalidPayloadTest();
});
