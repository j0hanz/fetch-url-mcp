import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as cache from '../src/lib/core.js';
import { config } from '../src/lib/core.js';
import { serializeMarkdownResult } from '../src/lib/fetch-pipeline.js';
import { handleDownload } from '../src/lib/http.js';
import { handleToolError } from '../src/lib/mcp-tools.js';
import { FetchError } from '../src/lib/utils.js';
import {
  fetchUrlOutputSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
  parseCachedPayload,
} from '../src/schemas.js';

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

  it('keeps structuredContent valid by dropping oversized metadata fields', () => {
    const oversizedImage =
      'https://example.com/' + 'a'.repeat(config.constants.maxUrlLength);
    const structured = {
      url: 'https://example.com/article',
      resolvedUrl: 'https://example.com/article',
      inputUrl: 'https://example.com/article',
      title: normalizePageTitle(' Example Title '),
      metadata: normalizeExtractedMetadata({ image: oversizedImage }),
      markdown: '# Body',
      fromCache: false,
      fetchedAt: new Date().toISOString(),
      contentSize: 6,
    };

    const validation = fetchUrlOutputSchema.safeParse(structured);

    assert.equal(validation.success, true);
    if (!validation.success) return;

    assert.equal(validation.data.title, 'Example Title');
    assert.equal(validation.data.metadata?.image, undefined);
  });

  it('drops unknown cache keys and invalid metadata instead of carrying them through', () => {
    const raw = JSON.stringify({
      markdown: '# Cached',
      title: '  Cached Title  ',
      metadata: {
        description: '  Useful description  ',
        image: 'x'.repeat(config.constants.maxUrlLength + 1),
        unused: 'noise',
      },
      unexpected: 'noise',
    });

    const parsed = parseCachedPayload(raw);

    assert.ok(parsed);
    assert.deepEqual(parsed, {
      markdown: '# Cached',
      title: 'Cached Title',
      metadata: { description: 'Useful description' },
    });
  });

  it('returns field-level download validation errors', () => {
    const { res, getJson, getStatus } = createResponseCapture();
    handleDownload(res as never, 'invalid', 'bad');

    assert.equal(getStatus(), 400);
    assert.deepEqual(getJson(), {
      error:
        'Invalid download parameters: namespace: Invalid input: expected "markdown"; hash: Too small: expected string to have >=8 characters',
      code: 'BAD_REQUEST',
    });
  });
});
