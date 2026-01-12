import assert from 'node:assert/strict';
import test from 'node:test';

import { FetchError } from '../dist/errors.js';
import { fetchNormalizedUrl } from '../dist/fetch.js';

function withMockedFetch(
  mock: typeof fetch,
  execute: () => Promise<void>
): Promise<void> {
  const originalFetch: typeof fetch = fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock;

  return execute().finally(() => {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  });
}

test('fetchNormalizedUrl throws rate limit error on 429', async () => {
  await withMockedFetch(
    async () => {
      return new Response('busy', {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 429);
          assert.equal(error.details.retryAfter, 30);
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl throws http error on non-OK response', async () => {
  await withMockedFetch(
    async () => {
      return new Response('error', { status: 500, statusText: 'Server Error' });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 500);
          assert.ok(error.message.includes('HTTP 500: Server Error'));
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl maps network failures to FetchError', async () => {
  await withMockedFetch(
    async () => {
      throw new TypeError('Network down');
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 502);
          assert.ok(error.message.includes('Network error'));
          return true;
        }
      );
    }
  );
});
