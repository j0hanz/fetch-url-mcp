import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../src/lib/core.js';
import { serializeMarkdownResult } from '../src/lib/fetch-pipeline.js';
import { handleDownload } from '../src/lib/http.js';
import { handleToolError } from '../src/lib/mcp-tools.js';
import { FetchError } from '../src/lib/utils.js';

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
    end: (payload: unknown) => {
      if (typeof payload === 'string') {
        try {
          state.jsonBody = JSON.parse(payload);
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
          state.headers[key.toLowerCase()] = value;
        }
      }
      return res;
    },
  };

  return res;
}

function createResponseCapture() {
  const state = createResponseState();
  return {
    res: createResponse(state),
    getStatus: () => state.statusCode,
    getJson: () => state.jsonBody,
    getBody: () => state.body,
  };
}

describe('zod + error-handling source regressions', () => {
  it('accepts current serialized markdown cache payloads in download flow', () => {
    const cacheKey = 'markdown:abc123def456';
    const payload = serializeMarkdownResult({
      markdown: '# Title\n\nBody',
      content: '# Title\n\nBody',
      title: 'Example Article',
      metadata: {
        title: 'Example Article',
        description: 'Current cache payload shape',
      },
      truncated: true,
    });

    cache.set(cacheKey, payload, {
      url: 'https://example.com/article',
      title: 'Example Article',
    });

    const { res, getBody, getJson, getStatus } = createResponseCapture();
    handleDownload(res as never, 'markdown', 'abc123def456');

    assert.equal(getStatus(), 200);
    assert.equal(getJson(), undefined);
    assert.equal(getBody(), '# Title\n\nBody...[truncated]');
  });

  it('preserves semantic validation codes for handled tool errors', () => {
    const error = new FetchError('Blocked host', 'https://example.com', 400, {
      code: 'EBLOCKED',
    });

    const response = handleToolError(error, 'https://example.com');
    const payload = JSON.parse(
      (response.content[0] as { text: string }).text
    ) as {
      code?: string;
      statusCode?: number;
      details?: { code?: string };
    };

    assert.equal(payload.code, 'EBLOCKED');
    assert.equal(payload.statusCode, 400);
    assert.equal(payload.details, undefined);
  });
});
