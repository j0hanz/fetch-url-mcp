import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { fetchWithRedirects } from '../dist/services/fetcher/redirects.js';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchWithRedirects', () => {
  it('follows validated redirect targets', async () => {
    let callCount = 0;
    const responses: [Response, Response] = [
      new Response(null, {
        status: 302,
        headers: { location: '/next' },
      }),
      new Response('ok', { status: 200 }),
    ];
    const fetchMock = async () => responses[callCount++];

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
