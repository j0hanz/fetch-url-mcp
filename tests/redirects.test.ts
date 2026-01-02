import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { fetchWithRedirects } from '../dist/services/fetcher/redirects.js';

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

describe('fetchWithRedirects', () => {
  it('follows validated redirect targets', async () => {
    let callCount = 0;
    const fetchMock = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: '/next' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchWithRedirects('https://example.com/start', {}, 5);

    assert.equal(result.url, 'https://example.com/next');
    assert.equal(callCount, 2);
  });

  it('fails when redirect target validation rejects', async () => {
    const fetchMock = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://blocked.local' },
      });

    globalThis.fetch = fetchMock as typeof fetch;

    await assert.rejects(
      fetchWithRedirects('https://example.com/start', {}, 5)
    );
  });
});
