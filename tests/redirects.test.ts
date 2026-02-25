import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FetchError } from '../dist/lib/errors.js';
import { fetchWithRedirects } from '../dist/lib/fetch.js';

describe('fetchWithRedirects', () => {
  it('follows validated redirect targets', async (t) => {
    let callCount = 0;
    const responses: [Response, Response] = [
      new Response(null, {
        status: 302,
        headers: { location: '/next' },
      }),
      new Response('ok', { status: 200 }),
    ];
    const fetchMock = async (_url: RequestInfo | URL, _init?: RequestInit) =>
      responses[callCount++];

    t.mock.method(globalThis, 'fetch', fetchMock);

    const result = await fetchWithRedirects('https://example.com/start', {}, 5);

    assert.equal(result.url, 'https://example.com/next');
    assert.equal(callCount, 2);
  });

  it('fails when a redirect response is missing a Location header', async (t) => {
    const fetchMock = async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, {
        status: 302,
      });

    t.mock.method(globalThis, 'fetch', fetchMock);

    await assert.rejects(
      fetchWithRedirects('https://example.com/start', {}, 5),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(
          error.message,
          'Redirect response missing Location header'
        );
        return true;
      }
    );
  });

  it('fails when too many redirects occur', async (t) => {
    const fetchMock = async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, {
        status: 302,
        headers: { location: '/next' },
      });

    t.mock.method(globalThis, 'fetch', fetchMock);

    await assert.rejects(
      fetchWithRedirects('https://example.com/start', {}, 1),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.message, 'Too many redirects');
        return true;
      }
    );
  });

  it('fails when redirect target validation rejects', async (t) => {
    const fetchMock = async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://blocked.local' },
      });

    t.mock.method(globalThis, 'fetch', fetchMock);

    await assert.rejects(
      fetchWithRedirects('https://example.com/start', {}, 5)
    );
  });
});
